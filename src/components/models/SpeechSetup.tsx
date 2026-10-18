import { Cpu, Download, LoaderCircle, Play } from "lucide-react";
import {
  CANARY_MODEL,
  modelById,
  PARAKEET_MODEL,
  speechTierById,
} from "../../data";
import { speechBackendById } from "../../speechModels";
import type { AppSettings, DictationStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";
import { BackendCapabilities } from "./BackendCapabilities";
import { EngineBadge } from "./EngineBadge";
import { SpeechTierPicker } from "./SpeechTierPicker";
import { DownloadedModels } from "./DownloadedModels";

export type SpeechSetupProps = {
  largeSpeechAvailable?: boolean;
  status: DictationStatus;
  settings: AppSettings;
  busy: boolean;
  setupPending?: boolean;
  onSetup: () => void;
  onCancelSetup?: () => void;
  onLoad: () => void;
  onUnload: () => void;
  /** Present where the engine may be switched in place. */
  onUpdateSettings?: (patch: Partial<AppSettings>) => void;
};
export function SpeechSetup({
  largeSpeechAvailable = false,
  status,
  settings,
  busy,
  setupPending = false,
  onSetup,
  onCancelSetup,
  onLoad,
  onUnload,
  onUpdateSettings,
}: SpeechSetupProps) {
  const execution = status.speechExecution;
  const r2t2 = modelById(status.speechModel ?? status.model ?? settings.model);
  const tier = speechTierById(settings.speechEngine);
  const model =
    tier.id === "small"
      ? CANARY_MODEL
      : tier.id === "medium" || !largeSpeechAvailable
        ? PARAKEET_MODEL
        : r2t2;
  // First run: nothing is installed yet, so the user chooses before any download.
  const choosing = status.engine === "missing" && !status.migrationRequired;
  const backend = execution ? speechBackendById(execution.backendId) : null;
  const speechBusy = ["preparing", "loading", "transcribing"].includes(
    status.phase,
  );
  const installing = ["running", "cancelling"].includes(
    status.setupState ?? "",
  );
  return (
    <section className="setup-card" aria-label="Speech setup">
      <div className="setup-card-heading">
        <Cpu />
        <div>
          <h2>
            {status.engine === "missing"
              ? status.migrationRequired
                ? `Set up ${tier.name}`
                : "Choose a speech model"
              : status.engine === "error"
                ? "Fix speech setup"
                : "Speech"}
          </h2>
          <p>
            {model.name} · {backend?.label ?? model.runtime}
          </p>
        </div>
        <EngineBadge engine={status.engine} />
      </div>
      {choosing && (
        <p className="setup-status-copy">
          Pick a size for this computer. Nothing is downloaded until you press
          Download &amp; set up, and you can switch later in Settings.
        </p>
      )}
      {onUpdateSettings && (
        <SpeechTierPicker
          settings={settings}
          largeAvailable={largeSpeechAvailable}
          disabled={busy || speechBusy || installing}
          onSelect={onUpdateSettings}
        />
      )}
      {(status.engine === "ready" || status.engine === "unloaded") &&
        status.residency && <ModelLifecycle status={status} />}
      {status.engine === "missing" && (
        <p className="setup-status-copy">
          {tier.name}: {tier.download} download
          {tier.id === "large"
            ? ", plus the GPU runtime (several GB)."
            : ", plus a small CPU runtime."}
        </p>
      )}
      <div className="runtime-actions">
        {onCancelSetup && installing && (
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
        {status.engine === "ready" ? (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onUnload}
          >
            Unload
          </button>
        ) : (
          status.engine === "unloaded" && (
            <button
              className="primary-button"
              disabled={busy || setupPending}
              onClick={onLoad}
            >
              <Play /> Load now
            </button>
          )
        )}
        {(status.engine === "ready" || status.engine === "unloaded") && (
          <button
            className="tool-button"
            disabled={busy || setupPending}
            onClick={onSetup}
            title="Reinstall the runtime included with this app"
          >
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            Repair
          </button>
        )}
        {(status.engine === "missing" || status.engine === "error") && (
          <button
            className="primary-button"
            disabled={busy || setupPending}
            onClick={onSetup}
          >
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing"
              ? `Download & set up ${tier.name}`
              : "Repair"}
          </button>
        )}
      </div>
      <ModelSetupStatus
        status={status}
        kind="speech"
        busy={busy || setupPending}
        onRepair={onSetup}
      />
      {status.setupState === "cancelled" && (
        <p className="setup-status-copy" role="status">
          {status.message}
        </p>
      )}
      <DownloadedModels status={status} busy={busy || installing} />
      <details className="setup-details">
        <summary>Model details & license</summary>
        <BackendCapabilities capabilities={status.capabilities} />
        <p className="setup-status-copy">{model.description}</p>
        {execution && (
          <dl aria-label="Reported speech execution">
            <dt>Backend</dt>
            <dd>
              {backend?.label ?? execution.backendId} ·{" "}
              {execution.precision?.toUpperCase() ?? "Precision unknown"}
            </dd>
            <dt>Platform / device</dt>
            <dd>
              {execution.platform} / {execution.device}
            </dd>
            <dt>Checkpoint</dt>
            <dd>{execution.checkpoint.repository || "Not reported"}</dd>
            <dt>Revision</dt>
            <dd>
              {execution.checkpoint.revision || "Unpinned / not reported"}
            </dd>
          </dl>
        )}
        <ModelProvenance {...model} />
      </details>
    </section>
  );
}
