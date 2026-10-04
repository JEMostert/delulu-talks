import { useRecordingClock } from "../hooks/useRecordingClock";
import { formatClock } from "../statusLabels";
import type { DictationPhase } from "../types";

/** Clock ticks update this label without rendering the whole workspace. */
export function RecordingClock({ phase }: { phase: DictationPhase }) {
  const elapsed = useRecordingClock(phase);
  return elapsed === null ? null : (
    <span className="recording-clock">{formatClock(elapsed)}</span>
  );
}
