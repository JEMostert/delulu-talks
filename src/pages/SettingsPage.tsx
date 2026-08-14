import { Check, Clipboard, Clock3, Cpu, Download, Gauge, HardDrive, Keyboard, Languages, Mic2, PlayCircle, RefreshCw, RotateCw, Save, ShieldCheck, Sparkles, Terminal, Trash2, Upload, WandSparkles, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { LANGUAGES, MAGIC_MODELS } from "../data";
import type { AppSettings, DictationStatus, MagicStatus, MicrophoneDevice, PlatformCapabilities, ShortcutStatus, UpdateStatus } from "../types";

function SettingRow({ icon: Icon, title, description, children }: { icon: typeof Keyboard; title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><span className="setting-icon"><Icon /></span><div className="setting-copy"><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

function Toggle({ value, onChange, label, disabled = false }: { value: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button className={`toggle ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={onChange}><i /></button>;
}

export function SettingsPage({ settings, devices, capabilities, shortcutStatus, updateStatus, status, magicStatus, saving, onSave, onConfigureShortcut, onAuthorizePaste, onTestPaste, onCheckForUpdates, onDownloadUpdate, onInstallUpdate, onSetup, onLoad, onUnload, onSetupMagic, onLoadMagic, onUnloadMagic, onReset }: {
  settings: AppSettings;
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  updateStatus: UpdateStatus;
  status: DictationStatus;
  magicStatus: MagicStatus;
  saving: boolean;
  onSave: (settings: AppSettings) => Promise<void>;
  onConfigureShortcut: () => void;
  onAuthorizePaste: () => void;
  onTestPaste: () => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onSetupMagic: () => void;
  onLoadMagic: () => void;
  onUnloadMagic: () => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const busy = ["preparing", "loading", "transcribing", "listening"].includes(status.phase) || ["preparing", "loading", "rewriting"].includes(magicStatus.phase);

  async function saveThen(action: () => void) {
    await onSave(draft);
    action();
  }

  return (
    <div className="content-stack settings-page">
      <section className="view-toolbar settings-toolbar"><div><strong>Preferences</strong><span>Changes are staged until saved.</span></div><button className="primary-button" disabled={saving} onClick={() => onSave(draft)}>{saving ? <Check /> : <Save />}{saving ? "Saved" : "Save changes"}</button></section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">A / CAPTURE</p><h3>Shortcut, microphone & recording pill</h3></div>
        <SettingRow icon={Keyboard} title="Global shortcut" description={shortcutStatus.message}><div className="shortcut-setting">{shortcutStatus.method === "portal" ? <><kbd>{shortcutStatus.accelerator}</kbd><button className="secondary-button" disabled={!shortcutStatus.registered} onClick={onConfigureShortcut}>Change in system</button></> : <input className="compact-input" aria-label="Global shortcut" value={draft.shortcut} onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })} />}<span className={shortcutStatus.registered ? "ready" : "error"}><i />{shortcutStatus.registered ? `${shortcutStatus.method} ready` : "not registered"}</span></div></SettingRow>
        <SettingRow icon={PlayCircle} title="Shortcut behavior" description="Hold starts on key-down and stops on release. Toggle starts and stops on separate presses."><select aria-label="Shortcut behavior" value={draft.shortcutMode} onChange={(event) => setDraft({ ...draft, shortcutMode: event.target.value as AppSettings["shortcutMode"] })}><option value="hold">Hold to dictate (recommended)</option><option value="toggle">Press once to start, again to stop</option></select></SettingRow>
        <SettingRow icon={Mic2} title="Microphone" description="Captured through Chromium's PipeWire/PulseAudio path for stable Linux and Wayland support."><select aria-label="Microphone" value={draft.inputDeviceId} onChange={(event) => { const device = devices.find((item) => item.deviceId === event.target.value); setDraft({ ...draft, inputDeviceId: event.target.value, inputDeviceLabel: device?.label ?? "System default" }); }}>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></SettingRow>
        <SettingRow icon={Waypoints} title="Recording pill" description={capabilities?.overlayMethod === "layer-shell" ? "Native Wayland overlay: bottom-anchored, focus-free, click-through, with a live listening meter." : capabilities?.overlayDetail ?? "Checking native overlay support…"}><Toggle value={draft.showOverlay} label="Recording pill" disabled={capabilities?.overlayMethod === "unavailable"} onChange={() => setDraft({ ...draft, showOverlay: !draft.showOverlay })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">B / TRANSCRIPTION</p><h3>What CrisperWhisper should preserve</h3></div>
        <SettingRow icon={Sparkles} title="Transcript mode" description="Dual creates a clean intended version and a faithful verbatim version from the same recording."><select aria-label="Transcript mode" value={draft.transcriptionMode} onChange={(event) => setDraft({ ...draft, transcriptionMode: event.target.value as AppSettings["transcriptionMode"] })}><option value="dual">Dual — intended + verbatim</option><option value="intended">Intended — clean writing</option><option value="verbatim">Verbatim — exactly spoken</option></select></SettingRow>
        <SettingRow icon={Clipboard} title="Version sent to cursor" description="Dual captures both; choose which one gets pasted into the active application."><div className="segmented" role="group" aria-label="Version sent to cursor"><button className={draft.pasteVersion === "intended" ? "active" : ""} aria-pressed={draft.pasteVersion === "intended"} onClick={() => setDraft({ ...draft, pasteVersion: "intended" })}>Intended</button><button className={draft.pasteVersion === "verbatim" ? "active" : ""} aria-pressed={draft.pasteVersion === "verbatim"} onClick={() => setDraft({ ...draft, pasteVersion: "verbatim" })}>Verbatim</button></div></SettingRow>
        <SettingRow icon={Languages} title="Spoken language" description="CrisperWhisper expects an explicit Whisper language code for reliable style control."><select aria-label="Spoken language" value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></SettingRow>
        <SettingRow icon={Clock3} title="Word timestamps" description="Extract precise per-word boundaries for timelines, SRT/VTT export, and Speech Lab."><Toggle value={draft.wordTimestamps} label="Word timestamps" onChange={() => setDraft({ ...draft, wordTimestamps: !draft.wordTimestamps })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">C / MODEL LIFECYCLE</p><h3>Resident engine & acceleration</h3></div>
        <SettingRow icon={PlayCircle} title="Keep speech model loaded" description="Recommended. Holds CrisperWhisper in memory so releasing the shortcut returns text immediately."><Toggle value={draft.preloadModel} label="Keep speech model loaded" onChange={() => setDraft({ ...draft, preloadModel: !draft.preloadModel })} /></SettingRow>
        <SettingRow icon={WandSparkles} title="Magic after dictation" description="When enabled: speech → Magic rewrite → clipboard and automatic paste. Turn it off to deliver the speech transcript directly."><Toggle value={draft.magicEnabled} label="Magic after dictation" onChange={() => setDraft({ ...draft, magicEnabled: !draft.magicEnabled })} /></SettingRow>
        <SettingRow icon={Cpu} title="Magic model" description="Official Qwen 3.5 checkpoints below the 8B ceiling. Larger options improve prompt and coding-context rewrites."><select aria-label="Magic model" disabled={!draft.magicEnabled} value={draft.magicModel} onChange={(event) => setDraft({ ...draft, magicModel: event.target.value as AppSettings["magicModel"] })}>{MAGIC_MODELS.map((model) => <option key={model.id} value={model.id}>{model.name} — {model.role} · {model.memory}</option>)}</select></SettingRow>
        <SettingRow icon={Sparkles} title="Dictation rewrite style" description="Applied automatically before shortcut results are copied or pasted."><select aria-label="Dictation Magic style" disabled={!draft.magicEnabled} value={draft.magicPreset} onChange={(event) => setDraft({ ...draft, magicPreset: event.target.value as AppSettings["magicPreset"] })}><option value="polish">Polish — natural cleanup</option><option value="concise">Concise — shorter and direct</option><option value="structured">Detailed — structured writing</option><option value="prompt">Prompt builder — actionable requirements</option></select></SettingRow>
        <SettingRow icon={ShieldCheck} title="Allow inferred details" description="Off preserves facts. On lets Magic add useful constraints and examples; review the delivered result before relying on them."><Toggle value={draft.magicAllowInferences} label="Allow inferred Magic details" onChange={() => setDraft({ ...draft, magicAllowInferences: !draft.magicAllowInferences })} /></SettingRow>
        <SettingRow icon={PlayCircle} title="Keep Magic model loaded" description="Keeps Qwen resident beside the speech model for instant rewrites. Disable this on memory-constrained systems."><Toggle value={draft.preloadMagicModel} label="Keep Magic model loaded" onChange={() => setDraft({ ...draft, preloadMagicModel: !draft.preloadMagicModel })} /></SettingRow>
        <SettingRow icon={Clock3} title="Idle unload delay" description="Models that are not pinned stay warm for this long after their last transcription or rewrite."><select aria-label="Idle unload delay" value={draft.modelIdleMinutes} onChange={(event) => setDraft({ ...draft, modelIdleMinutes: Number(event.target.value) })}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={15}>15 minutes (recommended)</option><option value={30}>30 minutes</option><option value={60}>1 hour</option></select></SettingRow>
        <SettingRow icon={Cpu} title="Inference backend" description="Auto prefers Nyra's fast CTranslate2 runtime on Linux x64 and portable Transformers elsewhere."><select aria-label="Inference backend" value={draft.backend} onChange={(event) => setDraft({ ...draft, backend: event.target.value as AppSettings["backend"] })}><option value="auto">Auto (recommended)</option><option value="ct2">CTranslate2</option><option value="transformers">Transformers / PyTorch</option></select></SettingRow>
        <SettingRow icon={Gauge} title="Compute type" description="Auto selects FP16 on supported GPUs and INT8 on CPU."><select aria-label="Compute type" value={draft.computeType} onChange={(event) => setDraft({ ...draft, computeType: event.target.value as AppSettings["computeType"] })}><option value="auto">Auto</option><option value="float16">FP16</option><option value="int8Float16">INT8 + FP16</option><option value="int8">INT8</option><option value="float32">FP32</option></select></SettingRow>
        <SettingRow icon={Gauge} title="Speculative decoding" description="For single-output Large + CTranslate2, use Turbo as a draft. Dual mode uses its faster batched path instead."><Toggle value={draft.speculativeDecoding} label="Speculative decoding" onChange={() => setDraft({ ...draft, speculativeDecoding: !draft.speculativeDecoding })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">D / DELIVERY & PRIVACY</p><h3>Where finished words go</h3></div>
        <SettingRow icon={Upload} title="Automatic paste" description={`Insert text at the previous cursor. Current method: ${capabilities?.pasteMethod ?? "detecting…"}.`}><div className="inline-control"><Toggle value={draft.autoPaste} label="Automatic paste" onChange={() => setDraft({ ...draft, autoPaste: !draft.autoPaste })} />{capabilities?.pasteMethod === "wayland-portal" && <><button className="secondary-button" onClick={onAuthorizePaste}>{settings.pastePortalToken ? "Refresh permission" : "Allow keyboard control"}</button><button className="secondary-button" disabled={!settings.pastePortalToken} title="After clicking, focus a text field within three seconds" onClick={onTestPaste}>Test paste</button></>}</div></SettingRow>
        <SettingRow icon={Clipboard} title="Copy every result" description="Leave the output on the clipboard even when automatic paste is disabled."><Toggle value={draft.copyToClipboard} label="Copy every result" onChange={() => setDraft({ ...draft, copyToClipboard: !draft.copyToClipboard })} /></SettingRow>
        <SettingRow icon={Clock3} title="Keep local history" description="Store transcript text and timing locally. Microphone WAV files are always deleted after inference."><Toggle value={draft.keepHistory} label="Keep local history" onChange={() => setDraft({ ...draft, keepHistory: !draft.keepHistory })} /></SettingRow>
        <SettingRow icon={HardDrive} title="Launch at login" description="Keep the global shortcut available after signing in."><Toggle value={draft.launchAtLogin} label="Launch at login" onChange={() => setDraft({ ...draft, launchAtLogin: !draft.launchAtLogin })} /></SettingRow>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">E / LICENSE & RUNTIME</p><h3>Model licenses & shared Python environment</h3></div>
        <div className="license-consent">
          <ShieldCheck />
          <label><input type="checkbox" checked={draft.modelLicenseAccepted} onChange={(event) => setDraft({ ...draft, modelLicenseAccepted: event.target.checked })} /><span><strong>I accept the Nyra Health model-weight license</strong><small>The app code is MIT. CrisperWhisper 2.0 standard weights are licensed for non-commercial research use; commercial use requires a license from Nyra. Pro weights are not downloaded by this app.</small><a href="https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Read the model license</a></span></label>
        </div>
        <SettingRow icon={Terminal} title="Python command" description="Python 3.11 or 3.12 is recommended. Delulu skips incompatible system Python 3.14 automatically."><input className="compact-input" aria-label="Python command" value={draft.pythonCommand} onChange={(event) => setDraft({ ...draft, pythonCommand: event.target.value })} /></SettingRow>
        <div className="runtime-setup"><ShieldCheck /><div><strong>{status.engine === "ready" ? "Model resident and ready" : status.engine === "missing" ? "Runtime not installed" : `Runtime: ${status.engine}`}</strong><p>{capabilities?.wayland ? `Wayland · ${capabilities.desktop} · portal shortcut enabled` : `${capabilities?.desktop ?? "Desktop"} · ${capabilities?.sessionType ?? "session"}`}</p></div><div className="runtime-actions">
          <button className="secondary-button" disabled={busy || !draft.modelLicenseAccepted} onClick={() => void saveThen(onSetup)}><Download /> Install / repair</button>
          {status.engine === "ready" ? <button className="secondary-button" disabled={busy} onClick={onUnload}>Unload</button> : status.engine === "unloaded" ? <button className="secondary-button" disabled={busy} onClick={() => void saveThen(onLoad)}>Load</button> : null}
          <button className="danger-button" disabled={busy} onClick={() => { if (window.confirm("Remove Delulu Talks' local Python environment? Settings, history, and model caches stay untouched.")) onReset(); }}><Trash2 /> Remove env</button>
        </div></div>
        <div className="runtime-setup magic-runtime-setup"><WandSparkles /><div><strong>{magicStatus.engine === "ready" ? "Magic model resident and ready" : magicStatus.engine === "missing" ? "Magic runtime not installed" : `Magic runtime: ${magicStatus.engine}`}</strong><p>{magicStatus.message}</p></div><div className="runtime-actions">
          <button className="secondary-button" disabled={busy || !draft.magicEnabled} onClick={() => void saveThen(onSetupMagic)}><Download /> Install / repair Magic</button>
          {magicStatus.engine === "ready" ? <button className="secondary-button" disabled={busy} onClick={onUnloadMagic}>Unload</button> : magicStatus.engine === "unloaded" ? <button className="secondary-button" disabled={busy || !draft.magicEnabled} onClick={() => void saveThen(onLoadMagic)}>Load</button> : null}
        </div></div>
      </section>

      <section className="settings-group"><div className="group-heading"><p className="eyebrow">F / APPLICATION</p><h3>Version & updates</h3></div>
        <SettingRow icon={RefreshCw} title={`Delulu Talks ${updateStatus.currentVersion || "development"}`} description={updateStatus.message}>
          <div className="inline-control update-controls">
            {updateStatus.phase === "available" && <button className="primary-button" onClick={onDownloadUpdate}><Download /> Download {updateStatus.version}</button>}
            {updateStatus.phase === "downloaded" && <button className="primary-button" onClick={onInstallUpdate}><RotateCw /> Restart & update</button>}
            {updateStatus.phase === "downloading" && <span className="update-percent">{Math.round(updateStatus.percent ?? 0)}%</span>}
            {!(["available", "downloaded", "downloading"] as UpdateStatus["phase"][]).includes(updateStatus.phase) && <button className="secondary-button" disabled={updateStatus.phase === "checking" || updateStatus.phase === "unsupported"} onClick={onCheckForUpdates}><RefreshCw className={updateStatus.phase === "checking" ? "spin" : ""} /> {updateStatus.phase === "checking" ? "Checking…" : "Check now"}</button>}
          </div>
        </SettingRow>
      </section>
    </div>
  );
}
