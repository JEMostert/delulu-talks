import type { DictationStatus, MagicStatus } from "./types";

export type StatusTone =
  "idle" | "busy" | "recording" | "ready" | "warning" | "error";

export type ActivityLabel = { label: string; tone: StatusTone; detail: string };

/**
 * A short label for whatever the app is doing right now, or null when idle.
 * The full runtime message stays available as `detail` for tooltips.
 */
export function activityLabel(
  speech: DictationStatus,
  rewrite: MagicStatus,
): ActivityLabel | null {
  switch (speech.phase) {
    case "listening":
      return { label: "Listening", tone: "recording", detail: speech.message };
    case "paused":
      return { label: "Paused", tone: "warning", detail: speech.message };
    case "transcribing":
      return { label: "Transcribing", tone: "busy", detail: speech.message };
    case "preparing":
      return { label: "Preparing", tone: "busy", detail: speech.message };
    case "loading":
      return { label: "Loading speech", tone: "busy", detail: speech.message };
    case "error":
      return {
        label: "Needs attention",
        tone: "error",
        detail: speech.message,
      };
  }
  switch (rewrite.phase) {
    case "rewriting":
      return { label: "Rewriting", tone: "busy", detail: rewrite.message };
    case "preparing":
    case "loading":
      return {
        label: "Loading rewriting",
        tone: "busy",
        detail: rewrite.message,
      };
  }
  return null;
}

const BACKEND_NAMES: Record<
  NonNullable<DictationStatus["capabilities"]>["backend"],
  string
> = {
  mlx: "MLX",
  "cuda-vllm": "CUDA",
  "cuda-transformers": "CUDA",
  transformers: "Transformers",
  "photon-cpu": "CPU",
};

/** Speech engine readiness, phrased for the home screen chip. */
export function engineLabel(speech: DictationStatus): ActivityLabel {
  const backend = speech.capabilities?.backend;
  const suffix = backend ? ` · ${BACKEND_NAMES[backend]}` : "";
  switch (speech.engine) {
    case "ready":
      return {
        label: `Speech ready${suffix}`,
        tone: "ready",
        detail: speech.message,
      };
    case "unloaded":
      return {
        label: "Speech on standby",
        tone: "idle",
        detail: "The speech model loads when you start dictating.",
      };
    case "loading":
    case "settingUp":
      return {
        label: "Preparing speech",
        tone: "busy",
        detail: speech.message,
      };
    case "missing":
      return {
        label: "Set up speech",
        tone: "warning",
        detail: "Install the speech model to start dictating.",
      };
    case "error":
      return {
        label: "Speech needs attention",
        tone: "error",
        detail: speech.message,
      };
  }
}

/** Elapsed recording time as m:ss (or h:mm:ss past an hour). */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Relative time for recent results: "just now", "4 min ago", then the clock time. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(timestamp);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
