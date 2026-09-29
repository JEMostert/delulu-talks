import {
  Cpu,
  Download,
  HardDrive,
  LoaderCircle,
  Play,
  ShieldCheck,
  WandSparkles,
} from "lucide-react";
import { MAGIC_MODELS, magicModelById, modelById } from "../data";
import { Diagnostics } from "../components/Diagnostics";
import { Alert } from "../components/ui";
import type { AppSettings, DictationStatus, MagicStatus } from "../types";

export function ModelsPage({
  status,
  magicStatus,
  settings,
  busy,
  saving,
  onUpdateSettings,
  onSetupMagic,
  onLoadMagic,
  onUnloadMagic,
  onSetup,
  onLoad,
  onUnload,
}: {
  status: DictationStatus;
  magicStatus: MagicStatus;
  settings: AppSettings;
  busy: boolean;
  saving: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSetupMagic: () => void;
  onLoadMagic: () => void;
  onUnloadMagic: () => void;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
}) {
  const model = modelById(status.speechModel ?? status.model ?? settings.model);
  const speechBusy = ["preparing", "loading", "transcribing"].includes(
    status.phase,
  );
  const writingModel = magicModelById(settings.magicModel);
  const writingBusy = ["preparing", "loading", "rewriting"].includes(
    magicStatus.phase,
  );
  return (
    <div className="content-stack">
      <section className="flex items-center gap-5 bg-hero rounded-panel p-7 shadow-panel backdrop-blur-xl max-[1150px]:flex-wrap">
        <div className="grid place-items-center size-[58px] rounded-[18px] bg-accent-soft text-accent-ink backdrop-blur-md shrink-0">
          <Cpu className="w-[26px] h-[26px]" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="eyebrow">LOCAL SPEECH ENGINE</span>
          <h2 className="text-[20px]">
            {status.engine === "ready"
              ? "Speech model loaded"
              : status.engine === "missing"
                ? status.migrationRequired
                  ? "Update the speech setup"
                  : "Install the speech engine"
                : status.engine === "error"
                  ? "Speech engine error"
                  : speechBusy
                    ? "Preparing speech engine…"
                    : "Speech model unloaded"}
          </h2>
          <p className="text-[12px] text-muted mt-2 [overflow-wrap:anywhere]">
            {status.engine === "missing"
              ? status.migrationRequired
                ? `Update the dedicated ${model.name} speech environment.`
                : `Install ${model.name} and download its weights. ${model.description}`
              : status.message}
          </p>
        </div>
        <div className="runtime-actions justify-end">
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
                className="secondary-button"
                disabled={busy}
                onClick={onLoad}
              >
                <Play /> Load model
              </button>
            )
          )}
          <button className="primary-button" disabled={busy} onClick={onSetup}>
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing"
              ? status.migrationRequired
                ? "Update setup"
                : "Install engine"
              : "Repair engine"}
          </button>
        </div>
      </section>
      {["preparing", "loading"].includes(status.phase) && (
        <section className="progress-panel" aria-live="polite">
          <div>
            <strong>
              {status.phase === "preparing"
                ? "Installing runtime packages"
                : "Preparing your model"}
            </strong>
            <span>
              {status.progress != null
                ? `${Math.round(status.progress * 100)}% of setup stages`
                : "Working…"}
            </span>
          </div>
          <progress
            aria-label="Model setup stages"
            max={1}
            value={status.progress ?? undefined}
          />
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          <p className="caption">
            Downloads can take a while. This indicates setup stages, not bytes
            downloaded. Keep the app open.
          </p>
        </section>
      )}
      {status.phase === "error" && (
        <Alert
          action={
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onSetup}
            >
              Repair
            </button>
          }
        >
          {status.message}
        </Alert>
      )}
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
                {item.runtime}
              </span>
            </div>
            <p className="text-[11px] text-muted leading-[1.6] max-[700px]:row-start-2 max-[700px]:col-span-full">
              {item.description}
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
      <p className="flex items-center justify-center gap-[7px] text-[11px] text-muted">
        <ShieldCheck className="w-3.5 h-3.5" /> Models stay on your device.
        Dictation runs fully locally.
      </p>
      <section className="card" aria-labelledby="rewrite-model-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">OPTIONAL REWRITING</span>
            <h3 id="rewrite-model-heading">Rewrite where your text is</h3>
          </div>
          <WandSparkles className="h-5 w-5 text-accent-ink" />
        </div>
        <p className="mt-3 text-sm text-muted">
          Use Rewrite beside any transcript to shorten, polish, organize, or
          build a prompt. Compare the preview before applying it, and undo at
          any time.
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
        {writingBusy && (
          <>
            <progress
              className="mt-3 w-full"
              aria-label="Rewrite model setup stages"
              max={1}
              value={magicStatus.progress ?? undefined}
            />
            {magicStatus.detail && (
              <p className="caption" role="status">
                {magicStatus.detail}
              </p>
            )}
          </>
        )}
        {magicStatus.engine === "error" && <Alert>{magicStatus.message}</Alert>}
      </section>
      <Diagnostics />
    </div>
  );
}
