import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as ipc from "../ipc";
import { resultWord } from "../helpers";
import { Pearl } from "../pearl/Pearl";
import type { Flash } from "../pearl/model";
import { Keys } from "./Controls";
import { phaseWord } from "./Rail";

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

function hint(status: ipc.Status, onHotkey: () => void): ReactNode {
  const unbound = !status.hotkey.bound || !status.hotkey.trigger;
  switch (status.phase) {
    case "idle":
      return unbound ? (
        <>
          <span>No hotkey set</span>
          <button type="button" className="hero-action" onClick={onHotkey}>
            Set a hotkey
          </button>
        </>
      ) : (
        <span
          className="hero-hold"
          data-tip="Or tap once to start, and again to stop"
        >
          Hold <Keys trigger={status.hotkey.trigger} /> and talk
          <span className="visually-hidden">
            , or tap once to start and again to stop
          </span>
        </span>
      );
    case "recording":
      return <span>Let go when you’re done</span>;
    case "transcribing":
      return <span>Turning your voice into text</span>;
    case "loadingModel":
      return <span>Getting the speech model ready</span>;
    case "needsSetup":
    case "error": {
      const message =
        status.message ||
        status.hotkey.error ||
        "Something stopped dictation from working.";
      return (
        <>
          <span className="hero-message">{message}</span>
          {status.hotkey.error && (
            <button type="button" className="hero-action" onClick={onHotkey}>
              Change hotkey
            </button>
          )}
        </>
      );
    }
  }
}

/** The pearl in its well, with dictation's state and how to start. */
export function Hero({
  status,
  level,
  recovery,
  onHotkey,
}: {
  status: ipc.Status;
  level: number;
  recovery: ipc.TranscriptEvent | undefined;
  onHotkey: () => void;
}) {
  const flash = useFlash(recovery);
  const showFlash = flash && status.phase === "idle";
  const title = showFlash ? flash.word : phaseWord[status.phase];
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
      <h1
        className={`hero-title ${showFlash ? `flash-${flash.tone}` : ""}`}
        aria-live="polite"
      >
        {title}
      </h1>
      <div className="hero-hint">{hint(status, onHotkey)}</div>
    </section>
  );
}
