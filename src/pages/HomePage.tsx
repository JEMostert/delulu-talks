import { ArrowRight, AudioLines, BookOpenText, Check, Clock3, Copy, Keyboard, Mic, Settings2, Sparkles } from "lucide-react";
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
  const language = settings.language === "auto" ? "Automatic" : settings.language.toUpperCase();

  const quickActions: Array<{ title: string; description: string; icon: typeof Sparkles; page: Page }> = [
    { title: "Choose a model", description: model.name, icon: Sparkles, page: "models" },
    { title: "My vocabulary", description: `${settings.customWords.length} custom words`, icon: BookOpenText, page: "vocabulary" },
    { title: "Open history", description: `${history.length} saved captures`, icon: Clock3, page: "history" },
    { title: "Tune settings", description: `${language} · ${settings.pasteMethod === "ctrlShiftV" ? "Ctrl+Shift+V" : "Ctrl+V"}`, icon: Settings2, page: "settings" },
  ];

  return (
    <div className="overview-page">
      <section className="overview-hero paper-card">
        <div className="overview-copy">
          <span className="system-ready"><i /><span>{status.phase === "idle" ? "Ready for your voice" : status.message || status.phase}</span></span>
          <p className="eyebrow">YOUR DICTATION DESK</p>
          <h2>Speak naturally.<br /><em>Your words land ready.</em></h2>
          <p>Start here or use your shortcut from any application. Audio stays local and the finished text appears exactly where you need it.</p>
          <div className="overview-primary-actions">
            <button className={`overview-record-button ${isRecording ? "recording" : ""}`} onClick={onToggle}><Mic />{isRecording ? "Stop listening" : "Start talking"}</button>
            <div className="overview-shortcut"><Keyboard /><span><small>Global shortcut</small><kbd>{settings.shortcut.split("+").join(" + ")}</kbd></span></div>
          </div>
        </div>
        <div className="overview-engine" aria-label={`Current model: ${model.name}`}>
          <div className={`engine-visual ${isRecording ? "active" : ""}`}><AudioLines /></div>
          <span>ACTIVE ENGINE</span>
          <strong>{model.name}</strong>
          <small>{model.role}</small>
          <button onClick={() => onNavigate("models")}>Change model <ArrowRight /></button>
        </div>
      </section>

      <section className="quick-section">
        <div className="overview-section-heading"><div><p className="eyebrow">QUICK START</p><h3>Where do you want to go?</h3></div><span>Everything important, one click away.</span></div>
        <div className="quick-grid">
          {quickActions.map(({ title, description, icon: Icon, page }) => (
            <button className="quick-card paper-card" key={page} onClick={() => onNavigate(page)}>
              <span><Icon /></span><div><strong>{title}</strong><small>{description}</small></div><ArrowRight />
            </button>
          ))}
        </div>
      </section>

      <section className="overview-bottom-grid">
        <div className="today-panel paper-card">
          <div className="overview-section-heading"><div><p className="eyebrow">TODAY</p><h3>Your flow at a glance</h3></div></div>
          <div className="overview-stats">
            <div><span><Clock3 /></span><strong>{minutes}</strong><small>minutes captured</small></div>
            <div><span><Check /></span><strong>{today.length}</strong><small>finished captures</small></div>
            <div><span><AudioLines /></span><strong>{language}</strong><small>active language</small></div>
          </div>
        </div>

        <div className="overview-recent paper-card">
          <div className="overview-section-heading"><div><p className="eyebrow">RECENT</p><h3>Latest transcripts</h3></div><button className="text-button" onClick={() => onNavigate("history")}>View all <ArrowRight /></button></div>
          <div className="capture-list">
            {history.slice(0, 3).map((item) => (
              <article key={item.id}>
                <span className="capture-play"><Mic /></span>
                <div><p>{item.text}</p><small>{relativeTime(item.createdAt)} · {Math.max(1, Math.round(item.durationMs / 1000))} sec</small></div>
                <button aria-label="Copy transcript" onClick={() => onCopy(item.text)}><Copy /></button>
              </article>
            ))}
            {!history.length && <div className="empty-inline"><Mic /><p><strong>Your first transcript will appear here.</strong><small>Start talking whenever you are ready.</small></p></div>}
          </div>
        </div>
      </section>
    </div>
  );
}
