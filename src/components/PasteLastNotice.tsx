import { useEffect, useState } from "react";
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
    <section
      className="card mx-auto mb-4 max-w-[1440px]"
      aria-label="Paste-last delivery"
    >
      <div className="flex items-center justify-between gap-4">
        <div
          role={status.phase === "error" ? "alert" : "status"}
          aria-live="polite"
          aria-atomic="true"
        >
          {status.phase === "pending" && (
            <strong>
              Paste in {status.remainingSeconds}{" "}
              {status.remainingSeconds === 1 ? "second" : "seconds"}.
            </strong>
          )}
          <p>{status.message}</p>
        </div>
        {status.phase === "pending" ? (
          <button className="secondary-button" onClick={onCancel}>
            Cancel scheduled paste
          </button>
        ) : status.phase !== "delivering" ? (
          <button
            className="tool-button"
            aria-label="Dismiss paste status"
            onClick={() => setDismissed(status.operationId)}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {status.phase === "pending" && (
        <p className="caption mt-2">
          Cancel with Escape while this app is focused, or use Cancel scheduled
          paste in the tray. No Enter key is sent.
        </p>
      )}
    </section>
  );
}
