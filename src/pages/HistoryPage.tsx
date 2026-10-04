import {
  useEffect,
  useDeferredValue,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  CheckSquare,
  Clock3,
  FileAudio,
  Mic,
  Search,
  WandSparkles,
  X,
} from "lucide-react";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { ConfirmDialog, EmptyState } from "../components/ui";
import { HistorySearchMatches } from "../components/HistorySearchMatches";
import type { ExportFormat, TranscriptRecord } from "../types";
import {
  EMPTY_HISTORY_FILTERS,
  filterHistory,
  type HistoryFilters,
} from "../historyFilters";
import { sortHistory, type HistoryViewState } from "../historyView";
import { deliveredText } from "../transcriptText";

function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString()
    ? "Today"
    : date.toDateString() === yesterday.toDateString()
      ? "Yesterday"
      : date.toLocaleDateString(undefined, {
          weekday: "long",
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
        });
}

const CHIPS: readonly [string, string, Partial<HistoryFilters>][] = [
  ["all", "All", { source: "all", rewritten: "all" }],
  ["dictation", "Dictation", { source: "dictation", rewritten: "all" }],
  ["file", "Files", { source: "file", rewritten: "all" }],
  ["rewritten", "Rewritten", { source: "all", rewritten: "yes" }],
];

/** History as a list beside the selected transcript: scan left, act right. */
export function HistoryPage({
  history,
  historyLimit,
  keepHistory,
  focusSearch,
  onSearchFocused,
  onClear,
  view,
  onViewChange,
  onExportSelection,
  onDeleteSelection,
  deletionPending,
  onOpenSettings,
  ...actions
}: TranscriptActions & {
  history: TranscriptRecord[];
  historyLimit: number;
  keepHistory: boolean;
  focusSearch?: boolean;
  onSearchFocused?: () => void;
  onClear: () => void;
  onExportSelection: (ids: string[], format: ExportFormat) => Promise<boolean>;
  onDeleteSelection: (ids: string[]) => Promise<boolean>;
  deletionPending: boolean;
  view: HistoryViewState;
  onViewChange: Dispatch<SetStateAction<HistoryViewState>>;
  onOpenSettings?: () => void;
}) {
  useEffect(() => {
    if (!focusSearch) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>("[data-history-search]")
        ?.focus();
      onSearchFocused?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSearch, onSearchFocused]);
  const { filters, sort } = view;
  const deferredFilters = useDeferredValue(filters);
  const [confirm, setConfirm] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmSelection, setConfirmSelection] = useState<string[] | null>(
    null,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const filtered = useMemo(
    () => sortHistory(filterHistory(history, deferredFilters), sort),
    [history, deferredFilters, sort],
  );
  const previews = useMemo(
    () =>
      new Map(
        history.map((record) => [
          record.id,
          {
            text: deliveredText(record).replace(/\s+/g, " ").slice(0, 240),
            time: new Date(record.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            }),
          },
        ]),
      ),
    [history],
  );
  const chip =
    CHIPS.find(
      ([, , patch]) =>
        patch.source === filters.source &&
        patch.rewritten === filters.rewritten,
    )?.[0] ?? null;
  const hiddenFilters =
    !!filters.from ||
    !!filters.through ||
    filters.model !== "all" ||
    filters.language !== "all" ||
    filters.rewritten === "no";
  const open =
    filtered.find((record) => record.id === openId) ?? filtered[0] ?? null;
  useEffect(() => {
    const available = new Set(history.map((record) => record.id));
    setSelected((ids) => {
      const next = [...ids].filter((id) => available.has(id));
      return next.length === ids.size ? ids : new Set(next);
    });
  }, [history]);
  const groups = useMemo(() => {
    const result = new Map<string, TranscriptRecord[]>();
    for (const item of filtered) {
      const day = dayLabel(item.createdAt);
      const bucket = result.get(day);
      if (bucket) bucket.push(item);
      else result.set(day, [item]);
    }
    return [...result];
  }, [filtered]);
  const selectedIds = history
    .filter((record) => selected.has(record.id))
    .map((record) => record.id);
  const exportSelected = async (format: ExportFormat) => {
    setBatchBusy(true);
    try {
      await onExportSelection(selectedIds, format);
    } finally {
      setBatchBusy(false);
    }
  };
  const setFilters = (patch: Partial<HistoryFilters>) =>
    onViewChange((previous) => ({
      ...previous,
      filters: { ...previous.filters, ...patch },
    }));
  const toggle = (id: string) =>
    setSelected((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else if (next.size < 500) next.add(id);
      return next;
    });

  if (!history.length)
    return (
      <EmptyState icon={Clock3} title="No transcripts yet">
        {keepHistory
          ? "Your dictations and imported files will appear here."
          : "Saving history is off, so only this session’s results appear here."}
      </EmptyState>
    );

  return (
    <div className={`history-shell ${showDetail ? "show-detail" : ""}`}>
      <aside className="history-pane" aria-label="Transcripts">
        <div className="history-pane-head">
          <div className="history-search-row">
            <label className="search-box">
              <Search aria-hidden="true" />
              <input
                aria-label="Search transcript history"
                data-history-search
                placeholder="Search"
                value={filters.query}
                onChange={(e) => setFilters({ query: e.target.value })}
              />
              {filters.query && (
                <button
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => setFilters({ query: "" })}
                >
                  <X />
                </button>
              )}
            </label>
            <button
              className={`sheet-icon ${selecting ? "is-selected" : ""}`}
              aria-label={selecting ? "Finish selection" : "Select transcripts"}
              aria-pressed={selecting}
              title={selecting ? "Done" : "Select"}
              onClick={() => {
                setSelecting(!selecting);
                setSelected(new Set());
              }}
            >
              {selecting ? <X /> : <CheckSquare />}
            </button>
          </div>
          <div className="history-chips" role="group" aria-label="Show">
            {CHIPS.map(([id, label, patch]) => (
              <button
                key={id}
                className="chip"
                aria-pressed={chip === id && !hiddenFilters}
                onClick={() =>
                  setFilters({
                    ...EMPTY_HISTORY_FILTERS,
                    query: filters.query,
                    ...patch,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          {hiddenFilters && (
            <button
              className="text-button compact"
              onClick={() =>
                setFilters({ ...EMPTY_HISTORY_FILTERS, query: filters.query })
              }
            >
              Older filters are active — show everything
            </button>
          )}
        </div>
        {selecting && (
          <div className="history-selection" role="status">
            <strong>{selectedIds.length} selected</strong>
            <button
              className="text-button compact"
              disabled={batchBusy}
              onClick={() =>
                setSelected(
                  new Set(filtered.slice(0, 500).map((record) => record.id)),
                )
              }
            >
              All
            </button>
            <span className="flex-1" />
            <button
              className="tool-button compact"
              disabled={batchBusy || !selectedIds.length}
              onClick={() => void exportSelected("txt")}
            >
              TXT
            </button>
            <button
              className="tool-button compact"
              disabled={batchBusy || !selectedIds.length}
              onClick={() => void exportSelected("json")}
            >
              JSON
            </button>
            <button
              className="tool-button compact danger"
              disabled={batchBusy || deletionPending || !selectedIds.length}
              onClick={() => setConfirmSelection([...selectedIds])}
            >
              Delete
            </button>
          </div>
        )}
        <div className="history-scroll">
          {!filtered.length && (
            <p className="history-none">No transcripts match.</p>
          )}
          {groups.map(([day, records]) => (
            <section key={day} className="history-group">
              <h3>{day}</h3>
              <ol>
                {records.map((record) => {
                  const { text, time } = previews.get(record.id)!;
                  return (
                    <li key={record.id}>
                      <button
                        className="history-item"
                        aria-current={
                          !selecting && open?.id === record.id
                            ? "true"
                            : undefined
                        }
                        aria-pressed={
                          selecting ? selected.has(record.id) : undefined
                        }
                        onClick={() => {
                          if (selecting) return toggle(record.id);
                          setOpenId(record.id);
                          setShowDetail(true);
                        }}
                      >
                        {selecting && (
                          <span
                            className={`history-check ${selected.has(record.id) ? "on" : ""}`}
                            aria-hidden="true"
                          />
                        )}
                        <span className="history-item-body">
                          <span className="history-item-top">
                            <span className="history-item-title">
                              {record.title || record.sourceName || text}
                            </span>
                            <span className="history-item-time">{time}</span>
                          </span>
                          {(record.title || record.sourceName) && (
                            <span className="history-item-text">{text}</span>
                          )}
                          <span className="history-item-meta">
                            {record.source === "file" ? (
                              <FileAudio aria-label="Imported file" />
                            ) : (
                              <Mic aria-label="Dictation" />
                            )}
                            {Math.max(1, Math.round(record.durationMs / 1000))}s
                            {record.magicText && (
                              <WandSparkles aria-label="Rewritten" />
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
        <footer className="history-pane-foot">
          <span>
            {keepHistory
              ? `${history.length} of ${historyLimit} kept`
              : "Session only — not saved"}
          </span>
          {onOpenSettings && (
            <button className="text-button compact" onClick={onOpenSettings}>
              Change
            </button>
          )}
          <button
            className="text-button compact danger-text"
            disabled={deletionPending || batchBusy}
            onClick={() => setConfirm(true)}
          >
            Clear all
          </button>
        </footer>
      </aside>
      <section className="history-detail" aria-label="Selected transcript">
        <button
          className="history-back text-button"
          onClick={() => setShowDetail(false)}
        >
          <ArrowLeft /> All transcripts
        </button>
        {open ? (
          <>
            <TranscriptCard
              key={open.id}
              record={open}
              variant="detail"
              {...actions}
            />
            <HistorySearchMatches record={open} query={deferredFilters.query} />
          </>
        ) : (
          <EmptyState icon={Search} title="Nothing selected">
            Pick a transcript on the left.
          </EmptyState>
        )}
      </section>
      {confirm && (
        <ConfirmDialog
          title="Clear your history?"
          confirmLabel="Clear history"
          onClose={() => setConfirm(false)}
          onConfirm={onClear}
        >
          <p>
            This permanently removes {history.length} transcripts and their
            corrections from this device. Export anything you want to keep
            first.
          </p>
        </ConfirmDialog>
      )}
      {confirmSelection && (
        <ConfirmDialog
          title={`Delete ${confirmSelection.length} transcripts?`}
          confirmLabel={`Delete ${confirmSelection.length}`}
          onClose={() => setConfirmSelection(null)}
          onConfirm={() => {
            const ids = confirmSelection;
            setConfirmSelection(null);
            setBatchBusy(true);
            void onDeleteSelection(ids)
              .then((success) => {
                if (success) setSelected(new Set());
              })
              .finally(() => setBatchBusy(false));
          }}
        >
          <p>
            They disappear right away; you have 30 seconds to undo before they
            are removed from this device.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
