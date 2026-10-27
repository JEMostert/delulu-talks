import { Square } from "lucide-react";
import { phaseLabel, type TalkStatus } from "../../talk";
import "../../styles/features/talk.css";

/** Always-visible badge while Sonar is on, with a stop button. */
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
      aria-label="Sonar on"
    >
      <span className="talk-dot" aria-hidden="true" />
      <span className="talk-indicator-label">
        <strong>Sonar</strong> {phaseLabel(status.phase)}
      </span>
      <button
        className="talk-stop"
        aria-label="Stop Sonar"
        title="Stop Sonar"
        onClick={onStop}
      >
        <Square aria-hidden="true" />
        <span className="talk-stop-label">Stop</span>
      </button>
    </div>
  );
}
