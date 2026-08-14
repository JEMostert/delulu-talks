import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type { AppSettings, TranscriptRecord } from "../../src/types";
import { DictationService } from "./dictation";
import type { AsrService } from "./asr";
import type { PasteService } from "./paste";
import type { PillService } from "./pill";
import type { StorageService } from "./storage";

function fakePill() {
  const commands: unknown[] = [];
  return {
    commands,
    service: {
      show: (command: unknown) => commands.push(command),
      hide: () => commands.push({ state: "hidden" }),
      level: (value: number) => commands.push({ state: "listening", level: value }),
    } as unknown as PillService,
  };
}

function harness(settings: AppSettings, transcription: Record<string, unknown> = { text: "um ship the release", intendedText: "Ship the release.", verbatimText: "um ship the release" }) {
  const cacheDirectory = mkdtempSync(join(tmpdir(), "delulu-dictation-test-"));
  const copied: string[] = [];
  const pasted: string[] = [];
  const records: TranscriptRecord[] = [];
  let magicCalls = 0;
  const storage = {
    cacheDirectory,
    getSettings: () => settings,
    addHistory: (record: TranscriptRecord) => records.push(record),
  } as unknown as StorageService;
  const asr = {
    getStatus: () => ({ phase: "idle", engine: "ready", message: "Ready" }),
    setActivity: () => undefined,
    transcribe: async () => transcription,
    rewriteMagic: async () => {
      magicCalls += 1;
      return { text: "Ship the release today.", model: settings.magicModel, processingTimeMs: 12, inputCharacters: 17, outputCharacters: 23, includedInferences: settings.magicAllowInferences };
    },
    unload: async () => undefined,
  } as unknown as AsrService;
  const paste = {
    copy: (text: string) => copied.push(text),
    paste: async (text: string) => { pasted.push(text); return "test"; },
  } as unknown as PasteService;
  const pill = fakePill();
  const service = new DictationService(
    storage,
    asr,
    paste,
    { main: () => null, pill: pill.service },
    (record) => records.push(record),
  );
  return { service, copied, pasted, records, hud: pill.commands, magicCalls: () => magicCalls, cleanup: () => rmSync(cacheDirectory, { recursive: true, force: true }) };
}

function captureHarness(settings: AppSettings = { ...DEFAULT_SETTINGS, modelLicenseAccepted: true }) {
  const commands: unknown[] = [];
  let current = settings;
  let status = { phase: "idle", engine: "ready", message: "Ready" };
  const pill = fakePill();
  const service = new DictationService(
    { getSettings: () => current } as unknown as StorageService,
    {
      getStatus: () => status,
      setActivity: (phase: typeof status.phase, message: string) => { status = { ...status, phase, message }; },
    } as unknown as AsrService,
    {} as PasteService,
    { main: () => ({ isDestroyed: () => false, webContents: { send: (_channel: string, command: unknown) => commands.push(command) } }) as never, pill: pill.service },
    () => undefined,
  );
  service.recorderAvailable();
  return {
    service,
    commands,
    hud: pill.commands,
    setSettings: (next: AppSettings) => { current = next; },
  };
}

describe("dictation delivery pipeline", () => {
  test("honors a hold release that arrives while the microphone is still opening", () => {
    const testHarness = captureHarness();
    testHarness.service.start();
    testHarness.service.stop();
    expect(testHarness.commands).toEqual([{ action: "start", inputDeviceId: "default" }]);
    testHarness.service.recordingStarted();
    expect(testHarness.commands).toEqual([
      { action: "start", inputDeviceId: "default" },
      { action: "stop", inputDeviceId: "default" },
    ]);
  });

  test("a second toggle also stops a capture whose microphone is still opening", () => {
    const testHarness = captureHarness();
    testHarness.service.toggle();
    testHarness.service.toggle();
    testHarness.service.recordingStarted();
    expect(testHarness.commands.at(-1)).toEqual({ action: "stop", inputDeviceId: "default" });
  });

  test("rewrites with Magic before copying the delivered result", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, magicEnabled: true, magicPreset: "polish", magicAllowInferences: false, autoPaste: false, copyToClipboard: true });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 1_000 });
      expect(testHarness.magicCalls()).toBe(1);
      expect(testHarness.copied).toEqual(["Ship the release today."]);
      expect(testHarness.records[0].magicText).toBe("Ship the release today.");
      expect(testHarness.records[0].intendedText).toBe("Ship the release.");
    } finally {
      testHarness.cleanup();
    }
  });

  test("delivers the speech transcript directly when Magic is off", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, magicEnabled: false, autoPaste: false, copyToClipboard: true });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 1_000 });
      expect(testHarness.magicCalls()).toBe(0);
      expect(testHarness.copied).toEqual(["Ship the release."]);
      expect(testHarness.records[0].magicText).toBeUndefined();
    } finally {
      testHarness.cleanup();
    }
  });

  test("automatic paste publishes the result exactly once", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, magicEnabled: false, autoPaste: true, copyToClipboard: true });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 1_000 });
      expect(testHarness.copied).toEqual([]);
      expect(testHarness.pasted).toEqual(["Ship the release."]);
      expect(testHarness.hud.at(-1)).toEqual({ state: "success", title: "Pasted", detail: "Ready to keep talking" });
    } finally {
      testHarness.cleanup();
    }
  });

  test("does not save, rewrite, copy, or paste silence", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, magicEnabled: true, autoPaste: true, copyToClipboard: true }, { text: "", intendedText: "", verbatimText: "" });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 1_000 });
      expect(testHarness.magicCalls()).toBe(0);
      expect(testHarness.copied).toEqual([]);
      expect(testHarness.records).toEqual([]);
      expect(testHarness.hud.at(-1)).toEqual({ state: "error", title: "Nothing heard", detail: "Try closer to the mic" });
    } finally {
      testHarness.cleanup();
    }
  });

  test("shows a short copied success state after delivery", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, magicEnabled: false, autoPaste: false, copyToClipboard: true });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 1_000 });
      expect(testHarness.hud).toContainEqual({ state: "transcribing" });
      expect(testHarness.hud.at(-1)).toEqual({ state: "success", title: "Copied", detail: "Ready to keep talking" });
    } finally {
      testHarness.cleanup();
    }
  });

  test("discards a tap as too short instead of hiding silently", async () => {
    const testHarness = harness({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true });
    try {
      await testHarness.service.submitRecording({ wav: new Uint8Array(64), durationMs: 80 });
      expect(testHarness.copied).toEqual([]);
      expect(testHarness.hud.at(-1)).toEqual({ state: "error", title: "Too short", detail: "Hold a little longer" });
    } finally {
      testHarness.cleanup();
    }
  });

  test("reapplies the current HUD when the overlay setting flips", () => {
    const testHarness = captureHarness();
    testHarness.service.start();
    testHarness.service.recordingStarted();
    expect(testHarness.hud.at(-1)).toEqual({ state: "listening", detail: "Release to send" });
    testHarness.setSettings({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, showOverlay: false });
    testHarness.service.syncOverlay();
    expect(testHarness.hud.at(-1)).toEqual({ state: "hidden" });
    testHarness.setSettings({ ...DEFAULT_SETTINGS, modelLicenseAccepted: true, showOverlay: true });
    testHarness.service.syncOverlay();
    expect(testHarness.hud.at(-1)).toEqual({ state: "listening", detail: "Release to send" });
  });
});
