import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as ipc from "../ipc";
import { resultWord } from "../helpers";
import { Pearl } from "../pearl/Pearl";
import type { Flash } from "../pearl/model";
import { Keys } from "./Controls";
import { phaseWord } from "./Header";

/** Shows the result word for a moment after each dictation or reinsert. */
function useFlash(recovery: ipc.TranscriptEvent | undefined) {
  const [flash, setFlash] = useState<{ tone: Flash; word: string }>();
  const first = useRef(recovery);
  useEffect(() => {
    if (!recovery || recovery === first.current) return;
    const ok =
      recovery.insert.kind === "pasted" || recovery.insert.kind === "copied";
    setFlash({
      tone: ok ? "success" : "warning",
      word: resultWord(recovery.insert),
    });
    const timer = setTimeout(() => setFlash(undefined), 1800);
    return () => clearTimeout(timer);
  }, [recovery]);
  return flash;
}

function hint(status: ipc.Status, onSettings: () => void): ReactNode {
  switch (status.phase) {
    case "idle":
      return (
        <>
          <span className="hero-hold">
            Hold <Keys trigger={status.hotkey.trigger} large /> and talk
          </span>
          <span>Or tap once to start and again to stop.</span>
        </>
      );
    case "recording":
      return <span>Let go when you’re done.</span>;
    case "transcribing":
      return <span>Turning your voice into text.</span>;
    case "loadingModel":
      return <span>Getting the speech model ready. One moment.</span>;
    case "needsSetup":
    case "error":
      return (
        <>
          <span>
            {status.message ||
              status.hotkey.error ||
              "Something stopped dictation from working."}
          </span>
          <button type="button" className="hero-action" onClick={onSettings}>
            Open settings
          </button>
        </>
      );
  }
}

export function Hero({
  status,
  level,
  recovery,
  onSettings,
}: {
  status: ipc.Status;
  level: number;
  recovery: ipc.TranscriptEvent | undefined;
  onSettings: () => void;
}) {
  const flash = useFlash(recovery);
  const showFlash = flash && status.phase === "idle";
  const title = showFlash ? flash.word : phaseWord[status.phase];
  const unbound = status.phase === "idle" && !status.hotkey.bound;
  return (
    <section
      className={`well hero phase-${status.phase}`}
      aria-label="Dictation"
    >
      <div className="hero-stage">
        <Pearl
          mode={status.phase}
          level={status.phase === "recording" ? level : 0}
          flash={showFlash ? flash.tone : null}
          label={`Dictation: ${title}`}
        />
      </div>
      <div className="hero-copy">
        <h1
          className={`hero-title ${showFlash ? `flash-${flash.tone}` : ""}`}
          aria-live="polite"
        >
          {title}
        </h1>
        <div className="hero-hint">
          {unbound ? (
            <>
              <span>No hotkey is set, so dictation can’t start.</span>
              <button
                type="button"
                className="hero-action"
                onClick={onSettings}
              >
                Set a hotkey
              </button>
            </>
          ) : (
            hint(status, onSettings)
          )}
        </div>
      </div>
    </section>
  );
}
