import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Keyboard,
  Mic,
  Settings2,
  Square,
  WandSparkles,
} from "lucide-react";
import { LANGUAGES } from "../data";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { Toggle } from "../components/ui";
import type {
  AppSettings,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  Page,
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
  shortcutStatus,
  devices,
  history,
  saving,
  busy,
  onNavigate,
  onUpdateSettings: save,
  onConfigureShortcut,
  onPasteLast,
  onToggleRecord,
  ...actions
}: TranscriptActions & {
  settings: AppSettings;
  status: DictationStatus;
  magicStatus: MagicStatus;
  shortcutStatus: ShortcutStatus;
  devices: MicrophoneDevice[];
  history: TranscriptRecord[];
  saving: boolean;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConfigureShortcut: () => void;
  onPasteLast: () => void;
  onToggleRecord: () => void;
}) {
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const portal = shortcutStatus.method === "portal";
  const latest = history[0];
  const recording = status.phase === "listening";
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
      <div className="grid gap-4 items-start grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)] max-[1150px]:grid-cols-1">
        <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
          <section
            className="min-w-0 rounded-2xl border border-line bg-surface shadow-panel backdrop-blur-xl overflow-hidden col-span-full"
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
              <button
                className={`inline-flex items-center gap-2.5 shrink-0 min-h-11 px-[22px] py-2 rounded-[12px] border-0 text-[15px] font-[650] tracking-[0.2px] text-on-accent bg-[linear-gradient(160deg,var(--accent),var(--accent-hover))] shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_8px_22px_rgba(10,132,255,0.35)] hover:brightness-[1.07] ${
                  recording
                    ? "bg-[linear-gradient(160deg,var(--danger),#c94a60)] shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_8px_22px_rgba(200,60,80,0.35)]"
                    : ""
                }`}
                disabled={busy}
                onClick={() =>
                  ["missing", "error"].includes(status.engine) && !recording
                    ? onNavigate("models")
                    : onToggleRecord()
                }
                aria-label={recording ? "Stop dictation" : "Start dictation"}
              >
                {recording ? (
                  <Square className="w-5 h-5 animate-[voice_1.2s_ease-in-out_infinite]" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
                <span>{recording ? "Stop" : "Record"}</span>
              </button>
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
                    ? "Listening — release the shortcut or press Stop"
                    : "Hold your shortcut, or press Record, and just talk."}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2.5 px-3.5 pt-2.5 pb-1.5 max-[700px]:grid-cols-1">
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
              <ControlField label="Language">
                <select
                  aria-label="Dictation language"
                  className="w-full min-h-[34px] px-[9px] py-[7px] pr-[23px] text-[12px] bg-input"
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
            {!shortcutStatus.registered && (
              <p className="control-warning">{shortcutStatus.message}</p>
            )}
          </section>
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
      </div>
    </div>
  );
}
