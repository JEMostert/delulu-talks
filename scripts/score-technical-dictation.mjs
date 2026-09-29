// Offline exact-text scoring only: never invokes a shell, model, or transform.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function scoreTechnicalDictation(corpus, submission) {
  if (corpus?.schemaVersion !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length)
    throw new Error("Expected a nonempty schemaVersion 1 corpus");
  const ids = new Set();
  for (const entry of corpus.cases) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
        !["nl", "en"].includes(entry.language) || typeof entry.spoken !== "string" ||
        typeof entry.expected !== "string" || !Array.isArray(entry.categories) ||
        !entry.categories.length || entry.categories.some((value) => typeof value !== "string" || !value))
      throw new Error("Invalid or duplicate corpus case");
    ids.add(entry.id);
  }
  if (submission?.schemaVersion !== 1 || typeof submission.system !== "string" ||
      !submission.system.trim() || !Array.isArray(submission.outputs))
    throw new Error("Expected schemaVersion 1 submission with system and outputs");
  const outputs = new Map();
  for (const entry of submission.outputs) {
    if (!entry || !ids.has(entry.id) || outputs.has(entry.id) || typeof entry.text !== "string")
      throw new Error("Submission has an unknown/duplicate ID or non-string text");
    outputs.set(entry.id, entry.text);
  }
  const rows = corpus.cases.map((entry) => {
    const actual = outputs.get(entry.id);
    const exact = actual === entry.expected;
    let firstDifference = null;
    if (actual !== undefined && !exact) {
      const expectedPoints = Array.from(entry.expected);
      const actualPoints = Array.from(actual);
      let index = 0;
      while (index < Math.min(expectedPoints.length, actualPoints.length) &&
             expectedPoints[index] === actualPoints[index]) index++;
      firstDifference = {
        codePointIndex: index,
        expected: expectedPoints[index] ?? null,
        actual: actualPoints[index] ?? null,
      };
    }
    return {
      id: entry.id, language: entry.language, categories: entry.categories,
      status: actual === undefined ? "missing" : exact ? "exact" : "mismatch",
      expected: entry.expected, actual: actual ?? null, firstDifference,
    };
  });
  const summarize = (entries) => ({
    total: entries.length,
    submitted: entries.filter((entry) => entry.status !== "missing").length,
    exact: entries.filter((entry) => entry.status === "exact").length,
    mismatches: entries.filter((entry) => entry.status === "mismatch").length,
    missing: entries.filter((entry) => entry.status === "missing").length,
    exactMatchRate: entries.length ? entries.filter((entry) => entry.status === "exact").length / entries.length : null,
  });
  return {
    schemaVersion: 1, corpus: corpus.id, system: submission.system,
    evidence: "Submitted text only; no native recognition or transform was run by this scorer.",
    comparison: "Exact Unicode string equality; no trimming, case folding, or normalization.",
    summary: summarize(rows),
    languages: Object.fromEntries(["nl", "en"].map((language) => [language, summarize(rows.filter((entry) => entry.language === language))])),
    categories: Object.fromEntries([...new Set(rows.flatMap((entry) => entry.categories))].map((category) => [category, summarize(rows.filter((entry) => entry.categories.includes(category)))])),
    cases: rows,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [submissionPath, corpusPath] = process.argv.slice(2);
    if (!submissionPath || process.argv.length > 4)
      throw new Error("Usage: node scripts/score-technical-dictation.mjs <submission.json> [corpus.json]");
    const corpus = JSON.parse(await readFile(corpusPath ?? new URL("../fixtures/technical-dictation.json", import.meta.url), "utf8"));
    const submission = JSON.parse(await readFile(submissionPath, "utf8"));
    const report = scoreTechnicalDictation(corpus, submission);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.summary.mismatches || report.summary.missing) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
