import { Cpu, Download, LoaderCircle } from "lucide-react";
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
import { RuntimeSetupLog } from "./RuntimeSetupLog";

export type SpeechSetupProps = {
  largeSpeechAvailable?: boolean;
  status: DictationStatus;
  settings: AppSettings;
  busy: boolean;
  setupPending?: boolean;
  onSetup: () => void;
  onCancelSetup?: () => void;
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
  const backend = execution ? speechBackendById(execution.backendId) : null;
  const speechBusy = ["preparing", "loading", "transcribing"].includes(
    status.phase,
  );
  const installing = ["running", "cancelling"].includes(
    status.setupState ?? "",
  );
  const installed = status.engine === "ready" || status.engine === "unloaded";
  return (
    <section className="setup-card" aria-labelledby="speech-engine-heading">
      <div className="setup-card-heading">
        <Cpu />
        <div>
          <h2 id="speech-engine-heading">
            {status.engine === "missing"
              ? status.migrationRequired
                ? `Set up ${tier.name}`
                : "Choose a size"
              : status.engine === "error"
                ? "Fix speech setup"
                : "Speech recognition"}
          </h2>
        </div>
        <EngineBadge engine={status.engine} />
      </div>
      {onUpdateSettings && (
        <SpeechTierPicker
          settings={settings}
          largeAvailable={largeSpeechAvailable}
          disabled={busy || speechBusy || installing}
          onSelect={onUpdateSettings}
        />
      )}
      {status.engine === "missing" && (
        <p className="setup-status-copy">
          Downloads {tier.download}, plus{" "}
          {tier.id === "large"
            ? "a GPU runtime of several GB."
            : "a small CPU runtime."}
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
        {/* A failed setup offers Fix setup in the alert below. */}
        {status.engine === "missing" && (
          <button
            className="primary-button"
            disabled={busy || setupPending}
            onClick={onSetup}
          >
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            Download & set up {tier.name}
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
        <summary>Details</summary>
        <p className="setup-status-copy">
          <strong className="text-ink">
            {model.name} · {backend?.label ?? model.runtime}
          </strong>
          <br />
          {model.description}
        </p>
        {installed && status.residency && <ModelLifecycle status={status} />}
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
        <BackendCapabilities capabilities={status.capabilities} />
        <ModelProvenance {...model} />
        <div className="runtime-actions mt-4">
          <RuntimeSetupLog kind="speech" />
        </div>
      </details>
    </section>
  );
}
