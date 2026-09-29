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
  onLoadMagic,
  onUnloadMagic,
}: RewriteSetupProps) {
  const writingModel = magicModelById(settings.magicModel);
  const writingBusy = ["preparing", "loading", "rewriting"].includes(
    magicStatus.phase,
  );
  return (
    <section className="card" aria-labelledby="rewrite-model-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">OPTIONAL REWRITING</span>
          <h3 id="rewrite-model-heading">Rewrite where your text is</h3>
        </div>
        <WandSparkles className="h-5 w-5 text-accent-ink" />
      </div>
      <p className="mt-3 text-sm text-muted">
        Use Rewrite beside any transcript to shorten, polish, make bullet points, write a professional message, organize, or build
        a prompt. Compare the preview before applying it, and undo at any time.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="field min-w-[180px] flex-1">
          Local rewrite model
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
          {magicStatus.engine === "ready" ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onUnloadMagic}
            >
              Unload rewrite model
            </button>
          ) : magicStatus.engine === "unloaded" ? (
            <button
              className="secondary-button"
              disabled={busy || setupPending}
              onClick={onLoadMagic}
            >
              <Play /> Load rewrite model
            </button>
          ) : null}
          <button
            className="primary-button"
            disabled={busy || setupPending}
            onClick={onSetupMagic}
          >
            {writingBusy ? <LoaderCircle className="spin" /> : <Download />}
            {magicStatus.engine === "missing"
              ? "Install rewrite runtime"
              : "Repair rewrite runtime"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{writingModel.description}</p>
      <ModelProvenance {...writingModel} />
      <ModelLifecycle status={magicStatus} />
      <BackendCapabilities capabilities={magicStatus.capabilities} />
      <p className="mt-2 text-xs text-muted" role="status">
        {magicStatus.message}
      </p>
      <ModelSetupStatus
        status={magicStatus}
        kind="rewrite"
        busy={busy || setupPending}
        onRepair={onSetupMagic}
      />
    </section>
  );
}
