import { BookOpenText, Check, ChevronRight, Clock3, Copy, Cpu, Mic, Pencil, RotateCcw, Save, Settings2, WandSparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { LANGUAGES, modelById } from "../data";
import { deliveredText, transcriptIsEdited, transcriptText } from "../transcriptText";
import type { AppSettings, DictationStatus, Page, TranscriptRecord, TranscriptVersion } from "../types";

function relativeTime(timestamp: number) {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function QuickSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button className={`quick-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={onChange}><i />{label}</button>;
}

export function HomePage({ settings, status, history, saving, onNavigate, onUpdateSettings, onUpdateTranscript, onCopy }: {
  settings: AppSettings;
  status: DictationStatus;
  history: TranscriptRecord[];
  saving: boolean;
  onNavigate: (page: Page) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onUpdateTranscript: (id: string, version: TranscriptVersion, text: string | null) => Promise<boolean>;
  onCopy: (text: string) => void;
}) {
  const latest = history[0] ?? null;
  const model = modelById(settings.model);
  const [version, setVersion] = useState<TranscriptVersion>("intended");
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  useEffect(() => {
    setVersion(latest?.intendedText ? "intended" : "verbatim");
    setEditing(false);
  }, [latest?.id, latest?.intendedText]);
  useEffect(() => setEditing(false), [version]);
  const visibleText = latest ? transcriptText(latest, version) : "";
  const corrected = latest ? transcriptIsEdited(latest, version) : false;

  function startEditing() {
    setEditDraft(visibleText);
    setEditing(true);
  }

  async function saveCorrection() {
    if (!latest || !editDraft.trim() || editDraft.trim() === visibleText) return;
    setSavingEdit(true);
    try {
      if (await onUpdateTranscript(latest.id, version, editDraft)) setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="dictation-view">
      <section className="quick-controls" aria-label="Dictation controls">
        <label><span>Transcript</span><div className="segmented compact triple" role="group" aria-label="Transcript mode">{(["intended", "dual", "verbatim"] as const).map((mode) => <button key={mode} className={settings.transcriptionMode === mode ? "active" : ""} aria-pressed={settings.transcriptionMode === mode} disabled={saving} onClick={() => onUpdateSettings({ transcriptionMode: mode })}>{mode === "dual" ? "Both" : mode}</button>)}</div></label>
        <label><span>Language</span><select value={settings.language} disabled={saving} onChange={(event) => onUpdateSettings({ language: event.target.value })}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
        {settings.transcriptionMode === "dual" && <label><span>Paste version</span><div className="segmented compact" role="group" aria-label="Version to paste"><button className={settings.pasteVersion === "intended" ? "active" : ""} aria-pressed={settings.pasteVersion === "intended"} onClick={() => onUpdateSettings({ pasteVersion: "intended" })}>Intended</button><button className={settings.pasteVersion === "verbatim" ? "active" : ""} aria-pressed={settings.pasteVersion === "verbatim"} onClick={() => onUpdateSettings({ pasteVersion: "verbatim" })}>Verbatim</button></div></label>}
        <div className="quick-toggles"><QuickSwitch checked={settings.magicEnabled} label="Magic" onChange={() => onUpdateSettings({ magicEnabled: !settings.magicEnabled })} /><QuickSwitch checked={settings.autoPaste} label="Auto-paste" onChange={() => onUpdateSettings({ autoPaste: !settings.autoPaste })} /><QuickSwitch checked={settings.copyToClipboard} label="Keep copy" onChange={() => onUpdateSettings({ copyToClipboard: !settings.copyToClipboard })} /></div>
      </section>

      <div className="dictation-grid">
        <section className="transcript-workbench">
          <header className="panel-toolbar">
            <div><strong>Latest transcript</strong>{latest && <span>{relativeTime(latest.createdAt)} · {Math.max(1, Math.round(latest.durationMs / 1000))}s · {corrected ? "corrected" : "original"}</span>}</div>
            <div className="transcript-toolbar-actions">
              {latest?.intendedText && latest.verbatimText && <div className="segmented compact" role="group" aria-label="Transcript version"><button className={version === "intended" ? "active" : ""} aria-pressed={version === "intended"} disabled={editing} onClick={() => setVersion("intended")}>Intended</button><button className={version === "verbatim" ? "active" : ""} aria-pressed={version === "verbatim"} disabled={editing} onClick={() => setVersion("verbatim")}>Verbatim</button></div>}
              {latest && !editing && <button className="tool-button edit-command" onClick={startEditing}><Pencil /> Correct text</button>}
            </div>
          </header>
          {latest ? <>
            {latest.magicText && <div className="magic-delivery-preview"><div><WandSparkles /><span><strong>Delivered with Magic</strong><small>{latest.magicPreset ?? "polish"} · {latest.magicIncludedInferences ? "review inferred details" : "facts preserved"}</small></span></div><p>{latest.magicText}</p><button className="tool-button" onClick={() => onCopy(latest.magicText!)}><Copy /> Copy delivered text</button></div>}
            {editing
              ? <textarea className="transcript-editor transcript-edit" aria-label={`Correct ${version} transcript`} value={editDraft} autoFocus onChange={(event) => setEditDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void saveCorrection(); }} />
              : <div className="transcript-editor" role="region" aria-label={`${version} transcript`} tabIndex={0}>{visibleText}</div>}
            <footer className="panel-footer">
              <div className="transcript-metrics">{editing ? <span>Ctrl + Enter to save · Esc to cancel</span> : <><span>{latest.insights.wordsPerMinute} WPM</span><span>{latest.insights.fillerCount} fillers</span><span>{latest.insights.repetitionCount} repetitions</span><span>{latest.words.length || latest.verbatimWords.length} timed words</span></>}</div>
              <div>{editing ? <>
                <button className="tool-button" disabled={savingEdit} onClick={() => setEditing(false)}><X /> Cancel</button>
                <button className="primary-button" disabled={savingEdit || !editDraft.trim() || editDraft.trim() === visibleText} onClick={() => void saveCorrection()}><Save /> {savingEdit ? "Saving" : "Save correction"}</button>
              </> : <>
                {corrected && <button className="tool-button" onClick={() => void onUpdateTranscript(latest.id, version, null)}><RotateCcw /> Restore original</button>}
                <button className="tool-button" onClick={() => onCopy(visibleText)}><Copy /> Copy</button>
                <button className="tool-button" onClick={() => onNavigate("history")}><Clock3 /> Open in history</button>
              </>}</div>
            </footer>
          </> : <div className="workbench-empty"><Mic /><strong>No transcript yet</strong><p>Use Record in the toolbar or press {settings.shortcut.split("+").join(" + ")} from any application.</p></div>}
        </section>

        <aside className="dictation-inspector">
          <section>
            <div className="inspector-heading"><span className={`state-dot phase-${status.phase}`} /><div><small>Capture status</small><strong>{status.phase === "listening" ? "Listening" : status.phase === "transcribing" ? "Transcribing" : status.engine === "ready" ? "Ready" : status.engine}</strong></div></div>
            <p className="inspector-message" role={status.phase === "error" ? "alert" : "status"} aria-live={status.phase === "error" ? "assertive" : "polite"}>{status.message}</p>
          </section>
          <section>
            <h3>Input</h3>
            <dl><div><dt>Microphone</dt><dd>{settings.inputDeviceLabel}</dd></div><div><dt>Shortcut</dt><dd><kbd>{settings.shortcut.split("CommandOrControl").join("Ctrl")}</kbd></dd></div></dl>
            <button className="inline-link" onClick={() => onNavigate("settings")}><Settings2 /> Change capture settings <ChevronRight /></button>
          </section>
          <section>
            <h3>Runtime</h3>
            <dl><div><dt>Speech</dt><dd>{model.size}</dd></div><div><dt>Magic</dt><dd>{settings.magicEnabled ? settings.magicPreset : "Off"}</dd></div><div><dt>Lifecycle</dt><dd>{settings.preloadModel ? "Resident" : "On demand"}</dd></div><div><dt>Backend</dt><dd>{status.backend ?? settings.backend}</dd></div></dl>
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
          {history.slice(0, 5).map((item) => { const itemVersion: TranscriptVersion = item.intendedText ? "intended" : "verbatim"; const itemText = deliveredText(item); return <div className="recent-row" key={item.id}><span className="source-icon">{item.magicText ? <WandSparkles /> : item.source === "dictation" ? <Mic /> : <Clock3 />}</span><p>{itemText}</p><small>{relativeTime(item.createdAt)}</small><b>{item.magicText ? "magic" : transcriptIsEdited(item, itemVersion) ? "edited" : item.mode}</b><button aria-label="Copy delivered text" onClick={() => onCopy(itemText)}><Copy /></button></div>; })}
          {!history.length && <div className="recent-empty"><Check /> Finished dictations will appear here.</div>}
        </div>
      </section>
    </div>
  );
}
