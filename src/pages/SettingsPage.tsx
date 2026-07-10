import { Check, ClipboardPaste, Clock3, Download, Keyboard, Mic2, Save, ShieldCheck, SlidersHorizontal, Terminal, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { LANGUAGES, PARAKEET_LANGUAGES } from "../data";
import type { AppSettings } from "../types";

function SettingRow({ icon: Icon, title, description, children }: { icon: typeof Keyboard; title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><span className="setting-icon"><Icon /></span><div className="setting-copy"><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

export function SettingsPage({ settings, devices, saving, onSave, onSetup, onReset }: { settings: AppSettings; devices: string[]; saving: boolean; onSave: (settings: AppSettings) => void; onSetup: () => void; onReset: () => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const availableLanguages = draft.model === "parakeetTdt06bV3"
    ? LANGUAGES.filter(([code]) => PARAKEET_LANGUAGES.has(code))
    : LANGUAGES;
  const languageDescription = draft.model === "parakeetTdt06bV3"
    ? "Choose a preferred language to condition Parakeet, or use automatic detection."
    : "Cohere needs a language; MOSS and Nemotron can detect it.";

  return (
    <div className="content-stack settings-page">
      <section className="page-intro"><div><span className="hello-pill"><SlidersHorizontal /> Make it yours</span><h2>Small controls. Big flow.</h2><p>Dial in how Delulu listens, writes, and hands your words back.</p></div><button className="primary-button" disabled={saving} onClick={() => onSave(draft)}>{saving ? <Check /> : <Save />}{saving ? "Saved" : "Save changes"}</button></section>

      <section className="settings-group paper-card"><div className="group-heading"><p className="eyebrow">CAPTURE</p><h3>Listening & shortcuts</h3></div>
        <SettingRow icon={Keyboard} title="Global shortcut" description="Click the field and type the combination you want."><input className="compact-input" value={draft.shortcut} onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })} /></SettingRow>
        <SettingRow icon={Mic2} title="Microphone" description="The input Delulu records from."><select value={draft.inputDevice} onChange={(event) => setDraft({ ...draft, inputDevice: event.target.value })}>{devices.map((device) => <option key={device} value={device}>{device === "default" ? "System default" : device}</option>)}</select></SettingRow>
        <SettingRow icon={Mic2} title="Recording behavior" description="Hold for quick dictation; if KDE misses release, press once more to stop. Toggle suits longer thoughts."><div className="segmented"><button className={draft.recordingMode === "hold" ? "active" : ""} onClick={() => setDraft({ ...draft, recordingMode: "hold" })}>Hold</button><button className={draft.recordingMode === "toggle" ? "active" : ""} onClick={() => setDraft({ ...draft, recordingMode: "toggle" })}>Toggle</button></div></SettingRow>
        <SettingRow icon={Volume2} title="Recording sounds" description="Play Handy's marimba cue before recording starts and after it stops."><button className={`toggle ${draft.recordingSounds ? "on" : ""}`} onClick={() => setDraft({ ...draft, recordingSounds: !draft.recordingSounds })}><i /></button></SettingRow>
      </section>

      <section className="settings-group paper-card"><div className="group-heading"><p className="eyebrow">OUTPUT</p><h3>How your words land</h3></div>
        <SettingRow icon={SlidersHorizontal} title="Language" description={languageDescription}><select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}>{availableLanguages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></SettingRow>
        <SettingRow icon={SlidersHorizontal} title="Output style" description="Smart preserves speakers with MOSS and stays clean for dictation."><select value={draft.outputStyle} onChange={(event) => setDraft({ ...draft, outputStyle: event.target.value as AppSettings["outputStyle"] })}><option value="smart">Smart</option><option value="plain">Plain text</option><option value="speakerAware">Speaker-aware</option></select></SettingRow>
        <SettingRow icon={SlidersHorizontal} title="Automatic paste" description="Insert the transcript wherever your cursor was."><button className={`toggle ${draft.autoPaste ? "on" : ""}`} onClick={() => setDraft({ ...draft, autoPaste: !draft.autoPaste })}><i /></button></SettingRow>
        <SettingRow icon={ClipboardPaste} title="Paste method" description="Use the standard paste shortcut, or Ctrl+Shift+V for terminals and apps that require it."><select value={draft.pasteMethod} onChange={(event) => setDraft({ ...draft, pasteMethod: event.target.value as AppSettings["pasteMethod"] })}><option value="ctrlV">Ctrl+V</option><option value="ctrlShiftV">Ctrl+Shift+V</option></select></SettingRow>
        <SettingRow icon={Clock3} title="Keep local history" description="Store finished transcripts on this device for quick reuse."><button className={`toggle ${draft.keepHistory ? "on" : ""}`} onClick={() => setDraft({ ...draft, keepHistory: !draft.keepHistory })}><i /></button></SettingRow>
        <SettingRow icon={SlidersHorizontal} title="Punctuation" description="Return readable sentences instead of raw word streams."><button className={`toggle ${draft.punctuation ? "on" : ""}`} onClick={() => setDraft({ ...draft, punctuation: !draft.punctuation })}><i /></button></SettingRow>
      </section>

      <section className="settings-group paper-card"><div className="group-heading"><p className="eyebrow">LOCAL RUNTIME</p><h3>Model environment</h3></div>
        <SettingRow icon={Terminal} title="Python command" description="Python 3.11 or 3.12 is recommended for the local model environment."><input className="compact-input" value={draft.pythonCommand} onChange={(event) => setDraft({ ...draft, pythonCommand: event.target.value })} /></SettingRow>
        <div className="runtime-setup"><ShieldCheck /><div><strong>Private by default</strong><p>Audio and transcripts stay on your machine. Hugging Face is only contacted to download model weights.</p></div><div className="runtime-actions"><button className="secondary-button" onClick={onSetup}><Download /> Build environment</button><button className="danger-button" onClick={() => { if (window.confirm("Remove Delulu Talks' local Python environment? Your transcripts and downloaded model cache will stay untouched.")) onReset(); }}><Trash2 /> Remove Python env</button></div></div>
      </section>
    </div>
  );
}
