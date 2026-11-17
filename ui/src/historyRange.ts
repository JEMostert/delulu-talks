import type { HistoryEntry } from "./ipc";

export type HistoryRange = "today" | "week" | "all";

/** Entries from today, from the last seven calendar days (today included), or all. */
export function inRange(
  entries: HistoryEntry[],
  range: HistoryRange,
  now = Date.now(),
): HistoryEntry[] {
  if (range === "all") return entries;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // Calendar days, so a daylight saving change does not move the edge.
  if (range === "week") start.setDate(start.getDate() - 6);
  return entries.filter((e) => e.createdAt >= start.getTime());
}

/**
 * How many transcripts the list shows. Dictate loads only the newest `limit`,
 * so when all of those are shown there may be more: "1000+".
 */
export function countLabel(
  shown: number,
  loaded: number,
  limit: number,
): string {
  return loaded >= limit && shown === loaded ? `${shown}+` : String(shown);
}
