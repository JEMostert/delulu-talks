import { Alert } from "../ui";
import type { DictationStatus, MagicStatus } from "../../types";

export function ModelSetupStatus({
  status,
  kind,
  busy,
  onRepair,
}: {
  status: DictationStatus | MagicStatus;
  kind: "speech" | "rewrite";
  busy: boolean;
  onRepair: () => void;
}) {
  const settingUp = ["preparing", "loading"].includes(status.phase);
  const failed = status.phase === "error" || status.engine === "error";
  return (
    <>
      {settingUp && (
        <section className="progress-panel" aria-live="polite">
          <div>
            <strong>
              {status.phase === "preparing"
                ? "Installing runtime packages"
                : "Preparing your model"}
            </strong>
            <span>
              {status.progress != null
                ? `${Math.round(status.progress * 100)}% of setup stages`
                : "Working…"}
            </span>
          </div>
          <progress
            aria-label={
              kind === "speech"
                ? "Model setup stages"
                : "Rewrite model setup stages"
            }
            max={1}
            value={status.progress ?? undefined}
          />
          {status.detail && (
            <p className="caption" role="status">
              {status.detail}
            </p>
          )}
          <p className="caption">
            Downloads can take a while. This indicates setup stages, not bytes
            downloaded. Keep the app open.
          </p>
        </section>
      )}
      {failed && (
        <Alert
          action={
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onRepair}
            >
              {kind === "speech" ? "Repair" : "Repair rewriting"}
            </button>
          }
        >
          {status.message}
        </Alert>
      )}
    </>
  );
}
