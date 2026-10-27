import { RotateCcw } from "lucide-react";
import { Alert } from "./ui";
import type { DictationStatus } from "../types";

/** Whether the last failed recording is still held for a retry. */
export function retryState(status: DictationStatus) {
  const audio = status.retryAudio;
  const retrying = audio?.phase === "retrying";
  const retained = audio
    ? audio.byteLength > 0 && !audio.discarded
    : !!status.retryAvailable;
  const available = audio
    ? audio.phase === "available" && retained
    : !!status.retryAvailable;
  return { retrying, retained, recoverable: available || retrying };
}

/** A failed transcription: retry or discard the session-only audio, or open engines. */
export function RetryNotice({
  status,
  busy,
  onEngines,
  onRetry,
  onDiscard,
}: {
  status: DictationStatus;
  busy: boolean;
  /** Absent on the Engines page, where errors already have their own controls. */
  onEngines?: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { retrying, retained, recoverable } = retryState(status);
  if (!recoverable && (status.phase !== "error" || !onEngines)) return null;
  return (
    <Alert
      tone={recoverable ? "warning" : "danger"}
      action={
        !recoverable ? (
          <button className="secondary-button compact" onClick={onEngines}>
            Open Engines
          </button>
        ) : retained ? (
          <div className="panel-actions">
            <button
              className="secondary-button compact"
              disabled={busy || retrying}
              onClick={onRetry}
            >
              <RotateCcw />
              Retry
            </button>
            <button
              className="tool-button compact"
              disabled={!status.retryAudio && busy}
              onClick={onDiscard}
            >
              Discard
            </button>
          </div>
        ) : undefined
      }
    >
      {retrying
        ? "Retrying transcription…"
        : recoverable
          ? "Transcription failed."
          : status.message}
    </Alert>
  );
}
