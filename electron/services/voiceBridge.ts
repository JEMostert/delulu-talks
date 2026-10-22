import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  LISTEN_LIMITS,
  type ListenNextResult,
  type ListenSessionInfo,
} from "../../src/listening";
import {
  VOICE_AGENT_INSTRUCTIONS,
  VOICE_LIMITS,
  type VoiceAgentSetup,
  type VoiceBridgeStatus,
  type VoiceEngineId,
  type VoiceQueued,
  type VoiceSpeakRequest,
  type VoiceSpeakResult,
} from "../../src/voice";

/**
 * Local agent bridge: coding agents reach Delulu Voice through a Unix socket
 * (a named pipe on Windows) that only this user can open. bridge.json beside
 * it holds the endpoint and a per-start token; the bundled MCP server/CLI
 * reads it and sends newline-delimited JSON requests.
 */
export const VOICE_BRIDGE_PROTOCOL = 1;
export const VOICE_BRIDGE_FILE = "bridge.json";
export const VOICE_AGENT_SCRIPT = "delulu-voice-mcp.mjs";
const SOCKET_FILE = "agent.sock";
const MAX_LINE_BYTES = 256 * 1024;
const MAX_CLIENTS = 16;
const MAX_IN_FLIGHT = 4;
const MAX_ID_BYTES = 128;
const MAX_AGENT_CHARACTERS = 64;
const MAX_ERROR_CHARACTERS = 2_000;
const RESPONSE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_CLIENT_CHARACTERS = 64;
// sun_path holds 108 bytes on Linux and 104 on macOS, including the NUL.
const MAX_SOCKET_PATH_BYTES = 100;

export type VoiceBridgeSnapshot = {
  enabled: boolean;
  ready: boolean;
  engine: VoiceEngineId;
  speaking: boolean;
  queued: number;
  message: string;
};

export type VoiceBridgeHandlers = {
  speak(
    request: VoiceSpeakRequest,
    wait: boolean,
  ): Promise<VoiceSpeakResult | VoiceQueued>;
  stop(): Promise<void>;
  status(): VoiceBridgeSnapshot;
  /** Idempotent for the same client; throws SESSION_BUSY for another client's session. */
  listenStart(client: string): Promise<ListenSessionInfo>;
  /** Waits for the first event after the cursor; `after` acknowledges up to it. */
  listenNext(
    sessionId: string,
    options: { after?: number; timeoutMs: number; signal: AbortSignal },
  ): Promise<ListenNextResult>;
  /** Acknowledges events up to `after` without waiting. */
  listenAck(sessionId: string, after: number): ListenSessionInfo;
  listenStatus(sessionId?: string): ListenSessionInfo | null;
  listenStop(sessionId: string): Promise<ListenSessionInfo>;
};

export type VoiceBridgeErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "VOICE_UNAVAILABLE"
  | "SESSION_BUSY"
  | "SESSION_NOT_FOUND"
  | "INTERNAL";

/** Handlers may throw this to choose the code an agent receives. */
export class VoiceBridgeError extends Error {
  constructor(
    readonly code: VoiceBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceBridgeError";
  }
}

type Connection = {
  socket: Socket;
  chunks: Buffer[];
  length: number;
  inFlight: number;
  closing: boolean;
  /** Waiting listen.next calls, aborted when the client disconnects. */
  waits: Set<AbortController>;
};

function bridgeEndpoint(
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const digest = createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 12);
  if (platform === "win32") return `\\\\.\\pipe\\delulu-talks-voice-${digest}`;
  const socket = join(directory, SOCKET_FILE);
  if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return socket;
  // A very long profile path cannot hold a socket; the token still guards it.
  return join(
    env.XDG_RUNTIME_DIR || tmpdir(),
    `delulu-talks-voice-${digest}.sock`,
  );
}

/** Whether something is accepting connections at a Unix socket path. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (answered: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), 500);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

function sameToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  // Hash first so different lengths still take the constant-time path.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(actual));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function failure(
  id: string | null,
  code: VoiceBridgeErrorCode,
  message: string,
) {
  return {
    v: VOICE_BRIDGE_PROTOCOL,
    id,
    ok: false,
    error: { code, message: message.slice(0, MAX_ERROR_CHARACTERS) },
  };
}

function sessionId(params: Record<string, unknown>): string {
  const value = params.sessionId;
  if (typeof value !== "string" || !value || value.length > MAX_ID_BYTES)
    throw new VoiceBridgeError("INVALID_REQUEST", "sessionId is required");
  return value;
}

function cursor(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new VoiceBridgeError(
      "INVALID_REQUEST",
      "after must be a nonnegative integer sequence number",
    );
  return value;
}

function parseSpeak(params: Record<string, unknown>): {
  request: VoiceSpeakRequest;
  wait: boolean;
} {
  const { text, interrupt, wait, agent, normalize, responseId } = params;
  if (typeof text !== "string" || !text.trim())
    throw new VoiceBridgeError("INVALID_REQUEST", "speak needs nonempty text");
  if (text.length > VOICE_LIMITS.requestCharacters)
    throw new VoiceBridgeError(
      "INVALID_REQUEST",
      `speak text is limited to ${VOICE_LIMITS.requestCharacters.toLocaleString("en-US")} characters`,
    );
  const flag = (key: string, value: unknown): boolean | undefined => {
    if (value !== undefined && typeof value !== "boolean")
      throw new VoiceBridgeError("INVALID_REQUEST", `${key} must be a boolean`);
    return value;
  };
  const interruptFlag = flag("interrupt", interrupt);
  const waitFlag = flag("wait", wait);
  const normalizeFlag = flag("normalize", normalize);
  if (agent !== undefined && typeof agent !== "string")
    throw new VoiceBridgeError("INVALID_REQUEST", "agent must be text");
  const label = (agent ?? "").trim().slice(0, MAX_AGENT_CHARACTERS) || "Agent";
  if (
    responseId !== undefined &&
    (typeof responseId !== "string" || !RESPONSE_ID.test(responseId))
  )
    throw new VoiceBridgeError(
      "INVALID_REQUEST",
      "responseId must be 1–128 characters of letters, digits, _ . : or -",
    );
  return {
    request: {
      text,
      source: "agent",
      agent: label,
      ...(responseId === undefined ? {} : { responseId }),
      ...(interruptFlag === undefined ? {} : { interrupt: interruptFlag }),
      ...(normalizeFlag === undefined ? {} : { normalize: normalizeFlag }),
    },
    wait: waitFlag === true,
  };
}

export class VoiceBridge {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private token = "";
  private readonly connections = new Set<Connection>();
  private readonly directory: string;
  private readonly appVersion: string;
  private readonly handlers: VoiceBridgeHandlers;
  private readonly onStatus: (status: VoiceBridgeStatus) => void;
  private readonly platform: NodeJS.Platform;
  private current: VoiceBridgeStatus = {
    enabled: false,
    listening: false,
    clients: 0,
    endpoint: null,
    error: null,
  };

  constructor(options: {
    directory: string;
    appVersion: string;
    handlers: VoiceBridgeHandlers;
    onStatus: (status: VoiceBridgeStatus) => void;
    platform?: NodeJS.Platform;
  }) {
    this.directory = options.directory;
    this.appVersion = options.appVersion;
    this.handlers = options.handlers;
    this.onStatus = options.onStatus;
    this.platform = options.platform ?? process.platform;
  }

  get status(): VoiceBridgeStatus {
    return { ...this.current };
  }

  private get bridgeFile(): string {
    return join(this.directory, VOICE_BRIDGE_FILE);
  }

  private update(patch: Partial<VoiceBridgeStatus>): void {
    const next = { ...this.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.onStatus(this.status);
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    const endpoint = bridgeEndpoint(this.directory, this.platform);
    this.update({ enabled: true, endpoint, error: null });
    let server: Server | null = null;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (this.platform !== "win32") chmodSync(this.directory, 0o700);
      if (this.platform !== "win32" && existsSync(endpoint)) {
        if (!lstatSync(endpoint).isSocket())
          throw new Error(
            `${endpoint} exists and is not a socket. Move it away and turn agent voice on again.`,
          );
        if (await socketAnswers(endpoint))
          throw new Error(
            "Another Delulu Talks instance already serves agent voice.",
          );
        rmSync(endpoint, { force: true });
      }
      this.token = randomBytes(32).toString("hex");
      const listening = createServer((socket) => this.accept(socket));
      server = listening;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(endpoint, () => {
          listening.off("error", reject);
          resolve();
        });
      });
      listening.on("error", (error) => {
        this.update({ listening: false, error: error.message });
      });
      if (this.platform !== "win32") chmodSync(endpoint, 0o600);
      // Publish the endpoint only once it accepts connections.
      this.writeBridgeFile(endpoint);
      this.server = listening;
      this.update({ listening: true, error: null });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.token = "";
      if (server?.listening) server.close();
      this.update({ listening: false, error: message });
      throw reason instanceof Error ? reason : new Error(message);
    }
  }

  private writeBridgeFile(endpoint: string): void {
    const temporary = join(
      this.directory,
      `.bridge-${randomBytes(6).toString("hex")}.tmp`,
    );
    const contents = JSON.stringify(
      {
        protocol: VOICE_BRIDGE_PROTOCOL,
        endpoint,
        token: this.token,
        pid: process.pid,
        appVersion: this.appVersion,
      },
      null,
      2,
    );
    try {
      writeFileSync(temporary, contents, { mode: 0o600 });
      if (this.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, this.bridgeFile);
    } catch (reason) {
      rmSync(temporary, { force: true });
      throw reason;
    }
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // Leave a file written by a newer start alone.
      const saved = JSON.parse(readFileSync(this.bridgeFile, "utf8"));
      if (saved?.token === this.token) rmSync(this.bridgeFile, { force: true });
    } catch {
      /* Missing or unreadable: nothing of ours to remove. */
    }
    const endpoint = this.current.endpoint;
    if (
      server &&
      endpoint &&
      this.platform !== "win32" &&
      existsSync(endpoint) &&
      lstatSync(endpoint).isSocket()
    )
      rmSync(endpoint, { force: true });
    this.token = "";
    this.update({
      enabled: false,
      listening: false,
      clients: 0,
      endpoint: null,
    });
  }

  private accept(socket: Socket): void {
    socket.on("error", () => undefined);
    if (this.connections.size >= MAX_CLIENTS) {
      socket.end(
        JSON.stringify(
          failure(
            null,
            "INVALID_REQUEST",
            "Too many agent connections are open. Close one and retry.",
          ),
        ) + "\n",
      );
      return;
    }
    const connection: Connection = {
      socket,
      chunks: [],
      length: 0,
      inFlight: 0,
      closing: false,
      waits: new Set(),
    };
    this.connections.add(connection);
    this.update({ clients: this.connections.size });
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.once("close", () => {
      // A disconnected waiter gives up; its event stays queued for the next one.
      for (const wait of connection.waits) wait.abort();
      connection.waits.clear();
      this.connections.delete(connection);
      if (this.server) this.update({ clients: this.connections.size });
    });
  }

  private receive(connection: Connection, chunk: Buffer): void {
    let offset = 0;
    while (!connection.closing && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (connection.length + part.length > MAX_LINE_BYTES) {
        connection.closing = true;
        connection.chunks = [];
        connection.socket.end(
          JSON.stringify(
            failure(
              null,
              "INVALID_REQUEST",
              "Request line exceeds 256 KiB. Shorten the text and reconnect.",
            ),
          ) + "\n",
        );
        return;
      }
      connection.chunks.push(Buffer.from(part));
      connection.length += part.length;
      if (newline < 0) return;
      const line = Buffer.concat(connection.chunks).toString("utf8").trim();
      connection.chunks = [];
      connection.length = 0;
      offset = newline + 1;
      if (line) this.handleLine(connection, line);
    }
  }

  private respond(connection: Connection, payload: unknown): void {
    const { socket } = connection;
    if (socket.destroyed || !socket.writable) return;
    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      const id =
        isObject(payload) && typeof payload.id === "string" ? payload.id : null;
      line = JSON.stringify(
        failure(
          id,
          "INTERNAL",
          "Delulu Talks produced an unreadable response.",
        ),
      );
    }
    socket.write(line + "\n");
  }

  private handleLine(connection: Connection, line: string): void {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      this.respond(
        connection,
        failure(null, "INVALID_REQUEST", "Request is not valid JSON."),
      );
      return;
    }
    const id =
      isObject(request) &&
      typeof request.id === "string" &&
      request.id &&
      Buffer.byteLength(request.id) <= MAX_ID_BYTES
        ? request.id
        : null;
    if (
      !isObject(request) ||
      request.v !== VOICE_BRIDGE_PROTOCOL ||
      id === null
    ) {
      this.respond(
        connection,
        failure(
          id,
          "INVALID_REQUEST",
          `Requests need v ${VOICE_BRIDGE_PROTOCOL} and a string id of at most ${MAX_ID_BYTES} bytes.`,
        ),
      );
      return;
    }
    if (!this.token || !sameToken(this.token, request.token)) {
      this.respond(
        connection,
        failure(
          id,
          "UNAUTHORIZED",
          "The bridge token does not match. Delulu Talks may have restarted; read bridge.json again.",
        ),
      );
      return;
    }
    if (typeof request.method !== "string") {
      this.respond(
        connection,
        failure(id, "INVALID_REQUEST", "Requests need a method."),
      );
      return;
    }
    if (request.params !== undefined && !isObject(request.params)) {
      this.respond(
        connection,
        failure(id, "INVALID_REQUEST", "params must be an object."),
      );
      return;
    }
    if (connection.inFlight >= MAX_IN_FLIGHT) {
      this.respond(
        connection,
        failure(
          id,
          "INVALID_REQUEST",
          `At most ${MAX_IN_FLIGHT} requests may wait on one connection.`,
        ),
      );
      return;
    }
    connection.inFlight++;
    void this.dispatch(request.method, request.params ?? {}, connection)
      .then(
        (result) => ({ v: VOICE_BRIDGE_PROTOCOL, id, ok: true, result }),
        (reason: unknown) =>
          reason instanceof VoiceBridgeError
            ? failure(id, reason.code, reason.message)
            : failure(
                id,
                "INTERNAL",
                reason instanceof Error ? reason.message : String(reason),
              ),
      )
      .then((response) => {
        connection.inFlight--;
        this.respond(connection, response);
      });
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    connection?: Connection,
  ): Promise<unknown> {
    switch (method) {
      case "hello":
        return {
          app: "delulu-talks",
          appVersion: this.appVersion,
          protocol: VOICE_BRIDGE_PROTOCOL,
          instructions: VOICE_AGENT_INSTRUCTIONS,
          status: this.handlers.status(),
        };
      case "status":
        return this.handlers.status();
      case "speak": {
        const { request, wait } = parseSpeak(params);
        return this.unavailableOnFailure(() =>
          this.handlers.speak(request, wait),
        );
      }
      case "stop":
        await this.unavailableOnFailure(() => this.handlers.stop());
        return { stopped: true };
      case "listen.start": {
        const client = params.client ?? "agent";
        if (
          typeof client !== "string" ||
          !client.trim() ||
          client.length > MAX_CLIENT_CHARACTERS
        )
          throw new VoiceBridgeError(
            "INVALID_REQUEST",
            "client must be 1–64 characters",
          );
        return this.unavailableOnFailure(() =>
          this.handlers.listenStart(client.trim()),
        );
      }
      case "listen.next": {
        const id = sessionId(params);
        const after = cursor(params.after, false);
        const seconds =
          params.timeoutSeconds ?? LISTEN_LIMITS.defaultWaitSeconds;
        if (
          typeof seconds !== "number" ||
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          seconds > LISTEN_LIMITS.maxWaitSeconds
        )
          throw new VoiceBridgeError(
            "INVALID_REQUEST",
            `timeoutSeconds must be between 0 and ${LISTEN_LIMITS.maxWaitSeconds}`,
          );
        const wait = new AbortController();
        connection?.waits.add(wait);
        try {
          return await this.unavailableOnFailure(() =>
            this.handlers.listenNext(id, {
              ...(after === undefined ? {} : { after }),
              timeoutMs: Math.round(seconds * 1000),
              signal: wait.signal,
            }),
          );
        } finally {
          connection?.waits.delete(wait);
        }
      }
      case "listen.ack": {
        const id = sessionId(params);
        const after = cursor(params.after, true)!;
        return this.unavailableOnFailure(async () =>
          this.handlers.listenAck(id, after),
        );
      }
      case "listen.status": {
        const id =
          params.sessionId === undefined ? undefined : sessionId(params);
        return { session: this.handlers.listenStatus(id) };
      }
      case "listen.stop":
        return this.unavailableOnFailure(() =>
          this.handlers.listenStop(sessionId(params)),
        );
      default:
        throw new VoiceBridgeError(
          "INVALID_REQUEST",
          `Unknown method: ${method.slice(0, 64)}`,
        );
    }
  }

  /** A handler that refuses (voice off, not set up) reports why, unchanged. */
  private async unavailableOnFailure<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (reason) {
      if (reason instanceof VoiceBridgeError) throw reason;
      // ListeningService throws ListenError; keep its session codes.
      const code = (reason as { code?: unknown } | null)?.code;
      if (code === "SESSION_BUSY" || code === "SESSION_NOT_FOUND")
        throw new VoiceBridgeError(
          code,
          reason instanceof Error ? reason.message : String(reason),
        );
      throw new VoiceBridgeError(
        "VOICE_UNAVAILABLE",
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }
}

/** Where the bundled MCP script lives: packaged resources or the source tree. */
export function voiceAgentScriptSource(
  resourcesPath: string,
  appPath: string,
  packaged: boolean,
): string {
  const bundled = join(resourcesPath, "voice", VOICE_AGENT_SCRIPT);
  if (packaged && existsSync(bundled)) return bundled;
  return join(appPath, "electron", "voice", VOICE_AGENT_SCRIPT);
}

/**
 * Copy the MCP script beside bridge.json, so agents keep a stable path across
 * app updates and AppImage mounts. Unchanged content is not rewritten.
 */
export function installVoiceAgentScript(
  directory: string,
  source: string,
): string {
  const target = join(directory, VOICE_AGENT_SCRIPT);
  const contents = readFileSync(source);
  if (existsSync(target) && readFileSync(target).equals(contents))
    return target;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${VOICE_AGENT_SCRIPT}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { mode: 0o755 });
    renameSync(temporary, target);
  } catch (reason) {
    rmSync(temporary, { force: true });
    throw reason;
  }
  return target;
}

function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const entries = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  return entries.some((directory) => {
    const candidate = paths.join(directory, name);
    try {
      if (!statSync(candidate).isFile()) return false;
      if (platform !== "win32") accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function quote(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Copyable commands that register the MCP server with common agents. */
export function voiceAgentSetup(
  scriptPath: string,
  options: {
    execPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): VoiceAgentSetup {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeFound = executableOnPath(
    platform === "win32" ? "node.exe" : "node",
    env,
    platform,
  );
  // An AppImage mounts at a new path on every launch; its file path is stable.
  const electron = env.APPIMAGE || options.execPath || process.execPath;
  const command = nodeFound ? ["node", scriptPath] : [electron, scriptPath];
  const variables: Record<string, string> = nodeFound
    ? {}
    : { ELECTRON_RUN_AS_NODE: "1" };
  const words = (values: string[]) =>
    values.map((value) => quote(value, platform)).join(" ");
  const envFlags = (flag: string) =>
    Object.entries(variables).map(([key, value]) => `${flag} ${key}=${value}`);
  const example = "Done, all tests pass.";
  const shell =
    platform === "win32"
      ? `${Object.entries(variables)
          .map(([key, value]) => `$env:${key}="${value}"; `)
          .join("")}& ${words([...command, "say", example])}`
      : `${Object.entries(variables)
          .map(([key, value]) => `${key}=${value} `)
          .join("")}${words([...command, "say", example])}`;
  return {
    scriptPath,
    command,
    nodeFound,
    claudeCode: [
      "claude mcp add --scope user",
      ...envFlags("-e"),
      "delulu-voice --",
      words(command),
    ].join(" "),
    codex: [
      "codex mcp add delulu-voice",
      ...envFlags("--env"),
      "--",
      words(command),
    ].join(" "),
    json: JSON.stringify(
      {
        mcpServers: {
          "delulu-voice": {
            command: command[0],
            args: command.slice(1),
            ...(Object.keys(variables).length ? { env: variables } : {}),
          },
        },
      },
      null,
      2,
    ),
    shell,
    instructions: VOICE_AGENT_INSTRUCTIONS,
  };
}
