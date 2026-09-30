import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AUTOMATION_CAPABILITIES, type AutomationCapability, type AutomationGrant, type AutomationGrantRequest, type AutomationStatus } from "../../src/localAutomation";
import { integrationEventPayload, type IntegrationEventInput } from "../../src/integrationEvents";
import type { AppSettings, MagicRewriteRequest, TranscriptRecord } from "../../src/types";
import { readPersonalProfiles } from "../../src/personalProfiles";
import { deliveredText } from "../../src/transcriptText";
import { isMagicPreset } from "../../src/rewritePresets";
import { validateRewriteInstructions } from "../../src/rewriteInstructions";

type StoredGrant = AutomationGrant & { tokenHash: string };
type Client = { id: string; capabilities: readonly AutomationCapability[]; directories: readonly string[] };
export type AutomationPorts = {
  status(): unknown;
  settings(): AppSettings;
  history(): TranscriptRecord[];
  diagnostics(): unknown | Promise<unknown>;
  transcribe(path: string): Promise<TranscriptRecord>;
  rewrite(request: MagicRewriteRequest): Promise<unknown>;
  activateProfile(id: string | null): Promise<unknown>;
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sameHash = (a: string, b: string) => validHash(a) && validHash(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Explicit opt-in: loopback only, capability-scoped tokens, no clipboard or shell endpoints. */
export class LocalAutomationService {
  private server: Server | null = null;
  private ownerToken = "";
  private url: string | null = null;
  private grants: StoredGrant[] = [];
  private streams = new Map<ServerResponse, string>();
  private activeOperations = 0;
  private permissionError: string | null = null;
  private transitions: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  readonly connectionFile: string;

  constructor(dataDirectory: string, private readonly ports: AutomationPorts) {
    this.directory = join(dataDirectory, "automation");
    this.connectionFile = join(this.directory, "connection.json");
    const path = join(this.directory, "grants.json");
    try { if (existsSync(path)) {
      if (statSync(path).size > 1024 * 1024) throw new Error("Automation permissions file is too large");
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.schemaVersion !== 1 || !Array.isArray(value.grants) || value.grants.length > 32)
        throw new Error("Unsupported automation permissions; existing permissions were preserved");
      this.grants = value.grants.map((grant: StoredGrant) => {
        if (typeof grant.id !== "string" || !validHash(grant.tokenHash) || !Number.isFinite(grant.createdAt))
          throw new Error("Invalid automation permission record");
        return { ...this.validateGrant(grant, false), id: grant.id, createdAt: grant.createdAt, tokenHash: grant.tokenHash };
      });
    } } catch (error) { this.permissionError = error instanceof Error ? error.message : String(error); }
  }

  private save(name: string, value: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.directory, 0o700);
    const path = join(this.directory, name);
    const stage = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(stage, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(stage, path);
    } finally { rmSync(stage, { force: true }); }
  }

  private validateGrant(value: AutomationGrantRequest, resolveDirectories = true): AutomationGrantRequest {
    if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 128 ||
      !Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.length > AUTOMATION_CAPABILITIES.length ||
      value.capabilities.some((capability) => !AUTOMATION_CAPABILITIES.includes(capability)) ||
      !Array.isArray(value.directories) || value.directories.length > 16 ||
      value.directories.some((directory) => typeof directory !== "string" || !isAbsolute(directory) || directory.length > 4096))
      throw new Error("Choose a name, supported capabilities, and absolute allowed audio directories");
    const directories = [...new Set(value.directories.map((directory) => {
      if (!resolveDirectories) return directory;
      const path = realpathSync(directory);
      if (!statSync(path).isDirectory()) throw new Error("Allowed audio roots must be directories");
      return path;
    }))];
    if (value.capabilities.includes("audio:transcribe") && !directories.length)
      throw new Error("Audio transcription requires at least one allowed source directory");
    return { name: value.name.trim(), capabilities: [...new Set(value.capabilities)], directories };
  }

  getStatus(): AutomationStatus {
    return {
      available: true, enabled: this.server !== null, url: this.url,
      connectionFile: this.server ? this.connectionFile : null,
      integrations: this.grants.map(({ tokenHash: _secret, ...grant }) => ({ ...grant, capabilities: [...grant.capabilities], directories: [...grant.directories] })),
      ...(this.permissionError ? { error: this.permissionError } : {}),
    };
  }

  async initialize(): Promise<void> {
    if (this.permissionError) return;
    const path = join(this.directory, "preferences.json");
    const enabled = existsSync(path) && JSON.parse(readFileSync(path, "utf8")).enabled === true;
    if (enabled || process.env.DELULU_LOCAL_API === "1") await this.setEnabled(true);
  }

  setEnabled(enabled: boolean): Promise<AutomationStatus> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error("Expected an automation toggle"));
    const operation = this.transitions.then(async () => {
      if (enabled && this.permissionError) throw new Error(this.permissionError);
      if (enabled && !this.server) await this.start();
      if (!enabled) await this.stop();
      this.save("preferences.json", { schemaVersion: 1, enabled });
      return this.getStatus();
    });
    this.transitions = operation.catch(() => undefined);
    return operation;
  }

  grant(request: AutomationGrantRequest): AutomationGrant & { token: string } {
    if (this.permissionError) throw new Error(this.permissionError);
    if (this.grants.length >= 32) throw new Error("Revoke an integration before adding another (limit 32)");
    const value = this.validateGrant(request);
    const token = randomBytes(32).toString("base64url");
    const grant = { ...value, id: randomUUID(), createdAt: Date.now() };
    const next = [...this.grants, { ...grant, tokenHash: hash(token) }];
    this.save("grants.json", { schemaVersion: 1, grants: next });
    this.grants = next;
    return { ...grant, token };
  }

  revoke(id: string): AutomationStatus {
    if (this.permissionError) throw new Error(this.permissionError);
    if (typeof id !== "string" || id.length > 128) throw new Error("Expected an integration ID");
    const next = this.grants.filter((grant) => grant.id !== id);
    this.save("grants.json", { schemaVersion: 1, grants: next });
    this.grants = next;
    for (const [response, clientId] of this.streams) if (clientId === id) { response.end(); this.streams.delete(response); }
    return this.getStatus();
  }

  private currentClient(id: string): Client | null {
    if (!this.server) return null;
    return id === "owner" ? { id, capabilities: AUTOMATION_CAPABILITIES, directories: [] } : this.grants.find((grant) => grant.id === id) ?? null;
  }

  private authenticate(request: IncomingMessage): Client {
    const authorization = request.headers.authorization ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new ApiError(401, "A local integration token is required");
    const digest = hash(authorization.slice(7));
    if (this.ownerToken && sameHash(digest, hash(this.ownerToken))) return this.currentClient("owner")!;
    const grant = this.grants.find((candidate) => sameHash(digest, candidate.tokenHash));
    if (!grant) throw new ApiError(401, "This token is invalid or revoked");
    return grant;
  }

  private require(client: Client, capability: AutomationCapability): void {
    if (!this.currentClient(client.id)?.capabilities.includes(capability)) throw new ApiError(403, `This integration needs ${capability}`);
  }

  private source(client: Client, value: unknown): string {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) throw new ApiError(400, "Expected an absolute source path");
    const path = realpathSync(value);
    if (!statSync(path).isFile()) throw new ApiError(400, "The source must be a regular file");
    if (client.id !== "owner" && !client.directories.some((directory) => {
      const part = relative(directory, path);
      return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
    })) throw new ApiError(403, "Source is outside this integration's allowed audio directories");
    if (!/\.(wav|flac|mp3|m4a|ogg|opus|webm|mp4|mov|mkv)$/i.test(path)) throw new ApiError(400, "Unsupported source format");
    return path;
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!request.headers["content-type"]?.startsWith("application/json")) throw new ApiError(415, "Use application/json");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 1024 * 1024) throw new ApiError(413, "Request exceeds 1 MiB");
      chunks.push(buffer);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError(400, "Invalid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Expected a request object");
    return value as Record<string, unknown>;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // Browsers are not API clients: no cross-origin access, cookies or URL tokens.
    if (request.headers.origin || request.headers.host !== this.url?.slice(7)) throw new ApiError(403, "Use the authenticated loopback client");
    const client = this.authenticate(request);
    const url = new URL(request.url ?? "/", this.url!);
    let result: unknown;
    if (request.method === "GET" && url.pathname === "/v1/events") {
      this.require(client, "events:status");
      if (this.streams.size >= 16) throw new ApiError(429, "Too many event subscribers");
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(": connected\n\n");
      this.streams.set(response, client.id);
      const timer = setInterval(() => { if (!response.write(": heartbeat\n\n")) response.destroy(); }, 15_000);
      timer.unref();
      response.once("close", () => { clearInterval(timer); this.streams.delete(response); });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      this.require(client, "events:status"); result = this.ports.status();
    } else if (request.method === "GET" && url.pathname === "/v1/diagnostics") {
      this.require(client, "diagnostics:read"); result = await this.ports.diagnostics();
    } else if (request.method === "GET" && url.pathname === "/v1/history") {
      this.require(client, "transcripts:read"); result = this.ports.history();
    } else if (request.method === "GET" && url.pathname.startsWith("/v1/history/")) {
      this.require(client, "transcripts:read");
      const record = this.ports.history().find((record) => record.id === decodeURIComponent(url.pathname.slice(12)));
      if (!record) throw new ApiError(404, "Transcript not found");
      result = url.searchParams.get("format") === "txt" ? { text: deliveredText(record) } : record;
    } else if (request.method === "GET" && url.pathname === "/v1/profiles") {
      this.require(client, "profiles:write");
      const profiles = readPersonalProfiles(this.ports.settings().personalProfiles);
      result = profiles.status === "supported" ? profiles.document.profiles.map(({ id, name }) => ({ id, name })) : [];
    } else if (request.method === "POST" && url.pathname === "/v1/profiles/activate") {
      this.require(client, "profiles:write");
      const body = await this.body(request);
      if (body.id !== null && (typeof body.id !== "string" || body.id.length > 128)) throw new ApiError(400, "Expected a profile ID or null");
      const profiles = readPersonalProfiles(this.ports.settings().personalProfiles);
      if (body.id !== null && (profiles.status !== "supported" || !profiles.document.profiles.some((profile) => profile.id === body.id))) throw new ApiError(404, "Profile not found");
      await this.ports.activateProfile(body.id as string | null); result = { activeProfileId: body.id };
    } else if (request.method === "POST" && url.pathname === "/v1/transcribe") {
      this.require(client, "audio:transcribe");
      const body = await this.body(request);
      if (this.activeOperations) throw new ApiError(409, "An automation model operation is already active");
      const path = this.source(client, body.path);
      this.activeOperations++;
      try { result = await this.ports.transcribe(path); } finally { this.activeOperations--; }
    } else if (request.method === "POST" && url.pathname === "/v1/rewrite") {
      this.require(client, "rewrite:preview");
      const body = await this.body(request);
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 50_000 || !isMagicPreset(body.preset ?? "polish")) throw new ApiError(400, "Expected source text and a supported rewrite preset");
      if (this.activeOperations) throw new ApiError(409, "An automation model operation is already active");
      this.activeOperations++;
      try {
        result = await this.ports.rewrite({ text: body.text, preset: (body.preset ?? "polish") as MagicRewriteRequest["preset"], instructions: validateRewriteInstructions(body.instructions), allowInferences: body.allowInferences === true });
      } finally { this.activeOperations--; }
    } else if (url.pathname === "/v1/integrations" && client.id === "owner") {
      if (request.method === "GET") result = this.getStatus();
      else if (request.method === "POST") result = this.grant(await this.body(request) as unknown as AutomationGrantRequest);
      else throw new ApiError(405, "Unsupported method");
    } else if (request.method === "DELETE" && url.pathname.startsWith("/v1/integrations/") && client.id === "owner") {
      result = this.revoke(decodeURIComponent(url.pathname.slice(17)));
    } else throw new ApiError(404, "Endpoint not found");
    // Revocation during an awaited model operation also prevents result disclosure.
    if (!this.currentClient(client.id)) throw new ApiError(403, "Integration was revoked during this operation");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result ?? null));
  }

  publish(input: IntegrationEventInput): void {
    for (const [response, id] of this.streams) {
      const payload = integrationEventPayload(input, () => {
        const client = this.currentClient(id);
        return client ? { active: true, capabilities: client.capabilities.filter((capability): capability is "events:status" | "transcripts:read" => capability === "events:status" || capability === "transcripts:read") } : null;
      });
      if (payload && !response.write(`data: ${JSON.stringify(payload)}\n\n`)) response.destroy();
    }
  }

  private async start(): Promise<void> {
    this.ownerToken = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(error instanceof ApiError ? error.status : 500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;
    server.maxConnections = 32;
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); }); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("Could not allocate a loopback API port"); }
    this.server = server;
    this.url = `http://127.0.0.1:${address.port}`;
    try { this.save("connection.json", { schemaVersion: 1, url: this.url, token: this.ownerToken, pid: process.pid }); }
    catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.url = null;
    this.ownerToken = "";
    for (const response of this.streams.keys()) response.destroy();
    this.streams.clear();
    if (server) await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    rmSync(this.connectionFile, { force: true });
  }
}
