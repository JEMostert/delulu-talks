import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { TranscriptRecord } from "../../src/types";

mock.module("electron", () => ({ app: {} }));

let normalizeSettings: typeof import("./storage")["normalizeSettings"];
let applyTranscriptEdit: typeof import("./storage")["applyTranscriptEdit"];

beforeAll(async () => {
  ({ normalizeSettings, applyTranscriptEdit } = await import("./storage"));
});

describe("settings migration", () => {
  test("migrates removed Tauri models to the balanced Crisper default", () => {
    const settings = normalizeSettings({ model: "mossTranscribeDiarize", language: "auto", autoPaste: false });
    expect(settings.model).toBe("crisperMedium");
    expect(settings.transcriptionMode).toBe("dual");
    expect(settings.language).toBe("en");
    expect(settings.autoPaste).toBeFalse();
  });

  test("sanitizes custom vocabulary at the IPC boundary", () => {
    const settings = normalizeSettings({ customWords: [{ id: "x", term: " Nyra ", soundsLike: "nira", enabled: true }, { term: "" }] });
    expect(settings.customWords).toEqual([{ id: "x", term: "Nyra", soundsLike: "nira", replacement: "", enabled: true }]);
  });

  test("normalizes Magic model residency settings", () => {
    const settings = normalizeSettings({ magicModel: "invented-8b", magicPreset: "invented", magicEnabled: false, magicAllowInferences: true, preloadMagicModel: false, modelIdleMinutes: 999 });
    expect(settings.magicModel).toBe("qwen35Medium");
    expect(settings.magicEnabled).toBeFalse();
    expect(settings.magicPreset).toBe("polish");
    expect(settings.magicAllowInferences).toBeTrue();
    expect(settings.preloadMagicModel).toBeFalse();
    expect(settings.modelIdleMinutes).toBe(15);
    expect(normalizeSettings({ modelIdleMinutes: 30 }).modelIdleMinutes).toBe(30);
  });
});

describe("non-destructive transcript correction", () => {
  const record: TranscriptRecord = {
    id: "one",
    createdAt: 1,
    durationMs: 2_000,
    text: "Original clean text.",
    intendedText: "Original clean text.",
    verbatimText: "[UM] original clean text.",
    mode: "dual",
    model: "crisperMedium",
    language: "en",
    words: [],
    verbatimWords: [],
    insights: { fillerCount: 1, repetitionCount: 0, cutOffCount: 0, vocalEventCount: 0, wordsPerMinute: 90, speakingSeconds: 1 },
    source: "dictation",
    processingTimeMs: 200,
  };

  test("stores a correction beside the untouched model output", () => {
    const updated = applyTranscriptEdit(record, "intended", "  Corrected clean text.  ");
    expect(updated.intendedText).toBe("Original clean text.");
    expect(updated.editedIntendedText).toBe("Corrected clean text.");
  });

  test("restores the original and rejects an empty correction", () => {
    const updated = applyTranscriptEdit({ ...record, editedIntendedText: "Corrected." }, "intended", null);
    expect(updated.editedIntendedText).toBeNull();
    expect(() => applyTranscriptEdit(record, "intended", "   ")).toThrow("cannot be empty");
  });
});
