// Run with Bun (imports the application's TypeScript transport).
// Uses temporary audio and cached weights; never touches user history/settings.
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePython } from "../electron/runtime/location.ts";
import { NativeInferenceHarness, prepareNativeAudio } from "../electron/runtime/nativeInferenceHarness.ts";

if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/benchmark-speech.mjs <user-data-directory> [audio-file]",
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
try {
  console.log(JSON.stringify({ stage: "runtime", ...(await harness.probe()) }));
  for (const [name, filters] of [
    ["original", []], ["different-input", ["-af", "adelay=300|300"]],
  ]) prepared.set(name, await prepareNativeAudio(source, filters));
  const loaded = await harness.load();
  console.log(JSON.stringify({ stage: "load-and-warm-up", seconds: loaded.wallSeconds, observed: loaded.status }));
  for (const name of ["original", "different-input", "original"]) {
    const { result, wallSeconds } = await harness.transcribe(prepared.get(name), "en");
    console.log(
      JSON.stringify({
        stage: name,
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
