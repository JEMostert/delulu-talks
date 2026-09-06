import { useMemo, useState } from "react";
import { Clock3, Search, Trash2 } from "lucide-react";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { ConfirmDialog, EmptyState } from "../components/ui";
import type { TranscriptRecord } from "../types";

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
  ...actions
}: TranscriptActions & { history: TranscriptRecord[]; onClear: () => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [confirm, setConfirm] = useState(false);
  const groups = useMemo(() => {
    const result = new Map<string, TranscriptRecord[]>();
    history
      .filter(
        (item) =>
          (filter === "all" ||
            (filter === "dictation"
              ? item.source === "dictation"
              : item.source !== "dictation")) &&
          [
            item.text,
            item.intendedText,
            item.verbatimText,
            item.editedIntendedText,
            item.editedVerbatimText,
            item.magicText,
            item.sourceName,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      )
      .forEach((item) => {
        const day = dayLabel(item.createdAt);
        result.set(day, [...(result.get(day) ?? []), item]);
      });
    return [...result];
  }, [history, query, filter]);
  return (
    <div className="content-stack">
      <div className="history-toolbar">
        <label className="search-box">
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
          disabled={!history.length}
          onClick={() => setConfirm(true)}
        >
          <Trash2 /> Clear history
        </button>
      </div>
      {groups.map(([day, records]) => (
        <section className="content-stack history-group" key={day}>
          <div className="section-heading">
            <h3>{day}</h3>
            <span className="caption">
              {records.length} {records.length === 1 ? "capture" : "captures"}
            </span>
          </div>
          {records.map((record) => (
            <TranscriptCard key={record.id} record={record} {...actions} />
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
    </div>
  );
}
