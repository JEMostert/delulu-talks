import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type { AppSettings } from "../../src/types";
import type {
  VoicePlaybackChunk,
  VoiceSynthesizeRequest,
  VoiceSynthesizeResult,
} from "../../src/voice";
import type { StorageService } from "./storage";
import { VoiceService, type VoiceWorker } from "./voice";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fixture(
  overrides: Partial<AppSettings> = {},
  options: { durationMs?: number; autoplay?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "voice-unit-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    voiceEnabled: true,
    ...overrides,
  };
  const storage = {
    dataDirectory: directory,
    modelCacheDirectory: join(directory, "models"),
    voiceVenvDirectory: join(directory, "voice-venv"),
    voiceDirectory: join(directory, "voice"),
    getSettings: () => settings,
  } as unknown as StorageService;
  const synthesized: VoiceSynthesizeRequest[] = [];
  const played: VoicePlaybackChunk[] = [];
  const stops: (string | null)[] = [];
  const commands: string[] = [];
  const worker: VoiceWorker & { running: boolean; busy: boolean } = {
    running: false,
    busy: false,
    async request<T>(command: string, payload: Record<string, unknown> = {}) {
      commands.push(command);
      worker.running = true;
      if (command === "voiceLoad")
        return {
          loaded: true,
          model: "test",
          device: "cpu",
          residency: "resident",
          warmup: "complete",
          engine: payload.engine,
        } as T;
      if (command === "voiceSynthesize") {
        synthesized.push(payload as unknown as VoiceSynthesizeRequest);
        const result: VoiceSynthesizeResult = {
          sampleRate: 24_000,
          audio: Buffer.alloc(8).toString("base64"),
          durationMs: options.durationMs ?? 1_000,
          processingTimeMs: 5,
          engine: settings.voiceEngine,
          device: "cpu",
          unsupported: settings.voiceEngine === "kokoro" ? ["laugh"] : [],
        };
        return result as T;
      }
      return {
        loaded: false,
        model: null,
        device: null,
        residency: "unloaded",
        warmup: "not-started",
        engine: null,
      } as T;
    },
    async stopAndWait() {
      worker.running = false;
    },
  };
  const service = new VoiceService(
    storage,
    {
      play: (chunk) => {
        played.push(chunk);
        if (options.autoplay !== false) {
          queueMicrotask(() => {
            service.playbackEvent({
              utteranceId: chunk.utteranceId,
              chunk: chunk.chunk,
              event: "started",
            });
            service.playbackEvent({
              utteranceId: chunk.utteranceId,
              chunk: chunk.chunk,
              event: "ended",
            });
          });
        }
        return true;
      },
      stop: (id) => stops.push(id),
    },
    { worker, ready: async () => true },
  );
  return {
    service,
    synthesized,
    played,
    stops,
    commands,
    setSettings(patch: Partial<AppSettings>) {
      settings = { ...settings, ...patch };
    },
  };
}

test("speaks every chunk in order and reports measured timestamps", async () => {
  const { service, synthesized, played } = fixture({
    voiceEngine: "kokoro",
  });
  await service.initialize(DEFAULT_SETTINGS);
  const text = [
    "Done.",
    "All of the tests pass and the cache path fix is merged into main now.",
    "The release notes still need a line about speech models.",
    "Want me to write that line and open the pull request for you right away?",
  ].join(" ");
  const result = await service.speak({ text: `${text} [laugh]` });
  expect(result.outcome).toBe("spoken");
  expect(synthesized.length).toBeGreaterThan(1);
  expect(played.map((chunk) => chunk.chunk)).toEqual(
    synthesized.map((_, index) => index),
  );
  expect(played.at(-1)?.last).toBe(true);
  expect(result.timestamps[0].startMs).toBe(0);
  for (let index = 1; index < result.timestamps.length; index++)
    expect(result.timestamps[index].startMs).toBe(
      result.timestamps[index - 1].endMs,
    );
  expect(result.durationMs).toBe(synthesized.length * 1_000);
  expect(result.unsupported).toEqual(["laugh"]);
  expect(service.getStatus().recent[0]).toMatchObject({
    id: result.id,
    outcome: "spoken",
    source: "app",
  });
});

test("passes the voice, speed and clone reference to the worker", async () => {
  const { service, synthesized } = fixture({
    voiceEngine: "chatterbox-turbo",
    voiceClone: "clip.wav",
    voiceSpeed: 1.2,
  });
  await service.initialize(DEFAULT_SETTINGS);
  await service.speak({ text: "<whisper>Between us.</whisper>" });
  expect(synthesized[0]).toMatchObject({
    engine: "chatterbox-turbo",
    speed: 1.2,
    styles: ["whisper"],
  });
  expect(synthesized[0].reference).toEndWith(join("references", "clip.wav"));
});

test("stop ends the current utterance and everything queued", async () => {
  const { service, stops } = fixture({}, { autoplay: false });
  await service.initialize(DEFAULT_SETTINGS);
  const first = service.enqueue({ text: "First message to speak." });
  const second = service.enqueue({ text: "Second message to speak." });
  expect(second.position).toBe(1);
  await until(() => service.getStatus().current !== null, "speech start");
  service.stop();
  const [a, b] = await Promise.all([first.done, second.done]);
  expect(a.outcome).toBe("stopped");
  expect(b.outcome).toBe("stopped");
  expect(stops).toContain(null);
  await until(() => service.getStatus().current === null, "idle");
  expect(service.isSpeaking).toBe(false);
});

test("interrupting replaces what is being said", async () => {
  const { service } = fixture({}, { autoplay: false });
  await service.initialize(DEFAULT_SETTINGS);
  const first = service.enqueue({ text: "A long status update." });
  await until(() => service.getStatus().current !== null, "speech start");
  const second = service.enqueue({ text: "Urgent.", interrupt: true });
  expect((await first.done).outcome).toBe("stopped");
  await until(
    () => service.getStatus().current?.id === second.id,
    "interrupting utterance",
  );
  service.stop();
  expect((await second.done).outcome).toBe("stopped");
});

test("dictation interrupts speech only when that setting is on", async () => {
  const on = fixture({}, { autoplay: false });
  await on.service.initialize(DEFAULT_SETTINGS);
  const spoken = on.service.enqueue({ text: "Hello there." });
  await until(() => on.service.isSpeaking, "speaking");
  on.service.interruptForDictation();
  expect((await spoken.done).outcome).toBe("stopped");

  const off = fixture(
    { voiceInterruptOnDictation: false },
    { autoplay: false },
  );
  await off.service.initialize(DEFAULT_SETTINGS);
  const kept = off.service.enqueue({ text: "Hello there." });
  await until(() => off.service.isSpeaking, "speaking");
  off.service.interruptForDictation();
  await tick();
  expect(off.service.isSpeaking).toBe(true);
  off.service.stop();
  expect((await kept.done).outcome).toBe("stopped");
});

test("agents cannot speak while voice is turned off; the app can", async () => {
  const { service } = fixture({ voiceEnabled: false });
  await service.initialize(DEFAULT_SETTINGS);
  expect(() => service.enqueue({ text: "Hi", source: "agent" })).toThrow(
    /turned off/,
  );
  expect((await service.speak({ text: "Hi", source: "app" })).outcome).toBe(
    "spoken",
  );
});

test("rejects empty, oversized and overflowing requests", async () => {
  const { service } = fixture({}, { autoplay: false });
  await service.initialize(DEFAULT_SETTINGS);
  expect(() =>
    service.enqueue({ text: "[pause] <whisper></whisper>" }),
  ).toThrow(/nothing to say/);
  expect(() => service.enqueue({ text: "a".repeat(15_001) })).toThrow(
    /limited/,
  );
  const queued = Array.from({ length: 21 }, (_, index) =>
    service.enqueue({ text: `Message ${index}.` }),
  );
  await until(() => service.getStatus().current !== null, "speech start");
  expect(() => service.enqueue({ text: "One too many." })).toThrow(
    /already waiting/,
  );
  service.stop();
  await Promise.all(queued.map((item) => item.done));
});

test("a silent renderer cannot stall the queue", async () => {
  const { service } = fixture({}, { autoplay: false, durationMs: 10 });
  await service.initialize(DEFAULT_SETTINGS);
  const pending = service.enqueue({ text: "Nobody is listening." });
  await until(() => service.getStatus().current !== null, "speech start");
  service.playbackLost();
  expect((await pending.done).outcome).toBe("spoken");
});

test("setup is required before speaking", async () => {
  const { service } = fixture();
  (
    service as unknown as { overrides: { ready: () => Promise<boolean> } }
  ).overrides.ready = async () => false;
  await service.initialize(DEFAULT_SETTINGS);
  expect(service.getStatus().engine).toBe("missing");
  expect(() => service.enqueue({ text: "Hello" })).toThrow(/Set up/);
});
