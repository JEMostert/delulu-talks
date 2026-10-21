import {
  Check,
  Download,
  Feather,
  LoaderCircle,
  Play,
  Sparkles,
  Speech,
} from "lucide-react";
import { Alert } from "../ui";
import { EngineBadge } from "../models/EngineBadge";
import {
  VOICE_ENGINE_INFO,
  VOICE_ENGINES,
  type VoiceEngineId,
  type VoiceStatus,
} from "../../voice";
import type { AppSettings, SetupStage } from "../../types";

const ICONS = { kokoro: Feather, "chatterbox-turbo": Sparkles } as const;

const STAGES: Partial<Record<SetupStage, string>> = {
  "runtime-check": "Checking the setup interpreter",
  "runtime-prepare": "Creating the isolated voice runtime",
  "runtime-packages": "Resolving and installing runtime packages",
  "runtime-download": "Downloading or reusing runtime packages",
  "runtime-install": "Installing retrieved runtime packages",
  "runtime-build": "Building runtime packages",
  "runtime-validate": "Validating runtime dependencies",
  "model-prepare": "Starting the voice model",
  "model-download": "Downloading or reusing voice model files",
  "model-load": "Loading voice model weights",
  warmup: "Speaking a short warmup",
  "model-loaded": "Voice model loaded",
  ready: "Ready",
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const gib = 1024 ** 3;
  const unit = bytes >= gib ? "GiB" : "MiB";
  return `${(bytes / (bytes >= gib ? gib : 1024 ** 2)).toFixed(2)} ${unit}`;
}

/** Kokoro or Chatterbox Turbo, with the same setup controls as speech models. */
export function VoiceEngineSetup({
  status,
  settings,
  saving,
  onSelect,
  onSetup,
  onCancelSetup,
  onLoad,
  onUnload,
}: {
  status: VoiceStatus;
  settings: AppSettings;
  saving: boolean;
  onSelect: (engine: VoiceEngineId) => void;
  onSetup: () => void;
  onCancelSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
}) {
  const info = VOICE_ENGINE_INFO[settings.voiceEngine];
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
  const bytes = status.downloadBytes;
  return (
    <section className="setup-card" aria-label="Voice model setup">
      <div className="setup-card-heading">
        <Speech />
        <div>
          <h2>
            {status.engine === "missing"
              ? status.migrationRequired
                ? `Update the runtime for ${info.name}`
                : "Choose a voice model"
              : failed
                ? "Fix voice setup"
                : "Voice model"}
          </h2>
          <p>
            {info.name} ·{" "}
            {status.device
              ? `${info.runtime} · ${status.device}`
              : info.runtime}
          </p>
        </div>
        <EngineBadge engine={status.engine} />
      </div>
      <div className="engine-choice" role="radiogroup" aria-label="Voice model">
        {VOICE_ENGINES.map((id) => {
          const engine = VOICE_ENGINE_INFO[id];
          const Icon = ICONS[id];
          const selected = settings.voiceEngine === id;
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
                  {engine.tier === "small" ? "Small" : "Large"} · {engine.name}
                  {engine.expressive && (
                    <span className="tier-tag">Expressive</span>
                  )}
                </strong>
                <small>{engine.description}</small>
                <small className="tier-meta">
                  {engine.downloadSize} · {engine.runtime}
                </small>
              </span>
              {selected && (
                <Check className="engine-check" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {status.engine === "missing" && (
        <p className="setup-status-copy">
          {info.name}: {info.downloadSize} download
          {info.tier === "large"
            ? ". Needs an NVIDIA GPU or Apple Silicon for real-time speech."
            : ", runs on the CPU you already have."}{" "}
          Nothing is downloaded until you press set up.
        </p>
      )}
      <div className="runtime-actions">
        {installing && (
          <button
            className="secondary-button"
            disabled={status.setupState === "cancelling"}
            onClick={onCancelSetup}
          >
            {status.setupState === "cancelling"
              ? "Cancelling…"
              : "Cancel setup"}
          </button>
        )}
        {status.engine === "ready" && (
          <button
            className="secondary-button"
            disabled={locked}
            onClick={onUnload}
          >
            Unload
          </button>
        )}
        {(status.engine === "unloaded" || reloadable) && (
          <button className="primary-button" disabled={locked} onClick={onLoad}>
            <Play /> {reloadable ? "Load again" : "Load now"}
          </button>
        )}
        {(status.engine === "ready" || status.engine === "unloaded") && (
          <button
            className="tool-button"
            disabled={locked}
            onClick={onSetup}
            title="Reinstall the voice runtime"
          >
            <Download /> Repair
          </button>
        )}
        {(status.engine === "missing" || failed) && (
          <button
            className={reloadable ? "tool-button" : "primary-button"}
            disabled={locked}
            onClick={onSetup}
          >
            {working ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing"
              ? `Download & set up ${info.name}`
              : "Repair"}
          </button>
        )}
      </div>
      {working && (
        <section className="progress-panel" aria-live="polite">
          <div>
            <strong>
              {(status.setupStage && STAGES[status.setupStage]) ??
                (status.engine === "loading"
                  ? "Loading the voice model"
                  : "Preparing the voice runtime")}
            </strong>
            <span>Working…</span>
          </div>
          {typeof status.progress === "number" ? (
            <progress
              aria-label="Voice setup progress"
              max={1}
              value={status.progress}
            />
          ) : (
            <progress aria-label="Voice setup progress" max={1} />
          )}
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          {bytes ? (
            <p className="caption">
              <strong>
                {bytes.kind === "transfer"
                  ? "Network transfer"
                  : "Cache reconstruction"}
              </strong>
              {": "}
              {formatBytes(bytes.completed)} completed
              {bytes.total == null
                ? " · total unavailable"
                : ` / ${formatBytes(bytes.total)} reported total`}
            </p>
          ) : null}
        </section>
      )}
      {!working && status.engine === "ready" && (
        <p className="caption mt-3" role="status">
          {status.warmup === "complete"
            ? "Ready to speak"
            : "Loaded · checked on the first sentence"}
        </p>
      )}
      {failed && (
        <Alert
          action={
            <button
              className="secondary-button"
              disabled={locked}
              onClick={reloadable ? onLoad : onSetup}
            >
              Try again
            </button>
          }
        >
          {status.failure?.message ?? status.message}
        </Alert>
      )}
      {status.setupState === "cancelled" && (
        <p className="setup-status-copy" role="status">
          {status.message}
        </p>
      )}
      <details className="setup-details">
        <summary>Model details & license</summary>
        <dl className="voice-facts" aria-label="Voice model details">
          <dt>Checkpoint</dt>
          <dd>{info.repository}</dd>
          <dt>Revision</dt>
          <dd>{info.revision}</dd>
          <dt>License</dt>
          <dd>{info.license}</dd>
          <dt>Runs on</dt>
          <dd>{info.runtime}</dd>
        </dl>
        {info.id === "chatterbox-turbo" && (
          <p className="caption mt-2">
            Chatterbox adds an inaudible watermark to every sentence it speaks,
            so the audio can be identified as synthetic.
          </p>
        )}
      </details>
    </section>
  );
}
