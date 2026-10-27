import { engineAttention } from "../statusLabels";
import type { DictationStatus } from "../types";

/** Home corner chip; present only while speech needs setup or is getting ready. */
export function EngineChip({
  status,
  onOpen,
}: {
  status: DictationStatus;
  onOpen: () => void;
}) {
  const engine = engineAttention(status);
  if (!engine) return null;
  return (
    <button
      className="engine-chip"
      title={engine.detail}
      aria-label={`${engine.label}. Open Engines`}
      onClick={onOpen}
    >
      <span className={`status-dot ${engine.tone}`} />
      <span>{engine.label}</span>
    </button>
  );
}
