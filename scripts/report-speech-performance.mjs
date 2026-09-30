// Offline report for benchmark-speech JSONL; never starts an inference worker.
import { readFile } from "node:fs/promises";

const [currentPath, baselinePath] = process.argv.slice(2);
if (!currentPath) throw new Error("Usage: node scripts/report-speech-performance.mjs <current.jsonl> [baseline.jsonl]");
async function parse(path) {
  const rows = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const metadata = rows.filter((row) => row.stage === "metadata");
  if (metadata.length !== 1 || metadata[0].schemaVersion !== 1) throw new Error("Expected exactly one benchmark metadata row (schemaVersion 1)");
  const meta = metadata[0];
  const hashes = meta.inputHashes;
  if (!hashes || !/^[a-f0-9]{64}$/.test(hashes.original) || !/^[a-f0-9]{64}$/.test(hashes["different-input"]) || hashes.original === hashes["different-input"])
    throw new Error("Original and changed input must have distinct SHA-256 hashes");
  if (!Number.isInteger(meta.repeats) || meta.repeats < 1 || meta.repeats > 100) throw new Error("Invalid expected repeat count");
  const measurements = rows.filter((row) => ["original", "different-input"].includes(row.stage));
  for (const stage of ["original", "different-input"]) {
    const stageRows = measurements.filter((row) => row.stage === stage);
    const samples = new Set();
    for (const row of stageRows) {
      if (row.inputSha256 !== hashes[stage] || !Number.isInteger(row.sample) || row.sample < 1 || row.sample > meta.repeats || samples.has(row.sample))
        throw new Error("Measurement has inconsistent input hash or duplicate/invalid sample number");
      samples.add(row.sample);
      for (const key of ["wallSeconds", "workerSeconds", "inferenceSeconds", "audioSeconds"])
        if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new Error(`Invalid ${key} measurement`);
    }
    if (samples.size !== meta.repeats) throw new Error(`Incomplete ${stage} measurements`);
  }
  const loads = rows.filter((row) => row.stage === "load-and-warm-up");
  if (loads.length !== 1 || !Number.isFinite(loads[0].seconds) || loads[0].seconds < 0) throw new Error("Expected one load/warmup measurement");
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  const summarize = (items) => ({ count: items.length,
    wallP50Seconds: percentile(items.map((row) => row.wallSeconds), 0.5),
    wallP95Seconds: percentile(items.map((row) => row.wallSeconds), 0.95),
    inferenceP50Seconds: percentile(items.map((row) => row.inferenceSeconds), 0.5),
    raw: items,
  });
  const original = measurements.filter((row) => row.stage === "original");
  return { metadata: meta, loadAndWarmupSeconds: loads[0].seconds,
    firstRequest: original[0], repeatedOriginal: original.length > 1 ? summarize(original.slice(1)) : null,
    changedInput: summarize(measurements.filter((row) => row.stage === "different-input")),
    uncertainty: "Nearest-rank percentiles describe these samples only; small repeated-run counts and concurrent system load do not establish stable p95 or significance. This report does not evaluate accuracy.",
  };
}
const current = await parse(currentPath);
const baseline = baselinePath ? await parse(baselinePath) : null;
let comparison = null;
if (baseline) {
  const comparable = JSON.stringify(current.metadata.hardware) === JSON.stringify(baseline.metadata.hardware)
    && current.metadata.language === baseline.metadata.language
    && current.metadata.inputHashes.original === baseline.metadata.inputHashes.original
    && current.metadata.inputHashes["different-input"] === baseline.metadata.inputHashes["different-input"];
  const ratio = (value, previous) => previous > 0 ? value / previous : null;
  comparison = comparable ? {
    comparable: true,
    changedInputP50Ratio: ratio(current.changedInput.wallP50Seconds, baseline.changedInput.wallP50Seconds),
    changedInputP95Ratio: ratio(current.changedInput.wallP95Seconds, baseline.changedInput.wallP95Seconds),
    repeatedOriginalP50Ratio: current.repeatedOriginal && baseline.repeatedOriginal ? ratio(current.repeatedOriginal.wallP50Seconds, baseline.repeatedOriginal.wallP50Seconds) : null,
    note: "Ratios above 1 mean slower. Inspect changed-input ratios separately; improvement only on repeated original audio can be cache-biased. No automatic pass/fail or matched-quality claim.",
  } : { comparable: false, reason: "Hardware, language or input hashes differ; no regression ratio computed." };
}
console.log(JSON.stringify({ schemaVersion: 1, current, baseline, comparison }, null, 2));
