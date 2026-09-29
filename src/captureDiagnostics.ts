import type { CaptureDiagnostics } from "./types";

// Samples at or above 99.9% of digital full scale may indicate input clipping.
// This cannot establish whether a microphone or upstream hardware clipped.
export const CLIPPING_THRESHOLD = 0.999;

export function normalizeCaptureDiagnostics(value: unknown): CaptureDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const fields = ["sampleCount", "sampleRate", "peakAmplitude", "rmsAmplitude", "clippedSampleCount", "clippingThreshold"] as const;
  if (fields.some((field) => typeof source[field] !== "number" || !Number.isFinite(source[field]))) return undefined;
  const stats = source as unknown as CaptureDiagnostics;
  if (!Number.isSafeInteger(stats.sampleCount) || stats.sampleCount <= 0 ||
      !Number.isSafeInteger(stats.clippedSampleCount) || stats.clippedSampleCount < 0 || stats.clippedSampleCount > stats.sampleCount ||
      stats.sampleRate < 8000 || stats.sampleRate > 384000 ||
      stats.peakAmplitude < 0 || stats.rmsAmplitude < 0 || stats.rmsAmplitude > stats.peakAmplitude ||
      stats.clippingThreshold !== CLIPPING_THRESHOLD) return undefined;
  return {
    sampleCount: stats.sampleCount,
    sampleRate: stats.sampleRate,
    peakAmplitude: stats.peakAmplitude,
    rmsAmplitude: stats.rmsAmplitude,
    clippedSampleCount: stats.clippedSampleCount,
    clippingThreshold: stats.clippingThreshold,
  };
}
