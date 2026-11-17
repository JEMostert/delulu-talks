import { useState } from "react";
import type * as ipc from "../ipc";
import {
  formatDate,
  formatMs,
  formatTime,
  highlight,
  languageName,
} from "../helpers";
import { IconButton } from "./Controls";

type Props = {
  entry: ipc.HistoryEntry;
  languages: ipc.Language[];
  onCopy: (text: string) => void;
  /** `raw`: insert what was said, as shown when Cleaned up is off. */
  onInsert: (entry: ipc.HistoryEntry, raw: boolean) => void;
  onDelete: () => void;
  /** Highlighted in the text. */
  query?: string;
};

/**
 * One dictation on one line. Click or Enter opens the full text and the
 * cleaned-up/raw toggle; copy, insert again and delete show on hover or focus.
 */
export function Transcript({
  entry,
  languages,
  onCopy,
  onInsert,
  onDelete,
  query = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const [cleaned, setCleaned] = useState(true);
  const shown = cleaned ? entry.text : (entry.raw ?? entry.text);
  const actions = (
    <div className="entry-actions">
      <IconButton icon="copy" label="Copy" onClick={() => onCopy(shown)} />
      <IconButton
        icon="insert"
        label="Insert again"
        onClick={() => onInsert(entry, !cleaned && entry.raw != null)}
      />
      <IconButton
        icon="trash"
        label="Delete"
        tone="danger"
        onClick={onDelete}
      />
    </div>
  );
  return (
    <li className={`entry ${open ? "open" : ""}`}>
      <button
        type="button"
        className="entry-main"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <time
          className="entry-time tabular"
          dateTime={new Date(entry.createdAt).toISOString()}
          data-tip={formatDate(entry.createdAt)}
        >
          {formatTime(entry.createdAt)}
        </time>
        <span className="entry-text">
          {highlight(shown, query).map((part, i) =>
            part.match ? <mark key={i}>{part.text}</mark> : part.text,
          )}
        </span>
        <span className="entry-meta">
          <span
            className="tag plain entry-lang"
            data-tip={languageName(entry.language, languages)}
          >
            <span aria-hidden="true">{entry.language.toUpperCase()}</span>
            <span className="visually-hidden">
              {languageName(entry.language, languages)}
            </span>
          </span>
          {entry.topic && (
            <span className="entry-topic" data-tip="Topic cleanup heard">
              {entry.topic}
            </span>
          )}
          <span
            className="tabular"
            data-tip="From letting go of the hotkey to text inserted"
          >
            {formatMs(entry.totalMs)}
          </span>
        </span>
      </button>
      {open ? (
        <div className="entry-more">
          {entry.raw && (
            <button
              type="button"
              className="entry-toggle"
              aria-pressed={cleaned}
              data-tip={
                cleaned
                  ? "Showing the cleaned-up text. Click for what you said."
                  : "Showing what you said. Click for the cleaned-up text."
              }
              onClick={() => setCleaned(!cleaned)}
            >
              Cleaned up
            </button>
          )}
          {actions}
        </div>
      ) : (
        actions
      )}
    </li>
  );
}
