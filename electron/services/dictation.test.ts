import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type { AppSettings, TranscriptRecord } from "../../src/types";
import { DictationService } from "./dictation";
import type { AsrService } from "./asr";
import type { PasteService } from "./paste";
import type { StorageService } from "./storage";

function harness(settings: AppSettings) {
  const cacheDirectory = mkdtempSync(join(tmpdir(), "delulu-dictation-test-"));
  const copied: string[] = [];
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
    transcribe: async () => ({ text: "um ship the release", intendedText: "Ship the release.", verbatimText: "um ship the release" }),
    rewriteMagic: async () => {
      magicCalls += 1;
      return { text: "Ship the release today.", model: settings.magicModel, processingTimeMs: 12, inputCharacters: 17, outputCharacters: 23, includedInferences: settings.magicAllowInferences };
    },
    unload: async () => undefined,
  } as unknown as AsrService;
  const paste = {
    copy: (text: string) => copied.push(text),
    paste: async () => "test",
  } as unknown as PasteService;
  const service = new DictationService(
    storage,
    asr,
    paste,
    { main: () => null, overlay: () => null },
    (record) => records.push(record),
  );
  return { service, copied, records, magicCalls: () => magicCalls, cleanup: () => rmSync(cacheDirectory, { recursive: true, force: true }) };
}

describe("dictation delivery pipeline", () => {
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
});
