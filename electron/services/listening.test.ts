import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type { ListenCommand } from "../../src/listening";
import { isRealTurn, ListeningService, soundsLikeOwnSpeech } from "./listening";

const wav = new Uint8Array(64);

function fixture() {
  const commands: ListenCommand[] = [];
  const transcripts: string[] = [];
  let prepared = 0;
  let interrupted: string[] = [];
  const service = new ListeningService({
    settings: () => DEFAULT_SETTINGS,
    cacheDirectory: mkdtempSync(join(tmpdir(), "listen-unit-")),
    prepareSpeech: async () => {
      prepared += 1;
    },
    transcribe: async () => transcripts.shift() ?? "",
    interruptSpeech: () => interrupted,
    recentlySpoken: () => ["All two hundred tests pass and the fix is merged."],
    command: (command) => {
      commands.push(command);
      return true;
    },
  });
  const say = async (sessionId: string, text: string) => {
    transcripts.push(text);
    service.captureEvent({
      type: "utterance",
      sessionId,
      wav,
      durationMs: 1500,
      speechMs: 1200,
      overlappedPlayback: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return {
    service,
    commands,
    say,
    prepared: () => prepared,
    setInterrupted(ids: string[]) {
      interrupted = ids;
    },
  };
}

test("turns reuse one session and model; speech between waits stays queued", async () => {
  const f = fixture();
  const session = await f.service.start("claude-code");
  f.service.captureEvent({
    type: "state",
    sessionId: session.id,
    state: "listening",
  });
  expect(await f.service.start("claude-code")).toMatchObject({
    id: session.id,
  });
  expect(f.prepared()).toBe(1);
  await f.say(session.id, "First question.");
  await f.say(session.id, "And a second thing.");
  const first = await f.service.next(session.id, { timeoutMs: 1000 });
  expect(first.status === "event" && first.event).toMatchObject({
    seq: 1,
    text: "First question.",
  });
  // A retry without advancing the cursor gets the same event again.
  const retry = await f.service.next(session.id, { timeoutMs: 1000 });
  expect(retry.status === "event" && retry.event.seq).toBe(1);
  const second = await f.service.next(session.id, {
    after: 1,
    timeoutMs: 1000,
  });
  expect(second.status === "event" && second.event).toMatchObject({
    seq: 2,
    text: "And a second thing.",
  });
  expect(f.commands.filter((c) => c.action === "start")).toHaveLength(1);
});

test("timeouts and cancelled waiters keep capture running and lose nothing", async () => {
  const f = fixture();
  const session = await f.service.start("agent");
  const timedOut = await f.service.next(session.id, { timeoutMs: 10 });
  expect(timedOut.status).toBe("timeout");
  const abort = new AbortController();
  const waiting = f.service.next(session.id, {
    timeoutMs: 10_000,
    signal: abort.signal,
  });
  abort.abort();
  expect((await waiting).status).toBe("timeout");
  await f.say(session.id, "Are you still there?");
  expect(f.service.active).toBe(true);
  expect(f.commands.some((c) => c.action === "stop")).toBe(false);
  const next = await f.service.next(session.id, { timeoutMs: 1000 });
  expect(next.status === "event" && next.event.type).toBe("utterance");
});

test("a waiter wakes when the utterance arrives", async () => {
  const f = fixture();
  const session = await f.service.start("agent");
  const waiting = f.service.next(session.id, { timeoutMs: 5000 });
  await f.say(session.id, "Ship it.");
  const result = await waiting;
  expect(result.status === "event" && result.event).toMatchObject({
    text: "Ship it.",
  });
});

test("noise, fillers and Delulu's own words never become turns", async () => {
  const f = fixture();
  const session = await f.service.start("agent");
  await f.say(session.id, "");
  await f.say(session.id, "Um.");
  await f.say(session.id, "All two hundred tests pass.");
  expect(f.service.status(session.id)?.queued).toBe(0);
  expect(isRealTurn("Hmm, uh")).toBe(false);
  expect(isRealTurn("No.")).toBe(true);
  expect(soundsLikeOwnSpeech("the fix is merged", ["The fix is merged."])).toBe(
    true,
  );
});

test("barge-in reports the response, then the utterance that interrupted it", async () => {
  const f = fixture();
  const session = await f.service.start("agent");
  f.setInterrupted(["rsp_1"]);
  f.service.captureEvent({
    type: "bargeIn",
    sessionId: session.id,
    utteranceIds: [],
  });
  // Even words Delulu just said count when the user deliberately interrupted.
  await f.say(session.id, "Wait, the fix is merged?");
  const interrupted = await f.service.next(session.id, { timeoutMs: 1000 });
  expect(interrupted.status === "event" && interrupted.event).toMatchObject({
    type: "interrupted",
    responseId: "rsp_1",
  });
  const utterance = await f.service.next(session.id, {
    after: 1,
    timeoutMs: 1000,
  });
  expect(utterance.status === "event" && utterance.event).toMatchObject({
    type: "utterance",
    interruptedResponseId: "rsp_1",
  });
});

test("other clients cannot take or read a running session", async () => {
  const f = fixture();
  const session = await f.service.start("claude-code");
  await expect(f.service.start("codex")).rejects.toThrow(/already listening/);
  expect(() => f.service.next("lsn_other", { timeoutMs: 10 })).toThrow(
    /does not exist/,
  );
  await f.service.stop(session.id);
  const second = await f.service.start("codex");
  expect(second.id).not.toBe(session.id);
});

test("stopping releases capture and resolves waiters", async () => {
  const f = fixture();
  const session = await f.service.start("agent");
  const waiting = f.service.next(session.id, { timeoutMs: 10_000 });
  await f.service.stop(session.id);
  const result = await waiting;
  expect(result.status === "event" && result.event.type).toBe("stopped");
  expect(f.commands.at(-1)).toMatchObject({ action: "stop" });
  expect(f.service.active).toBe(false);
  const after = await f.service.next(session.id, {
    after: result.status === "event" ? result.event.seq : 0,
    timeoutMs: 1000,
  });
  expect(after.status).toBe("stopped");
});
