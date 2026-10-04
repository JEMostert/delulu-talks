import { Cpu, Download, LoaderCircle, Play } from "lucide-react";
import { modelById } from "../../data";
import { speechBackendById } from "../../speechModels";
import type { AppSettings, DictationStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";
import { BackendCapabilities } from "./BackendCapabilities";
import { EngineBadge } from "./EngineBadge";

export type SpeechSetupProps = {
  status: DictationStatus;
  settings: AppSettings;
  busy: boolean;
  setupPending?: boolean;
  onSetup: () => void;
  onCancelSetup?: () => void;
  onLoad: () => void;
  onUnload: () => void;
};
export function SpeechSetup({
  status,
  settings,
  busy,
  setupPending = false,
  onSetup,
  onCancelSetup,
  onLoad,
  onUnload,
}: SpeechSetupProps) {
  const execution = status.speechExecution;
  const model = modelById(status.speechModel ?? status.model ?? settings.model);
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
                ? "Update speech model"
                : "Set up speech"
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
      {(status.engine === "ready" || status.engine === "unloaded") &&
        status.residency && <ModelLifecycle status={status} />}
      {status.engine === "missing" && (
        <p className="setup-status-copy">{model.downloadSize} download</p>
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
              ? status.migrationRequired
                ? "Update setup"
                : "Download & set up"
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
