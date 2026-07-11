import { Clock3, Copy, Mic, Search, Trash2, Users } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { modelById } from "../data";
import type { TranscriptRecord } from "../types";

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const PAGE_SIZE = 100;

function dateLabel(timestamp: number) { return dateFormatter.format(timestamp); }

export function HistoryPage({ history, onCopy, onDelete, onClear }: { history: TranscriptRecord[]; onCopy: (text: string) => void; onDelete: (id: string) => void; onClear: () => void }) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const filtered = useMemo(() => history.filter((item) => item.text.toLowerCase().includes(deferredQuery)), [history, deferredQuery]);
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  useEffect(() => setVisibleCount(PAGE_SIZE), [deferredQuery]);
  return (
    <div className="content-stack">
      <section className="page-intro"><div><span className="hello-pill"><Clock3 /> Your private timeline</span><h2>Everything you said, findable.</h2><p>Search past captures, copy them again, or clear them permanently from this device.</p></div><button className="danger-button" disabled={!history.length} onClick={onClear}><Trash2 /> Clear history</button></section>
      <section className="history-panel paper-card">
        <div className="history-toolbar"><label className="search-box wide"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search every transcript…" /></label><span>{filtered.length} captures</span></div>
        <div className="history-list">
          {visible.map((item) => {
            const model = modelById(item.model);
            return <article key={item.id}>
              <div className={`history-model ${model.accent}`}><Mic /></div>
              <div className="history-content"><div className="history-meta"><span>{dateLabel(item.createdAt)}</span><i>·</i><span>{Math.max(1, Math.round(item.durationMs / 1000))} sec</span><i>·</i><span>{model.maker}</span>{item.segments.length > 0 && <b><Users />{new Set(item.segments.map((segment) => segment.speaker)).size} speakers</b>}</div><p>{item.text}</p></div>
              <div className="history-actions"><button className="icon-button" onClick={() => onCopy(item.text)} aria-label="Copy"><Copy /></button><button className="icon-button danger" onClick={() => onDelete(item.id)} aria-label="Delete"><Trash2 /></button></div>
            </article>;
          })}
          {visible.length < filtered.length && <button className="load-more-button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more</button>}
          {!filtered.length && <div className="empty-state"><Clock3 /><h3>{history.length ? "No results" : "A clean slate"}</h3><p>{history.length ? "Try searching with fewer words." : "Your finished transcripts will appear here."}</p></div>}
        </div>
      </section>
    </div>
  );
}
