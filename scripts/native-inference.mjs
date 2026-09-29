// Opt-in real GPU inference. Run with Bun; importing the shared harness is inert.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeInferenceHarness, nativeWorkerSources, prepareNativeAudio } from "../electron/runtime/nativeInferenceHarness.ts";

const usage = "bun scripts/native-inference.mjs --run --python <existing interpreter> --cache <cached models> --audio <source audio> [--worker <source or packaged transcription_engine.py>] [--language en] [--cycles 1] [--repeats 1] [--output <new JSON path>] [--include-text]";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(usage); process.exit(0); }
const options = {};
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (["--run", "--include-text"].includes(name)) { options[name] = true; continue; }
  if (!["--python", "--cache", "--audio", "--worker", "--language", "--cycles", "--repeats", "--output"].includes(name) ||
      !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
  options[name] = args[++index];
}
if (!options["--run"] || !options["--python"] || !options["--cache"] || !options["--audio"]) throw new Error(usage);
const cycles = Number(options["--cycles"] ?? 1), repeats = Number(options["--repeats"] ?? 1);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10 || !Number.isInteger(repeats) || repeats < 1 || repeats > 20)
  throw new Error("Native cycles must be 1–10 and repeats 1–20");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = resolve(options["--python"]), cache = resolve(options["--cache"]), audio = resolve(options["--audio"]);
const workerScript = resolve(options["--worker"] ?? `${root}/electron/python/transcription_engine.py`);
const report = { schemaVersion: 1, kind: "native-inference", outcome: "running", startedAt: new Date().toISOString(),
  driverPid: process.pid, platform: process.platform, architecture: process.arch, cycles: [],
  scope: "Explicit cached R2T2 inference and adapter unload; no native app launch, delivery, accuracy or memory-release certification" };
let harness, prepared, failure;
try {
  harness = new NativeInferenceHarness({ python, workerScript, cacheDirectory: cache });
  report.runtime = await harness.probe();
  report.workerSources = await nativeWorkerSources(workerScript);
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000, maxBuffer: 4096 });
    report.driverSourceRevision = stdout.trim();
  } catch { report.driverSourceRevision = null; }
  prepared = await prepareNativeAudio(audio);
  report.fixture = { sourceSha256: prepared.sourceSha256, convertedSha256: prepared.audioSha256,
    durationMs: prepared.durationMs, requestedLanguage: options["--language"] ?? "en" };
  for (let cycle = 0; cycle < cycles; cycle++) {
    const entry = { cycle: cycle + 1, requests: [] };
    report.cycles.push(entry);
    entry.load = await harness.load();
    for (let repeat = 0; repeat < repeats; repeat++) {
      const { result, wallSeconds } = await harness.transcribe(prepared, options["--language"] ?? "en");
      if (!result.text.trim()) throw new Error("The supplied speech fixture produced empty text");
      entry.requests.push({ repeat: repeat + 1, wallSeconds, workerSeconds: result.processingTime,
        inferenceSeconds: result.inferenceTime ?? null, audioSeconds: result.duration,
        recognizedLanguage: result.language ?? null, characters: result.text.length,
        ...(options["--include-text"] ? { text: result.text } : {}) });
    }
    entry.unload = await harness.unload();
  }
  report.outcome = "completed";
} catch (error) { failure = error; report.outcome = "failed"; }
finally {
  const cleanupErrors = [];
  if (harness) { try { await harness.close(); } catch (error) { cleanupErrors.push(error); } }
  if (prepared) { try { await prepared.cleanup(); } catch (error) { cleanupErrors.push(error); } }
  if (cleanupErrors.length) { failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Native run or cleanup failed"); report.outcome = "failed"; }
  report.completedAt = new Date().toISOString();
  if (failure) {
    let message = failure instanceof Error ? failure.message : String(failure);
    for (const path of [python, cache, audio, workerScript]) message = message.split(path).join("[provided path]");
    report.error = message.slice(0, 1000);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--output"]) await writeFile(resolve(options["--output"]), serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(serialized);
}
if (failure) process.exitCode = 1;
