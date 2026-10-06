import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type {
  AppSettings,
  DictationStatus,
  RecorderCommand,
  TranscriptRecord,
} from "../../src/types";
import type { AsrService } from "./asr";
import type { DesktopPasteAdapter } from "./desktopAdapters";
import type { StorageService } from "./storage";
import { DictationService } from "./dictation";
import { ClipboardCopyError } from "./paste";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides: Partial<AppSettings> = {}) {
  let settings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
  const cacheDirectory = mkdtempSync(join(tmpdir(), "dictation-unit-"));
  const commands: RecorderCommand[] = [];
  const records: TranscriptRecord[] = [];
  const deliveries: string[] = [];
  const calls: { settings: AppSettings; audio: Uint8Array }[] = [];
  let status: DictationStatus = {
    phase: "idle",
    engine: "ready",
    message: "Ready",
  };
  let inference = async () => ({
    text: "Ship the release.",
    recognizedLanguage: "en",
  });
  let deliveryError: Error | null = null;
  const recovery: boolean[] = [];
  const asr = {
    getStatus: () => status,
    setActivity: (phase: DictationStatus["phase"], message: string) => {
      status = { ...status, phase, message };
    },
    setRecovery: (available: boolean) => recovery.push(available),
    transcribe: async (input: { audioPath: string }, captured: AppSettings) => {
      calls.push({
        settings: structuredClone(captured),
        audio: new Uint8Array(readFileSync(input.audioPath)),
      });
      return inference();
    },
    rewriteMagic: async () => {
      throw new Error("Writing model unavailable");
    },
  } as unknown as AsrService;
  const paste = {
    copy: (text: string) => deliveries.push(text),
    paste: async (text: string) => {
      deliveries.push(text);
      if (deliveryError) throw deliveryError;
      return "fake-paste";
    },
  } as unknown as DesktopPasteAdapter;
  const service = new DictationService(
    {
      cacheDirectory,
      getSettings: () => settings,
      addHistory: (record: TranscriptRecord) => records.push(record),
      findHistory: (id: string) => records.find((r) => r.id === id),
      replaceHistory: (record: TranscriptRecord) => {
        records[records.findIndex((r) => r.id === record.id)] = record;
      },
    } as unknown as StorageService,
    asr,
    paste,
    {
      main: () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (_channel: string, command: RecorderCommand) =>
              commands.push(command),
          },
        }) as never,
      pill: {
        method: "unavailable",
        detail: "Fake indicator",
        prepare() {},
        shutdown() {},
        hide() {},
        show() {},
        level() {},
      },
    },
    () => {},
    undefined,
    undefined,
    () => ({ state: "granted", canRequestCapture: true, detail: "Allowed" }),
  );
  service.recorderAvailable();
  cleanups.push(() => {
    service.releaseRetryAudio();
    rmSync(cacheDirectory, { recursive: true, force: true });
  });
  function start() {
    service.start();
    const command = commands.at(-1)!;
    if (command.action !== "start" || !command.sessionId)
      throw new Error("Capture did not start");
    return command.sessionId;
  }
  function recording() {
    const sessionId = start();
    service.recordingStarted(sessionId);
    service.stop();
    return { sessionId, durationMs: 1200, wav: new Uint8Array(64).fill(9) };
  }
  return {
    service,
    asr,
    paste,
    commands,
    records,
    deliveries,
    calls,
    recovery,
    cacheDirectory,
    start,
    recording,
    settings: (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
    },
    inference: (fn: typeof inference) => {
      inference = fn;
    },
    deliveryError: (error: Error) => {
      deliveryError = error;
    },
  };
}

test("release before microphone opens stops that capture; stale and duplicate submissions never deliver", async () => {
  const f = fixture();
  const old = f.start();
  f.service.stop();
  expect(f.commands.map((c) => c.action)).toEqual(["start"]);
  f.service.recordingStarted("foreign");
  f.service.recordingStarted(old);
  expect(f.commands.at(-1)).toMatchObject({ action: "stop", sessionId: old });
  f.service.cancel();
  const recording = f.recording();
  const result = deferred<{ text: string; recognizedLanguage: string }>();
  f.inference(() => result.promise);
  await f.service.submitRecording({ ...recording, sessionId: old });
  const submission = f.service.submitRecording(recording);
  await f.service.submitRecording(recording);
  result.resolve({ text: "Exactly once.", recognizedLanguage: "en" });
  await submission;
  expect(f.calls).toHaveLength(1);
  expect(f.deliveries).toEqual(["Exactly once."]);
  expect(f.records).toHaveLength(1);
  expect(readdirSync(f.cacheDirectory)).toEqual([]);
});

test("failed inference retains owned audio and captured settings for one successful retry", async () => {
  const f = fixture({ language: "en" });
  f.inference(async () => {
    throw new Error("Worker crashed");
  });
  const recording = f.recording();
  await f.service.submitRecording(recording);
  expect(f.deliveries).toEqual([]);
  expect(f.recovery.at(-1)).toBe(true);
  expect(readdirSync(f.cacheDirectory)).toEqual([]);
  recording.wav.fill(0);
  f.settings({ language: "nl" });
  f.inference(async () => ({
    text: "Recovered words.",
    recognizedLanguage: "en",
  }));
  await f.service.retry();
  expect(f.calls.map((c) => c.settings.language)).toEqual(["en", "en"]);
  expect(Array.from(f.calls[1].audio)).toEqual(new Array(64).fill(9));
  expect(f.deliveries).toEqual(["Recovered words."]);
  expect(f.recovery.at(-1)).toBe(false);
  await expect(f.service.retry()).rejects.toThrow("No failed recording");
  expect(readdirSync(f.cacheDirectory)).toEqual([]);
});

test("paste failures report clipboard truth and never offer audio retry that could duplicate delivery", async () => {
  for (const [error, state] of [
    [new Error("Injector denied"), "copied"],
    [new ClipboardCopyError("Clipboard denied"), "transcribed"],
  ] as const) {
    const f = fixture();
    f.deliveryError(error);
    await f.service.submitRecording(f.recording());
    expect(f.records[0].delivery?.state).toBe(state);
    expect(f.records[0].delivery?.detail).toBe(error.message);
    expect(f.deliveries).toEqual(["Ship the release."]);
    await expect(f.service.retry()).rejects.toThrow("No failed recording");
  }
});

test("rewrite failure holds spoken corrections for review but lets ordinary polishing fall back to the transcript", async () => {
  for (const preset of ["spoken-corrections", "clean"] as const) {
    const f = fixture({
      magicEnabled: true,
      magicPreset: preset === "clean" ? "polish" : preset,
    });
    await f.service.submitRecording(f.recording());
    expect(f.records[0].text).toBe("Ship the release.");
    expect(f.deliveries).toEqual(
      preset === "spoken-corrections" ? [] : ["Ship the release."],
    );
    expect(f.records[0].delivery?.state).toBe(
      preset === "spoken-corrections" ? "transcribed" : "paste-attempted",
    );
  }
});

test("a privacy change during inference prevents persistence while capture settings still govern delivery", async () => {
  const f = fixture({
    keepHistory: true,
    autoPaste: false,
    copyToClipboard: true,
  });
  const result = deferred<{ text: string; recognizedLanguage: string }>();
  f.inference(() => result.promise);
  const processing = f.service.submitRecording(f.recording());
  f.settings({ keepHistory: false, autoPaste: true });
  result.resolve({ text: "Private words.", recognizedLanguage: "en" });
  await processing;
  expect(f.records[0].sessionOnly).toBe(true);
  expect(f.records[0].delivery?.state).toBe("copied");
  expect(f.deliveries).toEqual(["Private words."]);
});

test("audio the renderer submits while paused is transcribed exactly once", async () => {
  const f = fixture();
  const sessionId = f.start();
  f.service.recordingStarted(sessionId);
  f.service.pause();
  f.service.recordingPauseChanged(sessionId, true);
  // The recording limit or a lost input stops the renderer on its own.
  f.service.recordingLimitReached(sessionId);
  await f.service.submitRecording({
    sessionId,
    durationMs: 1200,
    wav: new Uint8Array(64).fill(9),
  });
  expect(f.deliveries).toEqual(["Ship the release."]);
  expect(f.asr.getStatus().phase).toBe("idle");
});

test("presses during paste or processing never throw", async () => {
  const f = fixture();
  (f.paste as unknown as { isBusy: boolean }).isBusy = true;
  expect(() => f.service.start()).not.toThrow();
  expect(f.commands).toHaveLength(0);
  (f.paste as unknown as { isBusy: boolean }).isBusy = false;
  const result = deferred<{ text: string; recognizedLanguage: string }>();
  f.inference(() => result.promise);
  const submission = f.service.submitRecording(f.recording());
  expect(() => f.service.toggle()).not.toThrow();
  result.resolve({ text: "Done.", recognizedLanguage: "en" });
  await submission;
  expect(f.commands.filter((c) => c.action === "start")).toHaveLength(1);
});

test("silence is not a failure and keeps earlier retry audio", async () => {
  const f = fixture();
  f.inference(async () => ({ text: "   ", recognizedLanguage: "en" }));
  await f.service.submitRecording(f.recording());
  expect(f.records).toHaveLength(0);
  expect(f.deliveries).toEqual([]);
  expect(f.asr.getStatus()).toMatchObject({
    phase: "idle",
    message: "No speech detected — nothing was typed.",
  });
  expect(f.recovery.includes(true)).toBe(false);
});

test("a quick tap reports a short recording, not a microphone error", () => {
  const f = fixture();
  const sessionId = f.start();
  f.service.recordingFailed(
    "Recording too short — nothing was recorded.",
    sessionId,
  );
  expect(f.asr.getStatus().phase).toBe("idle");
  expect(f.service.isActive).toBe(false);
});

test("live typing pastes while recording and saves one transcript without pasting again", async () => {
  const f = fixture({
    liveTyping: true,
    autoPaste: true,
    magicEnabled: false,
    shortcutMode: "toggle",
  });
  const sent: string[] = [];
  const deltas = ["Ship ", "the ", "release"];
  Object.assign(f.asr, {
    liveStart: async () => true,
    liveAudio: async (_rate: number, pcm: string) => {
      sent.push(pcm);
      return deltas.shift() ?? "";
    },
    liveFinish: async () => ".",
    getStatus: () => ({ phase: "idle", engine: "ready", message: "Ready" }),
  });
  Object.assign(f.paste, {
    capabilities: () => ({ pasteMethod: "portal" }),
  });
  const sessionId = f.start();
  expect(f.commands.at(-1)).toMatchObject({ action: "start", live: true });
  f.service.recordingStarted(sessionId);
  for (const pcm of ["a", "b", "c"])
    f.service.recordingStream(sessionId, 48_000, pcm);
  f.service.recordingStream("foreign", 48_000, "x");
  f.service.stop();
  await f.service.submitRecording({
    sessionId,
    durationMs: 1200,
    wav: new Uint8Array(64).fill(9),
  });
  expect(sent).toEqual(["a", "b", "c"]);
  expect(f.deliveries.join("")).toBe("Ship the release.");
  expect(f.calls).toHaveLength(0);
  expect(f.records).toHaveLength(1);
  expect(f.records[0].text).toBe("Ship the release.");
  expect(f.records[0].delivery?.method).toBe("live");
});

test("live typing is off when rewriting must see the whole transcript", () => {
  const f = fixture({ liveTyping: true, autoPaste: true, magicEnabled: true });
  Object.assign(f.asr, { liveStart: async () => true });
  Object.assign(f.paste, { capabilities: () => ({ pasteMethod: "portal" }) });
  f.start();
  expect(f.commands.at(-1)).toMatchObject({ action: "start", live: false });
});

test("live fallback waits for clipboard failure and never claims the transcript was copied", async () => {
  const f = fixture({
    liveTyping: true,
    autoPaste: true,
    magicEnabled: false,
    shortcutMode: "toggle",
  });
  Object.assign(f.asr, {
    liveStart: async () => true,
    liveAudio: async () => "Hello ",
    liveFinish: async () => {
      throw new Error("Stream interrupted");
    },
  });
  Object.assign(f.paste, {
    capabilities: () => ({ pasteMethod: "portal" }),
    copy: async () => {
      throw new Error("Clipboard unavailable");
    },
  });
  const sessionId = f.start();
  f.service.recordingStarted(sessionId);
  f.service.recordingStream(sessionId, 48_000, "audio");
  // Let the live delivery complete before the stream failure.
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.service.stop();
  await f.service.submitRecording({
    sessionId,
    durationMs: 1200,
    wav: new Uint8Array(64).fill(9),
  });
  expect(f.records.at(-1)?.delivery?.state).toBe("transcribed");
  expect(f.asr.getStatus().message).toContain("clipboard copy failed");
  expect(f.asr.getStatus().message).not.toContain("was copied");
});

test("holding a shortcut never injects live paste keys before release, even with live typing enabled", async () => {
  const f = fixture({
    shortcutMode: "hold",
    liveTyping: true,
    autoPaste: true,
    magicEnabled: false,
  });
  let streamsStarted = 0;
  Object.assign(f.asr, {
    liveStart: async () => {
      streamsStarted++;
      return true;
    },
    liveAudio: async () => "Premature paste",
  });
  Object.assign(f.paste, { capabilities: () => ({ pasteMethod: "portal" }) });
  const sessionId = f.start();
  f.service.recordingStarted(sessionId);
  for (let seconds = 0; seconds < 20; seconds++) {
    f.service.recordingStream(sessionId, 48_000, "audio");
    await Promise.resolve();
  }
  expect(f.commands.at(-1)).toMatchObject({ action: "start", live: false });
  expect(streamsStarted).toBe(0);
  expect(f.deliveries).toEqual([]);
  expect(f.service.isActive).toBe(true);
  f.service.stop();
  await f.service.submitRecording({
    sessionId,
    durationMs: 20_000,
    wav: new Uint8Array(64).fill(9),
  });
  expect(f.deliveries).toEqual(["Ship the release."]);
  expect(f.records).toHaveLength(1);
  expect(f.service.isActive).toBe(false);
});

test("Redux buffers CPU dictation even when a legacy profile enables live typing", async () => {
  const f = fixture({
    speechEngine: "redux",
    liveTyping: true,
    autoPaste: true,
    shortcutMode: "toggle",
  });
  Object.assign(f.asr, {
    liveStart: async () => {
      throw new Error("Redux must not start a stream");
    },
  });
  Object.assign(f.paste, { capabilities: () => ({ pasteMethod: "portal" }) });
  const sessionId = f.start();
  expect(f.commands.at(-1)).toMatchObject({ action: "start", live: false });
  f.service.recordingStarted(sessionId);
  f.service.stop();
  await f.service.submitRecording({
    sessionId,
    durationMs: 1200,
    wav: new Uint8Array(64).fill(9),
  });
  expect(f.calls).toHaveLength(1);
  expect(f.deliveries).toEqual(["Ship the release."]);
});
