import type { ModelId } from "../../src/types";

export function speechModelForPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): ModelId {
  return platform === "darwin" && arch === "arm64" ? "qwen3Asr" : "r2t2";
}

export const usesMetal = () => speechModelForPlatform() === "qwen3Asr";
