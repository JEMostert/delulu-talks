import type { SpeechModelId } from "../../src/types";

export function speechModelForPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): SpeechModelId {
  return platform === "darwin" && arch === "arm64" ? "r2t2Mlx" : "r2t2";
}

export const usesMetal = () => speechModelForPlatform() === "r2t2Mlx";
