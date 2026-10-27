import { X } from "lucide-react";
import { RecordingClock } from "../components/RecordingClock";
import { activityLabel } from "../statusLabels";
import type { DictationStatus, MagicStatus } from "../types";

export function SheetHeader({
  title,
  status,
  magicStatus,
  closeLabel,
  hidden,
  onClose,
}: {
  title: string;
  status: DictationStatus;
  magicStatus: MagicStatus;
  closeLabel: string;
  hidden: boolean;
  onClose: () => void;
}) {
  const activity = activityLabel(status, magicStatus);
  return (
    <header className="sheet-header" hidden={hidden}>
      <h1 className="sheet-title">{title}</h1>
      {activity && (
        <span
          className={`sheet-status ${activity.tone}`}
          title={activity.detail}
        >
          <span className={`status-dot ${activity.tone}`} />
          <RecordingClock phase={status.phase} />
          <span>{activity.label}</span>
        </span>
      )}
      <button
        className="sheet-icon"
        aria-label={closeLabel}
        title="Close (Esc)"
        onClick={onClose}
      >
        <X />
      </button>
    </header>
  );
}
