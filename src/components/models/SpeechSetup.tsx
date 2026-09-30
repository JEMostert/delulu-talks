import {
  Cpu,
  Download,
  HardDrive,
  LoaderCircle,
  Play,
  ShieldCheck,
} from "lucide-react";
import { modelById } from "../../data";
import { speechBackendById } from "../../speechModels";
import type { AppSettings, DictationStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";
import { BackendCapabilities } from "./BackendCapabilities";

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
  return (
    <>
      <section className="flex items-center gap-5 bg-hero rounded-panel p-7 shadow-panel backdrop-blur-xl max-[1150px]:flex-wrap">
        <div className="grid place-items-center size-[58px] rounded-[18px] bg-accent-soft text-accent-ink backdrop-blur-md shrink-0">
          <Cpu className="w-[26px] h-[26px]" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="eyebrow">LOCAL SPEECH MODEL</span>
          <h2 className="text-[20px]">
            {status.engine === "ready"
              ? "Speech model loaded"
              : status.engine === "missing"
                ? status.migrationRequired
                  ? "Update the speech setup"
                  : "Install the speech runtime"
                : status.engine === "error"
                  ? "Speech setup error"
                  : speechBusy
                    ? "Preparing speech model…"
                    : "Speech model unloaded"}
          </h2>
          <p className="text-[12px] text-muted mt-2 [overflow-wrap:anywhere]">
            {status.setupState === "cancelled"
              ? status.message
              : status.engine === "missing"
                ? status.migrationRequired
                  ? `Update the dedicated speech runtime for ${model.name}.`
                  : `Install the speech runtime and download the ${model.name} weights. ${model.description}`
                : status.message}
          </p>
        </div>
        <div className="runtime-actions justify-end">
          {onCancelSetup &&
            ["running", "cancelling"].includes(status.setupState ?? "") && (
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
              Unload model
            </button>
          ) : (
            status.engine === "unloaded" && (
              <button
                className="secondary-button"
                disabled={busy || setupPending}
                onClick={onLoad}
              >
                <Play /> Load model
              </button>
            )
          )}
          <button
            className="primary-button"
            disabled={busy || setupPending}
            onClick={onSetup}
          >
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing"
              ? status.migrationRequired
                ? "Update setup"
                : "Install runtime"
              : "Repair runtime"}
          </button>
        </div>
      </section>
      <ModelLifecycle status={status} />
      <BackendCapabilities capabilities={status.capabilities} />
      <ModelSetupStatus
        status={status}
        kind="speech"
        busy={busy || setupPending}
        onRepair={onSetup}
      />
      <div className="section-heading">
        <div>
          <span className="eyebrow">SPEECH MODEL</span>
          <h3>Installed model</h3>
        </div>
      </div>
      <div className="border border-line rounded-lg overflow-hidden">
        {[model].map((item) => (
          <article
            key={item.id}
            className="model-option selected grid grid-cols-[150px_minmax(0,1fr)_130px] gap-5 items-center px-[18px] py-4 bg-accent-soft shadow-[inset_3px_0_var(--accent)] max-[1150px]:grid-cols-[120px_minmax(0,1fr)_106px] max-[1150px]:gap-3 max-[700px]:grid-cols-[1fr_auto]"
          >
            <div>
              <h3 className="text-[16px]">{item.name}</h3>
              <span className="block text-[11px] text-muted mt-1">
                {execution
                  ? `Backend: ${backend?.label ?? execution.backendId} · ${execution.precision?.toUpperCase() ?? "Precision unknown"}`
                  : item.runtime}
              </span>
            </div>
            <p className="text-[11px] text-muted leading-[1.6] max-[700px]:row-start-2 max-[700px]:col-span-full">
              {execution && backend ? backend.capability : item.description}
            </p>
            <div className="flex items-center gap-2 text-[11px] max-[1150px]:hidden">
              <HardDrive className="w-[15px] h-[15px] text-muted" />
              <span>
                {item.downloadSize}
                <small className="block text-[9px]">Model download</small>
              </span>
            </div>
          </article>
        ))}
      </div>
      {execution ? (
        <section className="card" aria-label="Reported speech execution">
          <h3>Reported speech execution</h3>
          <dl className="text-xs [overflow-wrap:anywhere]">
            <dt>Model</dt>
            <dd>
              {model.name} ({execution.modelId})
            </dd>
            <dt>Backend</dt>
            <dd>
              {backend?.label ?? execution.backendId} ({execution.backendId})
            </dd>
            <dt>Precision</dt>
            <dd>
              {execution.precision?.toUpperCase() ?? "Unknown (not reported)"}
            </dd>
            <dt>Platform / device</dt>
            <dd>
              {execution.platform} / {execution.device}
            </dd>
            <dt>Checkpoint repository</dt>
            <dd>
              {execution.checkpoint.repository || "Unknown (not reported)"}
            </dd>
            <dt>Checkpoint revision</dt>
            <dd>
              {execution.checkpoint.revision ||
                "Unpinned / unknown (not reported)"}
            </dd>
          </dl>
          <p className="caption">
            Native hardware validation pending. A loaded model does not
            establish native hardware acceptance.
          </p>
        </section>
      ) : null}
      <div>
        <p className="text-xs text-muted mt-3">
          Catalog source and license (configured checkpoint, not observed
          runtime facts)
        </p>
        <ModelProvenance {...model} />
      </div>
      <p className="flex items-center justify-center gap-[7px] text-[11px] text-muted">
        <ShieldCheck className="w-3.5 h-3.5" /> Models stay on your device.
        Dictation runs fully locally.
      </p>
    </>
  );
}
