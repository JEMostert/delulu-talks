// Real native-only scenario code; no evidence is created until an owner opts in.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NativeInferenceHarness, nativeFileHash, nativeWorkerSources, prepareNativeAudio } from "../electron/runtime/nativeInferenceHarness.ts";
const usage = "bun scripts/mac-native-lifecycle.mjs --run --python <native arm64 runtime> --cache <copied cached models> --audio <consented fixture> [--worker <source/packaged worker>] [--language en] [--retained-limit-mib 64] [--output <new report>]";
const args = process.argv.slice(2), options = {};
if (args.includes("--help")) { console.log(usage); process.exit(0); }
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === "--run") { options[name] = true; continue; }
  if (!["--python", "--cache", "--audio", "--worker", "--language", "--retained-limit-mib", "--output"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(usage);
  options[name] = args[++index];
}
if (!options["--run"] || !options["--python"] || !options["--cache"] || !options["--audio"]) throw new Error(usage);
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("These scenarios require an actual native Apple Silicon Mac");
const limitMiB = Number(options["--retained-limit-mib"] ?? 64);
if (!Number.isFinite(limitMiB) || limitMiB < 0 || limitMiB > 1024) throw new Error("Retained-memory limit must be 0–1024 MiB");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceWorker = resolve(options["--worker"] ?? join(root, "electron/python/transcription_engine.py"));
const wrapper = join(root, "scripts/native-worker-observation.py");
const control = await mkdtemp(join(tmpdir(), "delulu-mac-native-"));
const journal = join(control, "observations.json");
const report = { schemaVersion: 1, issues: [34, 35], outcome: "running", startedAt: new Date().toISOString(),
  platform: process.platform, architecture: process.arch, memoryLimitBytes: limitMiB * 1024 * 1024, cycles: [],
  limitations: ["Python socket guard is not an OS network sandbox", "Physical network disconnection and full native app restart remain pending", "Allocator observations do not measure other applications or thermal behavior"] };
let harness, prepared, primaryFailure;
const configured = () => new NativeInferenceHarness({ python: resolve(options["--python"]), workerScript: wrapper, cacheDirectory: resolve(options["--cache"]) });
const previousSource = process.env.DELULU_NATIVE_WORKER_SOURCE;
const previousJournal = process.env.DELULU_NATIVE_OBSERVATION_JOURNAL;
process.env.DELULU_NATIVE_WORKER_SOURCE = sourceWorker;
process.env.DELULU_NATIVE_OBSERVATION_JOURNAL = journal;
function stopped(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}
try {
  report.workerSources = await nativeWorkerSources(sourceWorker);
  report.observationSourceSha256 = await nativeFileHash(wrapper);
  prepared = await prepareNativeAudio(resolve(options["--audio"]));
  report.fixture = { sourceSha256: prepared.sourceSha256, convertedSha256: prepared.audioSha256, durationMs: prepared.durationMs, requestedLanguage: options["--language"] ?? "en" };
  harness = configured();
  report.runtime = await harness.probe();
  for (let cycle = 0; cycle < 10; cycle++) {
    const entry = { cycle: cycle + 1 }; report.cycles.push(entry);
    entry.load = await harness.load();
    const measured = await harness.transcribe(prepared, options["--language"] ?? "en");
    if (!measured.result.text.trim()) throw new Error("Lifecycle speech fixture produced empty text");
    entry.transcribe = { wallSeconds: measured.wallSeconds, characters: measured.result.text.length, memory: measured.result.nativeMemory };
    entry.unload = await harness.unload();
    const active = entry.unload.nativeMemory?.activeBytes;
    if (typeof active !== "number") throw new Error("MLX active-memory observation is unavailable; memory-return acceptance cannot be established");
    entry.memoryWithinLimit = active <= report.memoryLimitBytes;
    if (!entry.memoryWithinLimit) throw new Error("MLX active allocations exceed the declared post-unload limit");
  }
  await harness.close(); harness = null;
  const beforeRestart = JSON.parse(await readFile(journal, "utf8"));
  const firstPids = [...new Set(beforeRestart.events.map((event) => event.pid))];
  report.firstWorkerStopped = firstPids.every(stopped);
  if (!report.firstWorkerStopped) throw new Error("The first native worker still exists after bounded shutdown");
  harness = configured();
  report.offlineRestart = { load: await harness.load() };
  const fresh = await harness.transcribe(prepared, options["--language"] ?? "en");
  if (!fresh.result.text.trim()) throw new Error("Fresh offline worker produced empty speech output");
  report.offlineRestart.transcribe = { characters: fresh.result.text.length, wallSeconds: fresh.wallSeconds, memory: fresh.result.nativeMemory };
  await harness.close(); harness = null;
  report.observations = JSON.parse(await readFile(journal, "utf8"));
  report.allWorkersStopped = [...new Set(report.observations.events.map((event) => event.pid))].every(stopped);
  if (!report.allWorkersStopped) throw new Error("A native worker remains after restart cleanup");
  if (report.observations.externalNetworkAttempts !== 0) throw new Error("Native offline run attempted an external Python network operation");
  report.outcome = "completed";
} catch (error) { primaryFailure = error; report.outcome = "failed"; }
finally {
  const failures = [];
  if (harness) { try { await harness.close(); } catch (error) { failures.push(error); } }
  try { report.observations = JSON.parse(await readFile(journal, "utf8")); } catch { /* No successful observation yet. */ }
  if (prepared) { try { await prepared.cleanup(); } catch (error) { failures.push(error); } }
  try { await rm(control, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (previousSource === undefined) delete process.env.DELULU_NATIVE_WORKER_SOURCE; else process.env.DELULU_NATIVE_WORKER_SOURCE = previousSource;
  if (previousJournal === undefined) delete process.env.DELULU_NATIVE_OBSERVATION_JOURNAL; else process.env.DELULU_NATIVE_OBSERVATION_JOURNAL = previousJournal;
  if (failures.length) { primaryFailure = new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], "Native scenario or cleanup failed"); report.outcome = "failed"; }
  if (primaryFailure) {
    let message = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
    for (const path of [sourceWorker, control, ...["--python", "--cache", "--audio"].map((key) => resolve(options[key]))])
      message = message.split(path).join("[provided path]");
    report.error = message.slice(0, 1000);
  }
  report.completedAt = new Date().toISOString();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options["--output"]) await writeFile(resolve(options["--output"]), serialized, { mode: 0o600, flag: "wx" });
  process.stdout.write(serialized);
}
if (primaryFailure) process.exitCode = 1;
