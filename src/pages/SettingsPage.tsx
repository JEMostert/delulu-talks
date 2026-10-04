import { REWRITE_PRESETS } from "../rewritePresets";
import { ProfileActivationControls } from "../components/ProfileActivationControls";
import type { ProfileActivationCommand } from "../activePersonalProfile";
import { PersonalProfiles } from "../components/PersonalProfiles";
import type { PersonalProfileCommand } from "../personalProfileCommands";
import { EncryptedHistory } from "../components/EncryptedHistory";
import { SelectedTextWorkflow } from "../components/SelectedTextWorkflow";
import { useEffect, useState } from "react";
import type React from "react";
import {
  Check,
  Clipboard,
  Clock3,
  Languages,
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
import {
  ConfirmDialog,
  NumberField,
  RangeField,
  SettingRow,
  Tabs,
  Toggle,
} from "../components/ui";
import { LocalData } from "../components/LocalData";
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

const SETTINGS_TABS = [
  ["capture", "Recording"],
  ["delivery", "Delivery"],
  ["writing", "Rewriting"],
  ["profiles", "Profiles"],
  ["performance", "Performance"],
  ["app", "App"],
  ["data", "Local data"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];

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
  onOpenModels: () => void;
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
  const [tab, setTab] = useState<SettingsTab>("capture");
  useEffect(() => {
    const content = document.getElementById("page-content");
    if (content) content.scrollTop = 0;
  }, [tab]);
  const [remove, setRemove] = useState(false);
  const [python, setPython] = useState(s.pythonCommand);
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setPython(s.pythonCommand), [s.pythonCommand]);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const languageCapability = speechLanguageCapability(s.model);
  const busy =
    ["preparing", "loading", "listening", "paused", "transcribing"].includes(
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
  const group = (
    title: string,
    children: React.ReactNode,
    description?: string,
  ) => (
    <section className="settings-group">
      <div className="group-heading">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
  const clipboardOnly = !s.autoPaste && s.copyToClipboard;
  return (
    <div className="settings-layout">
      <Tabs
        className="settings-tabs"
        label="Settings sections"
        idPrefix="settings"
        tabs={SETTINGS_TABS}
        value={tab}
        onChange={setTab}
        trailing={
          <span className="settings-saving" aria-live="polite">
            {saving ? "Saving…" : ""}
          </span>
        }
      />
      <div
        className="settings-panel content-stack"
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "capture" && (
          <>
            {group(
              "Microphone and language",
              <>
                <SettingRow
                  icon={Mic}
                  title="Microphone"
                  description="The input used for dictation."
                >
                  <div className="flex flex-col items-end gap-1">
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
                  </div>
                </SettingRow>
                <SettingRow
                  icon={Languages}
                  title="Language"
                  description="Guides recognition toward one language."
                  help="This is a hint for the speech model, not a detected-language report. Automatic language selection is not offered."
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
              </>,
            )}
            {group(
              "Shortcut",
              <>
                <SettingRow
                  icon={Keyboard}
                  title="Dictation shortcut"
                  description={
                    shortcutStatus.registered
                      ? "Works in every app."
                      : "Not registered — choose another combination."
                  }
                  help={shortcutStatus.message}
                >
                  <div className="inline-control">
                    {shortcutStatus.method === "portal" ? (
                      <>
                        <kbd>
                          {shortcutStatus.accelerator.replace("Super", "Meta")}
                        </kbd>
                        <button
                          className="secondary-button compact"
                          onClick={props.onConfigureShortcut}
                        >
                          Change
                        </button>
                      </>
                    ) : (
                      <>
                        <input
                          className="w-44"
                          aria-label="Dictation shortcut"
                          value={shortcut}
                          onChange={(e) => setShortcut(e.target.value)}
                        />
                        <button
                          className="secondary-button compact"
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
                      ? "Hold while speaking, or press to start and stop."
                      : "This desktop only reports presses, so recording toggles."
                  }
                >
                  <select
                    aria-label="Recording gesture"
                    value={
                      shortcutStatus.method === "portal"
                        ? s.shortcutMode
                        : "toggle"
                    }
                    disabled={saving || shortcutStatus.method !== "portal"}
                    onChange={(e) =>
                      save({
                        shortcutMode: e.target
                          .value as AppSettings["shortcutMode"],
                      })
                    }
                  >
                    <option value="hold">Hold to talk</option>
                    <option value="toggle">Press to toggle</option>
                  </select>
                </SettingRow>
              </>,
            )}
            {group(
              "While recording",
              <>
                <SettingRow
                  title="Stop after silence"
                  description="End the recording automatically when you stop talking."
                  help="Uses an energy threshold, not speech recognition: quiet speech may stop early and background noise may prevent stopping. It arms after 150 ms above the threshold, and manual Stop always works."
                >
                  {toggle(
                    "trailingSilenceStopEnabled",
                    "Stop after silence",
                    busy,
                  )}
                </SettingRow>
                {s.trailingSilenceStopEnabled && (
                  <>
                    <SettingRow
                      title="Silence duration"
                      description="Seconds of quiet before stopping."
                    >
                      <NumberField
                        label="Silence duration in seconds"
                        min={2}
                        max={30}
                        value={s.trailingSilenceSeconds}
                        disabled={busy}
                        onCommit={(trailingSilenceSeconds) =>
                          save({ trailingSilenceSeconds })
                        }
                      />
                    </SettingRow>
                    <SettingRow
                      title="Silence threshold"
                      description="Audio below this level (dB) counts as quiet."
                    >
                      <NumberField
                        label="Silence threshold in dB"
                        min={-60}
                        max={-20}
                        value={s.trailingSilenceThresholdDb}
                        disabled={busy}
                        onCommit={(trailingSilenceThresholdDb) =>
                          save({ trailingSilenceThresholdDb })
                        }
                      />
                    </SettingRow>
                  </>
                )}
                <SettingRow
                  title="Recording overlay"
                  description="A small indicator that never takes focus."
                  help={capabilities?.overlayDetail}
                >
                  {toggle(
                    "showOverlay",
                    "Recording overlay",
                    capabilities?.overlayMethod === "unavailable",
                  )}
                </SettingRow>
                <SettingRow
                  title="Mute capture sounds"
                  description="No cue when recording starts and stops."
                >
                  {toggle("captureSoundsMuted", "Mute capture sounds")}
                </SettingRow>
                {!s.captureSoundsMuted && (
                  <SettingRow title="Cue volume">
                    <RangeField
                      label="Capture sound volume"
                      min={0}
                      max={1}
                      step={0.01}
                      value={s.captureSoundVolume}
                      format={(value) => `${Math.round(value * 100)}%`}
                      onCommit={(captureSoundVolume) =>
                        save({ captureSoundVolume })
                      }
                    />
                  </SettingRow>
                )}
              </>,
            )}
            {group(
              "Formatting",
              <>
                <SettingRow
                  title="Spoken line commands"
                  description="Say “command new line” or “commando nieuwe alinea”."
                  help="English ‘command new line/paragraph’ and Dutch ‘commando nieuwe regel/alinea’. The original speech stays available; other languages are unchanged."
                >
                  {toggle(
                    "spokenFormattingCommands",
                    "Interpret spoken line commands",
                    busy,
                  )}
                </SettingRow>
                <SettingRow
                  title="Punctuation"
                  description="Keep the model’s punctuation, or dictate it yourself."
                  help="Spoken punctuation works for English and Dutch microphone dictation: say “insert comma” or “insert new paragraph”, in Dutch “voeg komma in” or “voeg nieuwe alinea in”. Imported audio, raw recognition, quotes, code and shortcut blocks stay literal."
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
                    <option value="preserve">Recognized punctuation</option>
                    <option value="spoken">Spoken commands</option>
                  </select>
                </SettingRow>
              </>,
            )}
          </>
        )}
        {tab === "delivery" && (
          <>
            {group(
              "After a dictation",
              <>
                <SettingRow
                  icon={Clipboard}
                  title="Paste automatically"
                  description={
                    clipboardOnly
                      ? "Off — results are copied so you can paste yourself."
                      : "Type the result into the app you were using."
                  }
                >
                  {toggle("autoPaste", "Paste automatically")}
                </SettingRow>
                <SettingRow
                  title="Copy results to clipboard"
                  description="Keep the text ready for a manual paste."
                >
                  {toggle("copyToClipboard", "Copy results to clipboard")}
                </SettingRow>
                <SettingRow
                  title="Restore clipboard after paste"
                  description="Put your previous text back two seconds later."
                  help="Only plain text is restored, and only if the clipboard has not changed in the meantime."
                >
                  {toggle(
                    "restoreClipboardAfterPaste",
                    "Restore clipboard after paste",
                    !s.autoPaste,
                  )}
                </SettingRow>
              </>,
            )}
            {group(
              "Pasting",
              <>
                <SettingRow
                  icon={Keyboard}
                  title="Paste shortcut"
                  description="Terminals often need Ctrl+Shift+V."
                  help="Used for automatic paste and Paste latest; terminals are not detected automatically. Delulu only sends the paste shortcut, never Enter — but pasted newlines may still run commands in a terminal."
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
                      {capabilities?.platform === "darwin" ? "Cmd+V" : "Ctrl+V"}
                      )
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
                    description="Let your desktop paste for you."
                    help="Test paste sends the shortcut after three seconds: focus another text field first."
                  >
                    <div className="inline-control">
                      <button
                        className="secondary-button compact"
                        onClick={props.onAuthorizePaste}
                      >
                        Allow
                      </button>
                      <button
                        className="tool-button compact"
                        onClick={props.onTestPaste}
                      >
                        Test paste
                      </button>
                    </div>
                  </SettingRow>
                )}
                <SettingRow
                  title="Paste latest delay"
                  description="Time to focus the right field before pasting."
                  help="Cancel from the countdown or the tray. Delulu cannot confirm where the text lands."
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
                          {seconds} {seconds === 1 ? "second" : "seconds"}
                        </option>
                      ),
                    )}
                  </select>
                </SettingRow>
              </>,
            )}
            {group(
              "Privacy",
              <SettingRow
                icon={ShieldCheck}
                title="Keep local history"
                description="Save transcripts on this device."
                help="When off, only the newest 20 results of this session are kept in memory (up to 8 MiB of text) and nothing is written to disk. Existing saved history stays until you clear it."
              >
                {toggle("keepHistory", "Keep local history")}
              </SettingRow>,
            )}
          </>
        )}
        {tab === "writing" && (
          <>
            <div className="spoken-corrections-card">
              <span className="cleanup-eyebrow">Spoken corrections</span>
              <h3>Change your mind. Keep talking.</h3>
              <p>
                Take back a request or correct yourself naturally. What you
                explicitly withdraw is removed; your wording and the original
                transcript stay.
              </p>
              <div className="cleanup-example">
                <s>I want a new logo.</s> Also remake this feature.{" "}
                <s>Never mind, don’t do the logo.</s>
              </div>
              <div className="panel-actions">
                <button
                  className="primary-button"
                  disabled={
                    saving ||
                    busy ||
                    (s.magicEnabled && s.magicPreset === "spoken-corrections")
                  }
                  onClick={() =>
                    save({
                      magicEnabled: true,
                      memoryPolicy: "balanced",
                      magicPreset: "spoken-corrections",
                      magicAllowInferences: false,
                    })
                  }
                >
                  {s.magicEnabled && s.magicPreset === "spoken-corrections" ? (
                    <>
                      <Check /> Spoken corrections on
                    </>
                  ) : (
                    "Use spoken corrections"
                  )}
                </button>
                {magicStatus.engine === "missing" && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={props.onSetupMagic}
                  >
                    Set up rewriting model
                  </button>
                )}
              </div>
              <p className="caption">
                Runs locally before paste, loading speech and rewriting in turn.
                If a cleanup fails validation, nothing is sent. Prose dictation
                only; ambiguous corrections can still need review.
              </p>
            </div>
            {group(
              "Rewriting",
              <>
                <SettingRow
                  icon={Sparkles}
                  title="Rewrite after dictation"
                  description="Apply a style before delivery; the original stays in History."
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
                        ...(e.target.value === "spoken-corrections"
                          ? { magicAllowInferences: false }
                          : {}),
                        magicPreset: e.target
                          .value as AppSettings["magicPreset"],
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
                  description="Let rewriting fill in missing detail. Review before sending."
                >
                  {toggle(
                    "magicAllowInferences",
                    "Allow added assumptions",
                    s.magicPreset === "spoken-corrections",
                  )}
                </SettingRow>
                <SettingRow title="Rewriting model">
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
              </>,
            )}
            <details className="disclosure">
              <summary>Rewrite selected text in other apps</summary>
              <SelectedTextWorkflow
                status={magicStatus}
                onSetup={props.onOpenModels}
              />
            </details>
          </>
        )}
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
        {tab === "performance" && (
          <>
            {group(
              "Memory",
              <>
                <SettingRow
                  title="Memory policy"
                  description="Balanced runs speech and rewriting one at a time."
                  help="Balanced unloads rewriting before speech loads or transcribes, and loads rewriting on demand even when it is kept ready. It is a predictable memory-saving policy, not automatic pressure detection."
                >
                  <select
                    aria-label="Memory policy"
                    value={s.memoryPolicy}
                    disabled={saving || busy}
                    onChange={(e) =>
                      save({
                        memoryPolicy: e.target
                          .value as AppSettings["memoryPolicy"],
                      })
                    }
                  >
                    <option value="independent">Independent (default)</option>
                    <option value="balanced">Balanced — speech first</option>
                  </select>
                </SettingRow>
                <SettingRow
                  icon={Clock3}
                  title="Keep speech ready"
                  description="No cold start, at the cost of GPU memory."
                >
                  {toggle("preloadModel", "Keep speech ready", busy)}
                </SettingRow>
                <SettingRow
                  title="Keep rewriting ready"
                  description="Keep the rewriting model loaded too."
                >
                  {toggle("preloadMagicModel", "Keep rewriting ready", busy)}
                </SettingRow>
                <SettingRow
                  title="Unload when idle"
                  description="Free memory after this long without use."
                >
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
                        {n} {n === 1 ? "minute" : "minutes"}
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </>,
            )}
            {group(
              "Runtime",
              <>
                <SettingRow
                  title="Python command"
                  description="New installs use Python 3.11–3.13."
                >
                  <div className="inline-control">
                    <input
                      className="w-44"
                      aria-label="Python command"
                      value={python}
                      onChange={(e) => setPython(e.target.value)}
                    />
                    <button
                      className="secondary-button compact"
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
                <SettingRow title="Speech model" description={status.message}>
                  <div className="inline-control">
                    {props.onCancelSetup &&
                      ["running", "cancelling"].includes(
                        status.setupState ?? "",
                      ) && (
                        <button
                          className="secondary-button compact"
                          disabled={status.setupState === "cancelling"}
                          onClick={props.onCancelSetup}
                        >
                          {status.setupState === "cancelling"
                            ? "Cancelling…"
                            : "Cancel setup"}
                        </button>
                      )}
                    {status.engine === "ready" ? (
                      <button
                        className="tool-button compact"
                        disabled={busy}
                        onClick={props.onUnload}
                      >
                        Unload
                      </button>
                    ) : (
                      <button
                        className="tool-button compact"
                        disabled={busy || status.engine !== "unloaded"}
                        onClick={props.onLoad}
                      >
                        Load
                      </button>
                    )}
                    <button
                      className="secondary-button compact"
                      disabled={busy}
                      onClick={props.onSetup}
                    >
                      {status.engine === "missing" ? "Set up" : "Repair"}
                    </button>
                  </div>
                </SettingRow>
                <SettingRow
                  title="Rewriting model"
                  description={magicStatus.message}
                >
                  <div className="inline-control">
                    {props.onCancelSetupMagic &&
                      ["running", "cancelling"].includes(
                        magicStatus.setupState ?? "",
                      ) && (
                        <button
                          className="secondary-button compact"
                          disabled={magicStatus.setupState === "cancelling"}
                          onClick={props.onCancelSetupMagic}
                        >
                          {magicStatus.setupState === "cancelling"
                            ? "Cancelling…"
                            : "Cancel setup"}
                        </button>
                      )}
                    {magicStatus.engine === "ready" ? (
                      <button
                        className="tool-button compact"
                        disabled={busy}
                        onClick={props.onUnloadMagic}
                      >
                        Unload
                      </button>
                    ) : (
                      <button
                        className="tool-button compact"
                        disabled={busy || magicStatus.engine !== "unloaded"}
                        onClick={props.onLoadMagic}
                      >
                        Load
                      </button>
                    )}
                    <button
                      className="secondary-button compact"
                      disabled={busy}
                      onClick={props.onSetupMagic}
                    >
                      {magicStatus.engine === "missing" ? "Set up" : "Repair"}
                    </button>
                  </div>
                </SettingRow>
                <SettingRow
                  title="Remove runtime"
                  description="Settings, history and downloaded models stay."
                >
                  <button
                    className="danger-button compact"
                    disabled={busy}
                    onClick={() => setRemove(true)}
                  >
                    <Trash2 />
                    Remove
                  </button>
                </SettingRow>
              </>,
              "Repair reinstalls the runtime versions included with this app.",
            )}
          </>
        )}
        {tab === "app" && (
          <>
            {group(
              "Appearance and startup",
              <>
                <SettingRow
                  icon={Monitor}
                  title="Theme"
                  description="Abyss (dark), Shallows (light), or follow the system."
                >
                  <div className="segmented" role="group" aria-label="Theme">
                    {(
                      [
                        ["system", "Auto"],
                        ["light", "Light"],
                        ["dark", "Dark"],
                      ] as const
                    ).map(([theme, label]) => (
                      <button
                        key={theme}
                        aria-pressed={s.theme === theme}
                        className={s.theme === theme ? "active" : ""}
                        disabled={saving}
                        onClick={() => save({ theme })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow
                  title="Launch at login"
                  description="Start in the tray so your shortcut is ready."
                >
                  {toggle("launchAtLogin", "Launch at login")}
                </SettingRow>
                {capabilities?.platform === "darwin" && (
                  <SettingRow
                    title="Menu bar only"
                    description="Hide the Dock icon; use the menu bar instead."
                    help="Reopen the window, check status or quit from the menu bar. This window stays open when you turn it on."
                  >
                    {toggle("menuBarOnly", "Menu bar only")}
                  </SettingRow>
                )}
              </>,
            )}
            {group(
              "Updates",
              <>
                <SettingRow
                  icon={RefreshCw}
                  title={`Delulu Talks ${update.currentVersion || "development"}`}
                  description={update.message}
                >
                  <div className="inline-control">
                    {update.phase === "available" ? (
                      <button
                        className="primary-button compact"
                        onClick={props.onDownloadUpdate}
                      >
                        <Download />
                        Download {update.version}
                      </button>
                    ) : update.phase === "downloaded" ? (
                      <button
                        className="primary-button compact"
                        disabled={busy}
                        onClick={props.onInstallUpdate}
                      >
                        Restart & update
                      </button>
                    ) : (
                      <button
                        className="secondary-button compact"
                        disabled={
                          update.phase === "unsupported" ||
                          update.phase === "checking" ||
                          update.phase === "downloading"
                        }
                        onClick={props.onCheckForUpdates}
                      >
                        {update.phase === "checking"
                          ? "Checking…"
                          : "Check now"}
                      </button>
                    )}
                  </div>
                </SettingRow>
                {update.phase === "downloading" && (
                  <div className="setting-row">
                    <progress
                      aria-label="Update download"
                      max={100}
                      value={update.percent ?? 0}
                    />
                    <span className="caption tabular-nums">
                      {Math.round(update.percent ?? 0)}%
                    </span>
                  </div>
                )}
                <div className="setting-row">
                  <a
                    className="text-button"
                    href="https://github.com/JEMostert/delulu-talks/releases"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Release notes and manual downloads ↗
                  </a>
                </div>
              </>,
              "App updates never change your downloaded models.",
            )}
          </>
        )}
        {tab === "data" && (
          <>
            <LocalData />
            <details className="disclosure">
              <summary>History retention</summary>
              <HistoryRetention
                policy={s.historyRetention}
                saving={saving}
                onSave={onSave}
              />
            </details>
            <details className="disclosure">
              <summary>Encrypted backup</summary>
              <EncryptedHistory />
            </details>
          </>
        )}
      </div>
      {remove && (
        <ConfirmDialog
          title="Remove the local runtime?"
          confirmLabel="Remove setup"
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
