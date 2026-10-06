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
  AudioWaveform,
  Check,
  Cpu,
  Download,
  Feather,
  Gauge,
  Keyboard,
  Languages,
  Mic,
  Monitor,
  RefreshCw,
  Trash2,
  Zap,
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

const SECTIONS = [
  [
    "general",
    "General",
    "Microphone, language, shortcut and how the app starts.",
  ],
  ["speech", "Speech", "Which model listens, where it runs, and live typing."],
  [
    "output",
    "Output",
    "What happens with your words once they are recognized.",
  ],
  [
    "rewriting",
    "Rewriting",
    "Optional local rewriting before your text is delivered.",
  ],
  ["profiles", "Profiles", "Named sets of settings you can switch between."],
  ["privacy", "Privacy", "What is kept on this device, and for how long."],
  ["advanced", "Advanced", "Runtimes, memory and updates."],
] as const;
type Section = (typeof SECTIONS)[number][0];

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

/** A titled list of rows: the one structure every settings section uses. */
function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pref-group">
      <h3>{title}</h3>
      <div className="pref-list">{children}</div>
      {note && <p className="pref-note">{note}</p>}
    </section>
  );
}

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
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    const content = document.getElementById("page-content");
    if (content) content.scrollTop = 0;
  }, [section]);
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
  const mac = capabilities?.platform === "darwin";
  const liveBlocker =
    s.shortcutMode === "hold"
      ? "Hold to talk pastes after you release the shortcut. Choose Press to toggle in General to type live."
      : !s.autoPaste
        ? "Turn on Paste automatically (Output) to type live."
        : s.magicEnabled
          ? "Live typing pauses while Rewriting is on: a rewrite needs the whole text."
          : s.dictationFormatting === "spoken"
            ? "Live typing pauses while spoken punctuation commands are on."
            : null;
  const [, title, blurb] = SECTIONS.find(([id]) => id === section)!;

  return (
    <div className="settings-layout">
      <Tabs
        className="settings-tabs"
        label="Settings sections"
        idPrefix="settings"
        tabs={SECTIONS.map(([id, label]) => [id, label] as const)}
        value={section}
        onChange={setSection}
        trailing={
          <span className="settings-saving" aria-live="polite">
            {saving ? "Saving…" : ""}
          </span>
        }
      />
      <div
        className="settings-panel"
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        <header className="pref-head">
          <h2>{title}</h2>
          <p>{blurb}</p>
        </header>

        {section === "general" && (
          <>
            <Group title="Input">
              <SettingRow icon={Mic} title="Microphone">
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
                help="A hint for the speech model, not a detected-language report."
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
            </Group>
            <Group title="Shortcut">
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
                title="Gesture"
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
            </Group>
            <Group title="App">
              <SettingRow icon={Monitor} title="Theme">
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
                description="Starts quietly in the tray so your shortcut is ready."
              >
                {toggle("launchAtLogin", "Launch at login")}
              </SettingRow>
              {mac && (
                <SettingRow
                  title="Menu bar only"
                  description="Hide the Dock icon; use the menu bar instead."
                >
                  {toggle("menuBarOnly", "Menu bar only")}
                </SettingRow>
              )}
            </Group>
          </>
        )}

        {section === "speech" && (
          <>
            {!mac && (
              <Group title="Speech model">
                <div
                  className="engine-choice"
                  role="radiogroup"
                  aria-label="Speech model"
                >
                  {(
                    [
                      [
                        "redux",
                        "Parakeet Redux",
                        Feather,
                        "178 MB. Runs on the CPU. Automatically detects Dutch and 24 other languages.",
                      ],
                      [
                        "r2t2",
                        "R2T2",
                        Gauge,
                        "Most accurate, especially in Dutch. About 4 GB of GPU memory.",
                      ],
                      [
                        "nemotron",
                        "Nemotron 3.5",
                        Feather,
                        "Light and truly live, word by word. About 1.3 GB of GPU memory, or none on the CPU.",
                      ],
                    ] as const
                  ).map(([id, name, Icon, detail]) => (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={s.speechEngine === id}
                      className="engine-option"
                      disabled={saving || busy}
                      onClick={() =>
                        s.speechEngine !== id && save({ speechEngine: id })
                      }
                    >
                      <Icon aria-hidden="true" />
                      <span>
                        <strong>{name}</strong>
                        <small>{detail}</small>
                      </span>
                      {s.speechEngine === id && (
                        <Check className="engine-check" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
                {s.speechEngine === "nemotron" && (
                  <SettingRow
                    icon={Cpu}
                    title="Run on"
                    description="The CPU keeps your graphics card completely free."
                    help="With the GPU option, Nemotron moves to the CPU automatically when another app has filled the graphics memory."
                  >
                    <div className="segmented" role="group" aria-label="Run on">
                      {(
                        [
                          ["auto", "GPU"],
                          ["cpu", "CPU only"],
                        ] as const
                      ).map(([device, label]) => (
                        <button
                          key={device}
                          aria-pressed={s.speechDevice === device}
                          className={s.speechDevice === device ? "active" : ""}
                          disabled={saving || busy}
                          onClick={() => save({ speechDevice: device })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </SettingRow>
                )}
                <SettingRow
                  title="Keep the model ready"
                  description="No wait before your first word; uses memory while idle."
                >
                  {toggle("preloadModel", "Keep the model ready", busy)}
                </SettingRow>
                <SettingRow title="Unload when idle">
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
                        After {n} {n === 1 ? "minute" : "minutes"}
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </Group>
            )}
            <Group title="While you speak">
              <SettingRow
                icon={Zap}
                title="Live typing"
                description={
                  liveBlocker ??
                  (s.speechEngine === "nemotron"
                    ? "Words appear at your cursor as you say them."
                    : "Each phrase appears at your cursor when you pause.")
                }
              >
                {toggle(
                  "liveTyping",
                  "Live typing",
                  mac || s.speechEngine === "redux",
                )}
              </SettingRow>
              <SettingRow
                icon={AudioWaveform}
                title="Stop after silence"
                description="End the recording when you stop talking."
                help="Uses an energy threshold, not speech recognition: quiet speech may stop early and background noise may prevent stopping. Manual Stop always works."
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
            </Group>
            <Group title="Formatting">
              <SettingRow
                title="Punctuation"
                description="Keep the model’s punctuation, or dictate it yourself."
                help="Spoken punctuation works for English and Dutch: say “insert comma” or “voeg komma in”. Imported audio, quotes, code and shortcut blocks stay literal."
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
                  <option value="preserve">Recognized</option>
                  <option value="spoken">Spoken commands</option>
                </select>
              </SettingRow>
              <SettingRow
                title="Line commands"
                description="Say “command new line” or “commando nieuwe alinea”."
              >
                {toggle(
                  "spokenFormattingCommands",
                  "Interpret spoken line commands",
                  busy,
                )}
              </SettingRow>
            </Group>
          </>
        )}

        {section === "output" && (
          <>
            <Group title="Delivery">
              <SettingRow
                title="Paste automatically"
                description="Type the result into the app you were using."
              >
                {toggle("autoPaste", "Paste automatically")}
              </SettingRow>
              <SettingRow
                title="Copy to clipboard"
                description="Keep the text ready for a manual paste."
              >
                {toggle("copyToClipboard", "Copy results to clipboard")}
              </SettingRow>
              <SettingRow
                title="Restore clipboard"
                description="Put your previous text back after pasting."
                help="Only plain text is restored, two seconds later, and only if the clipboard has not changed."
              >
                {toggle(
                  "restoreClipboardAfterPaste",
                  "Restore clipboard after paste",
                  !s.autoPaste,
                )}
              </SettingRow>
            </Group>
            <Group title="Pasting">
              <SettingRow
                title="Paste shortcut"
                description="Terminals often need Ctrl+Shift+V."
                help="Delulu only sends the paste shortcut, never Enter — but pasted newlines may still run commands in a terminal."
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
                    Standard ({mac ? "Cmd+V" : "Ctrl+V"})
                  </option>
                  <option value="terminal">
                    Terminal ({mac ? "Cmd+V" : "Ctrl+Shift+V"})
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
                      Test
                    </button>
                  </div>
                </SettingRow>
              )}
              <SettingRow
                title="Paste latest delay"
                description="Time to focus the right field first."
              >
                <select
                  aria-label="Paste-last delay"
                  value={s.pasteLastDelaySeconds}
                  disabled={saving}
                  onChange={(e) =>
                    save({ pasteLastDelaySeconds: Number(e.target.value) })
                  }
                >
                  {[1, 2, 3, 5, 10, 15, 20, 30].map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds} {seconds === 1 ? "second" : "seconds"}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </Group>
            <Group title="Feedback">
              <SettingRow
                title="Recording pill"
                description="A small pearl that shows you are being heard."
                help={capabilities?.overlayDetail}
              >
                {toggle(
                  "showOverlay",
                  "Recording pill",
                  capabilities?.overlayMethod === "unavailable",
                )}
              </SettingRow>
              <SettingRow
                title="Sounds"
                description="A soft cue when recording starts and stops."
              >
                <Toggle
                  value={!s.captureSoundsMuted}
                  label="Capture sounds"
                  disabled={saving}
                  onChange={() =>
                    save({ captureSoundsMuted: !s.captureSoundsMuted })
                  }
                />
              </SettingRow>
              {!s.captureSoundsMuted && (
                <SettingRow title="Volume">
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
            </Group>
          </>
        )}

        {section === "rewriting" && (
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
            </div>
            <Group
              title="After dictation"
              note="While rewriting is on, live typing waits for the finished text."
            >
              <SettingRow
                title="Rewrite after dictation"
                description="Apply a style before delivery; the original stays in History."
              >
                {toggle("magicEnabled", "Rewrite after dictation", busy)}
              </SettingRow>
              <SettingRow title="Style">
                <select
                  aria-label="Rewrite style"
                  value={s.magicPreset}
                  disabled={saving}
                  onChange={(e) =>
                    save({
                      ...(e.target.value === "spoken-corrections"
                        ? { magicAllowInferences: false }
                        : {}),
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
                description="Let rewriting fill in missing detail."
              >
                {toggle(
                  "magicAllowInferences",
                  "Allow added assumptions",
                  s.magicPreset === "spoken-corrections",
                )}
              </SettingRow>
            </Group>
            <Group title="Rewriting model">
              <SettingRow title="Model">
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
                title="Keep rewriting ready"
                description="Keep the rewriting model loaded alongside speech."
              >
                {toggle("preloadMagicModel", "Keep rewriting ready", busy)}
              </SettingRow>
              <SettingRow
                title="Memory"
                description="Balanced runs speech and rewriting one at a time."
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
                  <option value="independent">Independent</option>
                  <option value="balanced">Balanced</option>
                </select>
              </SettingRow>
            </Group>
            <details className="disclosure">
              <summary>Rewrite selected text in other apps</summary>
              <SelectedTextWorkflow
                status={magicStatus}
                onSetup={props.onOpenModels}
              />
            </details>
          </>
        )}

        {section === "profiles" && (
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

        {section === "privacy" && (
          <>
            <Group title="History">
              <SettingRow
                title="Save transcripts"
                description={
                  s.keepHistory
                    ? "Kept on this device only."
                    : "Off — only this session’s results, in memory."
                }
              >
                {toggle("keepHistory", "Save transcripts")}
              </SettingRow>
              <SettingRow
                title="Keep the latest"
                description="Older transcripts are removed automatically."
              >
                <select
                  aria-label="History limit"
                  value={s.historyLimit}
                  disabled={saving || !s.keepHistory}
                  onChange={(e) =>
                    save({ historyLimit: Number(e.target.value) })
                  }
                >
                  {[25, 50, 100, 250, 500].map((count) => (
                    <option key={count} value={count}>
                      {count} transcripts
                    </option>
                  ))}
                </select>
              </SettingRow>
            </Group>
            <LocalData />
            <details className="disclosure">
              <summary>Remove by age</summary>
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

        {section === "advanced" && (
          <>
            <Group
              title="Runtimes"
              note="Repair reinstalls the runtime versions included with this app."
            >
              <SettingRow title="Speech" description={status.message}>
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
              <SettingRow title="Rewriting" description={magicStatus.message}>
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
                title="Python"
                description="New installs use Python 3.11–3.13."
              >
                <div className="inline-control">
                  <input
                    className="w-40"
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
              <SettingRow
                title="Remove runtimes"
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
            </Group>
            <Group title="Updates">
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
                      {update.phase === "checking" ? "Checking…" : "Check now"}
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
                  Release notes and downloads ↗
                </a>
              </div>
            </Group>
          </>
        )}
      </div>
      {remove && (
        <ConfirmDialog
          title="Remove the local runtimes?"
          confirmLabel="Remove"
          onClose={() => setRemove(false)}
          onConfirm={props.onReset}
        >
          <p>
            You’ll need to set up speech again before dictating. Your history,
            settings and downloaded models stay on this device.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
