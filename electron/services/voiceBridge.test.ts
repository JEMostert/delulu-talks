import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installVoiceAgentScript,
  VoiceBridge,
  VoiceBridgeError,
  voiceAgentScriptSource,
  voiceAgentSetup,
  type VoiceBridgeHandlers,
  type VoiceBridgeSnapshot,
} from "./voiceBridge";
import { fakeListen } from "../voice/fakeListen";
import {
  VOICE_AGENT_INSTRUCTIONS,
  type VoiceBridgeStatus,
  type VoiceSpeakRequest,
} from "../../src/voice";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const snapshot: VoiceBridgeSnapshot = {
  enabled: true,
  ready: true,
  engine: "kokoro",
  speaking: false,
  queued: 0,
  message: "Ready",
};

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "delulu-voice-bridge-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

type Calls = { speak: [VoiceSpeakRequest, boolean][]; stops: number };

async function started(
  handlers: Partial<VoiceBridgeHandlers> = {},
  root = directory(),
) {
  const calls: Calls = { speak: [], stops: 0 };
  const statuses: VoiceBridgeStatus[] = [];
  const bridge = new VoiceBridge({
    directory: join(root, "voice"),
    appVersion: "9.9.9",
    onStatus: (status) => statuses.push(status),
    handlers: {
      speak: async (request, wait) => {
        calls.speak.push([request, wait]);
        return wait
          ? {
              id: "u1",
              responseId: "r1",
              outcome: "spoken",
              durationMs: 4200,
              timestamps: [],
              warnings: [],
              unsupported: [],
            }
          : { id: "u1", responseId: "r1", position: 1 };
      },
      stop: async () => {
        calls.stops++;
      },
      status: () => snapshot,
      ...fakeListen().handlers,
      ...handlers,
    },
  });
  await bridge.start();
  cleanup.push(() => bridge.stop());
  const file = JSON.parse(
    readFileSync(join(root, "voice", "bridge.json"), "utf8"),
  ) as { endpoint: string; token: string; protocol: number };
  return { bridge, calls, statuses, file, root };
}

/** A line-oriented client that collects responses by id. */
async function client(endpoint: string) {
  const socket: Socket = connect(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  const lines: any[] = [];
  const waiters: Array<() => void> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  cleanup.push(() => {
    socket.destroy();
  });
  const next = async (predicate: (line: any) => boolean = () => true) => {
    for (;;) {
      const index = lines.findIndex(predicate);
      if (index >= 0) return lines.splice(index, 1)[0];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return {
    socket,
    closed,
    send: (value: unknown) => socket.write(JSON.stringify(value) + "\n"),
    raw: (text: string) => socket.write(text),
    next,
    response: (id: string) => next((line) => line.id === id),
  };
}

test("bridge.json is private, published after listening and removed on stop", async () => {
  if (process.platform === "win32") return;
  const { bridge, file, root, statuses } = await started();
  const path = join(root, "voice", "bridge.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "voice")).mode & 0o777).toBe(0o700);
  expect(file.protocol).toBe(1);
  expect(file.token).toMatch(/^[0-9a-f]{64}$/);
  expect(file.endpoint).toBe(join(root, "voice", "agent.sock"));
  expect(lstatSync(file.endpoint).isSocket()).toBe(true);
  expect(statSync(file.endpoint).mode & 0o777).toBe(0o600);
  expect(bridge.status).toMatchObject({
    enabled: true,
    listening: true,
    clients: 0,
    endpoint: file.endpoint,
    error: null,
  });
  await bridge.start();
  expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(file.token);
  await bridge.stop();
  expect(existsSync(path)).toBe(false);
  expect(existsSync(file.endpoint)).toBe(false);
  expect(bridge.status).toEqual({
    enabled: false,
    listening: false,
    clients: 0,
    endpoint: null,
    error: null,
  });
  expect(statuses.at(-1)?.listening).toBe(false);
});

test("each start issues a new token", async () => {
  const { bridge, file, root } = await started();
  await bridge.stop();
  await bridge.start();
  const next = JSON.parse(
    readFileSync(join(root, "voice", "bridge.json"), "utf8"),
  );
  expect(next.token).not.toBe(file.token);
});

test("requests without the current token are refused", async () => {
  const { file, calls } = await started();
  const agent = await client(file.endpoint);
  agent.send({
    v: 1,
    id: "a",
    method: "speak",
    params: { text: "Hi" },
  });
  agent.send({
    v: 1,
    id: "b",
    token: "0".repeat(64),
    method: "speak",
    params: { text: "Hi" },
  });
  agent.send({ v: 1, id: "c", token: 42, method: "status" });
  for (const id of ["a", "b", "c"])
    expect((await agent.response(id)).error.code).toBe("UNAUTHORIZED");
  expect(calls.speak).toHaveLength(0);
});

test("hello, speak, stop and status round trip", async () => {
  const { file, calls } = await started();
  const agent = await client(file.endpoint);
  const request = (id: string, method: string, params?: unknown) =>
    agent.send({ v: 1, id, token: file.token, method, params });

  request("h", "hello");
  expect(await agent.response("h")).toEqual({
    v: 1,
    id: "h",
    ok: true,
    result: {
      app: "delulu-talks",
      appVersion: "9.9.9",
      protocol: 1,
      instructions: VOICE_AGENT_INSTRUCTIONS,
      status: snapshot,
    },
  });

  request("q", "speak", { text: "Done. [laugh]", agent: "  Claude Code  " });
  expect((await agent.response("q")).result).toEqual({
    id: "u1",
    responseId: "r1",
    position: 1,
  });
  request("w", "speak", {
    text: "Done.",
    wait: true,
    interrupt: true,
    normalize: false,
  });
  expect((await agent.response("w")).result).toMatchObject({
    outcome: "spoken",
    durationMs: 4200,
  });
  expect(calls.speak).toEqual([
    [{ text: "Done. [laugh]", source: "agent", agent: "Claude Code" }, false],
    [
      {
        text: "Done.",
        source: "agent",
        agent: "Agent",
        interrupt: true,
        normalize: false,
      },
      true,
    ],
  ]);

  request("s", "stop");
  expect((await agent.response("s")).result).toEqual({ stopped: true });
  expect(calls.stops).toBe(1);
  request("t", "status", {});
  expect((await agent.response("t")).result).toEqual(snapshot);
});

test("invalid requests get specific errors without reaching handlers", async () => {
  const { file, calls } = await started();
  const agent = await client(file.endpoint);
  const send = (value: Record<string, unknown>) =>
    agent.send({ v: 1, token: file.token, ...value });

  agent.raw("{not json\n");
  expect((await agent.next()).error).toEqual({
    code: "INVALID_REQUEST",
    message: "Request is not valid JSON.",
  });
  agent.send({ v: 2, id: "v", token: file.token, method: "status" });
  expect((await agent.response("v")).error.code).toBe("INVALID_REQUEST");
  send({ id: "x".repeat(129), method: "status" });
  expect((await agent.next((line) => line.id === null)).error.code).toBe(
    "INVALID_REQUEST",
  );
  send({ id: "m", method: "dance" });
  expect((await agent.response("m")).error.message).toBe(
    "Unknown method: dance",
  );
  send({ id: "p", method: "speak", params: ["Hi"] });
  expect((await agent.response("p")).error.code).toBe("INVALID_REQUEST");
  send({ id: "e", method: "speak", params: { text: "   " } });
  expect((await agent.response("e")).error.code).toBe("INVALID_REQUEST");
  send({ id: "l", method: "speak", params: { text: "a".repeat(15_001) } });
  expect((await agent.response("l")).error.message).toContain("15,000");
  send({ id: "b", method: "speak", params: { text: "Hi", wait: "yes" } });
  expect((await agent.response("b")).error.message).toBe(
    "wait must be a boolean",
  );
  send({ id: "g", method: "speak", params: { text: "Hi", agent: 7 } });
  expect((await agent.response("g")).error.code).toBe("INVALID_REQUEST");
  expect(calls.speak).toHaveLength(0);
  // The connection survives malformed input.
  send({ id: "ok", method: "status" });
  expect((await agent.response("ok")).ok).toBe(true);
});

test("handler refusals reach the agent as VOICE_UNAVAILABLE", async () => {
  const { file } = await started({
    speak: async () => {
      throw new Error("Voice is turned off in Delulu Talks.");
    },
    stop: async () => {
      throw new VoiceBridgeError("INVALID_REQUEST", "Nothing to stop.");
    },
  });
  const agent = await client(file.endpoint);
  agent.send({
    v: 1,
    id: "s",
    token: file.token,
    method: "speak",
    params: { text: "Hi" },
  });
  expect((await agent.response("s")).error).toEqual({
    code: "VOICE_UNAVAILABLE",
    message: "Voice is turned off in Delulu Talks.",
  });
  agent.send({ v: 1, id: "t", token: file.token, method: "stop" });
  expect((await agent.response("t")).error.code).toBe("INVALID_REQUEST");
});

test("responses may complete out of order and in-flight requests are capped", async () => {
  const releases: Array<() => void> = [];
  const { file } = await started({
    speak: (request) =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            id: request.text,
            responseId: "r1",
            position: Number(request.text),
          }),
        );
      }),
  });
  const agent = await client(file.endpoint);
  for (const id of ["1", "2", "3", "4", "5"])
    agent.send({
      v: 1,
      id,
      token: file.token,
      method: "speak",
      params: { text: id },
    });
  expect((await agent.response("5")).error.message).toContain("At most 4");
  while (releases.length < 4) await Bun.sleep(5);
  releases[3]();
  expect((await agent.response("4")).result).toEqual({
    id: "4",
    responseId: "r1",
    position: 4,
  });
  releases[0]();
  expect((await agent.response("1")).result.position).toBe(1);
  releases[1]();
  releases[2]();
  await agent.response("2");
  await agent.response("3");
});

test("an oversized request line closes the connection with an error", async () => {
  const { file } = await started();
  const agent = await client(file.endpoint);
  agent.raw("x".repeat(256 * 1024 + 10));
  const line = await agent.next();
  expect(line).toMatchObject({ id: null, ok: false });
  expect(line.error.message).toContain("256 KiB");
  await agent.closed;
});

test("connections beyond the cap are refused and counted clients update", async () => {
  const { bridge, file, statuses } = await started();
  const agents = [];
  for (let index = 0; index < 16; index++)
    agents.push(await client(file.endpoint));
  while (bridge.status.clients < 16) await Bun.sleep(5);
  const extra = await client(file.endpoint);
  expect((await extra.next()).error.message).toContain("Too many");
  await extra.closed;
  expect(bridge.status.clients).toBe(16);
  expect(statuses.some((status) => status.clients === 16)).toBe(true);
  for (const agent of agents) agent.socket.destroy();
  while (bridge.status.clients > 0) await Bun.sleep(5);
});

test("stop destroys open connections", async () => {
  const { bridge, file } = await started();
  const agent = await client(file.endpoint);
  while (bridge.status.clients < 1) await Bun.sleep(5);
  await bridge.stop();
  await agent.closed;
});

test("a stale socket is replaced but a live one or a regular file is not", async () => {
  if (process.platform === "win32") return;
  const root = directory();
  const voice = join(root, "voice");
  mkdirSync(voice, { mode: 0o700 });
  const socket = join(voice, "agent.sock");
  const stale = spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.exit(0))`,
  ]);
  expect(stale.status).toBe(0);
  expect(lstatSync(socket).isSocket()).toBe(true);
  const { bridge } = await started({}, root);
  expect(bridge.status.listening).toBe(true);

  const handlers: VoiceBridgeHandlers = {
    speak: async () => ({ id: "x", responseId: "r1", position: 0 }),
    stop: async () => undefined,
    status: () => snapshot,
    ...fakeListen().handlers,
  };
  const second = new VoiceBridge({
    directory: voice,
    appVersion: "1",
    onStatus: () => undefined,
    handlers,
  });
  await expect(second.start()).rejects.toThrow("Another Delulu Talks");
  expect(second.status).toMatchObject({ listening: false, enabled: true });
  expect(second.status.error).toContain("Another Delulu Talks");
  await bridge.stop();

  writeFileSync(socket, "not a socket");
  const third = new VoiceBridge({
    directory: voice,
    appVersion: "1",
    onStatus: () => undefined,
    handlers,
  });
  await expect(third.start()).rejects.toThrow("is not a socket");
  expect(readFileSync(socket, "utf8")).toBe("not a socket");
});

test("the MCP script is installed beside bridge.json only when it changed", () => {
  const root = directory();
  const source = join(root, "source.mjs");
  writeFileSync(source, "console.log(1)\n");
  const target = installVoiceAgentScript(join(root, "voice"), source);
  expect(target).toBe(join(root, "voice", "delulu-voice-mcp.mjs"));
  expect(readFileSync(target, "utf8")).toBe("console.log(1)\n");
  const modified = statSync(target).mtimeMs;
  installVoiceAgentScript(join(root, "voice"), source);
  expect(statSync(target).mtimeMs).toBe(modified);
  writeFileSync(source, "console.log(2)\n");
  installVoiceAgentScript(join(root, "voice"), source);
  expect(readFileSync(target, "utf8")).toBe("console.log(2)\n");
});

test("the script source prefers packaged resources", () => {
  const root = directory();
  const resources = join(root, "resources");
  expect(voiceAgentScriptSource(resources, "/app", true)).toBe(
    join("/app", "electron", "voice", "delulu-voice-mcp.mjs"),
  );
  mkdirSync(join(resources, "voice"), { recursive: true });
  writeFileSync(join(resources, "voice", "delulu-voice-mcp.mjs"), "x");
  expect(voiceAgentScriptSource(resources, "/app", true)).toBe(
    join(resources, "voice", "delulu-voice-mcp.mjs"),
  );
  expect(voiceAgentScriptSource(resources, "/app", false)).toBe(
    join("/app", "electron", "voice", "delulu-voice-mcp.mjs"),
  );
});

// A POSIX PATH cannot hold Windows temp paths (their drive colon splits it).
test.skipIf(process.platform === "win32")(
  "agent setup uses Node when it is on PATH",
  () => {
    const bin = directory();
    writeFileSync(join(bin, "node"), "#!/bin/sh\n");
    chmodSync(join(bin, "node"), 0o755);
    const setup = voiceAgentSetup("/home/me/.config/delulu-talks/voice/s.mjs", {
      env: { PATH: `/nowhere:${bin}` },
      platform: "linux",
      execPath: "/opt/Delulu/delulu-talks",
    });
    expect(setup.nodeFound).toBe(true);
    expect(setup.command).toEqual([
      "node",
      "/home/me/.config/delulu-talks/voice/s.mjs",
    ]);
    expect(setup.claudeCode).toBe(
      "claude mcp add --scope user delulu-voice -- node /home/me/.config/delulu-talks/voice/s.mjs",
    );
    expect(setup.codex).toBe(
      "codex mcp add delulu-voice -- node /home/me/.config/delulu-talks/voice/s.mjs",
    );
    expect(JSON.parse(setup.json)).toEqual({
      mcpServers: {
        "delulu-voice": {
          command: "node",
          args: ["/home/me/.config/delulu-talks/voice/s.mjs"],
        },
      },
    });
    expect(setup.shell).toBe(
      "node /home/me/.config/delulu-talks/voice/s.mjs say 'Done, all tests pass.'",
    );
    expect(setup.instructions).toBe(VOICE_AGENT_INSTRUCTIONS);
  },
);

test("a non-executable node is ignored and Electron runs the script as Node", () => {
  const bin = directory();
  writeFileSync(join(bin, "node"), "");
  chmodSync(join(bin, "node"), 0o644);
  const script = "/home/me/Delulu Data/voice/delulu-voice-mcp.mjs";
  const setup = voiceAgentSetup(script, {
    env: { PATH: bin },
    platform: "linux",
    execPath: "/opt/Delulu Talks/delulu-talks",
  });
  expect(setup.nodeFound).toBe(false);
  expect(setup.command).toEqual(["/opt/Delulu Talks/delulu-talks", script]);
  expect(setup.claudeCode).toBe(
    "claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 delulu-voice -- '/opt/Delulu Talks/delulu-talks' '/home/me/Delulu Data/voice/delulu-voice-mcp.mjs'",
  );
  expect(setup.codex).toBe(
    "codex mcp add delulu-voice --env ELECTRON_RUN_AS_NODE=1 -- '/opt/Delulu Talks/delulu-talks' '/home/me/Delulu Data/voice/delulu-voice-mcp.mjs'",
  );
  expect(JSON.parse(setup.json).mcpServers["delulu-voice"]).toEqual({
    command: "/opt/Delulu Talks/delulu-talks",
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  expect(setup.shell).toBe(
    "ELECTRON_RUN_AS_NODE=1 '/opt/Delulu Talks/delulu-talks' '/home/me/Delulu Data/voice/delulu-voice-mcp.mjs' say 'Done, all tests pass.'",
  );
});

test("an AppImage registers its stable file path, not the mount", () => {
  const setup = voiceAgentSetup("/home/me/.config/delulu-talks/voice/s.mjs", {
    env: { PATH: "", APPIMAGE: "/home/me/Apps/Delulu-Talks.AppImage" },
    platform: "linux",
    execPath: "/tmp/.mount_DeluluXyz/delulu-talks",
  });
  expect(setup.command[0]).toBe("/home/me/Apps/Delulu-Talks.AppImage");
});

test("Windows setup quotes paths for PowerShell and agent CLIs", () => {
  const script = "C:\\Users\\Me\\AppData\\Roaming\\delulu-talks\\voice\\s.mjs";
  const fallback = voiceAgentSetup(script, {
    env: { Path: "" },
    platform: "win32",
    execPath: "C:\\Program Files\\Delulu Talks\\Delulu Talks.exe",
  });
  expect(fallback.nodeFound).toBe(false);
  expect(fallback.claudeCode).toBe(
    `claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 delulu-voice -- "C:\\Program Files\\Delulu Talks\\Delulu Talks.exe" "${script}"`,
  );
  expect(fallback.shell).toBe(
    `$env:ELECTRON_RUN_AS_NODE="1"; & "C:\\Program Files\\Delulu Talks\\Delulu Talks.exe" "${script}" say "Done, all tests pass."`,
  );
});

test("listening sessions deliver events after the cursor until acknowledged", async () => {
  const listen = fakeListen();
  const { file } = await started(listen.handlers);
  const agent = await client(file.endpoint);
  const request = (id: string, method: string, params = {}) => {
    agent.send({ v: 1, id, token: file.token, method, params });
    return agent.response(id);
  };
  const session = (await request("s", "listen.start", { client: "claude" }))
    .result;
  expect(session.id).toBe("ses_claude");
  // Idempotent for the same client, refused for another.
  expect(
    (await request("s2", "listen.start", { client: "claude" })).result.id,
  ).toBe(session.id);
  expect(
    (await request("s3", "listen.start", { client: "codex" })).error.code,
  ).toBe("SESSION_BUSY");

  // Speech between waits stays queued.
  listen.push({
    type: "utterance",
    id: "utt_1",
    text: "First",
    at: 1,
    durationMs: 900,
    interruptedResponseId: null,
  });
  const first = (
    await request("n1", "listen.next", {
      sessionId: session.id,
      timeoutSeconds: 5,
    })
  ).result;
  expect(first.event).toMatchObject({ seq: 1, id: "utt_1" });
  // A retry without advancing the cursor gets the same event again.
  const retry = (
    await request("n2", "listen.next", {
      sessionId: session.id,
      timeoutSeconds: 5,
    })
  ).result;
  expect(retry.event.id).toBe("utt_1");
  // Passing after acknowledges it; nothing new yet, so the wait times out.
  const empty = (
    await request("n3", "listen.next", {
      sessionId: session.id,
      after: 1,
      timeoutSeconds: 0.05,
    })
  ).result;
  expect(empty).toMatchObject({
    status: "timeout",
    session: { ackedSeq: 1, queued: 0 },
  });

  listen.push({ type: "interrupted", responseId: "rsp_9", at: 2 });
  listen.push({
    type: "utterance",
    id: "utt_2",
    text: "Wait",
    at: 3,
    durationMs: 700,
    interruptedResponseId: "rsp_9",
  });
  const interrupted = (
    await request("n4", "listen.next", {
      sessionId: session.id,
      after: 1,
      timeoutSeconds: 5,
    })
  ).result;
  expect(interrupted.event).toMatchObject({
    type: "interrupted",
    responseId: "rsp_9",
  });
  expect(
    (await request("a", "listen.ack", { sessionId: session.id, after: 2 }))
      .result.ackedSeq,
  ).toBe(2);
  expect((await request("st", "listen.status", {})).result.session.queued).toBe(
    1,
  );

  expect(
    (await request("x", "listen.next", { sessionId: "nope" })).error.code,
  ).toBe("SESSION_NOT_FOUND");
  expect(
    (await request("y", "listen.next", { sessionId: session.id, after: -1 }))
      .error.code,
  ).toBe("INVALID_REQUEST");
  expect(
    (await request("z", "speak", { text: "Hi", responseId: "bad id!" })).error
      .code,
  ).toBe("INVALID_REQUEST");

  await request("stop", "listen.stop", { sessionId: session.id });
  const stopped = (
    await request("n5", "listen.next", {
      sessionId: session.id,
      after: 3,
      timeoutSeconds: 5,
    })
  ).result;
  expect(stopped.status).toBe("stopped");
});

test("a disconnected waiter is aborted and loses nothing", async () => {
  const listen = fakeListen();
  const { file } = await started(listen.handlers);
  const owner = await client(file.endpoint);
  owner.send({
    v: 1,
    id: "s",
    token: file.token,
    method: "listen.start",
    params: {},
  });
  const session = (await owner.response("s")).result;
  const waiter = await client(file.endpoint);
  waiter.send({
    v: 1,
    id: "w",
    token: file.token,
    method: "listen.next",
    params: { sessionId: session.id, timeoutSeconds: 30 },
  });
  for (let tries = 0; listen.waiting === 0 && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(listen.waiting).toBe(1);
  waiter.socket.destroy();
  for (let tries = 0; listen.waiting > 0 && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(listen.waiting).toBe(0);
  listen.push({
    type: "utterance",
    id: "utt_1",
    text: "Still here",
    at: 1,
    durationMs: 500,
    interruptedResponseId: null,
  });
  owner.send({
    v: 1,
    id: "n",
    token: file.token,
    method: "listen.next",
    params: { sessionId: session.id, timeoutSeconds: 5 },
  });
  expect((await owner.response("n")).result.event.id).toBe("utt_1");
});
