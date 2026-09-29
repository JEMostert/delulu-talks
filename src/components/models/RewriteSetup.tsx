import { Download, LoaderCircle, Play, WandSparkles } from "lucide-react";
import { MAGIC_MODELS, magicModelById } from "../../data";
import type { AppSettings, MagicStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";

export type RewriteSetupProps = {
  magicStatus: MagicStatus;
  settings: AppSettings;
  busy: boolean;
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
        Use Rewrite beside any transcript to shorten, polish, organize, or build
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
              Unload rewriting
            </button>
          ) : magicStatus.engine === "unloaded" ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onLoadMagic}
            >
              <Play /> Load rewriting
            </button>
          ) : null}
          <button
            className="primary-button"
            disabled={busy}
            onClick={onSetupMagic}
          >
            {writingBusy ? <LoaderCircle className="spin" /> : <Download />}
            {magicStatus.engine === "missing"
              ? "Install rewriting"
              : "Repair rewriting"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{writingModel.description}</p>
      <p className="mt-2 text-xs text-muted" role="status">
        {magicStatus.message}
      </p>
      <ModelSetupStatus
        status={magicStatus}
        kind="rewrite"
        busy={busy}
        onRepair={onSetupMagic}
      />
    </section>
  );
}
