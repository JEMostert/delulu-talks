/**
 * Talk: one switch opens the microphone, every finished turn is routed (by the
 * optional local helper, or straight to the active agent) and Delulu answers
 * out loud. The desktop owns the loop; the renderer shows `TalkStatus`.
 */

/** Off forwards every turn verbatim; Lightweight loads the local 0.8B helper. */
export type VoiceHelperMode = "off" | "lightweight";

/** Earlier versions also offered "conversational"; it is now Lightweight. */
export function normalizeHelperMode(value: unknown): VoiceHelperMode {
  return value === "lightweight" || value === "conversational"
    ? "lightweight"
    : "off";
}

export type TalkPhase =
  | "off"
  | "starting"
  | "loading"
  | "downloading"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking"
  | "failed";

export type HelperState =
  "off" | "missing" | "installed" | "loading" | "ready" | "failed";

export type TalkTool =
  | "send_to_agent"
  | "task_status"
  | "cancel_task"
  | "stop_speaking"
  | "stop_listening"
  | "repeat_last"
  | "reply";

export type TalkAgent = {
  id: string;
  name: string;
  /** A `next` call is waiting; otherwise the agent is away. */
  listening: boolean;
  openTasks: number;
};

export type TalkTurn = {
  id: string;
  at: number;
  /** What the user said. */
  user: string;
  tool: TalkTool | null;
  /** What Delulu said; empty when nothing was spoken. */
  said: string;
  /** Null when the helper was not used. */
  helperMs: number | null;
};

export type TalkStatus = {
  on: boolean;
  phase: TalkPhase;
  message: string;
  helper: { mode: VoiceHelperMode; state: HelperState; message: string };
  /** Start was refused because the helper's files are not on disk yet. */
  needsDownload: boolean;
  /** e.g. "~1.7 GB". */
  downloadSize: string;
  agents: TalkAgent[];
  /** The last few turns, oldest first. */
  turns: TalkTurn[];
};

/** `talk:level`: dBFS of the raw microphone input. */
export type TalkLevel = { db: number };

export const INITIAL_TALK_STATUS: TalkStatus = {
  on: false,
  phase: "off",
  message: "",
  helper: { mode: "off", state: "off", message: "" },
  needsDownload: false,
  downloadSize: "",
  agents: [],
  turns: [],
};

const PHASES: Record<TalkPhase, string> = {
  off: "Off",
  starting: "Starting…",
  loading: "Loading the helper…",
  downloading: "Downloading the helper…",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking…",
  speaking: "Speaking",
  failed: "Talk stopped after an error",
};

export function phaseLabel(phase: TalkPhase): string {
  return PHASES[phase] ?? "Off";
}

/** The Talk row's one line. */
export function talkLine(status: TalkStatus, speechReady: boolean): string {
  const message = status.message.trim();
  if (status.on) return message || phaseLabel(status.phase);
  if (status.phase === "failed") return message || phaseLabel("failed");
  if (status.needsDownload) return "The helper needs a one-time download";
  if (!speechReady) return "Set up speech in Models first";
  return "Speak to your coding agents hands-free";
}

/** The helper row's one line for the selected mode. */
export function helperLine(status: TalkStatus, mode: VoiceHelperMode): string {
  if (mode === "off") return "Your words go straight to your agent";
  // Progress usually shows on the Talk line; avoid repeating it here.
  if (status.phase === "downloading")
    return status.helper.message.trim() || "Downloading…";
  // The desktop has not picked up the new choice yet.
  if (status.helper.mode !== mode) return "Switching…";
  const message = status.helper.message.trim();
  switch (status.helper.state) {
    case "missing":
      return "Not downloaded";
    case "installed":
      return "Downloaded · loads when Talk is on";
    case "loading":
      return message || "Loading…";
    case "ready":
      return "Ready";
    case "failed":
      return message || "Couldn't load the helper";
    default:
      return "Off";
  }
}

export type DotTone = "" | "ready" | "busy" | "warning" | "error";

export function helperTone(status: TalkStatus, mode: VoiceHelperMode): DotTone {
  if (mode === "off") return "";
  if (status.phase === "downloading") return "busy";
  if (status.helper.mode !== mode) return "busy";
  switch (status.helper.state) {
    case "ready":
      return "ready";
    case "loading":
      return "busy";
    case "missing":
      return "warning";
    case "failed":
      return "error";
    default:
      return "";
  }
}

const TOOLS: Record<TalkTool, string> = {
  send_to_agent: "Sent to agent",
  task_status: "Status",
  cancel_task: "Cancel",
  stop_speaking: "Stopped speaking",
  stop_listening: "Stopped listening",
  repeat_last: "Repeated",
  reply: "Replied",
};

/** A short human label for what Delulu did with a turn; null when unknown. */
export function toolLabel(tool: string | null | undefined): string | null {
  return tool && Object.prototype.hasOwnProperty.call(TOOLS, tool)
    ? TOOLS[tool as TalkTool]
    : null;
}

/** "Claude Code · listening, Codex · away". */
export function agentsLine(agents: readonly TalkAgent[]): string {
  if (!agents.length) return "No agent connected";
  return agents
    .map((agent) => `${agent.name} · ${agent.listening ? "listening" : "away"}`)
    .join(", ");
}

/** Below this the meter is empty; 0 dBFS fills it. */
export const LEVEL_FLOOR_DB = -60;

/** Maps dBFS (about −60…0) to 0…1 for the level meter. */
export function dbToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const level = (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return Math.min(1, Math.max(0, level));
}

// Rises within a frame or two and falls across the full scale in ~0.7 s, so
// the meter follows speech without flickering between ~15 Hz updates.
const RISE_MS = 40;
const FALL_PER_MS = 1 / 700;

/** One animation step of the meter toward the latest level. */
export function meterStep(shown: number, target: number, dtMs: number): number {
  const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  const next =
    target >= shown
      ? shown + (target - shown) * Math.min(1, dt / RISE_MS)
      : Math.max(target, shown - dt * FALL_PER_MS);
  return next < 0.002 ? 0 : Math.min(1, next);
}
