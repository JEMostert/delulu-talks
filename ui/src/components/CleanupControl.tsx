import * as ipc from "../ipc";
import { IconButton, Line, Switch, Tag, tipId } from "./Controls";
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

/** Clean up text as one compact setting line: the model's state, then the switch. */
export function CleanupLine({
  status,
  enabled,
  onToggle,
  onError,
}: {
  status?: ipc.CleanupStatus;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const shown = enabled && status && status.state !== "off";
  const percent = status?.totalBytes
    ? Math.round((status.doneBytes / status.totalBytes) * 100)
    : 0;
  const failed = status?.state === "error" || status?.error != null;
  return (
    <>
      <Line
        label="Clean up text"
        htmlFor="dictate-cleanup"
        tip="Fixes punctuation, filler and misheard words, on this computer"
      >
        {shown && status.state === "ready" && (
          <Tag tone="ok" tip={status.backend ?? undefined}>
            Ready
          </Tag>
        )}
        {shown && status.state === "loading" && <Tag>Loading</Tag>}
        {shown && status.state === "downloading" && (
          <>
            <div
              className="bar mini-bar"
              role="progressbar"
              aria-label="Cleanup model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={{ transform: `scaleX(${percent / 100})` }} />
            </div>
            <span className="line-note tabular">
              {status.totalBytes ? `${percent}%` : "Starting"}
            </span>
            <IconButton
              icon="close"
              label="Cancel download"
              onClick={() => void ipc.cancelCleanupDownload().catch(onError)}
            />
          </>
        )}
        {shown && (status.state === "missing" || status.state === "error") && (
          <button
            type="button"
            className="button primary small"
            data-tip="5.2 GB, then it works offline"
            onClick={() => void ipc.startCleanup().catch(onError)}
          >
            <Icon name="download" size={15} />
            {failed ? "Try again" : "Download"}
          </button>
        )}
        <Switch
          id="dictate-cleanup"
          checked={enabled}
          describedBy={tipId("dictate-cleanup")}
          onChange={onToggle}
        />
      </Line>
      {shown && status.error && (
        <p className="line-error" role="alert" data-tip={status.error}>
          <Icon name="alert" size={15} />
          <span>{status.error}</span>
        </p>
      )}
    </>
  );
}
