import { useState } from "react";
import {
  Check,
  Cpu,
  Download,
  HardDrive,
  LoaderCircle,
  Play,
  ShieldCheck,
} from "lucide-react";
import { MODELS, modelById } from "../data";
import { Diagnostics } from "../components/Diagnostics";
import { Alert, Modal } from "../components/ui";
import type { DictationStatus, ModelId } from "../types";

export function ModelsPage({
  selected,
  status,
  saving,
  licenseAccepted,
  onSelect,
  onSetup,
  onLoad,
  onUnload,
  onAcceptLicense,
}: {
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
  const [license, setLicense] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const busy =
    ["preparing", "loading", "listening", "transcribing"].includes(
      status.phase,
    ) || saving;
  const model = modelById(selected);
  const setup = () => {
    if (licenseAccepted) onSetup();
    else setLicense(true);
  };
  return (
    <div className="content-stack">
      <section className="runtime-banner">
        <div className="runtime-symbol">
          <Cpu />
        </div>
        <div>
          <span className="eyebrow">LOCAL SPEECH ENGINE</span>
          <h2>
            {status.engine === "ready"
              ? "Ready when you are."
              : status.engine === "missing"
                ? "A home for your voice."
                : status.engine === "error"
                  ? "Let’s get you talking again."
                  : busy
                    ? "Getting things ready…"
                    : "Resting until you need it."}
          </h2>
          <p>
            {status.engine === "missing"
              ? "Choose a model below. We’ll set up the engine and download its files to your device."
              : status.message}
          </p>
        </div>
        <div className="runtime-actions">
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
          <button className="primary-button" disabled={busy} onClick={setup}>
            {busy ? <LoaderCircle className="spin" /> : <Download />}
            {status.engine === "missing" ? "Install engine" : "Repair engine"}
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
              onClick={setup}
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
          <span className="eyebrow">FIND YOUR FIT</span>
          <h3>A model for your machine</h3>
        </div>
        <span className="caption">Selected: {model.size}</span>
      </div>
      <div className="model-grid">
        {MODELS.map((item) => (
          <article
            key={item.id}
            className={`model-card ${item.id === selected ? "selected" : ""}`}
          >
            <header>
              <span className="model-icon">
                <Cpu />
              </span>
              {item.recommended && (
                <span className="badge">Good starting point</span>
              )}
              {item.id === selected && <Check className="selected-check" />}
            </header>
            <h3>{item.size}</h3>
            <strong>{item.role}</strong>
            <p>{item.description}</p>
            <div className="model-facts">
              <span>
                <HardDrive /> {item.memory} memory use
              </span>
              <span>{item.latency}</span>
            </div>
            <button
              className={
                item.id === selected
                  ? "secondary-button selected"
                  : "secondary-button"
              }
              disabled={busy || item.id === selected}
              onClick={() => onSelect(item.id)}
            >
              {item.id === selected ? (
                <>
                  <Check /> Selected
                </>
              ) : (
                `Choose ${item.size}`
              )}
            </button>
          </article>
        ))}
      </div>
      <p className="privacy-footnote">
        <ShieldCheck /> Models stay on your device. Switching models may require
        another download.
      </p>
      <Diagnostics />
      {license && (
        <Modal
          title="Before your first download"
          onClose={() => setLicense(false)}
          busy={accepting}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={accepting}
                onClick={() => setLicense(false)}
              >
                Not now
              </button>
              <button
                className="primary-button"
                disabled={!accepted || accepting}
                onClick={async () => {
                  setAccepting(true);
                  try {
                    if (await onAcceptLicense()) {
                      setLicense(false);
                      onSetup();
                    }
                  } finally {
                    setAccepting(false);
                  }
                }}
              >
                <Download />
                {accepting ? "Saving…" : "Accept & install"}
              </button>
            </>
          }
        >
          <p>
            Delulu Talks is MIT licensed. The speech model weights have their
            own Nyra Health license. Review the terms before downloading{" "}
            {model.name}.
          </p>
          <a
            href="https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md"
            target="_blank"
            rel="noreferrer"
          >
            Read the complete model license ↗
          </a>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>I accept the Nyra Health model-weight license.</span>
          </label>
          <p className="caption">
            Models can be large. Setup uses your internet connection to install
            the engine and download the selected weights.
          </p>
        </Modal>
      )}
    </div>
  );
}
