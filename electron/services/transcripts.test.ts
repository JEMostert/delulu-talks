import { describe, expect, test } from "bun:test";
import { exportRecord } from "./transcripts";
import { deliveredText, transcriptIsEdited } from "../../src/transcriptText";
import type { TranscriptRecord } from "../../src/types";

const record: TranscriptRecord = {
  id: "one",
  createdAt: 1,
  durationMs: 2_000,
  text: "Hello world.",
  model: "r2t2",
  language: "en",
  source: "dictation",
  processingTimeMs: 200,
};

describe("transcript export", () => {
  test("delivers the plain transcript by default", () => {
    expect(deliveredText(record)).toBe("Hello world.");
    expect(exportRecord(record, "txt")).toBe("Hello world.\n");
  });

  test("corrections change delivery without replacing model output", () => {
    const corrected = { ...record, editedText: "Corrected hello world." };
    expect(deliveredText(corrected)).toBe("Corrected hello world.");
    expect(transcriptIsEdited(corrected)).toBe(true);
    expect(exportRecord(corrected, "txt")).toStartWith(
      "Corrected hello world.",
    );
    const json = JSON.parse(exportRecord(corrected, "json"));
    expect(json.text).toBe("Hello world.");
    expect(json.editedText).toBe("Corrected hello world.");
  });

  test("exports the delivered Magic result without losing the source transcript", () => {
    const rewritten = {
      ...record,
      magicText: "A polished delivery.",
      magicModel: "qwen35Medium" as const,
      magicPreset: "polish" as const,
    };
    const text = exportRecord(rewritten, "txt");
    expect(text).toStartWith("A polished delivery.");
    expect(text).toContain("--- Source transcript ---");
    expect(text).toContain("Hello world.");
  });

  test("restoring the original clears the correction", () => {
    const updated = { ...record, editedText: null };
    expect(transcriptIsEdited(updated)).toBe(false);
    expect(deliveredText(updated)).toBe("Hello world.");
  });
});

test("personalized delivery exports beside original speech", () => {
  const personalized = { ...record, personalizedText: "Hello Delulu." };
  expect(deliveredText(personalized)).toBe("Hello Delulu.");
  expect(exportRecord(personalized, "txt")).toStartWith("Hello Delulu.");
  expect(exportRecord(personalized, "txt")).toContain("Hello world.");
});
