import { Check, Clipboard, Clock3, Cpu, Download, Gauge, HardDrive, Keyboard, Languages, Mic2, PlayCircle, Save, ShieldCheck, Sparkles, Terminal, Trash2, Upload, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { LANGUAGES } from "../data";
import type { AppSettings, DictationStatus, MicrophoneDevice, PlatformCapabilities } from "../types";

function SettingRow({ icon: Icon, title, description, children }: { icon: typeof Keyboard; title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><span className="setting-icon"><Icon /></span><div className="setting-copy"><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: () => void; label: string }) {
  return <button className={`toggle ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} onClick={onChange}><i /></button>;
}

export function SettingsPage({ settings, devices, capabilities, status, saving, onSave, onSetup, onLoad, onUnload, onReset }: {
  settings: AppSettings;
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  status: DictationStatus;
  saving: boolean;
  onSave: (settings: AppSettings) => Promise<void>;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const busy = ["preparing", "loading", "transcribing", "listening"].includes(status.phase);

  async function saveThen(action: () => void) {
    await onSave(draft);
    action();
  }

  return (
    <div className="content-stack settings-page">
      <section className="view-toolbar settings-toolbar"><div><strong>Preferences</strong><span>Changes are staged until saved.</span></div><button className="primary-button" disabled={saving} onClick={() => onSave(draft)}>{saving ? <Check /> : <Save />}{saving ? "Saved" : "Save changes"}</button></section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">A / CAPTURE</p><h3>Shortcut, microphone & overlay</h3></div>
        <SettingRow icon={Keyboard} title="Global shortcut" description="Electron uses the desktop portal on Wayland, including KDE Plasma."><input className="compact-input" value={draft.shortcut} onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })} /></SettingRow>
        <SettingRow icon={Mic2} title="Microphone" description="Captured through Chromium's PipeWire/PulseAudio path for stable Linux and Wayland support."><select value={draft.inputDeviceId} onChange={(event) => { const device = devices.find((item) => item.deviceId === event.target.value); setDraft({ ...draft, inputDeviceId: event.target.value, inputDeviceLabel: device?.label ?? "System default" }); }}>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></SettingRow>
        <SettingRow icon={Waypoints} title="Recording overlay" description="Show a focus-free capsule while listening and transcribing."><Toggle value={draft.showOverlay} label="Recording overlay" onChange={() => setDraft({ ...draft, showOverlay: !draft.showOverlay })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">B / TRANSCRIPTION</p><h3>What CrisperWhisper should preserve</h3></div>
        <SettingRow icon={Sparkles} title="Transcript mode" description="Dual creates a clean intended version and a faithful verbatim version from the same recording."><select value={draft.transcriptionMode} onChange={(event) => setDraft({ ...draft, transcriptionMode: event.target.value as AppSettings["transcriptionMode"] })}><option value="dual">Dual — intended + verbatim</option><option value="intended">Intended — clean writing</option><option value="verbatim">Verbatim — exactly spoken</option></select></SettingRow>
        <SettingRow icon={Clipboard} title="Version sent to cursor" description="Dual captures both; choose which one gets pasted into the active application."><div className="segmented"><button className={draft.pasteVersion === "intended" ? "active" : ""} onClick={() => setDraft({ ...draft, pasteVersion: "intended" })}>Intended</button><button className={draft.pasteVersion === "verbatim" ? "active" : ""} onClick={() => setDraft({ ...draft, pasteVersion: "verbatim" })}>Verbatim</button></div></SettingRow>
        <SettingRow icon={Languages} title="Spoken language" description="CrisperWhisper expects an explicit Whisper language code for reliable style control."><select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></SettingRow>
        <SettingRow icon={Clock3} title="Word timestamps" description="Extract precise per-word boundaries for timelines, SRT/VTT export, and Speech Lab."><Toggle value={draft.wordTimestamps} label="Word timestamps" onChange={() => setDraft({ ...draft, wordTimestamps: !draft.wordTimestamps })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">C / MODEL LIFECYCLE</p><h3>Resident engine & acceleration</h3></div>
        <SettingRow icon={PlayCircle} title="Keep selected model loaded" description="Recommended. Holds the model in RAM/VRAM so releasing the shortcut returns text immediately."><Toggle value={draft.preloadModel} label="Keep model loaded" onChange={() => setDraft({ ...draft, preloadModel: !draft.preloadModel })} /></SettingRow>
        <SettingRow icon={Cpu} title="Inference backend" description="Auto prefers Nyra's fast CTranslate2 runtime on Linux x64 and portable Transformers elsewhere."><select value={draft.backend} onChange={(event) => setDraft({ ...draft, backend: event.target.value as AppSettings["backend"] })}><option value="auto">Auto (recommended)</option><option value="ct2">CTranslate2</option><option value="transformers">Transformers / PyTorch</option></select></SettingRow>
        <SettingRow icon={Gauge} title="Compute type" description="Auto selects FP16 on supported GPUs and INT8 on CPU."><select value={draft.computeType} onChange={(event) => setDraft({ ...draft, computeType: event.target.value as AppSettings["computeType"] })}><option value="auto">Auto</option><option value="float16">FP16</option><option value="int8Float16">INT8 + FP16</option><option value="int8">INT8</option><option value="float32">FP32</option></select></SettingRow>
        <SettingRow icon={Gauge} title="Speculative decoding" description="For single-output Large + CTranslate2, use Turbo as a draft. Dual mode uses its faster batched path instead."><Toggle value={draft.speculativeDecoding} label="Speculative decoding" onChange={() => setDraft({ ...draft, speculativeDecoding: !draft.speculativeDecoding })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">D / DELIVERY & PRIVACY</p><h3>Where finished words go</h3></div>
        <SettingRow icon={Upload} title="Automatic paste" description={`Insert text at the previous cursor. Current method: ${capabilities?.pasteMethod ?? "detecting…"}.`}><Toggle value={draft.autoPaste} label="Automatic paste" onChange={() => setDraft({ ...draft, autoPaste: !draft.autoPaste })} /></SettingRow>
        <SettingRow icon={Clipboard} title="Copy every result" description="Leave the output on the clipboard even when automatic paste is disabled."><Toggle value={draft.copyToClipboard} label="Copy every result" onChange={() => setDraft({ ...draft, copyToClipboard: !draft.copyToClipboard })} /></SettingRow>
        <SettingRow icon={Clock3} title="Keep local history" description="Store transcript text and timing locally. Microphone WAV files are always deleted after inference."><Toggle value={draft.keepHistory} label="Keep local history" onChange={() => setDraft({ ...draft, keepHistory: !draft.keepHistory })} /></SettingRow>
        <SettingRow icon={HardDrive} title="Launch at login" description="Keep the global shortcut available after signing in."><Toggle value={draft.launchAtLogin} label="Launch at login" onChange={() => setDraft({ ...draft, launchAtLogin: !draft.launchAtLogin })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">E / LICENSE & RUNTIME</p><h3>Nyra weights and Python environment</h3></div>
        <div className="license-consent">
          <ShieldCheck />
          <label><input type="checkbox" checked={draft.modelLicenseAccepted} onChange={(event) => setDraft({ ...draft, modelLicenseAccepted: event.target.checked })} /><span><strong>I accept the Nyra Health model-weight license</strong><small>The app code is MIT. CrisperWhisper 2.0 standard weights are licensed for non-commercial research use; commercial use requires a license from Nyra. Pro weights are not downloaded by this app.</small><a href="https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Read the model license</a></span></label>
        </div>
        <SettingRow icon={Terminal} title="Python command" description="Python 3.11 or 3.12 is recommended. Delulu skips incompatible system Python 3.14 automatically."><input className="compact-input" value={draft.pythonCommand} onChange={(event) => setDraft({ ...draft, pythonCommand: event.target.value })} /></SettingRow>
        <div className="runtime-setup"><ShieldCheck /><div><strong>{status.engine === "ready" ? "Model resident and ready" : status.engine === "missing" ? "Runtime not installed" : `Runtime: ${status.engine}`}</strong><p>{capabilities?.wayland ? `Wayland · ${capabilities.desktop} · portal shortcut enabled` : `${capabilities?.desktop ?? "Desktop"} · ${capabilities?.sessionType ?? "session"}`}</p></div><div className="runtime-actions">
          <button className="secondary-button" disabled={busy || !draft.modelLicenseAccepted} onClick={() => void saveThen(onSetup)}><Download /> Install / repair</button>
          {status.engine === "ready" ? <button className="secondary-button" disabled={busy} onClick={onUnload}>Unload</button> : status.engine === "unloaded" ? <button className="secondary-button" disabled={busy} onClick={() => void saveThen(onLoad)}>Load</button> : null}
          <button className="danger-button" disabled={busy} onClick={() => { if (window.confirm("Remove Delulu Talks' local Python environment? Settings, history, and model caches stay untouched.")) onReset(); }}><Trash2 /> Remove env</button>
        </div></div>
      </section>
    </div>
  );
}
