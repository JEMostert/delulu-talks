import { EMPTY_HISTORY_FILTERS, type HistoryFilters } from "./historyFilters";
import type { TranscriptRecord } from "./types";

export type HistorySort = "newest" | "oldest";

export type HistoryViewState = {
  filters: HistoryFilters;
  sort: HistorySort;
};

export const DEFAULT_HISTORY_VIEW: HistoryViewState = {
  filters: EMPTY_HISTORY_FILTERS,
  sort: "newest",
};

/** Sort a copy so reviewing history never changes the stored record order. */
export function sortHistory(
  history: readonly TranscriptRecord[],
  sort: HistorySort,
): TranscriptRecord[] {
  return [...history].sort((left, right) => {
    const leftTime = Number.isFinite(left.createdAt) ? left.createdAt : 0;
    const rightTime = Number.isFinite(right.createdAt) ? right.createdAt : 0;
    if (leftTime !== rightTime)
      return sort === "oldest" ? leftTime - rightTime : rightTime - leftTime;
    // Use stored identity rather than arrival order or locale-dependent collation.
    // Equal timestamps retain the same ordering after refresh, edits or rewrites.
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
