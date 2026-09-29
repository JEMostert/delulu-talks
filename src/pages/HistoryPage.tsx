import { useEffect, useMemo, useState } from "react";
import { Clock3, Search, Trash2 } from "lucide-react";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { ConfirmDialog, EmptyState } from "../components/ui";
import type { ExportFormat, TranscriptRecord } from "../types";

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
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirm, setConfirm] = useState(false);
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
    const needle = query.trim().toLowerCase();
    history
      .filter(
        (item) =>
          (filter === "all" ||
            (filter === "dictation"
              ? item.source === "dictation"
              : item.source !== "dictation")) &&
          [
            item.text,
            item.personalizedText,
            item.editedText,
            item.magicText,
            item.sourceName,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
      )
      .forEach((item) => {
        const day = dayLabel(item.createdAt);
        const bucket = result.get(day);
        if (bucket) bucket.push(item);
        else result.set(day, [item]);
      });
    return [...result];
  }, [history, query, filter]);
  return (
    <div className="content-stack">
      <div className="flex items-center gap-3.5 max-[700px]:flex-wrap">
        <label className="search-box max-[700px]:basis-full">
          <Search />
          <input
            aria-label="Search transcript history"
            placeholder="Find a thought, a phrase, a file…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter history"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All activity</option>
          <option value="dictation">Dictation</option>
          <option value="files">Imported files</option>
        </select>
        <button
          className="tool-button danger"
          disabled={!history.length || deletionPending || batchBusy}
          onClick={() => setConfirm(true)}
        >
          <Trash2 /> Clear history
        </button>
      </div>
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
            <div key={record.id} className="content-stack gap-1.5">
              <label className="flex items-center gap-2 text-[11px] text-muted">
                <input type="checkbox" disabled={batchBusy || (!selected.has(record.id) && selectedIds.length >= 500)} checked={selected.has(record.id)}
                  aria-label={`Select transcript from ${new Date(record.createdAt).toLocaleString()}: ${record.text.slice(0, 70)}`}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((ids) => {
                      const next = new Set(ids);
                      if (checked) next.add(record.id); else next.delete(record.id);
                      return next;
                    });
                  }} />
                Select transcript
              </label>
              <TranscriptCard record={record} {...actions} />
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
            ? "Try another phrase or choose all activity."
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
