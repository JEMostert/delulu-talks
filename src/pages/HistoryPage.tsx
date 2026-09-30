import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Clock3, Search, Trash2 } from "lucide-react";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { ConfirmDialog, EmptyState } from "../components/ui";
import { HistorySearchMatches } from "../components/HistorySearchMatches";
import type { ExportFormat, TranscriptRecord } from "../types";
import { LANGUAGES } from "../data";
import {
  EMPTY_HISTORY_FILTERS,
  filterHistory,
  historyDateError,
  type HistoryFilters,
} from "../historyFilters";
import {
  sortHistory,
  type HistorySort,
  type HistoryViewState,
} from "../historyView";

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
          month: "long",
          day: "numeric",
          year: "numeric",
        });
}
export function HistoryPage({
  history,
  onClear,
  view,
  onViewChange,
  onExportSelection,
  onDeleteSelection,
  deletionPending,
  ...actions
}: TranscriptActions & {
  history: TranscriptRecord[];
  onClear: () => void;
  onExportSelection: (ids: string[], format: ExportFormat) => Promise<boolean>;
  onDeleteSelection: (ids: string[]) => Promise<boolean>;
  deletionPending: boolean;
  view: HistoryViewState;
  onViewChange: Dispatch<SetStateAction<HistoryViewState>>;
}) {
  const { filters, sort } = view;
  const [confirm, setConfirm] = useState(false);
  const update = <K extends keyof HistoryFilters>(
    key: K,
    value: HistoryFilters[K],
  ) =>
    onViewChange((previous) => ({
      ...previous,
      filters: { ...previous.filters, [key]: value },
    }));
  const dateError = historyDateError(filters);
  const filtered = useMemo(
    () => filterHistory(history, filters),
    [history, filters],
  );
  const sorted = useMemo(() => sortHistory(filtered, sort), [filtered, sort]);
  const languages = [
    ...new Set([
      ...history.map((item) => item.language),
      ...(filters.language === "all" ? [] : [filters.language]),
    ]),
  ].sort();
  const active = Object.keys(EMPTY_HISTORY_FILTERS).some(
    (key) =>
      filters[key as keyof HistoryFilters] !==
      EMPTY_HISTORY_FILTERS[key as keyof HistoryFilters],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmSelection, setConfirmSelection] = useState<string[] | null>(null);
  const selectedIds = history.filter((record) => selected.has(record.id)).map((record) => record.id);
  useEffect(() => {
    const available = new Set(history.map((record) => record.id));
    setSelected((ids) => new Set([...ids].filter((id) => available.has(id))));
  }, [history]);
  const exportSelected = async (format: ExportFormat) => {
    setBatchBusy(true);
    try { await onExportSelection(selectedIds, format); } finally { setBatchBusy(false); }
  };
  const groups = useMemo(() => {
    const result = new Map<string, TranscriptRecord[]>();
    sorted.forEach((item) => {
      const day = dayLabel(item.createdAt);
      const bucket = result.get(day);
      if (bucket) bucket.push(item);
      else result.set(day, [item]);
    });
    return [...result];
  }, [sorted]);
  return (
    <div className="content-stack">
      <div className="flex items-center gap-3.5 max-[700px]:flex-wrap">
        <label className="search-box max-[700px]:basis-full">
          <Search />
          <input
            aria-label="Search transcript history"
            placeholder="Find a thought, a phrase, a file…"
            value={filters.query}
            onChange={(e) => update("query", e.target.value)}
          />
        </label>
        <label className="field min-w-0 max-[700px]:flex-1">
          Sort history
          <select
            aria-label="Sort history"
            value={sort}
            onChange={(e) => {
              const nextSort = e.target.value as HistorySort;
              onViewChange((previous) => ({
                ...previous,
                sort: nextSort,
              }));
            }}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <button
          className="tool-button danger"
          disabled={!history.length || deletionPending || batchBusy}
          onClick={() => setConfirm(true)}
        >
          <Trash2 /> Clear history
        </button>
      </div>
      <fieldset className="rounded-panel border border-line p-4">
        <legend className="caption px-1">Filter history</legend>
        <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
          <label className="field min-w-0">
            Start date
            <input
              type="date"
              value={filters.from}
              aria-invalid={!!dateError}
              aria-describedby="history-date-help"
              onChange={(e) => update("from", e.target.value)}
            />
          </label>
          <label className="field min-w-0">
            End date
            <input
              type="date"
              value={filters.through}
              aria-invalid={!!dateError}
              aria-describedby="history-date-help"
              onChange={(e) => update("through", e.target.value)}
            />
          </label>
          <label className="field min-w-0">
            Speech model
            <select
              aria-label="Speech model"
              value={filters.model}
              onChange={(e) =>
                update("model", e.target.value as HistoryFilters["model"])
              }
            >
              <option value="all">All models</option>
              <option value="r2t2">R2T2 · CUDA</option>
              <option value="r2t2Mlx">R2T2 · MLX</option>
              <option value="qwen3Asr">Qwen3 ASR · historical</option>
            </select>
          </label>
          <label className="field min-w-0">
            Transcript language
            <select
              aria-label="Transcript language"
              value={filters.language}
              onChange={(e) => update("language", e.target.value)}
            >
              <option value="all">All languages</option>
              {languages.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGES.find(([id]) => id === code)?.[1] ??
                    (code || "Unspecified")}
                </option>
              ))}
            </select>
          </label>
          <label className="field min-w-0">
            Recording/import source
            <select
              aria-label="Recording/import source"
              value={filters.source}
              onChange={(e) =>
                update("source", e.target.value as HistoryFilters["source"])
              }
            >
              <option value="all">All activity</option>
              <option value="dictation">Recording · dictation</option>
              <option value="file">Imported files</option>
            </select>
          </label>
          <label className="field min-w-0">
            Rewrite status
            <select
              aria-label="Rewrite status"
              value={filters.rewritten}
              onChange={(e) =>
                update(
                  "rewritten",
                  e.target.value as HistoryFilters["rewritten"],
                )
              }
            >
              <option value="all">All results</option>
              <option value="yes">Rewritten results</option>
              <option value="no">Without rewrite</option>
            </select>
          </label>
        </div>
        <p
          id="history-date-help"
          className={dateError ? "field-error" : "caption"}
          role={dateError ? "alert" : undefined}
        >
          {dateError ??
            "Dates include the whole start and end days in your local timezone."}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="caption" role="status" aria-live="polite">
            {filtered.length} of {history.length} transcripts
          </span>
          <button
            className="text-button"
            disabled={!active}
            onClick={() =>
              onViewChange((previous) => ({
                ...previous,
                filters: EMPTY_HISTORY_FILTERS,
              }))
            }
          >
            Reset search and filters
          </button>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-line bg-soft">
        <span className="text-sm" role="status">{selectedIds.length} selected</span>
        <button className="tool-button" disabled={batchBusy || !groups.length} onClick={() => {
          setSelected((ids) => new Set([...new Set([...ids, ...groups.flatMap(([, records]) => records.map((record) => record.id))])].slice(0, 500)));
        }}>Select matching (up to 500)</button>
        <button className="tool-button" disabled={batchBusy || !selectedIds.length} onClick={() => setSelected(new Set())}>Clear selection</button>
        <button className="secondary-button" disabled={batchBusy || !selectedIds.length} onClick={() => void exportSelected("txt")}>Export {selectedIds.length} TXT</button>
        <button className="secondary-button" disabled={batchBusy || !selectedIds.length} onClick={() => void exportSelected("json")}>Export {selectedIds.length} JSON</button>
        <button className="tool-button danger" disabled={batchBusy || deletionPending || !selectedIds.length} onClick={() => setConfirmSelection([...selectedIds])}>Delete {selectedIds.length} selected…</button>
        <span className="caption">Up to 500 per action; selection includes records hidden by the current filter. JSON keeps full originals and provenance.</span>
      </div>
      {groups.map(([day, records]) => (
        <section className="content-stack gap-3.5" key={day}>
          <div className="section-heading px-0.5 py-1.5">
            <h3>{day}</h3>
            <span className="caption">
              {records.length} {records.length === 1 ? "capture" : "captures"}
            </span>
          </div>
          {records.map((record) => (
            <div key={record.id}>
              <TranscriptCard record={record} {...actions} />
              <HistorySearchMatches record={record} query={filters.query} />
            </div>
          ))}
        </section>
      ))}
      {!groups.length && (
        <EmptyState
          icon={Clock3}
          title={
            history.length ? "No matching transcripts" : "No transcripts yet"
          }
        >
          {history.length
            ? "Try another phrase, adjust the filters, or reset search and filters."
            : "Your dictations and imported transcripts will appear here."}
        </EmptyState>
      )}
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
        <ConfirmDialog title={`Delete ${confirmSelection.length} selected transcripts?`}
          confirmLabel={`Delete ${confirmSelection.length} transcripts`}
          onClose={() => setConfirmSelection(null)}
          onConfirm={() => {
            const ids = confirmSelection;
            setConfirmSelection(null);
            setBatchBusy(true);
            void onDeleteSelection(ids).then((success) => {
              if (success) setSelected(new Set());
            }).finally(() => setBatchBusy(false));
          }}>
          <p>These {confirmSelection.length} transcripts will be hidden immediately. You have 30 seconds to undo before originals, corrections and rewrites are permanently removed from this device.</p>
          <p className="caption">Export first if you need a separate copy. Other deletion and retention actions wait until this window ends.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
