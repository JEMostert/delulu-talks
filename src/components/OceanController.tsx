import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Download,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import { recordingLevelStore } from "../recordingLevel";
import { RecordingClock } from "./RecordingClock";
import type { DictationStatus } from "../types";

function AudioHalo() {
  const level = useSyncExternalStore(
    recordingLevelStore.subscribe,
    recordingLevelStore.getSnapshot,
    recordingLevelStore.getServerSnapshot,
  );
  return (
    <span
      className="audio-halo"
      aria-hidden="true"
      style={{ "--level": (level.db + 60) / 60 } as CSSProperties}
    />
  );
}

/** The pearl with its dock: destinations on either side, recording controls beside it. */
export function OceanController({
  status,
  ready,
  busy,
  panelOpen,
  resultId,
  message,
  onRecord,
  onSetup,
  onPause,
  onCancel,
  leading,
  trailing,
}: {
  /** Dock items left and right of the pearl. */
  leading: ReactNode;
  trailing: ReactNode;
  status: DictationStatus;
  ready: boolean;
  busy: boolean;
  panelOpen: boolean;
  resultId?: string;
  message?: string;
  onRecord: () => Promise<boolean>;
  onSetup: () => void;
  onPause: () => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}) {
  const recording = status.phase === "listening" || status.phase === "paused";
  const paused = status.phase === "paused";
  const transcribing = status.phase === "transcribing";
  const countdown = status.silenceCountdownSeconds;
  const needsSetup = ["missing", "error"].includes(status.engine);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const previousResult = useRef(resultId);
  const armed = useRef(false);
  useEffect(() => {
    // History loads with the workspace; only results that arrive later
    // celebrate, never the newest record found at startup.
    if (armed.current && resultId && resultId !== previousResult.current)
      setCompleted(true);
    previousResult.current = resultId;
    if (ready) armed.current = true;
  }, [resultId, ready]);
  useEffect(() => {
    if (!completed) return;
    const timer = setTimeout(() => setCompleted(false), 1500);
    return () => clearTimeout(timer);
  }, [completed]);
  const invoke = async (operation: () => Promise<boolean>) => {
    if (pending) return;
    setPending(true);
    try {
      return await operation();
    } finally {
      setPending(false);
    }
  };
  const working = !ready || (!recording && busy) || pending;
  const label = !ready
    ? "Opening workspace"
    : recording
      ? "Stop recording"
      : needsSetup
        ? "Set up dictation"
        : "Start dictation";
  return (
    <div className={`controller-anchor ${panelOpen ? "with-panel" : ""}`}>
      <div
        className={`ocean-controller ${recording ? "is-recording" : ""} ${paused ? "is-paused" : ""} ${transcribing ? "is-transcribing" : ""} ${completed ? "is-complete" : ""}`}
        role="toolbar"
        aria-label="Dictation controls"
      >
        {leading}
        {recording && (
          <button
            className="ocean-icon"
            aria-label={paused ? "Resume recording" : "Pause recording"}
            title={paused ? "Resume recording" : "Pause recording"}
            disabled={pending}
            onClick={() => void invoke(onPause)}
          >
            {paused ? <Play /> : <Pause />}
          </button>
        )}
        <div className="record-well">
          {recording && !paused && <AudioHalo />}
          <button
            id={
              recording ? "recording-stop-control" : "recording-start-control"
            }
            className="ocean-record"
            aria-label={label}
            title={label}
            disabled={pending || (!recording && (!ready || busy))}
            onClick={() =>
              needsSetup && !recording ? onSetup() : void invoke(onRecord)
            }
          >
            {working ? (
              <LoaderCircle className="spin" />
            ) : recording ? (
              <Square fill="currentColor" />
            ) : needsSetup ? (
              <Download />
            ) : (
              <Mic />
            )}
          </button>
        </div>
        {recording && (
          <button
            className="ocean-icon"
            aria-label="Cancel recording"
            title="Cancel recording"
            disabled={pending}
            onClick={() => void invoke(onCancel)}
          >
            <X />
          </button>
        )}
        {trailing}
      </div>
      <div className={`controller-status ${paused ? "is-paused-status" : ""}`}>
        {/* Outside the live region so ticks are not re-announced. */}
        <RecordingClock phase={status.phase} />
        <span role="status" aria-live="polite" aria-atomic="true">
          {completed
            ? "Transcript ready"
            : recording && typeof countdown === "number" && countdown > 0
              ? `Silence detected — stopping in ${countdown}s`
              : (message ?? status.message)}
        </span>
      </div>
    </div>
  );
}
