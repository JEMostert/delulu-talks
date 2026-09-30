import { useEffect, useState } from "react";
import type { HistoryDeletionState } from "../types";

export function HistoryDeletionNotice({ state, onUndo, onHistory }: {
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
  if (!state || (state.phase === "failed" && dismissed === state.token)) return null;
  const remaining = Math.max(0, Math.ceil((state.deadline - now) / 1000));
  return (
    <div className="mx-6 mt-3 p-3 rounded-xl border border-line bg-soft max-[900px]:mx-4">
      <p role={state.phase === "failed" ? "alert" : "status"} className="text-sm">
        {state.phase === "failed" ? state.error : `${state.ids.length} transcripts queued for deletion.`}
      </p>
      {state.phase === "pending" ? (
        <>
          <div className="flex items-center gap-3 mt-2">
            <button className="secondary-button" disabled={busy || remaining === 0} onClick={async () => {
              setBusy(true);
              try { await onUndo(state.token); } finally { setBusy(false); }
            }}>Undo deletion</button>
            <span className="caption">{remaining > 0 ? `${remaining}s to undo` : "Finishing deletion…"}</span>
          </div>
          <p className="caption mt-2">Durable records stay saved during the window. Quitting cancels their pending deletion; session-only records still disappear on quit.</p>
        </>
      ) : (
        <div className="flex gap-3 mt-2">
          <button className="secondary-button" onClick={onHistory}>Open history</button>
          <button className="tool-button" onClick={() => setDismissed(state.token)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
