import type { ModelId, TranscriptRecord, TranscriptSource } from "./types";
import { createHistorySearch } from "./historySearch";

export type HistoryFilters = {
  query: string;
  from: string;
  through: string;
  model: ModelId | "all";
  language: string;
  source: TranscriptSource | "all";
  rewritten: "all" | "yes" | "no";
};

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  query: "",
  from: "",
  through: "",
  model: "all",
  language: "all",
  source: "all",
  rewritten: "all",
};

// Parse calendar components locally: Date.parse("YYYY-MM-DD") uses UTC and
// adding 24 hours skips or repeats local hours at daylight-saving transitions.
function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

export function historyDateError(filters: HistoryFilters): string | null {
  if (
    (filters.from && !calendarDate(filters.from)) ||
    (filters.through && !calendarDate(filters.through))
  )
    return "Choose valid start and end dates.";
  if (filters.from && filters.through && filters.from > filters.through)
    return "Start date must be on or before end date.";
  return null;
}

export function filterHistory(
  history: readonly TranscriptRecord[],
  filters: HistoryFilters,
): TranscriptRecord[] {
  if (historyDateError(filters)) return [];
  const start = filters.from ? calendarDate(filters.from)!.getTime() : null;
  const endDate = filters.through ? calendarDate(filters.through)! : null;
  if (endDate) endDate.setDate(endDate.getDate() + 1);
  const end = endDate?.getTime() ?? null;
  const matchesSearch = createHistorySearch(filters.query);
  return history.filter((item) => {
    const rewritten = !!item.magicText?.trim();
    return (
      (start === null || item.createdAt >= start) &&
      (end === null || item.createdAt < end) &&
      (filters.model === "all" || item.model === filters.model) &&
      (filters.language === "all" || item.language === filters.language) &&
      (filters.source === "all" || item.source === filters.source) &&
      (filters.rewritten === "all" ||
        rewritten === (filters.rewritten === "yes")) &&
      matchesSearch(item)
    );
  });
}
