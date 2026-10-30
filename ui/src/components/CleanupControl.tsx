import * as ipc from "../ipc";
import { Icon } from "./Icon";

/** The cleanup model's state, laid out like the speech model's control. */
export function CleanupControl({
  status,
  onError,
}: {
  status?: ipc.CleanupStatus;
  onError: (error: unknown) => void;
}) {
  if (!status || status.state === "off") return null;
  const percent = status.totalBytes
    ? Math.round((status.doneBytes / status.totalBytes) * 100)
    : 0;
  const retry = status.state === "error" || status.error != null;
  return (
    <div className="model-state cleanup-state">
      {status.state === "downloading" && (
        <>
          <div
            className="bar"
            role="progressbar"
            aria-label="Cleanup model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ transform: `scaleX(${percent / 100})` }} />
          </div>
          <span className="model-note tabular">
            {status.totalBytes ? `${percent}%` : "Starting…"}
          </span>
          <button
            className="button quiet"
            type="button"
            onClick={() => void ipc.cancelCleanupDownload().catch(onError)}
          >
            Cancel
          </button>
        </>
      )}
      {status.state === "loading" && (
        <span className="model-note">Loading the cleanup model…</span>
      )}
      {status.state === "ready" && (
        <>
          <span className="model-ready">
            <Icon name="check" size={16} />
            Ready
          </span>
          {status.backend && (
            <span className="model-note">{status.backend}</span>
          )}
        </>
      )}
      {(status.state === "missing" || status.state === "error") && (
        <>
          {status.error ? (
            <span className="model-note row-error" role="alert">
              {status.error}
            </span>
          ) : (
            <span className="model-note">
              5.2 GB download, then it works offline
            </span>
          )}
          <button
            className="button primary"
            type="button"
            onClick={() => void ipc.startCleanup().catch(onError)}
          >
            <Icon name="download" size={16} />
            {retry ? "Try again" : "Download"}
          </button>
        </>
      )}
    </div>
  );
}
