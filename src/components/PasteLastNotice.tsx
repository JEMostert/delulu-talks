import { useEffect, useState } from "react";
import { Alert } from "./ui";
import type { PasteLastStatus } from "../types";

export function PasteLastNotice({
  status,
  onCancel,
}: {
  status: PasteLastStatus;
  onCancel: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (status.phase !== "pending") return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [status.phase, status.operationId, onCancel]);
  if (
    status.phase === "idle" ||
    !status.operationId ||
    dismissed === status.operationId
  )
    return null;
  return (
    <Alert
      tone={status.phase === "error" ? "danger" : "info"}
      action={
        status.phase === "pending" ? (
          <button className="secondary-button compact" onClick={onCancel}>
            Cancel paste
          </button>
        ) : status.phase !== "delivering" ? (
          <button
            className="tool-button compact"
            aria-label="Dismiss paste status"
            onClick={() => setDismissed(status.operationId)}
          >
            Dismiss
          </button>
        ) : undefined
      }
    >
      <div aria-live="polite" aria-atomic="true">
        {status.phase === "pending" && (
          <strong>
            Pasting in {status.remainingSeconds}{" "}
            {status.remainingSeconds === 1 ? "second" : "seconds"}
          </strong>
        )}
        <p className={status.phase === "pending" ? "caption" : undefined}>
          {status.message}
        </p>
      </div>
      {status.phase === "pending" && (
        <p className="caption">
          Press Escape here or use the tray to cancel. No Enter key is sent.
        </p>
      )}
    </Alert>
  );
}
