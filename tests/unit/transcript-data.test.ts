import { describe, expect, test } from "bun:test";
import {
  assertPersistedSchema,
  migratePersistedSchema,
  reversePersistedSchema,
} from "../../src/persistedSchema";
import {
  deliveredText,
  originalTranscriptText,
  transcriptText,
} from "../../src/transcriptText";
import type { TranscriptRecord } from "../../src/types";

const transcript: TranscriptRecord = {
  id: "record",
  createdAt: 1,
  durationMs: 1000,
  text: "Original recognition",
  model: "r2t2",
  language: "en",
  source: "dictation",
  processingTimeMs: 10,
};

describe("transcript data cannot silently lose its source", () => {
  test("delivers only current rewrites, preserves explicit empty edits, and retains the original", () => {
    const record = {
      ...transcript,
      sourceRevision: 2,
      editedText: "Corrected source",
      personalizedText: "Old personalization",
      technicalText: "Old technical text",
      magicText: "Old rewrite",
      rewriteSourceRevision: 1,
    };
    expect(deliveredText(record)).toBe("Corrected source");
    expect(originalTranscriptText(record)).toBe("Original recognition");
    expect(transcriptText(record)).toBe("Corrected source");
    expect(deliveredText({ ...record, rewriteSourceRevision: 2 })).toBe(
      "Old rewrite",
    );
    expect(deliveredText({ ...record, editedText: "" })).toBe("");
    expect(
      deliveredText({
        ...transcript,
        personalizedText: "Personalized",
        technicalText: "Code",
      }),
    ).toBe("Code");
    expect(deliveredText({ ...transcript, magicText: "Legacy rewrite" })).toBe(
      "Legacy rewrite",
    );
  });

  test("legacy migration and reversal preserve literal text and unknown metadata without sharing mutable snapshots", () => {
    const original = {
      text: "\tExact\r\n  original\n",
      replacement: "\r\nKeep spaces  ",
      pluginMetadata: { tags: ["private"] },
    };
    const migration = migratePersistedSchema(original, "transcript");
    expect(migration.after).toEqual({ ...original, schemaVersion: 1 });
    migration.after.pluginMetadata.tags.push("changed");
    expect(original.pluginMetadata.tags).toEqual(["private"]);
    expect(reversePersistedSchema(migration)).toEqual(original);
    const restored = reversePersistedSchema(migration);
    restored.pluginMetadata.tags.length = 0;
    expect(reversePersistedSchema(migration)).toEqual(original);
    expect(
      Object.prototype.hasOwnProperty.call(restored, "schemaVersion"),
    ).toBe(false);
  });

  test("rejects unsupported and malformed saved data before migration can replace it", () => {
    for (const kind of ["settings", "transcript", "rule"] as const) {
      const future = { schemaVersion: 2, text: "Existing private text" };
      expect(() => migratePersistedSchema(future, kind)).toThrow(
        "Existing data is preserved",
      );
      expect(future).toEqual({
        schemaVersion: 2,
        text: "Existing private text",
      });
      for (const invalid of [null, [], "not a record", { schemaVersion: "1" }])
        expect(() => assertPersistedSchema(invalid, kind)).toThrow(
          "Existing data is preserved",
        );
    }
  });
});
