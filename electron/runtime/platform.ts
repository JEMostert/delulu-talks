import type { SpeechModelId, SpeechTier } from "../../src/types";

export function speechModelForPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): SpeechModelId {
  return platform === "darwin" && arch === "arm64" ? "r2t2Mlx" : "r2t2";
}

export const usesMetal = () => speechModelForPlatform() === "r2t2Mlx";

/** R2T2 (Large) needs CUDA on x64 Linux/Windows or MLX on Apple Silicon. */
export function largeSpeechSupported(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "darwin" ? arch === "arm64" : arch === "x64";
}

/** Small and Medium need only the CPU runtime; Large adds PyTorch or MLX. */
export type SpeechRuntimeProfile = "cpu" | "full";
export const speechRuntimeProfile = (tier: SpeechTier): SpeechRuntimeProfile =>
  tier === "large" ? "full" : "cpu";

/** Kokoro needs only the CPU voice runtime; Chatterbox Turbo adds PyTorch. */
export const voiceRuntimeProfile = (
  engine: import("../../src/voice").VoiceEngineId,
): SpeechRuntimeProfile => (engine === "chatterbox-turbo" ? "full" : "cpu");
