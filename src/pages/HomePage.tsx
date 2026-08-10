import { BookOpenText, Check, ChevronRight, Clock3, Copy, Cpu, Mic, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { LANGUAGES, modelById } from "../data";
import type { AppSettings, DictationStatus, Page, TranscriptRecord } from "../types";

function relativeTime(timestamp: number) {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function QuickSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button className={`quick-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={onChange}><i />{label}</button>;
}

export function HomePage({ settings, status, history, saving, onNavigate, onUpdateSettings, onCopy }: {
  settings: AppSettings;
  status: DictationStatus;
  history: TranscriptRecord[];
  saving: boolean;
  onNavigate: (page: Page) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onCopy: (text: string) => void;
}) {
  const latest = history[0] ?? null;
  const model = modelById(settings.model);
  const [version, setVersion] = useState<"intended" | "verbatim">("intended");
  useEffect(() => setVersion(latest?.intendedText ? "intended" : "verbatim"), [latest?.id, latest?.intendedText]);
  const visibleText = latest
    ? version === "intended" ? latest.intendedText || latest.text : latest.verbatimText || latest.text
    : "";

  return (
    <div className="dictation-view">
      <section className="quick-controls" aria-label="Dictation controls">
        <label><span>Transcript</span><div className="segmented compact triple">{(["intended", "dual", "verbatim"] as const).map((mode) => <button key={mode} className={settings.transcriptionMode === mode ? "active" : ""} disabled={saving} onClick={() => onUpdateSettings({ transcriptionMode: mode })}>{mode === "dual" ? "Both" : mode}</button>)}</div></label>
        <label><span>Language</span><select value={settings.language} disabled={saving} onChange={(event) => onUpdateSettings({ language: event.target.value })}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        {settings.transcriptionMode === "dual" && <label><span>Paste version</span><div className="segmented compact"><button className={settings.pasteVersion === "intended" ? "active" : ""} onClick={() => onUpdateSettings({ pasteVersion: "intended" })}>Intended</button><button className={settings.pasteVersion === "verbatim" ? "active" : ""} onClick={() => onUpdateSettings({ pasteVersion: "verbatim" })}>Verbatim</button></div></label>}
        <div className="quick-toggles"><QuickSwitch checked={settings.autoPaste} label="Auto-paste" onChange={() => onUpdateSettings({ autoPaste: !settings.autoPaste })} /><QuickSwitch checked={settings.copyToClipboard} label="Keep copy" onChange={() => onUpdateSettings({ copyToClipboard: !settings.copyToClipboard })} /></div>
      </section>

      <div className="dictation-grid">
        <section className="transcript-workbench">
          <header className="panel-toolbar">
            <div><strong>Latest transcript</strong>{latest && <span>{relativeTime(latest.createdAt)} · {Math.max(1, Math.round(latest.durationMs / 1000))}s</span>}</div>
            {latest?.intendedText && latest.verbatimText && <div className="segmented compact"><button className={version === "intended" ? "active" : ""} onClick={() => setVersion("intended")}>Intended</button><button className={version === "verbatim" ? "active" : ""} onClick={() => setVersion("verbatim")}>Verbatim</button></div>}
          </header>
          {latest ? <>
            <div className="transcript-editor" tabIndex={0}>{visibleText}</div>
            <footer className="panel-footer">
              <div className="transcript-metrics"><span>{latest.insights.wordsPerMinute} WPM</span><span>{latest.insights.fillerCount} fillers</span><span>{latest.insights.repetitionCount} repetitions</span><span>{latest.words.length || latest.verbatimWords.length} timed words</span></div>
              <div><button className="tool-button" onClick={() => onCopy(visibleText)}><Copy /> Copy</button><button className="tool-button" onClick={() => onNavigate("history")}><Clock3 /> Open in history</button></div>
            </footer>
          </> : <div className="workbench-empty"><Mic /><strong>No transcript yet</strong><p>Use Record in the toolbar or press {settings.shortcut.split("+").join(" + ")} from any application.</p></div>}
        </section>

        <aside className="dictation-inspector">
          <section>
            <div className="inspector-heading"><span className={`state-dot phase-${status.phase}`} /><div><small>Capture status</small><strong>{status.phase === "listening" ? "Listening" : status.phase === "transcribing" ? "Transcribing" : status.engine === "ready" ? "Ready" : status.engine}</strong></div></div>
            <p className="inspector-message">{status.message}</p>
          </section>
          <section>
            <h3>Input</h3>
            <dl><div><dt>Microphone</dt><dd>{settings.inputDeviceLabel}</dd></div><div><dt>Shortcut</dt><dd><kbd>{settings.shortcut.split("CommandOrControl").join("Ctrl")}</kbd></dd></div></dl>
            <button className="inline-link" onClick={() => onNavigate("settings")}><Settings2 /> Change capture settings <ChevronRight /></button>
          </section>
          <section>
            <h3>Runtime</h3>
            <dl><div><dt>Model</dt><dd>{model.size}</dd></div><div><dt>Lifecycle</dt><dd>{settings.preloadModel ? "Resident" : "On demand"}</dd></div><div><dt>Backend</dt><dd>{status.backend ?? settings.backend}</dd></div></dl>
            <button className="inline-link" onClick={() => onNavigate("models")}><Cpu /> Configure model <ChevronRight /></button>
          </section>
          <section>
            <h3>Personalization</h3>
            <button className="inline-link" onClick={() => onNavigate("vocabulary")}><BookOpenText /> {settings.customWords.length} Wordbook rules <ChevronRight /></button>
          </section>
        </aside>
      </div>

      <section className="recent-captures">
        <header className="panel-toolbar"><div><strong>Recent captures</strong><span>{history.length} stored locally</span></div><button className="tool-button" onClick={() => onNavigate("history")}>View all <ChevronRight /></button></header>
        <div className="recent-table">
          {history.slice(0, 5).map((item) => <div className="recent-row" key={item.id}><span className="source-icon">{item.source === "dictation" ? <Mic /> : <Clock3 />}</span><p>{item.intendedText || item.text}</p><small>{relativeTime(item.createdAt)}</small><b>{item.mode}</b><button aria-label="Copy transcript" onClick={() => onCopy(item.text)}><Copy /></button></div>)}
          {!history.length && <div className="recent-empty"><Check /> Finished dictations will appear here.</div>}
        </div>
      </section>
    </div>
  );
}
