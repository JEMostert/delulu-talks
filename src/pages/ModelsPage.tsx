import { Check, ChevronRight, Cpu, Download, Gauge, HardDrive, LoaderCircle, PauseCircle, PlayCircle, ShieldAlert } from "lucide-react";
import { MODELS } from "../data";
import type { DictationStatus, ModelId } from "../types";

export function ModelsPage({ selected, status, saving, licenseAccepted, onSelect, onSetup, onLoad, onUnload, onOpenSettings }: {
  selected: ModelId;
  status: DictationStatus;
  saving: boolean;
  licenseAccepted: boolean;
  onSelect: (id: ModelId) => void;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onOpenSettings: () => void;
}) {
  const busy = ["preparing", "loading"].includes(status.phase);
  return (
    <div className="content-stack models-view">
      <section className="view-toolbar">
        <div><strong>Installed model family</strong><span>Four standard CrisperWhisper 2.0 checkpoints · selection changes the next loaded runtime</span></div>
        <div className="runtime-actions">
          {status.engine === "ready" ? <button className="secondary-button" onClick={onUnload}><PauseCircle /> Unload model</button> : status.engine === "unloaded" ? <button className="secondary-button" onClick={onLoad}><PlayCircle /> Load selected</button> : null}
          <button className="primary-button" disabled={busy || !licenseAccepted} onClick={onSetup}>{busy ? <LoaderCircle className="spin" /> : <Download />} {status.engine === "missing" ? "Install engine" : "Repair / update"}</button>
        </div>
      </section>

      {!licenseAccepted && <button className="license-banner" onClick={onOpenSettings}><ShieldAlert /><span><strong>Model license acceptance required</strong><small>Nyra's standard weights are non-commercial research weights. Review and accept their terms in Settings before downloading.</small></span><ChevronRight /></button>}

      <div className="model-list">
        {MODELS.map((model, index) => {
          const active = selected === model.id;
          const resident = active && status.engine === "ready";
          return (
            <article key={model.id} className={`model-row ${model.accent} ${active ? "selected" : ""}`}>
              <div className="model-index"><span>0{index + 1}</span><i className={`model-glyph ${model.accent}`}><span /><span /><span /></i></div>
              <div className="model-identity"><p className="maker">NYRA LABS / CRISPER 2.0</p><h3>{model.name}</h3><strong className="model-role">{model.role}</strong></div>
              <p className="model-description">{model.description}</p>
              <div className="model-specs"><span><Cpu />{model.size}</span><span><HardDrive />{model.memory}</span><span><Gauge />{model.latency}</span></div>
              <div className="model-select"><div className="mini-tags">{model.badges.map((badge) => <span key={badge}>{badge}</span>)}</div><button disabled={active || saving} className={active ? "model-button active" : "model-button"} onClick={() => onSelect(model.id)}>{resident ? <><Check /> Loaded</> : active ? <><Check /> Selected</> : <>Select <ChevronRight /></>}</button></div>
            </article>
          );
        })}
      </div>

      <div className="info-banner"><Gauge /><div><strong>Two optimized paths</strong><p>Dual mode batches intended and verbatim together. Single-output Large can use Turbo as a strict speculative draft for roughly 1.3–1.4× faster long dictation; short clips skip the overhead automatically.</p></div></div>
    </div>
  );
}
