import { Download, RotateCw } from "lucide-react";
import type { UpdateStatus } from "../types";
export function UpdateNotice({
  status,
  busy,
  onDownload,
  onInstall,
}: {
  status: UpdateStatus;
  busy: boolean;
  onDownload: () => void;
  onInstall: () => void;
}) {
  if (!["available", "downloading", "downloaded"].includes(status.phase))
    return null;
  return (
    <aside className="update-notice" aria-live="polite">
      <Download />
      <div>
        <strong>
          {status.phase === "downloaded"
            ? "A fresh version is ready"
            : `Delulu Talks ${status.version ?? "update"}`}
        </strong>
        <p>
          {status.phase === "downloaded"
            ? busy
              ? "Finish your current task before restarting."
              : "Restart when you’re ready. Your words and models stay put."
            : status.message}
        </p>
        {status.phase === "downloading" && (
          <progress
            max={100}
            value={status.percent ?? 0}
            aria-label="Update download"
          />
        )}
      </div>
      {status.phase === "available" && (
        <button className="secondary-button" onClick={onDownload}>
          Download
        </button>
      )}
      {status.phase === "downloaded" && (
        <button className="primary-button" disabled={busy} onClick={onInstall}>
          <RotateCw /> Restart & update
        </button>
      )}
    </aside>
  );
}
