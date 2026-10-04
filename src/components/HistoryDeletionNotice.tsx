import { useEffect, useState } from "react";
import { Alert } from "./ui";
import type { HistoryDeletionState } from "../types";

export function HistoryDeletionNotice({
  state,
  onUndo,
  onHistory,
}: {
  state: HistoryDeletionState | null;
  onUndo: (token: string) => Promise<boolean>;
  onHistory: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (state?.phase !== "pending") return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state?.token, state?.phase]);
  if (!state || (state.phase === "failed" && dismissed === state.token))
    return null;
  const remaining = Math.max(0, Math.ceil((state.deadline - now) / 1000));
  return (
    <Alert
      tone={state.phase === "failed" ? "danger" : "info"}
      action={
        state.phase === "pending" ? (
          <button
            className="secondary-button compact"
            disabled={busy || remaining === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await onUndo(state.token);
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo
          </button>
        ) : (
          <div className="panel-actions">
            <button className="secondary-button compact" onClick={onHistory}>
              Open history
            </button>
            <button
              className="tool-button compact"
              onClick={() => setDismissed(state.token)}
            >
              Dismiss
            </button>
          </div>
        )
      }
    >
      <strong>
        {state.phase === "failed"
          ? state.error
          : `${state.ids.length} ${state.ids.length === 1 ? "transcript" : "transcripts"} queued for deletion`}
      </strong>
      {state.phase === "pending" && (
        <p className="caption">
          {remaining > 0
            ? `${remaining}s to undo. Quitting now cancels the deletion of saved transcripts.`
            : "Finishing deletion…"}
        </p>
      )}
    </Alert>
  );
}
