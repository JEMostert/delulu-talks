import { Square } from "lucide-react";
import { phaseLabel, type TalkStatus } from "../../talk";
import "../../styles/features/talk.css";

/** Always-visible badge while Talk is on, with a stop button. */
export function TalkIndicator({
  status,
  onStop,
}: {
  status: TalkStatus;
  onStop: () => void;
}) {
  if (!status.on) return null;
  return (
    <div
      className={`talk-indicator ${status.phase === "hearing" ? "speaking" : ""}`}
      role="group"
      aria-label="Talk"
    >
      <span className="talk-dot" aria-hidden="true" />
      <span className="talk-indicator-label">{phaseLabel(status.phase)}</span>
      <button
        className="talk-stop"
        aria-label="Stop Talk"
        title="Stop Talk"
        onClick={onStop}
      >
        <Square aria-hidden="true" />
        <span className="talk-stop-label">Stop</span>
      </button>
    </div>
  );
}
