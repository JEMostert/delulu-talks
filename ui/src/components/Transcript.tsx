import * as ipc from "../ipc";
import { formatDate, formatMs, languageName } from "../helpers";
export function Transcript({
  entry,
  languages,
  onCopy,
  onInsert,
  onDelete,
}: {
  entry: ipc.HistoryEntry;
  languages: ipc.Language[];
  onCopy: (text: string) => void;
  onInsert: (entry: ipc.HistoryEntry) => void;
  onDelete?: () => void;
}) {
  return (
    <article className="transcript">
      <p className="transcript-text">{entry.text}</p>
      <div className="transcript-bottom">
        <span className="muted">
          {formatDate(entry.createdAt)} ·{" "}
          {languageName(entry.language, languages)} · {formatMs(entry.totalMs)}
        </span>
        <div className="transcript-actions">
          <button onClick={() => onCopy(entry.text)}>Copy</button>
          <button onClick={() => onInsert(entry)}>Insert again</button>
          {onDelete && <button onClick={onDelete}>Delete</button>}
        </div>
      </div>
    </article>
  );
}
