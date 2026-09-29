// Run with Bun (imports the application's TypeScript transport).
// Uses temporary audio and cached weights; never touches user history/settings.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { WorkerClient } from "../electron/runtime/workerClient.ts";
import { runtimePython } from "../electron/runtime/location.ts";

if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/benchmark-speech.mjs <user-data-directory> [audio-file]",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(process.argv[2]);
const cache = join(data, "models");
const source = resolve(process.argv[3] ?? join(root, "test-audio.m4a"));
const temporary = await mkdtemp(join(tmpdir(), "delulu-benchmark-"));
const worker = new WorkerClient(
  () => ({
    python: runtimePython(join(data, "speech-venv")),
    script: join(root, "electron/python/transcription_engine.py"),
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      HF_HOME: cache,
      HF_HUB_CACHE: join(cache, "hub"),
      HUGGINGFACE_HUB_CACHE: join(cache, "hub"),
    },
  }),
  (error) => console.error(error.message),
);
try {
  for (const [name, filters] of [
    ["original", []],
    ["different-input", ["-af", "adelay=300|300"]],
  ]) {
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      source,
      ...filters,
      "-ar",
      "16000",
      "-ac",
      "1",
      join(temporary, `${name}.wav`),
    ]);
  }
  const started = performance.now();
  await worker.request("load", {}, 180_000);
  console.log(
    JSON.stringify({
      stage: "load-and-warm-up",
      seconds: (performance.now() - started) / 1000,
    }),
  );
  for (const name of ["original", "different-input", "original"]) {
    const started = performance.now();
    const result = await worker.request(
      "transcribe",
      { audioPath: join(temporary, `${name}.wav`), language: "en" },
      120_000,
    );
    console.log(
      JSON.stringify({
        stage: name,
        wallSeconds: (performance.now() - started) / 1000,
        workerSeconds: result.processingTime,
        inferenceSeconds: result.inferenceTime,
        audioSeconds: result.duration,
        characters: result.text.length,
      }),
    );
    if (!result.text.trim())
      throw new Error("Benchmark audio produced no transcript");
  }
} finally {
  await worker.stopAndWait();
  await rm(temporary, { recursive: true, force: true });
}
