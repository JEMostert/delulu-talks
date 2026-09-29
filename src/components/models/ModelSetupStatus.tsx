import { Alert } from "../ui";
import type { DictationStatus, MagicStatus } from "../../types";

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
  const settingUp = ["preparing", "loading"].includes(status.phase);
  const failed = status.phase === "error" || status.engine === "error";
  const bytes = status.downloadBytes;
  return (
    <>
      {settingUp && (
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
                : "Setup stages indeterminate"}
            </span>
          </div>
          <progress
            aria-label={
              kind === "speech"
                ? "Model setup stages"
                : "Rewrite model setup stages"
            }
            max={1}
            value={status.progress ?? undefined}
          />
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          {bytes ? (
            <p className="caption">
              <strong>
                {bytes.kind === "transfer" ? "Network transfer" : "Cache reconstruction"}
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
              . Reported total may change as more files are discovered.
            </p>
          ) : (
            <p className="caption">Byte totals unavailable for this setup.</p>
          )}
          <p className="caption">
            Downloads can take a while. The progress bar shows setup stages,
            not download percentage. Keep the app open.
          </p>
        </section>
      )}
      {failed && (
        <Alert
          action={
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onRepair}
            >
              {kind === "speech" ? "Repair" : "Repair rewriting"}
            </button>
          }
        >
          {status.message}
        </Alert>
      )}
    </>
  );
}
