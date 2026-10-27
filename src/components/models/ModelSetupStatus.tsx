import { RuntimeSetupLog } from "./RuntimeSetupLog";
import { Alert } from "../ui";
import type { DictationStatus, MagicStatus, SetupStage } from "../../types";

const STAGES: Record<SetupStage, string> = {
  "runtime-check": "Checking Python",
  "runtime-prepare": "Creating the runtime",
  "runtime-packages": "Installing packages",
  "runtime-download": "Downloading packages",
  "runtime-install": "Installing packages",
  "runtime-build": "Building packages",
  "runtime-validate": "Checking packages",
  "model-prepare": "Starting",
  "model-download": "Downloading the model",
  "model-load": "Loading the model",
  "model-conversion": "Converting the model",
  warmup: "Warming up",
  "model-loaded": "Loaded",
  ready: "Ready",
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const gib = 1024 ** 3;
  const unit = bytes >= gib ? "GiB" : "MiB";
  const value = bytes / (bytes >= gib ? gib : 1024 ** 2);
  return `${value.toFixed(2)} ${unit}`;
}

/** Setup progress while installing or loading, and the repair path when it fails. */
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
  const total = bytes?.total ?? null;
  return (
    <>
      {settingUp && (
        <section className="progress-panel" aria-live="polite">
          <div>
            <strong>
              {status.setupStage
                ? STAGES[status.setupStage]
                : status.phase === "preparing"
                  ? "Preparing the runtime"
                  : "Preparing the model"}
            </strong>
            <span>Working…</span>
          </div>
          <progress
            aria-label={kind === "speech" ? "Speech setup" : "Rewriting setup"}
            {...(bytes && total ? { max: total, value: bytes.completed } : {})}
          />
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          {bytes ? (
            <p
              className="caption tabular-nums"
              title={`${bytes.completed} bytes${total == null ? "" : ` of ${total}`}`}
            >
              {bytes.kind === "transfer" ? "Downloaded" : "Restored from cache"}{" "}
              {formatBytes(bytes.completed)}
              {total != null && ` of ${formatBytes(total)}`}
            </p>
          ) : null}
        </section>
      )}
      {failed && (
        <Alert
          action={
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={onRepair}
              >
                Fix setup
              </button>
              <RuntimeSetupLog kind={kind} />
            </>
          }
        >
          {status.message}
        </Alert>
      )}
    </>
  );
}
