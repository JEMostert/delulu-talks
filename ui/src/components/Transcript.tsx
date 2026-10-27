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
          {highlight(entry.text, query).map((part, i) =>
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
          <span className="entry-lang">
            {languageName(entry.language, languages)}
          </span>
          <span title="From letting go of the hotkey to text inserted">
            {formatMs(entry.totalMs)}
          </span>
        </div>
      </div>
      <div className="entry-actions">
        <IconButton
          icon="copy"
          label="Copy"
          onClick={() => onCopy(entry.text)}
        />
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
