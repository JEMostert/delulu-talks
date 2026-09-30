// Run with Bun (imports the application's TypeScript transport).
// Uses temporary audio and cached weights; never touches user history/settings.
import { cpus, totalmem, release } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePython } from "../electron/runtime/location.ts";
import { NativeInferenceHarness, prepareNativeAudio } from "../electron/runtime/nativeInferenceHarness.ts";

if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/benchmark-speech.mjs <user-data-directory> [audio-file] [repeats]",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = resolve(process.argv[2]);
const cache = join(data, "models");
const source = resolve(process.argv[3] ?? join(root, "test-audio.m4a"));
const harness = new NativeInferenceHarness({
  python: runtimePython(join(data, "speech-venv")),
  workerScript: join(root, "electron/python/transcription_engine.py"), cacheDirectory: cache,
});
const prepared = new Map();
let primaryFailure;
const repeats = Number(process.argv[4] ?? 3);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
  throw new Error("Repeat count must be an integer from 1 to 100");
try {
  console.log(JSON.stringify({ stage: "runtime", ...(await harness.probe()) }));
  for (const [name, filters] of [
    ["original", []], ["different-input", ["-af", "adelay=300|300"]],
  ]) prepared.set(name, await prepareNativeAudio(source, filters));
  const hashes = Object.fromEntries([...prepared].map(([name, audio]) => [name, audio.audioSha256]));
  if (hashes.original === hashes["different-input"]) throw new Error("Changed audio must have different bytes");
  console.log(JSON.stringify({ stage: "metadata", schemaVersion: 1,
    hardware: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model ?? "unknown", memoryBytes: totalmem() },
    language: "en", repeats, inputHashes: hashes,
    note: "Fresh worker, cached files. Load includes warmup; changed input remains separately measured." }));
  const loaded = await harness.load();
  console.log(JSON.stringify({ stage: "load-and-warm-up", seconds: loaded.wallSeconds, observed: loaded.status }));
  for (const [index, name] of Array.from({ length: repeats }, () => ["original", "different-input"]).flat().entries()) {
    const { result, wallSeconds } = await harness.transcribe(prepared.get(name), "en");
    console.log(
      JSON.stringify({
        stage: name,
        sample: Math.floor(index / 2) + 1,
        inputSha256: hashes[name],
        wallSeconds,
        workerSeconds: result.processingTime,
        inferenceSeconds: result.inferenceTime,
        audioSeconds: result.duration,
        characters: result.text.length,
      }),
    );
    if (!result.text.trim())
      throw new Error("Benchmark audio produced no transcript");
  }
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  const failures = [];
  try { await harness.close(); } catch (error) { failures.push(error); }
  const cleanup = await Promise.allSettled([...prepared.values()].map((audio) => audio.cleanup()));
  failures.push(...cleanup.filter((result) => result.status === "rejected").map((result) => result.reason));
  if (failures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], "Benchmark or cleanup failed");
}
