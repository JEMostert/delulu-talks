import { describe, expect, test } from "bun:test";
import { deriveInsights, exportRecord } from "./transcripts";
import type { TranscriptRecord } from "../../src/types";

const record: TranscriptRecord = {
  id: "one",
  createdAt: 1,
  durationMs: 2_000,
  text: "Hello world.",
  intendedText: "Hello world.",
  verbatimText: "[UM] hello hello world.",
  mode: "dual",
  model: "crisperMedium",
  language: "en",
  words: [{ word: "Hello", start: 0.1, end: 0.4 }, { word: "world.", start: 0.5, end: 0.9 }],
  verbatimWords: [],
  insights: { fillerCount: 1, repetitionCount: 1, cutOffCount: 0, vocalEventCount: 0, wordsPerMinute: 90, speakingSeconds: 1 },
  source: "dictation",
  processingTimeMs: 200,
};

describe("speech metadata", () => {
  test("counts disfluencies and repeated words", () => {
    const insights = deriveInsights("[UM] we we th- [laughter]", [], 3_000);
    expect(insights.fillerCount).toBe(1);
    expect(insights.repetitionCount).toBe(1);
    expect(insights.vocalEventCount).toBe(1);
  });

  test("exports dual text and timed captions", () => {
    expect(exportRecord(record, "txt")).toContain("--- Verbatim ---");
    expect(exportRecord(record, "vtt")).toContain("00:00:00.100 --> 00:00:00.900");
    expect(exportRecord(record, "srt")).toContain("00:00:00,100 --> 00:00:00,900");
  });
});
