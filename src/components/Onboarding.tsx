import { Check, Cpu, X } from "lucide-react";
import type { EnginePhase } from "../types";
export function Onboarding({
  engine,
  saving,
  onFinish,
}: {
  engine: EnginePhase;
  saving: boolean;
  onFinish: (openModels: boolean) => Promise<void>;
}) {
  const ready = engine === "ready";
  return (
    <section
      className="setup-notice mx-6 mt-3 flex items-center gap-3 rounded-[14px] border border-line-strong bg-accent-soft px-4 py-3 backdrop-blur-md"
      aria-label="First-run setup"
    >
      {ready ? (
        <Check className="text-accent-ink" />
      ) : (
        <Cpu className="text-accent-ink" />
      )}
      <div className="flex-1">
        <strong className="text-xs">
          {ready ? "Ready to dictate" : "Set up local dictation"}
        </strong>
        <p className="text-[11px] text-muted">
          {ready
            ? "Record with the button or your shortcut — the transcript lands in your active app."
            : "Select your microphone below, then install the speech engine. You can configure the app while setup is pending."}
        </p>
      </div>
      {ready ? (
        <button
          className="secondary-button"
          disabled={saving}
          onClick={() => void onFinish(false)}
        >
          Got it
        </button>
      ) : (
        <button
          className="secondary-button"
          disabled={saving}
          onClick={() => void onFinish(true)}
        >
          Set up engine
        </button>
      )}
      <button
        className="icon-button"
        aria-label="Dismiss setup"
        disabled={saving}
        onClick={() => void onFinish(false)}
      >
        <X />
      </button>
    </section>
  );
}
