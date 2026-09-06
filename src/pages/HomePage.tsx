import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Cpu,
  Keyboard,
  Mic,
  Settings2,
  WandSparkles,
} from "lucide-react";
import { LANGUAGES, MODELS, MAGIC_MODELS } from "../data";
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
    <label className={`control-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function HomePage({
  settings: s,
  status,
  magicStatus,
  shortcutStatus,
  devices,
  history,
  saving,
  busy,
  onNavigate,
  onUpdateSettings: save,
  onConfigureShortcut,
  onPasteLast,
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
}) {
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const portal = shortcutStatus.method === "portal";
  const latest = history[0];
  const engineText = (engine: DictationStatus["engine"]) =>
    ({
      ready: "Loaded",
      unloaded: "Loads on demand",
      missing: "Installation required",
      error: "Needs repair",
      loading: "Loading",
      settingUp: "Installing",
    })[engine];
  return (
    <div className="control-workspace">
      <div className="workspace-toolbar">
        <span className="save-indicator">
          <Check />{" "}
          {saving ? "Saving settings…" : "Settings saved automatically"}
        </span>
        <button className="tool-button" onClick={() => onNavigate("settings")}>
          <Settings2 /> All settings <ArrowUpRight />
        </button>
      </div>
      <div className="workspace-grid">
        <div className="control-deck">
          <section className="control-panel" aria-labelledby="capture-heading">
            <header>
              <Mic />
              <h2 id="capture-heading">Capture</h2>
              <span className="section-number">01</span>
            </header>
            <div className="control-fields">
              <ControlField label="Microphone" wide>
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
              </ControlField>
              <ControlField label="Language">
                <select
                  aria-label="Dictation language"
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
              <div className="shortcut-control wide">
                <span>
                  <Keyboard /> Shortcut
                </span>
                {portal ? (
                  <>
                    <kbd>
                      {shortcutStatus.accelerator
                        .replace("Super", "Meta")
                        .split("+")
                        .join(" + ")}
                    </kbd>
                    <button
                      className="tool-button"
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
                      value={shortcut}
                      disabled={saving || busy}
                      onChange={(e) => setShortcut(e.target.value)}
                    />
                    <button
                      className="tool-button"
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
          <section className="control-panel" aria-labelledby="speech-heading">
            <header>
              <Cpu />
              <h2 id="speech-heading">Transcription</h2>
              <span className="section-number">02</span>
            </header>
            <div className="control-fields">
              <ControlField label="Speech model" wide>
                <select
                  aria-label="Speech model"
                  value={s.model}
                  disabled={saving || busy}
                  onChange={(e) =>
                    save({ model: e.target.value as AppSettings["model"] })
                  }
                >
                  {MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      CrisperWhisper · {model.size}
                    </option>
                  ))}
                </select>
              </ControlField>
              <ControlField label="Transcripts">
                <select
                  aria-label="Speech output"
                  value={s.transcriptionMode}
                  disabled={saving || busy}
                  onChange={(e) =>
                    save({
                      transcriptionMode: e.target
                        .value as AppSettings["transcriptionMode"],
                    })
                  }
                >
                  <option value="dual">Clean + verbatim</option>
                  <option value="intended">Clean only</option>
                  <option value="verbatim">Verbatim only</option>
                </select>
              </ControlField>
              <ControlField label="Deliver">
                <select
                  aria-label="Version to deliver"
                  value={s.pasteVersion}
                  disabled={saving || busy}
                  onChange={(e) =>
                    save({
                      pasteVersion: e.target
                        .value as AppSettings["pasteVersion"],
                    })
                  }
                >
                  <option value="intended">Clean</option>
                  <option value="verbatim">Verbatim</option>
                </select>
              </ControlField>
              <div className="engine-line wide">
                <span
                  className={`engine-state ${status.engine === "ready" ? "ready" : ""}`}
                >
                  {engineText(status.engine)}
                </span>
                <button
                  className="text-button"
                  onClick={() => onNavigate("models")}
                >
                  Manage <ArrowUpRight />
                </button>
              </div>
            </div>
          </section>
          <section className="control-panel" aria-labelledby="writing-heading">
            <header>
              <WandSparkles />
              <h2 id="writing-heading">Writing</h2>
              <span className="section-number">03</span>
            </header>
            <div className="control-fields">
              <div className="quick-toggle wide">
                <span>Rewrite after dictation</span>
                <Toggle
                  label="Rewrite after dictation"
                  value={s.magicEnabled}
                  disabled={saving || busy}
                  onChange={() => save({ magicEnabled: !s.magicEnabled })}
                />
              </div>
              <ControlField label="Style">
                <select
                  aria-label="Dictation writing style"
                  value={s.magicPreset}
                  disabled={saving || busy || !s.magicEnabled}
                  onChange={(e) =>
                    save({
                      magicPreset: e.target.value as AppSettings["magicPreset"],
                    })
                  }
                >
                  <option value="polish">Polish</option>
                  <option value="concise">Concise</option>
                  <option value="structured">Structured</option>
                  <option value="prompt">Prompt</option>
                </select>
              </ControlField>
              <ControlField label="Writing model">
                <select
                  aria-label="Writing model"
                  value={s.magicModel}
                  disabled={saving || busy || !s.magicEnabled}
                  onChange={(e) =>
                    save({
                      magicModel: e.target.value as AppSettings["magicModel"],
                    })
                  }
                >
                  {MAGIC_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </ControlField>
              <div className="engine-line wide">
                <span
                  className={`engine-state ${s.magicEnabled && magicStatus.engine === "ready" ? "ready" : ""}`}
                >
                  {s.magicEnabled
                    ? engineText(magicStatus.engine)
                    : "Rewriting off"}
                </span>
                <button
                  className="text-button"
                  onClick={() => onNavigate("magic")}
                >
                  Open writing <ArrowUpRight />
                </button>
              </div>
            </div>
          </section>
          <section className="control-panel" aria-labelledby="delivery-heading">
            <header>
              <ClipboardPaste />
              <h2 id="delivery-heading">Delivery</h2>
              <span className="section-number">04</span>
            </header>
            <div className="delivery-controls">
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
                <div className="quick-toggle" key={key}>
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
        <section className="output-inspector" aria-label="Latest output">
          <header className="inspector-heading">
            <h2>Latest output</h2>
            <button
              className="text-button"
              onClick={() => onNavigate("history")}
            >
              History <ArrowUpRight />
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
              <div className="inspector-footer">
                <span className="caption">
                  {s.keepHistory
                    ? "History saving on"
                    : "New results stay in this session"}
                </span>
                <button className="secondary-button" onClick={onPasteLast}>
                  <ClipboardPaste /> Paste last
                </button>
              </div>
            </>
          ) : (
            <div className="output-empty">
              <ClipboardPaste />
              <h3>No transcript yet</h3>
              <p>
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
