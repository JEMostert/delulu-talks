import type { EnginePhase } from "../../types";

const BADGES: Record<EnginePhase, [string, string]> = {
  ready: ["Ready", "success"],
  unloaded: ["Standby", "neutral"],
  loading: ["Loading", ""],
  settingUp: ["Installing", ""],
  missing: ["Not set up", "warning"],
  error: ["Needs repair", "danger"],
};

/** One consistent status pill for every model card. */
export function EngineBadge({ engine }: { engine: EnginePhase }) {
  const [label, tone] = BADGES[engine];
  return (
    <span className={`badge ${tone}`}>
      <span
        className={`status-dot ${
          engine === "ready"
            ? "ready"
            : engine === "error"
              ? "error"
              : engine === "missing"
                ? "warning"
                : engine === "unloaded"
                  ? ""
                  : "busy"
        }`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
