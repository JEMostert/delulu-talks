import { describe, expect, test } from "bun:test";
import {
  rememberSessionTranscript,
  retainSessionTranscripts,
  SESSION_TRANSCRIPT_LIMIT,
  SESSION_TRANSCRIPT_TEXT_BYTES,
} from "../../src/sessionTranscriptRetention";
import type { TranscriptRecord } from "../../src/types";

function transcript(
  id: string,
  createdAt: number,
  extra: Partial<TranscriptRecord> = {},
): TranscriptRecord {
  return {
    id,
    createdAt,
    text: "private text",
    sessionOnly: true,
    durationMs: 1000,
    model: "r2t2",
    language: "en",
    source: "dictation",
    processingTimeMs: 10,
    ...extra,
  };
}

describe("private session retention stays bounded without truncating text", () => {
  test("keeps the newest unpinned sessions plus active pins, leaves saved history alone, and never caches saved records", () => {
    const sessions = Array.from(
      { length: SESSION_TRANSCRIPT_LIMIT + 3 },
      (_, index) => transcript(`session-${index}`, index),
    );
    const saved = transcript("saved", -1, { sessionOnly: false });
    const input = [saved, ...sessions];
    const retained = retainSessionTranscripts(input, ["session-0"]);
    expect(retained.map(({ id }) => id)).toEqual([
      "saved",
      "session-0",
      ...sessions.slice(3).map(({ id }) => id),
    ]);
    expect(input).toEqual([saved, ...sessions]);
    const cache = new Map<string, TranscriptRecord>();
    for (const record of sessions)
      rememberSessionTranscript(cache, record, ["session-0"]);
    rememberSessionTranscript(cache, saved);
    expect([...cache.keys()]).toEqual([
      "session-0",
      ...sessions.slice(3).map(({ id }) => id),
    ]);
    expect(cache.has(saved.id)).toBe(false);
  });

  test("counts UTF-8 originals and rewrites against the budget and keeps an oversized newest output whole", () => {
    const newest = transcript("newest", 3, { text: "é".repeat(3_000_000) });
    const older = transcript("older", 2, {
      text: "x".repeat(1_000_000),
      magicText: "é".repeat(1_000_000),
    });
    const active = transcript("active", 1);
    expect(
      retainSessionTranscripts([older, active, newest], [active.id]),
    ).toEqual([active, newest]);
    expect(newest.text.length).toBe(3_000_000);
    const oversized = transcript("oversized", 4, {
      text: "x".repeat(SESSION_TRANSCRIPT_TEXT_BYTES + 1),
    });
    expect(retainSessionTranscripts([older, newest, oversized])).toEqual([
      oversized,
    ]);
    expect(oversized.text.length).toBe(SESSION_TRANSCRIPT_TEXT_BYTES + 1);
  });
});
