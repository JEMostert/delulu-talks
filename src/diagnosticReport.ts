import type { RuntimeDiagnostics } from "./types";

const PACKAGE_NAMES = ["mlx", "mlx-audio", "qwen-asr", "torch", "torchvision", "transformers", "accelerate", "safetensors"];

/** Explicit export schema excludes paths, arbitrary package metadata and errors. */
export function diagnosticReport(data: RuntimeDiagnostics) {
  const packages: Record<string, string> = {};
  for (const name of PACKAGE_NAMES) {
    const version = data.packages[name];
    packages[name] = typeof version === "string" && /^[0-9][0-9a-zA-Z.+_-]{0,79}$/.test(version)
      ? version
      : "Not installed or unavailable";
  }
  return {
    schemaVersion: 1,
    platform: ["darwin", "linux", "win32"].includes(data.platform) ? data.platform : "unknown",
    arch: ["arm64", "x64", "ia32"].includes(data.arch) ? data.arch : "unknown",
    memoryGB: Number.isFinite(data.memoryGB) ? data.memoryGB : null,
    freeMemoryGB: Number.isFinite(data.freeMemoryGB) ? data.freeMemoryGB : null,
    pythonVersion: /^Python ([0-9]+\.[0-9]+\.[0-9]+)/.exec(data.python)?.[1] ?? "Not available",
    ffmpegAvailable: data.ffmpeg !== "Not available",
    runtimeInstalled: data.runtimeInstalled === true,
    packages,
    pathsIncluded: false,
    transcriptContentIncluded: false,
  };
}
