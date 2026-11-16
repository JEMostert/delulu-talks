import { expect, test } from "bun:test";
import { countLabel, inRange } from "./historyRange";
import type { HistoryEntry } from "./ipc";

const entry = (createdAt: number): HistoryEntry => ({
  id: String(createdAt),
  createdAt,
  text: "",
  language: "en",
  model: "m",
  audioMs: 0,
  sttMs: 0,
  totalMs: 0,
});

test("history ranges follow calendar days, not the last 24 hours", () => {
  const now = new Date(2026, 10, 17, 0, 30).getTime();
  const lastNight = entry(new Date(2026, 10, 16, 23, 50).getTime());
  const weekStart = entry(new Date(2026, 10, 11, 0, 0).getTime());
  const weekBefore = entry(new Date(2026, 10, 10, 23, 59).getTime());
  const all = [entry(now - 60000), lastNight, weekStart, weekBefore];
  expect(inRange(all, "today", now)).toEqual([all[0]]);
  expect(inRange(all, "week", now)).toEqual([all[0], lastNight, weekStart]);
  expect(inRange(all, "all", now)).toBe(all);
});

test("the count says when older transcripts were not loaded", () => {
  expect(countLabel(1000, 1000, 1000)).toBe("1000+");
  expect(countLabel(12, 1000, 1000)).toBe("12");
  expect(countLabel(566, 566, 1000)).toBe("566");
});
