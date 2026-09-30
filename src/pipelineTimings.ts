import type { PipelineTimings } from "./types";

export const TIMING_LABELS: Record<keyof PipelineTimings, string> = {
  captureEndMs: "Capture finalization",
  preprocessingMs: "Audio preparation",
  speechLoadMs: "Speech model readiness wait",
  speechRequestMs: "Speech worker round trip",
  backendPreprocessingMs: "Backend audio preprocessing",
  inferenceMs: "Speech inference",
  rewriteLoadMs: "Writing model readiness wait",
  rewritingMs: "Rewrite worker round trips",
  clipboardMs: "Clipboard publication",
  pasteMs: "Paste dispatch",
};

/** Only measured finite durations survive IPC/storage; absence means unmeasured. */
export function normalizeTimings(value: unknown): PipelineTimings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: PipelineTimings = {};
  for (const key of Object.keys(TIMING_LABELS) as (keyof PipelineTimings)[]) {
    const duration = source[key];
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
      result[key] = Math.round(duration * 100) / 100;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function withoutRewriteTimings(value: unknown): PipelineTimings | undefined {
  const timings = normalizeTimings(value);
  if (!timings) return undefined;
  delete timings.rewriteLoadMs;
  delete timings.rewritingMs;
  delete timings.clipboardMs;
  delete timings.pasteMs;
  return Object.keys(timings).length ? timings : undefined;
}
