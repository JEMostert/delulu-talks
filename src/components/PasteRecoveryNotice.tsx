import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { Alert } from "./ui";
import type { PasteRecovery } from "../types";

export function PasteRecoveryNotice({ onCopied }: { onCopied: () => void }) {
  const [recovery, setRecovery] = useState<PasteRecovery | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onPasteRecovery((next) => {
      receivedEvent = true;
      if (active) setRecovery(next);
    });
    void bridge
      .getPasteRecovery()
      .then((next) => {
        if (active && !receivedEvent) setRecovery(next);
      })
      .catch(() => {
        // Live events can still expose recovery if the initial request fails.
      });
    return () => {
      active = false;
      unsubscribe();
    };
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
      setFailure({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingId((current) => (current === id ? null : current));
    }
  };

  return (
    <Alert
      tone="warning"
      action={
        <div className="panel-actions">
          <button
            className="secondary-button compact"
            disabled={pending}
            onClick={() => void act(true)}
          >
            {pending ? "Working…" : "Copy instead"}
          </button>
          <button
            className="tool-button compact"
            disabled={pending}
            onClick={() => void act(false)}
          >
            Dismiss
          </button>
        </div>
      }
    >
      <strong>Automatic paste failed</strong>
      <p className="caption break-words">{recovery.detail}</p>
      <p className="caption">
        Copy the transcript and paste it yourself. It is also in History.
      </p>
      {failure?.id === id && (
        <p className="caption text-danger">{failure.message}</p>
      )}
    </Alert>
  );
}
