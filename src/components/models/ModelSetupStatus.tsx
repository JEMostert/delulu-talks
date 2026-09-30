import { RuntimeSetupLog } from "./RuntimeSetupLog";
import { Alert } from "../ui";
import type { DictationStatus, MagicStatus, SetupStage } from "../../types";

const STAGES: Record<SetupStage, string> = {
  "runtime-check": "Checking the setup interpreter",
  "runtime-prepare": "Creating the isolated runtime",
  "runtime-packages": "Resolving and installing runtime packages",
  "runtime-download": "Downloading or reusing runtime packages",
  "runtime-install": "Installing retrieved runtime packages",
  "runtime-build": "Building runtime packages",
  "runtime-validate": "Validating runtime dependencies",
  "model-prepare": "Starting the model operation",
  "model-download": "Downloading or reusing model files",
  "model-load": "Loading model weights",
  "model-conversion": "Converting model weights",
  warmup: "Exercising inference warmup",
  "model-loaded": "Model loaded; warmup not yet exercised",
  ready: "Ready",
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const gib = 1024 ** 3;
  const unit = bytes >= gib ? "GiB" : "MiB";
  const value = bytes / (bytes >= gib ? gib : 1024 ** 2);
  return `${value.toFixed(2)} ${unit}`;
}

export function ModelSetupStatus({
  status,
  kind,
  busy,
  onRepair,
}: {
  status: DictationStatus | MagicStatus;
  kind: "speech" | "rewrite";
  busy: boolean;
  onRepair: () => void;
}) {
  const settingUp =
    ["preparing", "loading"].includes(status.phase) ||
    status.warmup === "warming";
  const failed = status.phase === "error" || status.engine === "error";
  const bytes = status.downloadBytes;
  return (
    <>
      {settingUp && (
        <section className="progress-panel" aria-live="polite">
          <div>
            <strong>
              {status.setupStage
                ? STAGES[status.setupStage]
                : status.phase === "preparing"
                  ? "Preparing runtime dependencies"
                  : "Preparing the model"}
            </strong>
            <span>Working…</span>
          </div>
          <progress
            aria-label={
              kind === "speech"
                ? "Model setup stages"
                : "Rewrite model setup stages"
            }
            max={1}
          />
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          {bytes ? (
            <p className="caption">
              <strong>
                {bytes.kind === "transfer"
                  ? "Network transfer"
                  : "Cache reconstruction"}
              </strong>
              {": "}
              <span
                title={`${bytes.completed} bytes completed; ${bytes.total == null ? "total unknown" : `${bytes.total} bytes reported total`}`}
              >
                {formatBytes(bytes.completed)} completed
                {bytes.total == null
                  ? " · total unavailable"
                  : ` / ${formatBytes(bytes.total)} reported total`}
              </span>
            </p>
          ) : null}
        </section>
      )}
      {!settingUp &&
        !failed &&
        status.engine === "ready" &&
        status.phase === "idle" && (
          <p className="caption mt-3" role="status">
            {status.warmup === "complete"
              ? STAGES.ready
              : kind === "rewrite"
                ? "Loaded · checked on your first rewrite"
                : "Loaded · warmup not confirmed"}
          </p>
        )}
      {failed && (
        <Alert
          action={
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onRepair}
            >
              Fix setup
            </button>
          }
        >
          {status.message}
        </Alert>
      )}
      <details>
        <summary>Setup log</summary>
        <RuntimeSetupLog kind={kind} />
      </details>
    </>
  );
}
