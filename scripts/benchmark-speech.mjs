// Run with Bun (imports the application's TypeScript transport).
// Uses temporary audio and cached weights; never touches user history/settings.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { WorkerClient } from "../electron/runtime/workerClient.ts";
import { runtimePython } from "../electron/runtime/location.ts";

if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/benchmark-speech.mjs <user-data-directory> [audio-file] [repeats]",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(process.argv[2]);
const cache = join(data, "models");
const source = resolve(process.argv[3] ?? join(root, "test-audio.m4a"));
const repeats = Number(process.argv[4] ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
  throw new Error("Repeat count must be an integer from 1 to 100");
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
  const hashes = Object.fromEntries(await Promise.all(["original", "different-input"].map(async (name) => [name, createHash("sha256").update(await readFile(join(temporary, `${name}.wav`))).digest("hex")])));
  if (hashes.original === hashes["different-input"]) throw new Error("Changed audio must have different bytes");
  console.log(JSON.stringify({ stage: "metadata", schemaVersion: 1,
    hardware: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model ?? "unknown", memoryBytes: totalmem() },
    language: "en", repeats, inputHashes: hashes,
    note: "Fresh worker, cached model files. Load includes warmup. Repeated original audio may benefit from caching; changed-input measurements remain separate. No GPU model or accuracy evidence is inferred." }));
  const started = performance.now();
  await worker.request("load", {}, 180_000);
  console.log(
    JSON.stringify({
      stage: "load-and-warm-up",
      seconds: (performance.now() - started) / 1000,
    }),
  );
  for (const [index, name] of Array.from({ length: repeats }, () => ["original", "different-input"]).flat().entries()) {
    const started = performance.now();
    const result = await worker.request(
      "transcribe",
      { audioPath: join(temporary, `${name}.wav`), language: "en" },
      120_000,
    );
    console.log(
      JSON.stringify({
        stage: name,
        sample: Math.floor(index / 2) + 1,
        inputSha256: hashes[name],
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
