import {
  Check,
  Cpu,
  Download,
  Feather,
  Info,
  LoaderCircle,
  Play,
  Sparkles,
} from "lucide-react";
import {
  VOICE_ENGINE_INFO,
  VOICE_ENGINES,
  type VoiceEngineId,
  type VoiceEngineInfo,
  type VoiceStatus,
} from "../../voice";
import type { DotTone } from "../../talk";
import type { DownloadBytes, SetupStage } from "../../types";

const ICONS = { kokoro: Feather, "chatterbox-turbo": Sparkles } as const;

const STAGES: Partial<Record<SetupStage, string>> = {
  "runtime-check": "Checking the setup",
  "runtime-prepare": "Preparing the runtime",
  "runtime-packages": "Installing packages",
  "runtime-download": "Downloading packages",
  "runtime-install": "Installing packages",
  "runtime-build": "Building packages",
  "runtime-validate": "Checking packages",
  "model-prepare": "Starting the engine",
  "model-download": "Downloading the engine",
  "model-load": "Loading the engine",
  warmup: "Warming up",
  "model-loaded": "Engine loaded",
  ready: "Ready",
};

const hardware = (info: VoiceEngineInfo) =>
  info.tier === "small" ? "CPU" : "GPU";

function formatBytes(bytes: number) {
  const gib = 1024 ** 3;
  return bytes >= gib
    ? `${(bytes / gib).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function progressNote(
  detail: string | null | undefined,
  bytes?: DownloadBytes | null,
) {
  const amount =
    bytes && Number.isFinite(bytes.completed) && bytes.completed >= 0
      ? bytes.total == null
        ? `${formatBytes(bytes.completed)} so far`
        : `${formatBytes(bytes.completed)} of ${formatBytes(bytes.total)}`
      : "";
  return [detail, amount].filter(Boolean).join(" · ");
}

/** Pick Small or Large, then set up, load or repair the chosen engine. */
export function VoiceEngineSetup({
  status,
  engine,
  saving,
  onSelect,
  onSetup,
  onCancelSetup,
  onLoad,
  onUnload,
}: {
  status: VoiceStatus;
  engine: VoiceEngineId;
  saving: boolean;
  onSelect: (engine: VoiceEngineId) => void;
  onSetup: () => void;
  onCancelSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
}) {
  const info = VOICE_ENGINE_INFO[engine];
  const installing = ["running", "cancelling"].includes(
    status.setupState ?? "",
  );
  const working =
    installing ||
    status.engine === "settingUp" ||
    status.engine === "loading" ||
    status.warmup === "warming";
  const locked = saving || working;
  const failed = status.engine === "error";
  // A crash or timeout only needs a reload; a failed setup needs Repair.
  const reloadable = failed && status.setupState !== "failed";

  let tone: DotTone = "";
  let line: string;
  if (working) {
    tone = "busy";
    line =
      (status.setupStage && STAGES[status.setupStage]) ??
      (status.engine === "loading" ? "Loading the engine" : "Setting up");
  } else if (failed) {
    tone = "error";
    line = status.failure?.message ?? status.message;
  } else if (status.engine === "missing") {
    tone = "warning";
    line =
      status.setupState === "cancelled"
        ? "Setup cancelled"
        : status.migrationRequired
          ? "Needs a runtime update"
          : info.tier === "small"
            ? `Not set up · ${info.downloadSize} download`
            : `Not set up · ${info.downloadSize} download, needs an NVIDIA GPU or Apple Silicon`;
  } else if (status.engine === "ready") {
    tone = "ready";
    line = status.device ? `Ready · ${status.device.toUpperCase()}` : "Ready";
  } else {
    line = "Asleep · wakes when something is said";
  }
  const note = working ? progressNote(status.detail, status.downloadBytes) : "";

  return (
    <>
      <div className="engine-choice" role="radiogroup" aria-label="Engine">
        {VOICE_ENGINES.map((id) => {
          const option = VOICE_ENGINE_INFO[id];
          const Icon = ICONS[id];
          const selected = engine === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="engine-option"
              disabled={locked}
              onClick={() => !selected && onSelect(id)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>
                  {option.tier === "small" ? "Small" : "Large"} · {option.name}
                </strong>
                <small>{option.description}</small>
                <small className="tier-meta">
                  {option.downloadSize} · {hardware(option)}
                </small>
              </span>
              {selected && (
                <Check className="engine-check" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      <div className="setting-row siren-engine">
        <Cpu className="setting-icon" aria-hidden="true" />
        <div className="setting-copy">
          <strong>{info.name}</strong>
          <details className="setting-help">
            <summary
              aria-label={`About ${info.name}`}
              title={`About ${info.name}`}
            >
              <Info />
            </summary>
            <p>
              {info.repository} at {info.revision.slice(0, 7)} · {info.license}{" "}
              · {info.runtime}
              {info.id === "chatterbox-turbo" &&
                ". Adds an inaudible watermark to everything it says."}
            </p>
          </details>
          <p
            className={`siren-state ${failed ? "failed" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span className={`status-dot ${tone}`} aria-hidden="true" />
            {line}
          </p>
          {working && (
            <>
              <progress
                aria-label={`${info.name} setup progress`}
                max={1}
                value={
                  typeof status.progress === "number"
                    ? status.progress
                    : undefined
                }
              />
              {note && <p className="caption">{note}</p>}
            </>
          )}
        </div>
        <div className="setting-control">
          {installing && (
            <button
              className="secondary-button"
              disabled={status.setupState === "cancelling"}
              onClick={onCancelSetup}
            >
              {status.setupState === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {status.engine === "ready" && (
            <button
              className="tool-button"
              disabled={locked}
              onClick={onUnload}
            >
              Unload
            </button>
          )}
          {(status.engine === "unloaded" || reloadable) && (
            <button
              className="secondary-button"
              disabled={locked}
              onClick={onLoad}
            >
              <Play /> {reloadable ? "Try again" : "Load"}
            </button>
          )}
          {(status.engine === "ready" ||
            status.engine === "unloaded" ||
            reloadable) && (
            <button
              className="tool-button"
              disabled={locked}
              onClick={onSetup}
              title={`Reinstall ${info.name}`}
            >
              <Download /> Repair
            </button>
          )}
          {(status.engine === "missing" || (failed && !reloadable)) && (
            <button
              className="primary-button"
              disabled={locked}
              onClick={onSetup}
            >
              {working ? <LoaderCircle className="spin" /> : <Download />}
              {status.engine === "missing"
                ? status.migrationRequired
                  ? "Update"
                  : "Set up"
                : "Repair"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
