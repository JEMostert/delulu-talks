import { describe, expect, test } from "bun:test";
import {
  EMPTY_HISTORY_FILTERS,
  filterHistory,
  historyDateError,
  type HistoryFilters,
} from "../../src/historyFilters";
import type { TranscriptRecord } from "../../src/types";

const record = (patch: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  id: "record",
  createdAt: new Date(2026, 8, 30, 12).getTime(),
  durationMs: 2000,
  text: "original",
  model: "r2t2",
  language: "en",
  source: "dictation",
  processingTimeMs: 20,
  ...patch,
});
const select = (items: TranscriptRecord[], patch: Partial<HistoryFilters>) =>
  filterHistory(items, { ...EMPTY_HISTORY_FILTERS, ...patch }).map(
    (item) => item.id,
  );

describe("history filters", () => {
  test("combines every filter with search without changing records or order", () => {
    const target = record({
      id: "target",
      source: "file",
      model: "r2t2Mlx",
      language: "nl",
      magicText: "A rewritten needle",
      text: "immutable\r\noriginal",
    });
    const items = [
      record({ ...target, id: "wrong-source", source: "dictation" }),
      target,
      record({
        ...target,
        id: "wrong-date",
        createdAt: new Date(2026, 8, 29, 12).getTime(),
      }),
      record({ ...target, id: "wrong-language", language: "en" }),
      record({ ...target, id: "wrong-model", model: "r2t2" }),
      record({ ...target, id: "not-rewritten", magicText: null }),
    ];
    const before = JSON.stringify(items);
    expect(
      select(items, {
        query: " NEEDLE ",
        from: "2026-09-30",
        through: "2026-09-30",
        source: "file",
        model: "r2t2Mlx",
        language: "nl",
        rewritten: "yes",
      }),
    ).toEqual(["target"]);
    expect(filterHistory(items, EMPTY_HISTORY_FILTERS)).toEqual(items);
    expect(JSON.stringify(items)).toBe(before);
  });

  test("keeps historical model identities, language codes and source exact", () => {
    const items = [
      record({
        id: "legacy",
        model: "qwen3Asr",
        language: "xx",
        source: "file",
      }),
      record({ id: "mlx", model: "r2t2Mlx", language: "nl" }),
      record({ id: "cuda" }),
    ];
    expect(select(items, { model: "qwen3Asr" })).toEqual(["legacy"]);
    expect(select(items, { language: "xx" })).toEqual(["legacy"]);
    expect(select(items, { source: "file" })).toEqual(["legacy"]);
    expect(select(items, { source: "dictation" })).toEqual(["mlx", "cuda"]);
  });

  test("rewrite status depends on a current accepted result, not old model metadata", () => {
    const items = [
      record({ id: "yes", magicText: "rewrite" }),
      record({ id: "undone", magicModel: "qwen35Medium", magicText: null }),
      record({ id: "empty", magicText: " \n " }),
      record({ id: "original" }),
    ];
    expect(select(items, { rewritten: "yes" })).toEqual(["yes"]);
    expect(select(items, { rewritten: "no" })).toEqual([
      "undone",
      "empty",
      "original",
    ]);
  });

  test("searches each stored text layer and filename alongside filters", () => {
    for (const field of [
      "text",
      "personalizedText",
      "editedText",
      "magicText",
      "sourceName",
    ]) {
      const item = record({ source: "file", [field]: "Unique NEEDLE" });
      expect(select([item], { query: "needle", source: "file" })).toEqual([
        "record",
      ]);
    }
  });

  test("includes local day edges with independent open bounds", () => {
    const start = new Date(2026, 8, 30).getTime();
    const end = new Date(2026, 9, 1).getTime();
    const items = [
      record({ id: "before", createdAt: start - 1 }),
      record({ id: "start", createdAt: start }),
      record({ id: "last", createdAt: end - 1 }),
      record({ id: "next", createdAt: end }),
    ];
    expect(
      select(items, { from: "2026-09-30", through: "2026-09-30" }),
    ).toEqual(["start", "last"]);
    expect(select(items, { from: "2026-09-30" })).toEqual([
      "start",
      "last",
      "next",
    ]);
    expect(select(items, { through: "2026-09-30" })).toEqual([
      "before",
      "start",
      "last",
    ]);
  });

  test("calendar end bounds handle short and long daylight-saving days", () => {
    // Europe/Amsterdam transitions; also run in America/New_York and UTC.
    for (const [month, day, value] of [
      [2, 29, "2026-03-29"],
      [9, 25, "2026-10-25"],
      [2, 8, "2026-03-08"],
      [10, 1, "2026-11-01"],
    ] as const) {
      const start = new Date(2026, month, day).getTime();
      const end = new Date(2026, month, day + 1).getTime();
      expect(
        select(
          [
            record({ id: "last", createdAt: end - 1 }),
            record({ id: "next", createdAt: end }),
            record({ id: "start", createdAt: start }),
          ],
          { from: value, through: value },
        ),
      ).toEqual(["last", "start"]);
    }
  });

  test("invalid and reversed dates explain empty results; leap day is valid", () => {
    for (const from of ["2026-02-29", "2026-13-01", "bad", "2026-2-03"]) {
      const filters = { ...EMPTY_HISTORY_FILTERS, from };
      expect(historyDateError(filters)).toBe(
        "Choose valid start and end dates.",
      );
      expect(filterHistory([record()], filters)).toEqual([]);
    }
    expect(
      historyDateError({
        ...EMPTY_HISTORY_FILTERS,
        from: "2026-09-30",
        through: "2026-09-29",
      }),
    ).toBe("Start date must be on or before end date.");
    expect(
      historyDateError({ ...EMPTY_HISTORY_FILTERS, from: "2024-02-29" }),
    ).toBeNull();
    expect(filterHistory([], EMPTY_HISTORY_FILTERS)).toEqual([]);
  });
});
