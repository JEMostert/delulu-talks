import { ChevronDown, Clock3, Copy, Download, FileAudio, Fingerprint, Gauge, Mic, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { modelById } from "../data";
import type { ExportFormat, TranscriptRecord } from "../types";

function dateLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

export function HistoryPage({ history, onCopy, onDelete, onClear, onExport }: {
  history: TranscriptRecord[];
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onExport: (id: string, format: ExportFormat) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(history[0]?.id ?? null);
  const [versions, setVersions] = useState<Record<string, "intended" | "verbatim">>({});
  const filtered = useMemo(() => history.filter((item) => `${item.text} ${item.intendedText} ${item.verbatimText} ${item.sourceName ?? ""}`.toLowerCase().includes(query.toLowerCase())), [history, query]);
  return (
    <div className="content-stack">
      <section className="history-panel">
        <div className="history-toolbar"><label className="search-box wide"><Search /><input aria-label="Search transcript history" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search intended and verbatim transcripts…" /></label><span>{filtered.length} captures</span><button className="danger-button compact-button" disabled={!history.length} onClick={() => { if (window.confirm(`Permanently delete ${history.length} local ${history.length === 1 ? "capture" : "captures"}?`)) onClear(); }}><Trash2 /> Clear history</button></div>
        <div className="history-list">
          {filtered.map((item) => {
            const model = modelById(item.model);
            const open = expanded === item.id;
            const version = versions[item.id] ?? (item.intendedText ? "intended" : "verbatim");
            const visibleText = version === "intended" ? item.intendedText || item.text : item.verbatimText || item.text;
            const hasTiming = item.words.length > 0 || item.verbatimWords.length > 0;
            return <article key={item.id} className={open ? "expanded" : ""}>
              <button className={`history-model ${model.accent}`} onClick={() => setExpanded(open ? null : item.id)} aria-label="Expand transcript">{item.source === "dictation" ? <Mic /> : <FileAudio />}</button>
              <div className="history-content">
                <button className="history-summary" onClick={() => setExpanded(open ? null : item.id)}>
                  <span className="history-meta"><span>{dateLabel(item.createdAt)}</span><i>·</i><span>{Math.max(1, Math.round(item.durationMs / 1000))} sec</span><i>·</i><span>{model.size}</span><b>{item.mode}</b></span>
                  <p>{item.intendedText || item.text}</p><ChevronDown className={open ? "rotated" : ""} />
                </button>
                {open && <div className="history-detail">
                  {item.intendedText && item.verbatimText && <div className="segmented result-tabs"><button className={version === "intended" ? "active" : ""} onClick={() => setVersions({ ...versions, [item.id]: "intended" })}>Intended</button><button className={version === "verbatim" ? "active" : ""} onClick={() => setVersions({ ...versions, [item.id]: "verbatim" })}>Verbatim</button></div>}
                  <div className="history-transcript">{visibleText}</div>
                  <div className="insight-strip"><span><Fingerprint />{item.insights.fillerCount} fillers</span><span><Gauge />{item.insights.wordsPerMinute} WPM</span><span><Clock3 />{item.insights.speakingSeconds}s voiced</span><span>{item.insights.repetitionCount} repetitions</span><span>{item.insights.vocalEventCount} vocal events</span></div>
                  <div className="export-row"><span>Export</span>{(["txt", "json"] as ExportFormat[]).map((format) => <button key={format} onClick={() => onExport(item.id, format)}><Download />{format.toUpperCase()}</button>)}{hasTiming && (["srt", "vtt"] as ExportFormat[]).map((format) => <button key={format} onClick={() => onExport(item.id, format)}><Download />{format.toUpperCase()}</button>)}</div>
                </div>}
              </div>
              <div className="history-actions"><button className="icon-button" onClick={() => onCopy(visibleText)} aria-label="Copy"><Copy /></button><button className="icon-button danger" onClick={() => onDelete(item.id)} aria-label="Delete"><Trash2 /></button></div>
            </article>;
          })}
          {!filtered.length && <div className="empty-state"><Clock3 /><h3>{history.length ? "No results" : "A clean slate"}</h3><p>{history.length ? "Try searching with fewer words." : "Your finished dictations and Speech Lab runs will appear here."}</p></div>}
        </div>
      </section>
    </div>
  );
}
