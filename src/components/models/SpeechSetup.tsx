import {
  Cpu,
  Download,
  HardDrive,
  LoaderCircle,
  Play,
  ShieldCheck,
} from "lucide-react";
import { modelById } from "../../data";
import type { AppSettings, DictationStatus } from "../../types";
import { ModelSetupStatus } from "./ModelSetupStatus";
import { ModelProvenance } from "./ModelProvenance";
import { ModelLifecycle } from "./ModelLifecycle";

export type SpeechSetupProps = {
  status: DictationStatus;
  settings: AppSettings;
  busy: boolean;
  setupPending?: boolean;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
};
export function SpeechSetup({
  status,
  settings,
  busy,
  setupPending = false,
  onSetup,
  onLoad,
  onUnload,
}: SpeechSetupProps) {
  const model = modelById(status.speechModel ?? status.model ?? settings.model);
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
                disabled={busy || setupPending}
                onClick={onLoad}
              >
                <Play /> Load model
              </button>
            )
          )}
          <button className="primary-button" disabled={busy || setupPending} onClick={onSetup}>
            {speechBusy ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing"
              ? status.migrationRequired
                ? "Update setup"
                : "Install engine"
              : "Repair engine"}
          </button>
        </div>
      </section>
      <ModelLifecycle status={status} />
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
      <ModelProvenance {...model} />
      <p className="flex items-center justify-center gap-[7px] text-[11px] text-muted">
        <ShieldCheck className="w-3.5 h-3.5" /> Models stay on your device.
        Dictation runs fully locally.
      </p>
    </>
  );
}
