#!/usr/bin/env node
/**
 * Delulu Voice for coding agents: an MCP server (stdio) and a small CLI that
 * speak through a running Delulu Talks. Uses only Node built-ins, so `node`
 * or Electron with ELECTRON_RUN_AS_NODE=1 can run it.
 *
 *   MCP:  node delulu-voice-mcp.mjs
 *   CLI:  node delulu-voice-mcp.mjs say [--wait] [--interrupt] [--agent NAME] [--response ID] <text…>
 *         node delulu-voice-mcp.mjs listen start|next|ack|status|stop …
 *         node delulu-voice-mcp.mjs stop | status | --help
 *
 * The app writes bridge.json beside this file with the socket and a token.
 * DELULU_VOICE_BRIDGE overrides where bridge.json is read from.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const NOT_RUNNING =
  "Delulu Talks isn't running, or agent voice is turned off in its Voice page.";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Waiting for speech covers the queue ahead of it as well as its own audio.
const WAIT_TIMEOUT_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// A waiting listen.next may take up to its own timeout; allow for the answer.
const LISTEN_MARGIN_MS = 15_000;
const MCP_LISTEN_SECONDS = 50;
const MAX_LISTEN_SECONDS = 3_600;
const DEFAULT_LISTEN_SECONDS = 600;
/** Exit codes for `listen next`. */
const EXIT_EVENT = 0;
const EXIT_TIMEOUT = 3;
const EXIT_STOPPED = 4;
const ENGINE_NAMES = {
  kokoro: "Kokoro",
  "chatterbox-turbo": "Chatterbox Turbo",
};

const FALLBACK_INSTRUCTIONS =
  "You can talk to the user out loud with the speak tool. Speak only when work is done, when you are blocked, or when you need a decision: one to three short sentences, never code or logs. See the speak tool for expressive tags. Delulu Talks was not reachable when this session started; start it and turn on agent voice in its Voice page.";

const SPEAK_DESCRIPTION = `Speak to the user out loud through Delulu Talks.

You are the lead agent and the only one who speaks; the user is your board. Speak when work is done, when you are blocked, when you need a decision, or when something important broke. Not for routine progress, and never once per subtask. Use one to three short sentences, like a colleague talking. Never read code, diffs, logs or long lists aloud; name the file or the outcome instead. Ask one clear question when you need a decision.

Expressive markup, used sparingly where a person really would:
- One-off sounds: [laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush]
- Pauses: [pause] [long-pause]
- Wrapping styles: <whisper>…</whisper> <happy>…</happy> <angry>…</angry> <surprised>…</surprised> <scared>…</scared> <sarcastic>…</sarcastic> <dramatic>…</dramatic> <narration>…</narration> <crying>…</crying>
- Pacing and volume: <slow>…</slow> <fast>…</fast> <soft>…</soft> <loud>…</loud> <emphasis>…</emphasis>
Example: "[sigh] the build still fails on the cache path. Want me to try another way?"

Returns once the speech is queued, unless wait is true.`;

const TOOLS = [
  {
    name: "speak",
    title: "Speak out loud",
    description: SPEAK_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 15000,
          description: "What to say, with optional expressive markup.",
        },
        interrupt: {
          type: "boolean",
          description: "Stop current speech and clear the queue first.",
        },
        wait: {
          type: "boolean",
          description:
            "Wait until the speech has finished playing. Defaults to false.",
        },
        agent: {
          type: "string",
          maxLength: 64,
          description: "Your display name in Delulu's spoken history.",
        },
        responseId: {
          type: "string",
          pattern: "^[A-Za-z0-9_.:-]{1,128}$",
          description:
            "Your id for this spoken response. If the user talks over it, the interruption event reports this id. Generated when omitted.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "stop_speaking",
    title: "Stop speaking",
    description:
      "Stop Delulu Talks speaking right away and clear anything queued.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "voice_status",
    title: "Voice status",
    description:
      "Whether Delulu Talks can speak right now: voice on or off, the engine, and whether it is speaking or has speech queued.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "listen_start",
    title: "Start listening",
    description:
      "Start (or reuse) a persistent listening session. Delulu keeps the microphone and speech model running across turns until listen_stop. Idempotent for the same client. Returns the session, including its id.",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          maxLength: 64,
          description:
            'Who owns the session, e.g. "claude-code". Another client cannot take it over.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "listen_next",
    title: "Wait for the user",
    description: `Wait for the next event in a listening session and return it as JSON: {"status":"event","event":{...}} for an utterance or an interruption, {"status":"timeout"} when nothing arrived (just call again), or {"status":"stopped"}. Pass after = the seq of the last event you processed: that acknowledges it and everything before; calling again with the same after returns the same event, so retries never lose input. An "interrupted" event means the user talked over your speech and is still speaking; do not repeat yourself, wait for the following "utterance" (it carries interruptedResponseId). The wait is bounded (default ${MCP_LISTEN_SECONDS} s); the session keeps listening between calls.`,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        after: { type: "integer", minimum: 0 },
        timeoutSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_LISTEN_SECONDS,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "listen_ack",
    title: "Acknowledge events",
    description:
      "Acknowledge every event up to and including seq `after` without waiting, so they are not delivered again.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        after: { type: "integer", minimum: 0 },
      },
      required: ["sessionId", "after"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "listen_status",
    title: "Listening status",
    description:
      "The active listening session (or the given one): state, queued events, cursor, whether the user is speaking.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "listen_stop",
    title: "Stop listening",
    description:
      "Stop a listening session: the microphone closes, waiting calls return stopped. Only when the user is done talking.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

class BridgeError extends Error {
  constructor(message, code = "VOICE_UNAVAILABLE") {
    super(message);
    this.code = code;
  }
}

function bridgeFile() {
  return (
    process.env.DELULU_VOICE_BRIDGE ||
    join(dirname(fileURLToPath(import.meta.url)), "bridge.json")
  );
}

/** Read bridge.json on every call: the token changes when the app restarts. */
function readBridge() {
  let value;
  try {
    value = JSON.parse(readFileSync(bridgeFile(), "utf8"));
  } catch {
    throw new BridgeError(NOT_RUNNING);
  }
  if (
    !value ||
    value.protocol !== 1 ||
    typeof value.endpoint !== "string" ||
    typeof value.token !== "string"
  )
    throw new BridgeError(
      "Delulu Talks wrote a bridge file this script does not understand. Update the agent setup from the Voice page.",
    );
  return value;
}

/** One request per connection; the app answers with one JSON line. Aborting closes it. */
function call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
  let bridge;
  try {
    bridge = readBridge();
  } catch (error) {
    return Promise.reject(error);
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect(bridge.endpoint);
    let received = Buffer.alloc(0);
    let settled = false;
    let timer = setTimeout(
      () => finish(new BridgeError(NOT_RUNNING)),
      CONNECT_TIMEOUT_MS,
    );
    const abort = () =>
      finish(new BridgeError("Cancelled; nothing was lost.", "CANCELLED"));
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(new BridgeError("Delulu Talks did not answer in time.")),
        timeoutMs,
      );
      socket.write(
        JSON.stringify({ v: 1, id, token: bridge.token, method, params }) +
          "\n",
      );
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        finish(new BridgeError("Delulu Talks sent an oversized response."));
        return;
      }
      let newline;
      while ((newline = received.indexOf(10)) >= 0) {
        const line = received.subarray(0, newline).toString("utf8").trim();
        received = received.subarray(newline + 1);
        if (!line) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          finish(new BridgeError("Delulu Talks sent an unreadable response."));
          return;
        }
        if (response.id !== id && response.id !== null) continue;
        if (response.ok) finish(null, response.result);
        else
          finish(
            new BridgeError(
              response.error?.message || "Delulu Talks refused the request.",
              response.error?.code,
            ),
          );
        return;
      }
    });
    socket.once("error", () => finish(new BridgeError(NOT_RUNNING)));
    socket.once("close", () =>
      finish(new BridgeError("Delulu Talks closed the connection.")),
    );
  });
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;
}

/** Turn a speak result into one or two sentences an agent can act on. */
function describeSpeak(result) {
  const response = result?.responseId ? ` Response ${result.responseId}.` : "";
  if (result && typeof result.position === "number")
    return {
      text:
        (result.position <= 0
          ? "Speaking now."
          : `Queued (${result.position} ahead).`) + response,
      error: false,
    };
  const lines = [];
  let error = false;
  switch (result?.outcome) {
    case "spoken":
      lines.push(`Spoken (${seconds(result.durationMs)}).`);
      break;
    case "stopped":
      lines.push(`Stopped after ${seconds(result.durationMs)}.`);
      break;
    case "interrupted":
      lines.push(
        `Interrupted by the user after ${seconds(result.durationMs)}; collect their utterance with listen next.`,
      );
      break;
    case "failed":
      error = true;
      lines.push(`Speech failed: ${result.error || "unknown error"}.`);
      break;
    default:
      lines.push(`Speech ${result?.outcome ?? "accepted"}.`);
  }
  if (Array.isArray(result?.warnings) && result.warnings.length)
    lines.push(`Markup warnings: ${result.warnings.join("; ")}.`);
  if (Array.isArray(result?.unsupported) && result.unsupported.length)
    lines.push(`Skipped by this voice: ${result.unsupported.join(", ")}.`);
  if (result?.responseId) lines.push(`Response ${result.responseId}.`);
  return { text: lines.join(" "), error };
}

function describeStatus(status) {
  if (!status || typeof status !== "object") return "Voice status unknown.";
  const engine = ENGINE_NAMES[status.engine] ?? String(status.engine ?? "");
  const parts = [];
  if (!status.enabled) parts.push("Voice is turned off in Delulu Talks.");
  else if (!status.ready)
    parts.push(`Voice is on; ${engine || "the voice"} is not ready yet.`);
  else parts.push(`Voice is on and ${engine} is ready.`);
  if (status.speaking) parts.push("Speaking now.");
  if (status.queued > 0)
    parts.push(
      `${status.queued} ${status.queued === 1 ? "message" : "messages"} queued.`,
    );
  if (typeof status.message === "string" && status.message.trim())
    parts.push(status.message.trim());
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* MCP server                                                          */
/* ------------------------------------------------------------------ */

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function listenTimeout(timeoutSeconds) {
  const seconds = Number(timeoutSeconds);
  return (
    (Number.isFinite(seconds) ? Math.max(0, seconds) : DEFAULT_LISTEN_SECONDS) *
      1000 +
    LISTEN_MARGIN_MS
  );
}

function argumentsOf(params) {
  const args = params?.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new RpcError(-32602, "Tool arguments must be an object.");
  return args;
}

async function callTool(params) {
  if (!params || typeof params.name !== "string")
    throw new RpcError(-32602, "tools/call needs a tool name.");
  const args = argumentsOf(params);
  try {
    switch (params.name) {
      case "speak": {
        if (typeof args.text !== "string" || !args.text.trim())
          throw new RpcError(-32602, "speak needs nonempty text.");
        for (const key of ["interrupt", "wait"])
          if (args[key] !== undefined && typeof args[key] !== "boolean")
            throw new RpcError(-32602, `${key} must be a boolean.`);
        if (args.agent !== undefined && typeof args.agent !== "string")
          throw new RpcError(-32602, "agent must be text.");
        if (
          args.responseId !== undefined &&
          typeof args.responseId !== "string"
        )
          throw new RpcError(-32602, "responseId must be text.");
        const wait = args.wait === true;
        const result = await call(
          "speak",
          {
            text: args.text,
            wait,
            ...(args.interrupt === undefined
              ? {}
              : { interrupt: args.interrupt }),
            ...(args.agent === undefined ? {} : { agent: args.agent }),
            ...(args.responseId === undefined
              ? {}
              : { responseId: args.responseId }),
          },
          wait ? WAIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        );
        const description = describeSpeak(result);
        return {
          ...textResult(description.text, description.error),
          structuredContent: result,
        };
      }
      case "listen_start":
        return jsonResult(
          await call(
            "listen.start",
            args.client === undefined ? {} : { client: args.client },
          ),
        );
      case "listen_next": {
        const timeoutSeconds = args.timeoutSeconds ?? MCP_LISTEN_SECONDS;
        return jsonResult(
          await call(
            "listen.next",
            {
              sessionId: args.sessionId,
              timeoutSeconds,
              ...(args.after === undefined ? {} : { after: args.after }),
            },
            listenTimeout(timeoutSeconds),
          ),
        );
      }
      case "listen_ack":
        return jsonResult(
          await call("listen.ack", {
            sessionId: args.sessionId,
            after: args.after,
          }),
        );
      case "listen_status":
        return jsonResult(
          await call(
            "listen.status",
            args.sessionId === undefined ? {} : { sessionId: args.sessionId },
          ),
        );
      case "listen_stop":
        return jsonResult(
          await call("listen.stop", { sessionId: args.sessionId }),
        );
      case "stop_speaking":
        await call("stop");
        return textResult("Stopped speaking and cleared the queue.");
      case "voice_status":
        return textResult(describeStatus(await call("status")));
      default:
        throw new RpcError(-32602, `Unknown tool: ${params.name}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...textResult(
        String(error?.code ?? "").startsWith("SESSION_")
          ? `${error.code}: ${message}`
          : message,
        true,
      ),
      structuredContent: { error: { code: error?.code ?? "ERROR", message } },
    };
  }
}

async function initialize(params) {
  const requested = params?.protocolVersion;
  let instructions = FALLBACK_INSTRUCTIONS;
  let version = "1";
  try {
    const hello = await call("hello", {}, 1_500);
    if (typeof hello?.instructions === "string")
      instructions = hello.instructions;
    if (typeof hello?.appVersion === "string") version = hello.appVersion;
  } catch {
    /* Delulu Talks may start later; tools report it then. */
  }
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: "delulu-voice", title: "Delulu Voice", version },
    instructions,
  };
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      return initialize(message.params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(message.params);
    default:
      throw new RpcError(-32601, `Method not found: ${message.method}`);
  }
}

/** Returns a response, or undefined for notifications and stray responses. */
async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request." },
    };
  const isRequest =
    typeof message.method === "string" &&
    (typeof message.id === "string" || typeof message.id === "number");
  if (!isRequest) return undefined;
  try {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: await handleRequest(message),
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: error instanceof RpcError ? error.rpcCode : -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function serve() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error." },
      });
      return;
    }
    if (Array.isArray(message)) {
      if (!message.length) {
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Empty batch." },
        });
        return;
      }
      void Promise.all(message.map(handleMessage)).then((responses) => {
        const replies = responses.filter(Boolean);
        if (replies.length) write(replies);
      });
      return;
    }
    void handleMessage(message).then((response) => {
      if (response) write(response);
    });
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `Delulu Voice: speak through Delulu Talks.

Usage:
  delulu-voice-mcp.mjs                 Run as an MCP server on stdio
  delulu-voice-mcp.mjs say [options] <text…>
      --wait          Wait until the speech has finished
      --interrupt     Stop current speech and clear the queue first
      --agent NAME    Name shown in Delulu's spoken history
      --response ID   Your id for this response; interruptions report it
      Use "-" as the text to read it from stdin.
  delulu-voice-mcp.mjs stop            Stop speaking and clear the queue
  delulu-voice-mcp.mjs status          Show whether Delulu can speak

Listening sessions (each prints one JSON object on stdout):
  listen start [--client NAME]         Start or reuse a session; prints its info ({"id": …})
  listen next --session ID [--after SEQ] [--timeout SECONDS]
                                       Wait for the next event after SEQ (default 600 s).
                                       Passing --after acknowledges SEQ and everything before;
                                       repeating it returns the same event again.
                                       Exit 0: {"status":"event","event":{…}}
                                       Exit 3: {"status":"timeout"}  (start another waiter)
                                       Exit 4: {"status":"stopped"}  (the session ended)
  listen ack --session ID --after SEQ  Acknowledge up to SEQ without waiting
  listen status [--session ID]         {"session": … | null}
  listen stop --session ID             Stop listening; waiters return "stopped"
Errors exit 1 with {"error":{"code","message"}} on stderr.
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function option(rest, name) {
  const index = rest.indexOf(name);
  if (index >= 0) return rest[index + 1];
  const inline = rest.find((value) => value.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function printJson(value, stream = process.stdout) {
  stream.write(JSON.stringify(value) + "\n");
}

function integerOption(rest, name, required) {
  const value = option(rest, name);
  if (value === undefined) {
    if (required)
      throw new BridgeError(`${name} is required.`, "INVALID_REQUEST");
    return undefined;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new BridgeError(
      `${name} must be a nonnegative integer.`,
      "INVALID_REQUEST",
    );
  return number;
}

async function listenCli(rest) {
  const [action, ...options] = rest;
  const session = option(options, "--session");
  const needSession = () => {
    if (!session)
      throw new BridgeError("--session ID is required.", "INVALID_REQUEST");
    return session;
  };
  switch (action) {
    case "start": {
      const client = option(options, "--client");
      printJson(
        await call("listen.start", client === undefined ? {} : { client }),
      );
      return 0;
    }
    case "next": {
      const sessionId = needSession();
      const after = integerOption(options, "--after", false);
      const raw = option(options, "--timeout");
      const timeoutSeconds =
        raw === undefined ? DEFAULT_LISTEN_SECONDS : Number(raw);
      if (
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds < 0 ||
        timeoutSeconds > MAX_LISTEN_SECONDS
      )
        throw new BridgeError(
          `--timeout must be between 0 and ${MAX_LISTEN_SECONDS} seconds.`,
          "INVALID_REQUEST",
        );
      // Being killed closes the connection; the app keeps the event queued.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const result = await call(
          "listen.next",
          {
            sessionId,
            timeoutSeconds,
            ...(after === undefined ? {} : { after }),
          },
          listenTimeout(timeoutSeconds),
          controller.signal,
        );
        printJson(result);
        return result?.status === "timeout"
          ? EXIT_TIMEOUT
          : result?.status === "stopped"
            ? EXIT_STOPPED
            : EXIT_EVENT;
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    }
    case "ack":
      printJson(
        await call("listen.ack", {
          sessionId: needSession(),
          after: integerOption(options, "--after", true),
        }),
      );
      return 0;
    case "status":
      printJson(
        await call("listen.status", session ? { sessionId: session } : {}),
      );
      return 0;
    case "stop":
      printJson(await call("listen.stop", { sessionId: needSession() }));
      return 0;
    default:
      process.stderr.write(`Unknown listen command: ${action}\n\n${USAGE}`);
      return 1;
  }
}

async function cli(args) {
  const [command, ...rest] = args;
  if (command === "listen") {
    try {
      return await listenCli(rest);
    } catch (error) {
      printJson(
        {
          error: {
            code: error?.code ?? "ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        process.stderr,
      );
      return 1;
    }
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "stop") {
    await call("stop");
    process.stdout.write("Stopped speaking.\n");
    return 0;
  }
  if (command === "status") {
    process.stdout.write(describeStatus(await call("status")) + "\n");
    return 0;
  }
  if (command !== "say") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  let wait = false;
  let interrupt = false;
  let agent;
  let responseId;
  const words = [];
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (value === "--") {
      words.push(...rest.slice(index + 1));
      break;
    }
    if (value === "--wait") wait = true;
    else if (value === "--interrupt") interrupt = true;
    else if (value === "--agent") {
      agent = rest[++index];
      if (agent === undefined) {
        process.stderr.write("--agent needs a name.\n");
        return 1;
      }
    } else if (value.startsWith("--agent=")) agent = value.slice(8);
    else if (value === "--response") {
      responseId = rest[++index];
      if (responseId === undefined) {
        process.stderr.write("--response needs an id.\n");
        return 1;
      }
    } else if (value.startsWith("--response=")) responseId = value.slice(11);
    else if (value.startsWith("--") && value.length > 2) {
      process.stderr.write(`Unknown option: ${value}\n\n${USAGE}`);
      return 1;
    } else words.push(value);
  }
  const text =
    words.length === 1 && words[0] === "-"
      ? await readStdin()
      : words.join(" ");
  if (!text.trim()) {
    process.stderr.write("Nothing to say.\n");
    return 1;
  }
  const result = await call(
    "speak",
    {
      text,
      wait,
      ...(interrupt ? { interrupt } : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(responseId === undefined ? {} : { responseId }),
    },
    wait ? WAIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  );
  const description = describeSpeak(result);
  (description.error ? process.stderr : process.stdout).write(
    description.text + "\n",
  );
  return description.error ? 1 : 0;
}

const args = process.argv.slice(2);
if (args.length) {
  cli(args).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
} else {
  serve();
}
