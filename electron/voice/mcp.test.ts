import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { VoiceBridge, type VoiceBridgeSnapshot } from "../services/voiceBridge";
import {
  VOICE_AGENT_INSTRUCTIONS,
  type VoiceSpeakRequest,
} from "../../src/voice";

const SCRIPT = resolve(import.meta.dir, "delulu-voice-mcp.mjs");
// Agents run the script with Node; fall back to this runtime when absent.
const NODE =
  spawnSync("node", ["--version"]).status === 0 ? "node" : process.execPath;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function bridge(snapshot: Partial<VoiceBridgeSnapshot> = {}) {
  const root = mkdtempSync(join(tmpdir(), "delulu-voice-mcp-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: Array<[VoiceSpeakRequest, boolean]> = [];
  let stops = 0;
  const server = new VoiceBridge({
    directory: join(root, "voice"),
    appVersion: "0.17.0",
    onStatus: () => undefined,
    handlers: {
      speak: async (request, wait) => {
        calls.push([request, wait]);
        if (request.text.includes("fail"))
          throw new Error("Voice is turned off in Delulu Talks.");
        return wait
          ? {
              id: "u",
              outcome: "spoken",
              durationMs: 4200,
              timestamps: [],
              warnings: ["Unknown tag [dance] was skipped"],
              unsupported: ["[laugh]"],
            }
          : { id: "u", position: 2 };
      },
      stop: async () => {
        stops++;
      },
      status: () => ({
        enabled: true,
        ready: true,
        engine: "chatterbox-turbo",
        speaking: true,
        queued: 1,
        message: "Speaking for Claude Code",
        ...snapshot,
      }),
    },
  });
  await server.start();
  cleanup.push(() => server.stop());
  return {
    calls,
    stops: () => stops,
    env: {
      ...process.env,
      DELULU_VOICE_BRIDGE: join(root, "voice", "bridge.json"),
    },
  };
}

function cli(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(NODE, [SCRIPT, ...args], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("close", (code) => done({ code, stdout, stderr }));
      child.stdin.end(input ?? "");
    },
  );
}

function mcp(env: NodeJS.ProcessEnv) {
  const child = spawn(NODE, [SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => {
    child.kill();
  });
  const responses = new Map<unknown, (value: any) => void>();
  const received: any[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    received.push(message);
    responses.get(message.id)?.(message);
  });
  let next = 1;
  return {
    received,
    raw: (line: string) => child.stdin.write(line + "\n"),
    notify: (method: string, params?: unknown) =>
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      ),
    request: (method: string, params?: unknown): Promise<any> => {
      const id = next++;
      const reply = new Promise((resolve) => responses.set(id, resolve));
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      return reply;
    },
  };
}

test("MCP server initializes from the bridge and exposes the voice tools", async () => {
  const { env, calls, stops } = await bridge();
  const server = mcp(env);
  const init = await server.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  expect(init.result).toEqual({
    protocolVersion: "2025-03-26",
    capabilities: { tools: {} },
    serverInfo: {
      name: "delulu-voice",
      title: "Delulu Voice",
      version: "0.17.0",
    },
    instructions: VOICE_AGENT_INSTRUCTIONS,
  });
  server.notify("notifications/initialized");
  expect((await server.request("ping")).result).toEqual({});

  const tools = (await server.request("tools/list")).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
    "speak",
    "stop_speaking",
    "voice_status",
  ]);
  const speak = tools[0];
  expect(speak.inputSchema.required).toEqual(["text"]);
  for (const tag of [
    "[laugh]",
    "[clear-throat]",
    "[long-pause]",
    "<whisper>",
    "<emphasis>",
  ])
    expect(speak.description).toContain(tag);

  const queued = await server.request("tools/call", {
    name: "speak",
    arguments: {
      text: "Done, all tests pass. [chuckle]",
      agent: "Claude Code",
    },
  });
  expect(queued.result).toEqual({
    content: [{ type: "text", text: "Queued (position 2)." }],
  });
  const waited = await server.request("tools/call", {
    name: "speak",
    arguments: { text: "Done.", wait: true, interrupt: true },
  });
  expect(waited.result.content[0].text).toBe(
    "Spoken (4.2 s). Markup warnings: Unknown tag [dance] was skipped. Skipped by this voice: [laugh].",
  );
  expect(calls).toEqual([
    [
      {
        text: "Done, all tests pass. [chuckle]",
        source: "agent",
        agent: "Claude Code",
      },
      false,
    ],
    [{ text: "Done.", source: "agent", agent: "Agent", interrupt: true }, true],
  ]);

  const refused = await server.request("tools/call", {
    name: "speak",
    arguments: { text: "this will fail" },
  });
  expect(refused.result).toEqual({
    content: [{ type: "text", text: "Voice is turned off in Delulu Talks." }],
    isError: true,
  });

  const stopped = await server.request("tools/call", {
    name: "stop_speaking",
    arguments: {},
  });
  expect(stopped.result.content[0].text).toBe(
    "Stopped speaking and cleared the queue.",
  );
  expect(stops()).toBe(1);
  const status = await server.request("tools/call", { name: "voice_status" });
  expect(status.result.content[0].text).toBe(
    "Voice is on and Chatterbox Turbo is ready. Speaking now. 1 message queued. Speaking for Claude Code",
  );
});

test("MCP errors use JSON-RPC codes", async () => {
  const { env } = await bridge();
  const server = mcp(env);
  const init = await server.request("initialize", {
    protocolVersion: "1999-01-01",
  });
  expect(init.result.protocolVersion).toBe("2025-06-18");
  expect((await server.request("resources/list")).error.code).toBe(-32601);
  expect(
    (
      await server.request("tools/call", {
        name: "speak",
        arguments: { text: "" },
      })
    ).error.code,
  ).toBe(-32602);
  expect(
    (
      await server.request("tools/call", {
        name: "speak",
        arguments: { text: "Hi", wait: "no" },
      })
    ).error.code,
  ).toBe(-32602);
  expect(
    (await server.request("tools/call", { name: "sing", arguments: {} })).error
      .code,
  ).toBe(-32602);
  server.raw("{oops");
  while (!server.received.some((message) => message.error?.code === -32700))
    await Bun.sleep(5);
});

test("MCP server still initializes when Delulu Talks is not running", async () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-voice-mcp-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const server = mcp({
    ...process.env,
    DELULU_VOICE_BRIDGE: join(root, "bridge.json"),
  });
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
  });
  expect(init.result.serverInfo.version).toBe("1");
  expect(init.result.instructions).toContain("Delulu Talks was not reachable");
  const speak = await server.request("tools/call", {
    name: "speak",
    arguments: { text: "Hi" },
  });
  expect(speak.result).toEqual({
    content: [
      {
        type: "text",
        text: "Delulu Talks isn't running, or agent voice is turned off in its Voice page.",
      },
    ],
    isError: true,
  });
});

test("CLI says, reads stdin, stops and reports status", async () => {
  const { env, calls, stops } = await bridge({
    speaking: false,
    queued: 0,
    message: "",
  });
  expect(
    await cli(["say", "--agent", "Codex", "Build", "is", "green."], env),
  ).toEqual({
    code: 0,
    stdout: "Queued (position 2).\n",
    stderr: "",
  });
  const waited = await cli(
    ["say", "--wait", "--interrupt", "-"],
    env,
    "From stdin [sigh]\n",
  );
  expect(waited.code).toBe(0);
  expect(waited.stdout).toStartWith("Spoken (4.2 s).");
  expect(calls).toEqual([
    [{ text: "Build is green.", source: "agent", agent: "Codex" }, false],
    [
      {
        text: "From stdin [sigh]\n",
        source: "agent",
        agent: "Agent",
        interrupt: true,
      },
      true,
    ],
  ]);
  expect(await cli(["stop"], env)).toMatchObject({
    code: 0,
    stdout: "Stopped speaking.\n",
  });
  expect(stops()).toBe(1);
  expect((await cli(["status"], env)).stdout).toBe(
    "Voice is on and Chatterbox Turbo is ready.\n",
  );
  expect((await cli(["--help"], env)).stdout).toContain("Usage:");
  const unknown = await cli(["sing"], env);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Unknown command: sing");
  expect((await cli(["say"], env)).stderr).toBe("Nothing to say.\n");
});

test("CLI explains when Delulu Talks is not running", async () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-voice-mcp-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const result = await cli(["say", "Hello"], {
    ...process.env,
    DELULU_VOICE_BRIDGE: join(root, "bridge.json"),
  });
  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr:
      "Delulu Talks isn't running, or agent voice is turned off in its Voice page.\n",
  });
});
