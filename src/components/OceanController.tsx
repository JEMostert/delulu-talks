import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Check,
  Copy,
  Download,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  Settings,
  Square,
  X,
} from "lucide-react";
import { captureLevelStore } from "../captureLevel";
import type { DictationStatus } from "../types";

function AudioHalo() {
  const level = useSyncExternalStore(
    captureLevelStore.subscribe,
    captureLevelStore.getSnapshot,
    captureLevelStore.getServerSnapshot,
  );
  return (
    <span
      className="audio-halo"
      aria-hidden="true"
      style={{ "--level": (level.db + 60) / 60 } as CSSProperties}
    />
  );
}

export function OceanController({
  status,
  ready,
  busy,
  panelOpen,
  canCopy,
  resultId,
  onRecord,
  onCopy,
  onSettings,
  onSetup,
  onPause,
  onCancel,
  navigation,
}: {
  navigation?: ReactNode;
  status: DictationStatus;
  ready: boolean;
  busy: boolean;
  panelOpen: boolean;
  canCopy: boolean;
  resultId?: string;
  onRecord: () => Promise<boolean>;
  onCopy: () => Promise<boolean>;
  onSettings: () => void;
  onSetup: () => void;
  onPause: () => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}) {
  const recording = status.phase === "listening" || status.phase === "paused";
  const paused = status.phase === "paused";
  const needsSetup = ["missing", "error"].includes(status.engine);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [completed, setCompleted] = useState(false);
  const previousResult = useRef(resultId);
  useEffect(() => {
    if (resultId && resultId !== previousResult.current) setCompleted(true);
    previousResult.current = resultId;
  }, [resultId]);
  useEffect(() => {
    if (!copied && !completed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setCompleted(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, [copied, completed]);
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
        className={`ocean-controller ${recording ? "is-recording" : ""} ${paused ? "is-paused" : ""} ${completed ? "is-complete" : ""} ${navigation ? "has-navigation" : ""}`}
        role="toolbar"
        aria-label="Dictation controls"
      >
        {navigation}
        {recording ? (
          <button
            className="ocean-icon"
            aria-label={paused ? "Resume recording" : "Pause recording"}
            title={paused ? "Resume recording" : "Pause recording"}
            disabled={pending}
            onClick={() => void invoke(onPause)}
          >
            {paused ? <Play /> : <Pause />}
          </button>
        ) : !navigation ? (
          <button
            className="ocean-icon"
            aria-label={copied ? "Copied" : "Copy last result"}
            title={
              canCopy
                ? "Copy last result"
                : "Your next result will be available here"
            }
            disabled={!canCopy || pending}
            onClick={() =>
              void invoke(onCopy).then((ok) => {
                if (ok) setCopied(true);
              })
            }
          >
            {copied ? <Check /> : <Copy />}
          </button>
        ) : null}
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
        {!navigation && (
          <button
            className={`ocean-icon ${panelOpen ? "is-selected" : ""}`}
            aria-label="Open settings"
            title="Settings"
            aria-expanded={panelOpen}
            onClick={onSettings}
          >
            <Settings />
          </button>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {copied
          ? "Copied to clipboard"
          : completed
            ? "Transcript ready"
            : status.message}
      </span>
    </div>
  );
}
