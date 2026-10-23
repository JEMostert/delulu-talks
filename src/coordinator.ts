/** Optional, fully local voice helper. Work agents retain planning responsibility. */
export type VoiceCoordinatorMode = "off" | "lightweight" | "conversational";

export type CoordinatorStatus = {
  mode: VoiceCoordinatorMode;
  phase: "off" | "not-ready" | "loading" | "ready" | "failed";
  message: string;
  model: "qwen35Small" | "qwen35Medium" | null;
  registeredAgents: number;
  queuedTasks: number;
  activeAgent: string | null;
};

export function normalizeCoordinatorMode(value: unknown): VoiceCoordinatorMode {
  return value === "lightweight" || value === "conversational" ? value : "off";
}
