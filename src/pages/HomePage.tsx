import { DeliveryControl } from "../components/DeliveryControl";
import { technicalDictationGuide } from "../technicalDictation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaptureDiagnostics } from "../components/CaptureDiagnostics";
import { InputLevel } from "../components/InputLevel";
import { ProfileActivationControls } from "../components/ProfileActivationControls";
import type { CaptureProfileSnapshot, ProfileActivationCommand } from "../activePersonalProfile";
import {
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Copy,
  Keyboard,
  Mic,
  Settings2,
  WandSparkles,
} from "lucide-react";
import { deliveredText } from "../transcriptText";
import { speechLanguageCapability } from "../speechCapabilities";
import { MAX_CAPTURE_DURATION_MS } from "../captureLimits";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { Toggle } from "../components/ui";
import { LiveCaptureStatus } from "../components/LiveCaptureStatus";
import { MicrophoneNotice } from "../components/MicrophoneNotice";
import type {
  AppSettings,
  CaptureDiagnostics as CaptureStats,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  Page,
  PlatformCapabilities,
  ShortcutStatus,
  TranscriptRecord,
} from "../types";

const panelHeader =
  "flex items-center gap-2 min-h-9 px-3.5 py-[9px] border-b border-line bg-[linear-gradient(100deg,var(--panel-heading),var(--surface))]";
const panelHeading = "text-[13px] font-[650] tracking-[0.1px]";

function ControlField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label
      className={`flex flex-col gap-1.5 min-w-0 ${wide ? "col-span-full" : ""}`}
    >
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}

export function HomePage({
  settings: s,
  status,
  magicStatus,
  capabilities,
  shortcutStatus,
  devices,
  history,
  captureDiagnostics,
  captureProfile,
  onActivateProfile,
  saving,
  busy,
  onNavigate,
  onUpdateSettings: save,
  onConfigureShortcut,
  onPasteLast,
  pasteLastBusy,
  onToggleRecord,
  ...actions
}: TranscriptActions & {
  settings: AppSettings;
  status: DictationStatus;
  magicStatus: MagicStatus;
  capabilities?: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  devices: MicrophoneDevice[];
  history: TranscriptRecord[];
  captureDiagnostics?: CaptureStats | null;
  captureProfile?: CaptureProfileSnapshot | null;
  onActivateProfile: (command: ProfileActivationCommand) => Promise<boolean>;
  saving: boolean;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConfigureShortcut: () => void;
  onPasteLast: () => void;
  onToggleRecord: () => Promise<boolean>;
  pasteLastBusy: boolean;
}) {
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const portal = shortcutStatus.method === "portal";
  const latest = history[0];
  const recording = status.phase === "listening" || status.phase === "paused";
  const needsSetup = ["missing", "error"].includes(status.engine);
  const startedFromHome = useRef(false);
  useEffect(() => {
    if (recording && startedFromHome.current) {
      document.getElementById("recording-stop-control")?.focus({ preventScroll: true });
      startedFromHome.current = false;
    } else if (status.phase === "error") {
      startedFromHome.current = false;
    }
  }, [recording, status.phase]);
  const languageCapability = speechLanguageCapability(s.model);
  const engineText = (engine: DictationStatus["engine"]) =>
    ({
      ready: "Ready",
      unloaded: "Loads on demand",
      missing: "Installation required",
      error: "Needs repair",
      loading: "Loading",
      settingUp: "Installing",
    })[engine];
  return (
    <div className="control-workspace">
      <div className="flex items-center justify-between gap-3 mt-[-5px] mb-3 max-[700px]:flex-wrap">
        <span className="flex gap-1.5 items-center text-[10px] text-muted">
          <Check className="w-[13px] h-[13px] text-success" />{" "}
          {saving ? "Saving settings…" : "Settings saved automatically"}
        </span>
        <button
          className="tool-button px-0 py-1 min-h-[26px] text-[11px]"
          onClick={() => onNavigate("settings")}
        >
          <Settings2 className="w-3.5 h-3.5" /> All settings{" "}
          <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
      </div>
      <LiveCaptureStatus settings={s} speech={status} rewrite={magicStatus} shortcut={shortcutStatus} devices={devices} capabilities={capabilities} />
      <div className="grid gap-4 items-start grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)] max-[1150px]:grid-cols-1">
        <section
          className="min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl overflow-hidden"
          aria-labelledby="record-heading"
        >
          <header className={panelHeader}>
            <Mic className="w-4 h-4 text-accent-ink" />
            <h2 id="record-heading" className={panelHeading}>
              Record
            </h2>
            <span className="ml-auto font-mono text-[10px] text-subtle">
              01
            </span>
          </header>
          <div className="flex items-center gap-[18px] mx-3.5 mt-2.5 px-3.5 py-2.5 border border-line rounded-xl bg-[linear-gradient(115deg,var(--panel-heading),var(--surface)_70%)] backdrop-blur-md">
            {recording ? (
              <span
                className="inline-flex items-center gap-2 shrink-0 text-[13px] font-[650] text-accent-ink"
                role="status"
              >
                <Mic className="w-4 h-4 animate-[voice_1.2s_ease-in-out_infinite]" />
                Listening
              </span>
            ) : (
              <button
                className="inline-flex items-center gap-2.5 shrink-0 min-h-11 px-[22px] py-2 rounded-[12px] border-0 text-[15px] font-[650] tracking-[0.2px] text-on-accent bg-[linear-gradient(160deg,var(--accent),var(--accent-hover))] shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_8px_22px_rgba(10,132,255,0.35)] hover:brightness-[1.07]"
                disabled={busy}
                onClick={() => {
                  if (needsSetup) {
                    onNavigate("models");
                  } else {
                    startedFromHome.current = true;
                    void onToggleRecord().then((started) => {
                      if (!started) startedFromHome.current = false;
                    }).catch(() => {
                      startedFromHome.current = false;
                    });
                  }
                }}
                aria-label={needsSetup ? "Set up speech" : "Start dictation"}
              >
                <Mic className="w-5 h-5" />
                <span>{needsSetup ? "Set up speech" : "Record"}</span>
              </button>
            )}
            <div className="flex flex-col justify-center gap-1 flex-1 min-w-0">
              <div className="engine-line border-0 m-0 p-0 min-h-0">
                <span
                  className={`engine-state ${status.engine === "ready" ? "ready" : ""}`}
                >
                  {engineText(status.engine)}
                </span>
                <button
                  className="text-button text-[10px] min-h-[26px] gap-[3px]"
                  onClick={() => onNavigate("models")}
                >
                  Manage <ArrowUpRight className="w-3 h-3" />
                </button>
              </div>
              <span className="text-[11px] text-muted">
                {recording
                  ? portal && s.shortcutMode === "hold"
                    ? "Release the shortcut or press Stop in the header to finish."
                    : "Press the shortcut again or press Stop in the header to finish."
                  : portal && s.shortcutMode === "hold"
                    ? "Hold your shortcut, or press Record, and just talk."
                    : "Press your shortcut or Record to start; press again to finish."}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5 px-3.5 pt-2.5 pb-3 max-[700px]:grid-cols-1">
            <ControlField label="Language">
              <select
                aria-label="Dictation language"
                className="w-full min-h-[34px] px-[9px] py-[7px] pr-[23px] text-[12px] bg-input"
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
            </ControlField>
            <DeliveryControl
              settings={s}
              saving={saving}
              busy={busy}
              onChange={save}
            />
          </div>
          <details className="border-t border-line">
            <summary className="cursor-pointer px-3.5 py-3 text-[12px] font-[650] text-muted">
              Microphone & shortcut
            </summary>
            <div className="grid grid-cols-2 gap-2.5 px-3.5 pb-3 max-[700px]:grid-cols-1">
              <ControlField label="Microphone">
                <select
                  aria-label="Microphone"
                  className="w-full min-h-[34px] px-[9px] py-[7px] pr-[23px] text-[12px] bg-input"
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
              </ControlField>
              <ControlField label="Text mode">
                <select
                  aria-label="Dictation text mode"
                  className="w-full min-h-[34px] px-[9px] py-[7px] text-[12px] bg-input"
                  value={s.dictationMode ?? "prose"}
                  disabled={saving || busy}
                  onChange={(e) => save({ dictationMode: e.target.value as AppSettings["dictationMode"] })}
                >
                  <option value="prose">Prose</option>
                  <option value="code">Code symbols</option>
                  <option value="command">Command text</option>
                </select>
                <MicrophoneNotice settings={s} devices={devices} />
              </ControlField>
              <ControlField label="Record mode">
                <select
                  aria-label="Recording gesture"
                  className="w-full min-h-[34px] px-[9px] py-[7px] pr-[23px] text-[12px] bg-input"
                  title={
                    portal
                      ? "Hold while speaking or press to toggle"
                      : "This desktop supports toggle shortcuts"
                  }
                  value={portal ? s.shortcutMode : "toggle"}
                  disabled={saving || busy || !portal}
                  onChange={(e) =>
                    save({
                      shortcutMode: e.target
                        .value as AppSettings["shortcutMode"],
                    })
                  }
                >
                  <option value="hold">Hold to talk</option>
                  <option value="toggle">Toggle</option>
                </select>
              </ControlField>
              {s.dictationMode && s.dictationMode !== "prose" && (
                <div className="col-span-full text-[11px] text-muted">
                  Spoken symbols become text after recognition. Original speech stays in history.
                  Vocabulary expansion and automatic rewriting are bypassed. Command text is never executed by Delulu Talks.
                  <details className="mt-1">
                    <summary className="cursor-pointer">Spoken symbol guide</summary>
                    <p className="mt-1">Say “open parenthesis”, “close parenthesis”, “equals”, “semicolon”,
                      “forward slash”, “backslash”, “new line”, “tab” or “space”.
                      Say “literal” before a word to keep that word unchanged.
                      Ordinary words keep their spacing; operators receive spaces.</p>
                    <p className="mt-2">Identifiers: say “camel case user account end identifier” for userAccount.
                      Also use pascal case, snake case, kebab case or literal spelling.
                      Literal spelling accepts letters, digit names and “capital”/“hoofdletter”.</p>
                    <ul className="mt-2 grid gap-1">
                      {technicalDictationGuide.map((entry) => (
                        <li key={entry.label}>
                          {entry.phrases.join(" / ")} → <code>{JSON.stringify(entry.output)}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
              <div className="flex items-center gap-2 min-h-[37px] mt-0.5 border-t border-line pt-[9px] col-span-full">
                <span className="flex items-center gap-1.5 text-[10px] text-muted">
                  <Keyboard className="w-[13px] h-[13px]" /> Shortcut
                </span>
                {portal ? (
                  <>
                    <kbd className="ml-auto px-1.5 py-1 font-mono text-[10px] bg-input">
                      {shortcutStatus.accelerator
                        .replace("Super", "Meta")
                        .split("+")
                        .join(" + ")}
                    </kbd>
                    <button
                      className="tool-button px-0 py-1 min-h-[25px] text-[10px]"
                      disabled={busy}
                      onClick={onConfigureShortcut}
                    >
                      Change
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      aria-label="Dictation shortcut"
                      className="w-full min-w-[50px] px-[7px] py-[5px] font-mono text-[11px]"
                      value={shortcut}
                      disabled={saving || busy}
                      onChange={(e) => setShortcut(e.target.value)}
                    />
                    <button
                      className="tool-button px-0 py-1 min-h-[25px] text-[10px]"
                      disabled={
                        saving ||
                        busy ||
                        shortcut === s.shortcut ||
                        !shortcut.trim()
                      }
                      onClick={() => save({ shortcut })}
                    >
                      Save
                    </button>
                  </>
                )}
              </div>
            </div>
            <InputLevel />
            <CaptureDiagnostics value={captureDiagnostics} />
            <ProfileActivationControls settings={s} busy={busy || saving} captureProfile={captureProfile} onActivate={onActivateProfile} />
            <p className="caption">Recordings finish at {MAX_CAPTURE_DURATION_MS / 60_000} minutes; high sample-rate inputs may finish sooner to bound memory.</p>
            {!shortcutStatus.registered && (
              <p className="control-warning">{shortcutStatus.message}</p>
            )}
          </details>
        </section>
        <section
          className="min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl overflow-hidden"
          aria-label="Latest output"
        >
          <header className="flex items-center justify-between gap-2 min-h-9 px-3.5 py-[9px] border-b border-line bg-[linear-gradient(100deg,var(--panel-heading),var(--surface))]">
            <h2 className={panelHeading}>Latest output</h2>
            <button
              className="text-button min-h-[22px] text-[10px] gap-1"
              onClick={() => onNavigate("history")}
            >
              History <ArrowUpRight className="w-[13px] h-[13px]" />
            </button>
          </header>
          {latest ? (
            <>
              <TranscriptCard
                key={latest.id}
                record={latest}
                inspector
                {...actions}
              />
              <div className="flex flex-wrap gap-2.5 items-center justify-between border-t border-line bg-heading px-3.5 py-3">
                <span className="caption text-[10px]">
                  {s.keepHistory
                    ? "History saving on"
                    : "New results stay in this session"}
                </span>
                <button
                  className="secondary-button text-[11px] min-h-[31px] px-[9px] py-1.5"
                  onClick={onPasteLast}
                >
                  <ClipboardPaste /> Paste last
                </button>
              </div>
            </>
          ) : (
            <div className="min-h-[380px] max-[1150px]:min-h-[160px] p-[30px] flex flex-col justify-center items-start gap-3">
              <ClipboardPaste className="w-7 h-7 text-accent-ink" />
              <h3 className="text-[15px]">No transcript yet</h3>
              <p className="text-[12px] text-muted max-w-[30ch]">
                Record with the button above or use your shortcut. The result
                appears here for review, editing and copying.
              </p>
            </div>
          )}
        </section>
        <details className="col-span-full min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl">
          <summary className="cursor-pointer px-3.5 py-3 text-[13px] font-[650]">
            Corrections, rewriting & delivery options
          </summary>
          <div className="grid grid-cols-2 gap-3.5 p-3.5 max-[700px]:grid-cols-1">
            <section
              className="min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl overflow-hidden"
              aria-labelledby="polish-heading"
            >
              <header className={panelHeader}>
                <WandSparkles className="w-4 h-4 text-accent-ink" />
                <h2 id="polish-heading" className={panelHeading}>
                  Polish
                </h2>
                <span className="ml-auto font-mono text-[10px] text-subtle">
                  02
                </span>
              </header>
              <div className="grid gap-3 p-4">
                <p className="text-[13px] text-muted leading-[1.5]">
                  Correct names and insert saved text in clean results.
                </p>
                <button
                  className="secondary-button justify-between text-[12px]"
                  onClick={() => onNavigate("vocabulary")}
                >
                  Corrections & text shortcuts <ArrowUpRight />
                </button>
                <span className="caption">
                  {s.customWords.filter((word) => word.enabled).length} enabled
                  rules
                </span>
                <div className="quick-toggle">
                  <span>
                    Rewrite after dictation
                    <small>
                      {s.magicEnabled
                        ? "Automatic rewriting enabled"
                        : "Off · rewrite any result on demand"}
                    </small>
                  </span>
                  <Toggle
                    label="Rewrite after dictation"
                    value={s.magicEnabled}
                    disabled={saving || busy}
                    onChange={() => save({ magicEnabled: !s.magicEnabled })}
                  />
                </div>
                {s.magicEnabled && (
                  <button
                    className="text-button"
                    onClick={() => onNavigate("settings")}
                  >
                    Configure automatic writing <ArrowUpRight />
                  </button>
                )}
              </div>
            </section>
            <section
              className="min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl overflow-hidden"
              aria-labelledby="delivery-heading"
            >
              <header className={panelHeader}>
                <ClipboardPaste className="w-4 h-4 text-accent-ink" />
                <h2 id="delivery-heading" className={panelHeading}>
                  Deliver
                </h2>
                <span className="ml-auto font-mono text-[10px] text-subtle">
                  03
                </span>
              </header>
              <div className="px-3.5 pt-[3px] pb-[5px]">
                {(
                  [
                    [
                      "autoPaste",
                      "Paste automatically",
                      "Into the active text field",
                    ],
                    [
                      "copyToClipboard",
                      "Copy to clipboard",
                      "Keep the result ready to paste",
                    ],
                    [
                      "keepHistory",
                      "Save history",
                      "Store new transcripts on this device",
                    ],
                  ] as const
                ).map(([key, label, detail]) => (
                  <div
                    className="quick-toggle py-2.5 border-b border-line last:border-0"
                    key={key}
                  >
                    <span>
                      {label}
                      <small>{detail}</small>
                    </span>
                    <Toggle
                      label={label}
                      value={s[key]}
                      disabled={saving || busy}
                      onChange={() => save({ [key]: !s[key] })}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        </details>
      </div>
    </div>
  );
}
