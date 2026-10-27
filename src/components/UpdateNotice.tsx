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
  const version = status.version ? `Version ${status.version}` : "An update";
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
            <RotateCw /> Restart
          </button>
        ) : undefined
      }
    >
      <strong>
        {status.phase === "downloaded"
          ? `${version} is ready`
          : status.phase === "downloading"
            ? `Downloading ${version.toLowerCase()}…`
            : `${version} is available`}
      </strong>
      {status.phase === "downloaded" && busy && (
        <p className="caption">Finish your current task first.</p>
      )}
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
