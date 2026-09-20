import { VocabularyPage } from "./VocabularyPage";
import { useState } from "react";
import {
  Clipboard,
  Clock3,
  Download,
  Keyboard,
  Mic,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { LANGUAGES, MAGIC_MODELS } from "../data";
import { ConfirmDialog, SettingRow, Toggle } from "../components/ui";
import { Diagnostics } from "../components/Diagnostics";
import type {
  AppSettings,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  PlatformCapabilities,
  ShortcutStatus,
  UpdateStatus,
} from "../types";

type Props = {
  settings: AppSettings;
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  updateStatus: UpdateStatus;
  status: DictationStatus;
  magicStatus: MagicStatus;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
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
};
export function SettingsPage(props: Props) {
  const {
    settings: s,
    devices,
    capabilities,
    shortcutStatus,
    updateStatus: update,
    status,
    magicStatus,
    saving,
    onSave,
  } = props;
  const [tab, setTab] = useState("general");
  const [remove, setRemove] = useState(false);
  const [python, setPython] = useState(s.pythonCommand);
  const [shortcut, setShortcut] = useState(s.shortcut);
  const busy =
    ["preparing", "loading", "listening", "transcribing"].includes(
      status.phase,
    ) || ["preparing", "loading", "rewriting"].includes(magicStatus.phase);
  const save = (patch: Partial<AppSettings>) => {
    void onSave(patch);
  };
  const toggle = (key: keyof AppSettings, label: string, disabled = false) => (
    <Toggle
      value={!!s[key]}
      label={label}
      disabled={saving || disabled}
      onChange={() => save({ [key]: !s[key] })}
    />
  );
  return (
    <div className="content-stack">
      <div
        className="page-tabs max-[900px]:gap-[15px] max-[900px]:flex-wrap"
        role="tablist"
        aria-label="Settings sections"
      >
        {[
          ["general", "Capture & delivery"],
          ["personalization", "Personalization"],
          ["writing", "Writing"],
          ["advanced", "Runtime"],
          ["maintenance", "Application"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span className="max-[900px]:hidden">
          {saving ? "Saving…" : "Changes save automatically"}
        </span>
      </div>
      {tab === "personalization" && (
        <VocabularyPage
          words={s.customWords}
          saving={saving}
          onChange={(customWords) => onSave({ customWords })}
        />
      )}
      {tab === "general" && (
        <>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Capture configuration</h3>
              <p>Input, shortcut and recording behavior.</p>
            </div>

            <SettingRow
              icon={Mic}
              title="Microphone"
              description="Choose the input you use for dictation."
            >
              <select
                aria-label="Microphone"
                value={s.inputDeviceId}
                disabled={saving || busy}
                onChange={(e) =>
                  save({
                    inputDeviceId: e.target.value,
                    inputDeviceLabel:
                      devices.find((d) => d.deviceId === e.target.value)
                        ?.label ?? "Microphone",
                  })
                }
              >
                {!devices.some((d) => d.deviceId === s.inputDeviceId) && (
                  <option value={s.inputDeviceId}>
                    {s.inputDeviceLabel} (disconnected)
                  </option>
                )}
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow title="Language">
              <select
                aria-label="Language"
                value={s.language}
                disabled={saving || busy}
                onChange={(e) => save({ language: e.target.value })}
              >
                {LANGUAGES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              icon={Keyboard}
              title="Dictation shortcut"
              description={shortcutStatus.message}
            >
              <div className="inline-control">
                {shortcutStatus.method === "portal" ? (
                  <>
                    <kbd>
                      {shortcutStatus.accelerator.replace("Super", "Meta")}
                    </kbd>
                    <button
                      className="secondary-button"
                      onClick={props.onConfigureShortcut}
                    >
                      Change shortcut
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      aria-label="Dictation shortcut"
                      value={shortcut}
                      onChange={(e) => setShortcut(e.target.value)}
                    />
                    <button
                      className="secondary-button"
                      disabled={saving || shortcut === s.shortcut}
                      onClick={() => save({ shortcut })}
                    >
                      Save
                    </button>
                  </>
                )}
              </div>
            </SettingRow>
            <SettingRow
              title="Recording gesture"
              description={
                shortcutStatus.method === "portal"
                  ? "Hold while speaking, or press once to start and again to stop."
                  : "This desktop provides press-only shortcuts, so recording uses toggle behavior."
              }
            >
              <select
                aria-label="Recording gesture"
                value={
                  shortcutStatus.method === "portal" ? s.shortcutMode : "toggle"
                }
                disabled={saving || shortcutStatus.method !== "portal"}
                onChange={(e) =>
                  save({
                    shortcutMode: e.target.value as AppSettings["shortcutMode"],
                  })
                }
              >
                <option value="hold">Hold to talk</option>
                <option value="toggle">Press to toggle</option>
              </select>
            </SettingRow>
            <SettingRow
              title="Recording overlay"
              description={
                capabilities?.overlayDetail ??
                "A small indicator while you speak, without taking focus."
              }
            >
              {toggle(
                "showOverlay",
                "Recording overlay",
                capabilities?.overlayMethod === "unavailable",
              )}
            </SettingRow>
            <SettingRow
              title="Launch at login"
              description="Have your shortcut ready when you sign in."
            >
              {toggle("launchAtLogin", "Launch at login")}
            </SettingRow>
          </section>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Delivery & privacy</h3>
            </div>
            <SettingRow
              icon={Clipboard}
              title="Paste automatically"
              description="Deliver the finished text to the app you were using."
            >
              {toggle("autoPaste", "Paste automatically")}
            </SettingRow>
            {capabilities?.wayland && (
              <SettingRow
                title="Keyboard permission"
                description="Allow your desktop to paste for you. For a test, focus another text field within three seconds."
              >
                <div className="inline-control">
                  <button
                    className="secondary-button"
                    onClick={props.onAuthorizePaste}
                  >
                    Allow paste
                  </button>
                  <button
                    className="secondary-button"
                    onClick={props.onTestPaste}
                  >
                    Test paste
                  </button>
                </div>
              </SettingRow>
            )}
            <SettingRow
              title="Copy results to clipboard"
              description="Keep text ready for a manual paste."
            >
              {toggle("copyToClipboard", "Copy results to clipboard")}
            </SettingRow>
            <SettingRow
              icon={ShieldCheck}
              title="Keep local history"
              description="Save transcript text on this device. Turning this off stops new saves; existing history stays until you clear it."
            >
              {toggle("keepHistory", "Keep local history")}
            </SettingRow>
          </section>
        </>
      )}
      {tab === "writing" && (
        <section className="settings-group">
          <div className="group-heading">
            <h3>Optional automatic rewriting</h3>
            <p>
              Native clean dictation works without this. You can always rewrite
              individual results on demand.
            </p>
          </div>
          <SettingRow
            icon={Sparkles}
            title="Rewrite after dictation"
            description="Polish each result through a second local model before delivery."
          >
            {toggle("magicEnabled", "Rewrite after dictation", busy)}
          </SettingRow>
          <SettingRow title="Writing style">
            <select
              aria-label="Writing style"
              value={s.magicPreset}
              disabled={saving}
              onChange={(e) =>
                save({
                  magicPreset: e.target.value as AppSettings["magicPreset"],
                })
              }
            >
              <option value="polish">Polished</option>
              <option value="concise">Concise</option>
              <option value="structured">Structured</option>
              <option value="prompt">Prompt builder</option>
            </select>
          </SettingRow>
          <SettingRow
            title="Allow added assumptions"
            description="Let Magic suggest additional detail. Review the result before sending it."
          >
            {toggle("magicAllowInferences", "Allow added assumptions")}
          </SettingRow>
        </section>
      )}
      {tab === "advanced" && (
        <>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Memory & performance</h3>
              <p>
                Defaults are a good starting point. Adjust when you need to.
              </p>
            </div>
            <SettingRow
              icon={Clock3}
              title="Keep speech ready"
              description="Use more memory to avoid loading the model for your next recording."
            >
              {toggle("preloadModel", "Keep speech ready", busy)}
            </SettingRow>
            <SettingRow
              title="Keep Magic ready"
              description="Keep the writing model loaded alongside speech."
            >
              {toggle("preloadMagicModel", "Keep Magic ready", busy)}
            </SettingRow>
            <SettingRow title="Release idle models after">
              <select
                aria-label="Idle unload delay"
                value={s.modelIdleMinutes}
                disabled={saving}
                onChange={(e) =>
                  save({ modelIdleMinutes: Number(e.target.value) })
                }
              >
                {[1, 5, 15, 30, 60].map((n) => (
                  <option value={n} key={n}>
                    {n} minutes
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow title="Magic model">
              <select
                aria-label="Magic model"
                value={s.magicModel}
                disabled={saving || busy}
                onChange={(e) =>
                  save({
                    magicModel: e.target.value as AppSettings["magicModel"],
                  })
                }
              >
                {MAGIC_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.memory}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              title="Python command"
              description="New installs use Python 3.11–3.13."
            >
              <div className="inline-control">
                <input
                  aria-label="Python command"
                  value={python}
                  onChange={(e) => setPython(e.target.value)}
                />
                <button
                  className="secondary-button"
                  disabled={
                    saving ||
                    busy ||
                    python === s.pythonCommand ||
                    !python.trim()
                  }
                  onClick={() => save({ pythonCommand: python })}
                >
                  Save
                </button>
              </div>
            </SettingRow>
          </section>
          <Diagnostics />
        </>
      )}
      {tab === "maintenance" && (
        <>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Appearance</h3>
            </div>
            <SettingRow
              icon={Monitor}
              title="Appearance"
              description="Use the desktop theme or select light / dark."
            >
              <div className="segmented" role="group" aria-label="Appearance">
                {(["system", "light", "dark"] as const).map((theme) => (
                  <button
                    key={theme}
                    aria-pressed={s.theme === theme}
                    className={s.theme === theme ? "active" : ""}
                    disabled={saving}
                    onClick={() => save({ theme })}
                  >
                    {theme}
                  </button>
                ))}
              </div>
            </SettingRow>
          </section>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Application updates</h3>
              <p>App updates are separate from your downloaded models.</p>
            </div>
            <SettingRow
              icon={RefreshCw}
              title={`Delulu Talks ${update.currentVersion || "development"}`}
              description={update.message}
            >
              <div className="inline-control">
                {update.phase === "available" ? (
                  <button
                    className="primary-button"
                    onClick={props.onDownloadUpdate}
                  >
                    <Download />
                    Download {update.version}
                  </button>
                ) : update.phase === "downloaded" ? (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={props.onInstallUpdate}
                  >
                    Restart & update
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    disabled={
                      update.phase === "unsupported" ||
                      update.phase === "checking" ||
                      update.phase === "downloading"
                    }
                    onClick={props.onCheckForUpdates}
                  >
                    {update.phase === "checking"
                      ? "Checking…"
                      : "Check for updates"}
                  </button>
                )}
              </div>
            </SettingRow>
            {update.phase === "downloading" && (
              <div className="progress-panel">
                <progress
                  aria-label="Update download"
                  max={100}
                  value={update.percent ?? 0}
                />
                <p>{Math.round(update.percent ?? 0)}% downloaded</p>
              </div>
            )}
            <div className="px-6 py-4 text-[12px]">
              <a
                href="https://github.com/JEMostert/delulu-talks/releases"
                target="_blank"
                rel="noreferrer"
              >
                View releases & manual downloads ↗
              </a>
            </div>
          </section>
          <section className="settings-group">
            <div className="group-heading">
              <h3>Local engine maintenance</h3>
              <p>Repair uses the runtime versions included with this app.</p>
            </div>
            <SettingRow title="Speech engine" description={status.message}>
              <div className="inline-control">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={props.onSetup}
                >
                  Install / repair
                </button>
                {status.engine === "ready" ? (
                  <button
                    className="tool-button"
                    disabled={busy}
                    onClick={props.onUnload}
                  >
                    Unload
                  </button>
                ) : (
                  <button
                    className="tool-button"
                    disabled={busy || status.engine !== "unloaded"}
                    onClick={props.onLoad}
                  >
                    Load
                  </button>
                )}
              </div>
            </SettingRow>
            <SettingRow title="Magic engine" description={magicStatus.message}>
              <div className="inline-control">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={props.onSetupMagic}
                >
                  Install / repair
                </button>
                {magicStatus.engine === "ready" ? (
                  <button
                    className="tool-button"
                    disabled={busy}
                    onClick={props.onUnloadMagic}
                  >
                    Unload
                  </button>
                ) : (
                  <button
                    className="tool-button"
                    disabled={busy || magicStatus.engine !== "unloaded"}
                    onClick={props.onLoadMagic}
                  >
                    Load
                  </button>
                )}
              </div>
            </SettingRow>
            <SettingRow
              title="Remove runtime"
              description="Remove the Python environment. Your settings, history and downloaded model cache are preserved."
            >
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                <Trash2 />
                Remove runtime
              </button>
            </SettingRow>
          </section>
          <Diagnostics />
        </>
      )}
      {remove && (
        <ConfirmDialog
          title="Remove the local runtime?"
          confirmLabel="Remove runtime"
          onClose={() => setRemove(false)}
          onConfirm={props.onReset}
        >
          <p>
            You’ll need to install the engines again before dictating. Your
            history, settings, and model cache stay on this device.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
