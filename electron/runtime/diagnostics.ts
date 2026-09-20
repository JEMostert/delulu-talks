import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { RuntimeDiagnostics } from "../../src/types";
import type { StorageService } from "../services/storage";
import { runtimePython } from "./location";

function probe(program: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(
      program,
      args,
      { timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error ? "Not available" : stdout.trim()),
    ),
  );
}
export async function runtimeDiagnostics(
  storage: StorageService,
): Promise<RuntimeDiagnostics> {
  const pythonPath = runtimePython(storage.venvDirectory);
  const installed = existsSync(pythonPath);
  const [python, ffmpeg, metadata] = await Promise.all([
    probe(
      installed
        ? pythonPath
        : process.platform === "win32"
          ? "python"
          : "python3",
      ["--version"],
    ),
    probe("ffmpeg", ["-version"]),
    installed
      ? probe(pythonPath, [
          "-c",
          "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))",
        ])
      : Promise.resolve("{}"),
  ]);
  let packages: Record<string, string> = {};
  try {
    packages = JSON.parse(metadata);
  } catch {
    /* Failed interpreter remains visible in diagnostics. */
  }
  return {
    platform: process.platform,
    arch: process.arch,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    freeMemoryGB: Math.round(freemem() / 2 ** 30),
    python,
    ffmpeg: ffmpeg.split("\n")[0],
    dataDirectory: storage.dataDirectory,
    runtimeInstalled: installed,
    packages,
    checkedAt: Date.now(),
  };
}
