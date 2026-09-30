import { Download, LoaderCircle, Play, WandSparkles } from "lucide-react";
import { MAGIC_MODELS, magicModelById } from "../../data";
import type { AppSettings, MagicStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";
import { BackendCapabilities } from "./BackendCapabilities";

export type RewriteSetupProps = {
  magicStatus: MagicStatus;
  settings: AppSettings;
  busy: boolean;
  setupPending?: boolean;
  saving: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSetupMagic: () => void;
  onCancelSetupMagic?: () => void;
  onLoadMagic: () => void;
  onUnloadMagic: () => void;
};
export function RewriteSetup({
  magicStatus,
  settings,
  busy,
  setupPending = false,
  saving,
  onUpdateSettings,
  onSetupMagic,
  onCancelSetupMagic,
  onLoadMagic,
  onUnloadMagic,
}: RewriteSetupProps) {
  const writingModel = magicModelById(settings.magicModel);
  const writingBusy = ["preparing", "loading", "rewriting"].includes(
    magicStatus.phase,
  );
  return (
    <section className="setup-card" aria-labelledby="rewrite-model-heading">
      <div className="setup-card-heading">
        <WandSparkles />
        <div>
          <h2 id="rewrite-model-heading">Rewriting</h2>
          <p>{writingModel.name}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="field min-w-[180px] flex-1">
          Model
          <select
            aria-label="Local rewrite model"
            value={settings.magicModel}
            disabled={busy || saving}
            onChange={(event) =>
              onUpdateSettings({
                magicModel: event.target.value as AppSettings["magicModel"],
              })
            }
          >
            {MAGIC_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="runtime-actions">
          {onCancelSetupMagic &&
            ["running", "cancelling"].includes(
              magicStatus.setupState ?? "",
            ) && (
              <button
                className="secondary-button"
                disabled={magicStatus.setupState === "cancelling"}
                onClick={onCancelSetupMagic}
              >
                {magicStatus.setupState === "cancelling"
                  ? "Cancelling…"
                  : "Cancel setup"}
              </button>
            )}
          {magicStatus.engine === "ready" ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onUnloadMagic}
            >
              Release memory
            </button>
          ) : magicStatus.engine === "unloaded" ? (
            <button
              className="secondary-button"
              disabled={busy || setupPending}
              onClick={onLoadMagic}
            >
              <Play /> Load rewriting
            </button>
          ) : null}
          {(magicStatus.engine === "missing" ||
            magicStatus.engine === "error") && (
            <button
              className="primary-button"
              disabled={busy || setupPending}
              onClick={onSetupMagic}
            >
              {writingBusy ? <LoaderCircle className="spin" /> : <Download />}
              {magicStatus.engine === "missing"
                ? "Download & set up"
                : "Fix setup"}
            </button>
          )}
        </div>
      </div>
      <ModelSetupStatus
        status={magicStatus}
        kind="rewrite"
        busy={busy || setupPending}
        onRepair={onSetupMagic}
      />
      {magicStatus.setupState === "cancelled" && (
        <p className="setup-status-copy" role="status">
          {magicStatus.message}
        </p>
      )}
      {(magicStatus.engine === "ready" ||
        magicStatus.engine === "unloaded") && (
        <details className="disclosure">
          <summary>Maintenance</summary>{" "}
          <button
            className="secondary-button"
            disabled={busy || setupPending}
            onClick={onSetupMagic}
          >
            {writingBusy ? <LoaderCircle className="spin" /> : <Download />}
            Fix setup
          </button>
        </details>
      )}
      <details className="setup-details">
        <summary>Model details & license</summary>
        <p className="setup-status-copy">{writingModel.description}</p>
        <ModelProvenance {...writingModel} />
        <ModelLifecycle status={magicStatus} />
        <BackendCapabilities capabilities={magicStatus.capabilities} />
      </details>
    </section>
  );
}
