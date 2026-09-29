import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { PasteRecovery } from "../types";

export function PasteRecoveryNotice({ onCopied }: { onCopied: () => void }) {
  const [recovery, setRecovery] = useState<PasteRecovery | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onPasteRecovery((next) => {
      receivedEvent = true;
      if (active) setRecovery(next);
    });
    void bridge.getPasteRecovery().then((next) => {
      if (active && !receivedEvent) setRecovery(next);
    }).catch(() => {
      // Live events can still expose recovery if the initial request fails.
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  if (!recovery) return null;
  const id = recovery.transcriptId;
  const pending = pendingId === id;
  const act = async (copy: boolean) => {
    setPendingId(id);
    setFailure(null);
    try {
      if (copy) {
        await bridge.copyInstead(id);
        onCopied();
      } else {
        await bridge.dismissPasteRecovery(id);
      }
    } catch (error) {
      setFailure({ id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPendingId((current) => current === id ? null : current);
    }
  };

  return (
    <div className="px-6 pt-3 max-[900px]:px-4">
      <div role="alert" className="rounded-xl border border-line-strong bg-surface p-4">
        <p className="font-medium">Automatic paste failed</p>
        <p className="mt-1 break-words text-sm text-muted">{recovery.detail}</p>
        <p className="mt-1 text-sm text-muted">
          Use Copy instead, then paste manually in your intended text field. Your transcript is also available in History.
        </p>
        {failure?.id === id && <p className="mt-2 text-sm text-danger">{failure.message}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="secondary-button" disabled={pending} onClick={() => void act(true)}>
            {pending ? "Working…" : "Copy instead"}
          </button>
          <button className="tool-button" disabled={pending} onClick={() => void act(false)}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
