import { ArrowRight, BookOpenText, ChevronRight, Clock3, Copy, Mic, Sparkles, WandSparkles } from "lucide-react";
import { modelById } from "../data";
import type { AppSettings, DictationStatus, Page, TranscriptRecord } from "../types";

function relativeTime(timestamp: number) {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function HomePage({ settings, status, history, onToggle, onNavigate, onCopy }: {
  settings: AppSettings; status: DictationStatus; history: TranscriptRecord[]; onToggle: () => void; onNavigate: (page: Page) => void; onCopy: (text: string) => void;
}) {
  const model = modelById(settings.model);
  const isRecording = status.phase === "listening";
  const today = history.filter((item) => Date.now() - item.createdAt < 86_400_000);
  const minutes = Math.round(today.reduce((sum, item) => sum + item.durationMs, 0) / 60_000);

  return (
    <div className="home-grid">
      <section className="hero-card paper-card">
        <div className="hero-copy">
          <span className="hello-pill"><Sparkles /> Voice, upgraded</span>
          <h2>Your thoughts.<br /><em>Without the typing.</em></h2>
          <p>Press your shortcut anywhere, speak naturally, and Delulu turns the mess in your head into polished text.</p>
          <div className="shortcut-row"><kbd>{settings.shortcut.split("+").join(" + ")}</kbd><span>{settings.recordingMode === "hold" ? "Hold to talk" : "Tap to start & stop"}</span></div>
        </div>
        <div className={`record-zone ${isRecording ? "is-recording" : ""}`}>
          <span className="orbit orbit-one" /><span className="orbit orbit-two" />
          <div className="record-content">
            <button className="record-button" onClick={onToggle} aria-label={isRecording ? "Stop recording" : "Start recording"}><Mic /></button>
            <strong>{isRecording ? "Listening…" : status.phase === "transcribing" ? "Working on it…" : "Click to talk"}</strong>
            <small>{status.message || "or use your shortcut anywhere"}</small>
          </div>
        </div>
      </section>

      <section className="stat-strip paper-card">
        <div><span className="stat-icon coral"><Clock3 /></span><p><strong>{minutes || 0}<b> min</b></strong><small>Captured today</small></p></div>
        <div><span className="stat-icon blue"><WandSparkles /></span><p><strong>{today.length}</strong><small>Thoughts rescued</small></p></div>
        <button onClick={() => onNavigate("vocabulary")}><span className="stat-icon yellow"><BookOpenText /></span><p><strong>{settings.customWords.length}</strong><small>Custom words</small></p><ChevronRight /></button>
      </section>

      <section className="recent-section paper-card">
        <div className="section-heading"><div><p className="eyebrow">YOUR FLOW</p><h3>Recent captures</h3></div><button className="text-button" onClick={() => onNavigate("history")}>View all <ArrowRight /></button></div>
        <div className="capture-list">
          {history.slice(0, 3).map((item) => (
            <article key={item.id}>
              <span className="capture-play"><Mic /></span>
              <div><p>{item.text}</p><small>{relativeTime(item.createdAt)} · {Math.max(1, Math.round(item.durationMs / 1000))} sec</small></div>
              <button aria-label="Copy transcript" onClick={() => onCopy(item.text)}><Copy /></button>
            </article>
          ))}
          {!history.length && <div className="empty-inline"><Mic /><p><strong>Your first thought lands here.</strong><small>Start a recording and say what is on your mind.</small></p></div>}
        </div>
      </section>

      <aside className="model-mini paper-card">
        <p className="eyebrow">CURRENT ENGINE</p>
        <span className={`model-glyph ${model.accent}`}><span /><span /><span /></span>
        <h3>{model.name}</h3><p>{model.role}</p>
        <div className="mini-tags">{model.badges.slice(0, 2).map((badge) => <span key={badge}>{badge}</span>)}</div>
        <button className="secondary-button" onClick={() => onNavigate("models")}>Explore models <ChevronRight /></button>
      </aside>
    </div>
  );
}
