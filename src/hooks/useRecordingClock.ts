import { useEffect, useRef, useState } from "react";
import type { DictationPhase } from "../types";

/**
 * Elapsed capture time for the current recording, frozen while paused.
 * Returns null when no recording is in progress.
 */
export function useRecordingClock(phase: DictationPhase): number | null {
  const recording = phase === "listening" || phase === "paused";
  const clock = useRef<{ accumulated: number; since: number | null } | null>(
    null,
  );
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) {
      clock.current = null;
      setElapsed(0);
      return;
    }
    const current = (clock.current ??= { accumulated: 0, since: null });
    if (phase === "paused") {
      if (current.since !== null) {
        current.accumulated += Date.now() - current.since;
        current.since = null;
      }
      setElapsed(current.accumulated);
      return;
    }
    current.since ??= Date.now();
    const tick = () =>
      setElapsed(current.accumulated + Date.now() - (current.since ?? 0));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [recording, phase]);
  return recording ? elapsed : null;
}
