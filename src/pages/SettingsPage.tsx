import { REWRITE_PRESETS } from "../rewritePresets";
import { ProfileActivationControls } from "../components/ProfileActivationControls";
import type { ProfileActivationCommand } from "../activePersonalProfile";
import { PersonalProfiles } from "../components/PersonalProfiles";
import type { PersonalProfileCommand } from "../personalProfileCommands";
import { EncryptedHistory } from "../components/EncryptedHistory";
import { ProjectVocabulary } from "../components/ProjectVocabulary";
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
import { MAGIC_MODELS } from "../data";
import { speechLanguageCapability } from "../speechCapabilities";
import { ConfirmDialog, SettingRow, Toggle } from "../components/ui";
import { LocalData } from "../components/LocalData";
import { Diagnostics } from "../components/Diagnostics";
import { HistoryRetention } from "../components/HistoryRetention";
import { MicrophoneNotice } from "../components/MicrophoneNotice";
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
  onManagePersonalProfile: (
    command: PersonalProfileCommand,
  ) => Promise<boolean>;
  onActivateProfile: (command: ProfileActivationCommand) => Promise<boolean>;
  onConfigureShortcut: () => void;
  onAuthorizePaste: () => void;
  onTestPaste: () => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onSetup: () => void;
  onCancelSetup?: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onSetupMagic: () => void;
  onCancelSetupMagic?: () => void;
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
  const languageCapability = speechLanguageCapability(s.model);
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
          ["profiles", "Profiles"],
          ["writing", "Rewriting"],
          ["advanced", "Runtime"],
          ["maintenance", "Application"],
          ["data", "Local data"],
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
      {tab === "data" && <LocalData />}
      {tab === "profiles" && (
        <>
          <ProfileActivationControls
            settings={s}
            busy={busy || saving}
            onActivate={props.onActivateProfile}
          />
          <PersonalProfiles
            settings={s}
            saving={saving}
            onManage={props.onManagePersonalProfile}
          />
        </>
      )}
      {tab === "personalization" && (
        <>
          <ProjectVocabulary />
          <VocabularyPage
            words={s.customWords}
            saving={saving}
            onChange={(customWords) => onSave({ customWords })}
          />
        </>
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
                    {s.inputDeviceLabel} (not listed)
                  </option>
                )}
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
              <MicrophoneNotice settings={s} devices={devices} />
            </SettingRow>
            <SettingRow
              title="Language hint"
              description="Choose a hint supported by the speech adapter. This guides recognition; it is not a detected-language report. Automatic language selection is not offered."
            >
              <select
                aria-label="Language"
                value={s.language}
                disabled={
                  saving || busy || !languageCapability.canSelectLanguage
                }
                onChange={(e) => save({ language: e.target.value })}
              >
                {languageCapability.languages.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              title="Spoken formatting commands"
              description="Opt in to explicit line commands: English ‘command new line/paragraph’ or Dutch ‘commando nieuwe regel/alinea’. Original speech stays available. Other language hints keep text unchanged."
            >
              {toggle(
                "spokenFormattingCommands",
                "Interpret spoken formatting commands",
                busy,
              )}
            </SettingRow>
            <SettingRow
              title="Dictation formatting"
              description={
                "Optional commands for English (en) and Dutch (nl) microphone dictation. " +
                "Say “insert comma” or “insert new paragraph”; in Dutch, “voeg komma in” or “voeg nieuwe alinea in”. " +
                "Imported audio and raw recognition stay unchanged. Quotes, code and shortcut blocks stay literal."
              }
            >
              <select
                aria-label="Dictation formatting"
                value={s.dictationFormatting ?? "preserve"}
                disabled={saving || busy}
                onChange={(e) =>
                  save({
                    dictationFormatting: e.target
                      .value as AppSettings["dictationFormatting"],
                  })
                }
              >
                <option value="preserve">Keep recognized punctuation</option>
                <option value="spoken">
                  Explicit spoken formatting commands
                </option>
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
              title="Stop after trailing silence"
              description="Stops recording after audio stays below the energy threshold. This does not recognize speech: quiet speech may stop early, and background noise may prevent stopping. It arms after 150 ms above the threshold."
            >
              {toggle(
                "trailingSilenceStopEnabled",
                "Stop after trailing silence",
                busy,
              )}
            </SettingRow>
            <SettingRow
              title="Trailing silence duration"
              description="Seconds below the threshold before stopping. Each recording uses the settings chosen when it starts; manual Stop is always available."
            >
              <input
                type="number"
                aria-label="Trailing silence duration in seconds"
                min={2}
                max={30}
                step={1}
                value={s.trailingSilenceSeconds}
                disabled={saving || busy || !s.trailingSilenceStopEnabled}
                onChange={(e) => {
                  const value = e.target.valueAsNumber;
                  if (Number.isFinite(value)) {
                    save({
                      trailingSilenceSeconds: Math.min(30, Math.max(2, value)),
                    });
                  }
                }}
              />
            </SettingRow>
            <SettingRow
              title="Silence energy threshold"
              description="Audio below this level in dB counts as silence. A lower threshold requires quieter audio."
            >
              <input
                type="number"
                aria-label="Silence energy threshold in dB"
                min={-60}
                max={-20}
                step={1}
                value={s.trailingSilenceThresholdDb}
                disabled={saving || busy || !s.trailingSilenceStopEnabled}
                onChange={(e) => {
                  const value = e.target.valueAsNumber;
                  if (Number.isFinite(value)) {
                    save({
                      trailingSilenceThresholdDb: Math.min(
                        -20,
                        Math.max(-60, value),
                      ),
                    });
                  }
                }}
              />
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
              title="Mute capture sounds"
              description="Silence the cues when recording starts and stops."
            >
              {toggle("captureSoundsMuted", "Mute capture sounds")}
            </SettingRow>
            <SettingRow
              title="Capture sound volume"
              description="Adjust the start and stop cues, even while muted."
            >
              <div className="inline-control">
                <input
                  type="range"
                  aria-label="Capture sound volume"
                  aria-valuetext={`${Math.round(s.captureSoundVolume * 100)}%`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={s.captureSoundVolume}
                  disabled={saving}
                  onChange={(e) =>
                    save({ captureSoundVolume: Number(e.target.value) })
                  }
                />
                <span>{Math.round(s.captureSoundVolume * 100)}%</span>
              </div>
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
              title="Clipboard-only mode"
              description="Copy each result, then switch to your destination and use its Paste command. No input injector or keyboard permission is needed."
            >
              <button
                className="secondary-button"
                aria-pressed={!s.autoPaste && s.copyToClipboard}
                disabled={saving || busy}
                onClick={() =>
                  save({ autoPaste: false, copyToClipboard: true })
                }
              >
                {!s.autoPaste && s.copyToClipboard
                  ? "Clipboard only enabled"
                  : "Use clipboard only"}
              </button>
            </SettingRow>
            <SettingRow
              icon={Clipboard}
              title="Paste automatically"
              description="Deliver the finished text to the app you were using."
            >
              {toggle("autoPaste", "Paste automatically")}
            </SettingRow>
            <SettingRow
              icon={Keyboard}
              title="Paste shortcut"
              description="Applies to automatic paste and Paste last; terminals are not detected automatically. Choose a shortcut supported by the focused app, or turn off automatic paste and copy to clipboard. Delulu only sends the paste shortcut, never Enter; pasted newlines may execute commands depending on the terminal."
            >
              <select
                aria-label="Paste shortcut"
                value={s.pasteShortcut}
                disabled={saving}
                onChange={(e) =>
                  save({
                    pasteShortcut: e.target
                      .value as AppSettings["pasteShortcut"],
                  })
                }
              >
                <option value="standard">
                  Standard (
                  {capabilities?.platform === "darwin" ? "Cmd+V" : "Ctrl+V"})
                </option>
                <option value="terminal">
                  Terminal (
                  {capabilities?.platform === "darwin"
                    ? "Cmd+V"
                    : "Ctrl+Shift+V"}
                  )
                </option>
              </select>
            </SettingRow>
            {s.autoPaste && capabilities?.wayland && (
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
              title="Paste-last delay"
              description="Wait before sending paste keystrokes so you can focus the intended field. Cancel from the countdown or tray. Destination insertion cannot be confirmed."
            >
              <select
                aria-label="Paste-last delay"
                value={s.pasteLastDelaySeconds}
                disabled={saving}
                onChange={(e) =>
                  save({ pasteLastDelaySeconds: Number(e.target.value) })
                }
              >
                {Array.from({ length: 30 }, (_, index) => index + 1).map(
                  (seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds} seconds
                    </option>
                  ),
                )}
              </select>
            </SettingRow>
            <SettingRow
              title="Copy results to clipboard"
              description="Keep text ready for a manual paste."
            >
              {toggle("copyToClipboard", "Copy results to clipboard")}
            </SettingRow>
            <SettingRow
              title="Restore clipboard after paste"
              description="Restore previous plain text two seconds after a successful automatic paste, if the clipboard hasn't changed. Rich content is not restored."
            >
              {toggle(
                "restoreClipboardAfterPaste",
                "Restore clipboard after paste",
                !s.autoPaste,
              )}
            </SettingRow>
            <SettingRow
              icon={ShieldCheck}
              title="Keep local history"
              description="Save transcript text on this device. When off, keep only the newest 20 session results within 8 MiB of text; the newest oversized result is kept whole. Session edits and rewrites stay in memory until exit. Existing saved history stays until cleared."
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
          <SettingRow title="Rewrite style">
            <select
              aria-label="Rewrite style"
              value={s.magicPreset}
              disabled={saving}
              onChange={(e) =>
                save({
                  magicPreset: e.target.value as AppSettings["magicPreset"],
                })
              }
            >
              {REWRITE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            title="Allow added assumptions"
            description="Let rewriting suggest additional detail. Review the result before sending it."
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
              title="Memory policy"
              description="Balanced unloads Magic before speech loads or transcribes, and runs speech and rewriting one at a time. Magic loads on demand even when Keep Magic ready is enabled. This is a predictable memory-saving policy, not automatic pressure detection."
            >
              <select
                aria-label="Memory policy"
                value={s.memoryPolicy}
                disabled={saving || busy}
                onChange={(e) =>
                  save({
                    memoryPolicy: e.target.value as AppSettings["memoryPolicy"],
                  })
                }
              >
                <option value="independent">
                  Independent models (default)
                </option>
                <option value="balanced">Balanced — prioritize speech</option>
              </select>
            </SettingRow>
            <SettingRow
              icon={Clock3}
              title="Keep speech model ready"
              description="Load the speech model at startup and keep it in GPU memory. Uses more VRAM, but avoids cold starts between recordings."
            >
              {toggle("preloadModel", "Keep speech model ready", busy)}
            </SettingRow>
            <SettingRow
              title="Keep rewrite model ready"
              description="Keep the rewrite model loaded alongside the speech model."
            >
              {toggle("preloadMagicModel", "Keep rewrite model ready", busy)}
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
            <SettingRow title="Rewrite model">
              <select
                aria-label="Rewrite model"
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
          <HistoryRetention
            policy={s.historyRetention}
            saving={saving}
            onSave={onSave}
          />
          <Diagnostics />
        </>
      )}
      {tab === "maintenance" && (
        <>
          <EncryptedHistory />
          <section className="settings-group">
            <div className="group-heading">
              <h3>Appearance</h3>
            </div>
            {capabilities?.platform === "darwin" && (
              <SettingRow
                icon={Monitor}
                title="Menu bar only"
                description="Hide the Dock icon and start with Controls closed. Reopen Controls, view status or quit from the menu bar. This window stays open when you enable the setting."
              >
                {toggle("menuBarOnly", "Menu bar only")}
              </SettingRow>
            )}
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
              <h3>Local runtime and model maintenance</h3>
              <p>Repair uses the runtime versions included with this app.</p>
            </div>
            <SettingRow
              title="Speech runtime and model"
              description={status.message}
            >
              <div className="inline-control">
                {props.onCancelSetup &&
                  ["running", "cancelling"].includes(
                    status.setupState ?? "",
                  ) && (
                    <button
                      className="secondary-button"
                      disabled={status.setupState === "cancelling"}
                      onClick={props.onCancelSetup}
                    >
                      {status.setupState === "cancelling"
                        ? "Cancelling…"
                        : "Cancel setup"}
                    </button>
                  )}
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={props.onSetup}
                >
                  Install / repair runtime
                </button>
                {status.engine === "ready" ? (
                  <button
                    className="tool-button"
                    disabled={busy}
                    onClick={props.onUnload}
                  >
                    Unload model
                  </button>
                ) : (
                  <button
                    className="tool-button"
                    disabled={busy || status.engine !== "unloaded"}
                    onClick={props.onLoad}
                  >
                    Load model
                  </button>
                )}
              </div>
            </SettingRow>
            <SettingRow
              title="Rewrite runtime and model"
              description={magicStatus.message}
            >
              <div className="inline-control">
                {props.onCancelSetupMagic &&
                  ["running", "cancelling"].includes(
                    magicStatus.setupState ?? "",
                  ) && (
                    <button
                      className="secondary-button"
                      disabled={magicStatus.setupState === "cancelling"}
                      onClick={props.onCancelSetupMagic}
                    >
                      {magicStatus.setupState === "cancelling"
                        ? "Cancelling…"
                        : "Cancel rewriting setup"}
                    </button>
                  )}
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={props.onSetupMagic}
                >
                  Install / repair runtime
                </button>
                {magicStatus.engine === "ready" ? (
                  <button
                    className="tool-button"
                    disabled={busy}
                    onClick={props.onUnloadMagic}
                  >
                    Unload model
                  </button>
                ) : (
                  <button
                    className="tool-button"
                    disabled={busy || magicStatus.engine !== "unloaded"}
                    onClick={props.onLoadMagic}
                  >
                    Load model
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
          <HistoryRetention
            policy={s.historyRetention}
            saving={saving}
            onSave={onSave}
          />
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
            You’ll need to install the speech runtime again before dictating.
            Your history, settings, and model cache stay on this device.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
