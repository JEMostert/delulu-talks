import { useEffect, useState } from "react";
import { Check, ChevronRight, Cpu, Download, ExternalLink, Gauge, HardDrive, LoaderCircle, PauseCircle, PlayCircle, ShieldAlert, X } from "lucide-react";
import { MODELS } from "../data";
import type { DictationStatus, ModelId } from "../types";

export function ModelsPage({ selected, status, saving, licenseAccepted, onSelect, onSetup, onLoad, onUnload, onAcceptLicense }: {
  selected: ModelId;
  status: DictationStatus;
  saving: boolean;
  licenseAccepted: boolean;
  onSelect: (id: ModelId) => void;
  onSetup: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onAcceptLicense: () => Promise<boolean>;
}) {
  const busy = ["preparing", "loading"].includes(status.phase);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const selectedModel = MODELS.find((model) => model.id === selected) ?? MODELS[1];

  useEffect(() => {
    if (!licenseOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !accepting) setLicenseOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [licenseOpen, accepting]);

  async function acceptAndInstall() {
    if (!confirmed || accepting) return;
    setAccepting(true);
    try {
      if (await onAcceptLicense()) {
        setLicenseOpen(false);
        onSetup();
      }
    } finally {
      setAccepting(false);
    }
  }

  function requestSetup() {
    if (licenseAccepted) onSetup();
    else {
      setConfirmed(false);
      setLicenseOpen(true);
    }
  }

  function openLicense() {
    setConfirmed(false);
    setLicenseOpen(true);
  }

  return (
    <div className="content-stack models-view">
      <section className="view-toolbar">
        <div><strong>Installed model family</strong><span>Four standard CrisperWhisper 2.0 checkpoints · selection changes the next loaded runtime</span></div>
        <div className="runtime-actions">
          {status.engine === "ready" ? <button className="secondary-button" onClick={onUnload}><PauseCircle /> Unload model</button> : status.engine === "unloaded" ? <button className="secondary-button" onClick={onLoad}><PlayCircle /> Load selected</button> : null}
          <button className="primary-button" disabled={busy || saving} onClick={requestSetup}>{busy ? <LoaderCircle className="spin" /> : <Download />} {status.engine === "missing" ? "Install engine" : "Repair / update"}</button>
        </div>
      </section>

      {!licenseAccepted && <button className="license-banner" onClick={openLicense}><ShieldAlert /><span><strong>Model license acceptance required</strong><small>Review the short summary and continue without leaving this page.</small></span><ChevronRight /></button>}

      <div className="model-list">
        {MODELS.map((model, index) => {
          const active = selected === model.id;
          const resident = active && status.engine === "ready";
          return (
            <article key={model.id} className={`model-row ${model.accent} ${active ? "selected" : ""}`} aria-current={active ? "true" : undefined}>
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

      {licenseOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !accepting) setLicenseOpen(false); }}>
        <section className="license-modal" role="dialog" aria-modal="true" aria-labelledby="license-title" aria-describedby="license-summary">
          <header>
            <div className="modal-icon"><ShieldAlert /></div>
            <div><p className="eyebrow">ONE-TIME SETUP</p><h2 id="license-title">Install {selectedModel.name}</h2></div>
            <button className="icon-button" aria-label="Close license dialog" disabled={accepting} onClick={() => setLicenseOpen(false)}><X /></button>
          </header>
          <div className="license-modal-body" id="license-summary">
            <p>The Delulu Talks app is MIT-licensed. The CrisperWhisper 2.0 model weights are provided separately by Nyra Health under their non-commercial research license.</p>
            <ul>
              <li>Personal and non-commercial research use is covered by the standard weight license.</li>
              <li>Commercial use requires a separate license from Nyra Health.</li>
              <li>The selected weights download only after you accept and remain on this device.</li>
            </ul>
            <a href="https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Read the complete model license <ExternalLink /></a>
            <label className="license-checkbox"><input type="checkbox" checked={confirmed} autoFocus aria-labelledby="license-accept-label license-accept-help" onChange={(event) => setConfirmed(event.target.checked)} /><span><strong id="license-accept-label">I accept the Nyra Health model-weight license</strong><small id="license-accept-help">This acceptance applies to the standard CrisperWhisper 2.0 weights used by Delulu Talks.</small></span></label>
          </div>
          <footer>
            <button className="secondary-button" disabled={accepting} onClick={() => setLicenseOpen(false)}>Cancel</button>
            <button className="primary-button" disabled={!confirmed || accepting} onClick={() => void acceptAndInstall()}>{accepting ? <LoaderCircle className="spin" /> : <Download />}{accepting ? "Accepting…" : "Accept & install"}</button>
          </footer>
        </section>
      </div>}
    </div>
  );
}
