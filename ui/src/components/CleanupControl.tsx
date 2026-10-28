import * as ipc from "../ipc";

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
  return (
    <div>
      {status.state === "downloading" && (
        <>
          <progress max={100} value={percent} /> <span>{percent}%</span>{" "}
          <button
            className="button"
            type="button"
            onClick={() => void ipc.cancelCleanupDownload().catch(onError)}
          >
            Cancel
          </button>
        </>
      )}
      {status.error && <span className="row-error">{status.error}</span>}
      {(status.state === "missing" || status.state === "error") && (
        <button
          className="button"
          type="button"
          onClick={() => void ipc.startCleanup().catch(onError)}
        >
          {status.state === "missing" && !status.error
            ? "Download (5.2 GB)"
            : "Try again"}
        </button>
      )}
      {status.state === "loading" && "Loading…"}
      {status.state === "ready" && "Ready"}
    </div>
  );
}
