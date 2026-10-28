import { useState } from "react";
import type * as ipc from "../ipc";
import {
  formatDate,
  formatMs,
  formatTime,
  highlight,
  languageName,
  whenLabel,
} from "../helpers";
import { IconButton } from "./Controls";

type Props = {
  entry: ipc.HistoryEntry;
  languages: ipc.Language[];
  onCopy: (text: string) => void;
  onInsert: (entry: ipc.HistoryEntry) => void;
  onDelete?: () => void;
  /** History rows put the time in a gutter and highlight the search. */
  query?: string;
  timeInGutter?: boolean;
};

export function Transcript({
  entry,
  languages,
  onCopy,
  onInsert,
  onDelete,
  query = "",
  timeInGutter,
}: Props) {
  const [cleaned, setCleaned] = useState(true);
  const shown = cleaned ? entry.text : (entry.raw ?? entry.text);
  const when = timeInGutter
    ? formatTime(entry.createdAt)
    : whenLabel(entry.createdAt);
  return (
    <li className={`entry ${timeInGutter ? "entry-gutter" : ""}`}>
      {timeInGutter && (
        <time
          className="entry-time"
          dateTime={new Date(entry.createdAt).toISOString()}
          title={formatDate(entry.createdAt)}
        >
          {when}
        </time>
      )}
      <div className="entry-body">
        <p className="entry-text">
          {highlight(shown, query).map((part, i) =>
            part.match ? <mark key={i}>{part.text}</mark> : part.text,
          )}
        </p>
        <div className="entry-meta">
          {!timeInGutter && (
            <time
              dateTime={new Date(entry.createdAt).toISOString()}
              title={formatDate(entry.createdAt)}
            >
              {when}
            </time>
          )}
          {entry.raw && (
            <button
              type="button"
              className="button"
              aria-pressed={cleaned}
              onClick={() => setCleaned(!cleaned)}
            >
              Cleaned up
            </button>
          )}
          <span className="entry-lang">
            {languageName(entry.language, languages)}
          </span>
          {entry.topic && (
            <span className="entry-topic" title="Topic cleanup heard">
              {entry.topic}
            </span>
          )}
          <span title="From letting go of the hotkey to text inserted">
            {formatMs(entry.totalMs)}
          </span>
        </div>
      </div>
      <div className="entry-actions">
        <IconButton icon="copy" label="Copy" onClick={() => onCopy(shown)} />
        <IconButton
          icon="insert"
          label="Insert again"
          onClick={() => onInsert(entry)}
        />
        {onDelete && (
          <IconButton
            icon="trash"
            label="Delete"
            tone="danger"
            onClick={onDelete}
          />
        )}
      </div>
    </li>
  );
}
