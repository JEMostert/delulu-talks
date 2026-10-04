import { Download, RotateCw } from "lucide-react";
import { Alert } from "./ui";
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
    <Alert
      tone={status.phase === "downloaded" ? "success" : "info"}
      action={
        status.phase === "available" ? (
          <button className="secondary-button compact" onClick={onDownload}>
            <Download /> Download
          </button>
        ) : status.phase === "downloaded" ? (
          <button
            className="primary-button compact"
            disabled={busy}
            onClick={onInstall}
          >
            <RotateCw /> Restart & update
          </button>
        ) : undefined
      }
    >
      <strong>
        {status.phase === "downloaded"
          ? "A new version is ready"
          : `Delulu Talks ${status.version ?? "update"} is available`}
      </strong>
      <p className="caption">
        {status.phase === "downloaded"
          ? busy
            ? "Finish your current task before restarting."
            : "Restart when you’re ready. Your words and models stay put."
          : status.message}
      </p>
      {status.phase === "downloading" && (
        <progress
          className="mt-2"
          max={100}
          value={status.percent ?? 0}
          aria-label="Update download"
        />
      )}
    </Alert>
  );
}
