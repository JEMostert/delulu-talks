// Offline comparison of submitted text; never runs a model, command, or transform.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { scoreTechnicalDictation } from "./score-technical-dictation.mjs";

/** Compare complete, identically keyed submissions against exact corpus references. */
export function compareTechnicalDictation(corpus, candidates) {
  if (!candidates || typeof candidates !== "object" || Array.isArray(candidates))
    throw new Error("Expected raw, deterministic and vocabulary submissions");
  if (candidates.schemaVersion !== undefined && candidates.schemaVersion !== 1)
    throw new Error("Expected schemaVersion 1 comparison manifest");
  const required = ["raw", "deterministic", "vocabulary"];
  for (const pipeline of required) {
    if (!Object.prototype.hasOwnProperty.call(candidates, pipeline))
      throw new Error(`Missing required pipeline: ${pipeline}`);
  }
  const allowed = new Set([...required, "rewrite", "schemaVersion"]);
  if (Object.keys(candidates).some((key) => !allowed.has(key)))
    throw new Error("Unknown comparison manifest field");
  const pipelines = [...required];
  if (Object.prototype.hasOwnProperty.call(candidates, "rewrite")) pipelines.push("rewrite");
  const scores = Object.fromEntries(pipelines.map((pipeline) => {
    const score = scoreTechnicalDictation(corpus, candidates[pipeline]);
    if (score.summary.missing)
      throw new Error(`${pipeline}: every corpus case must have a submitted output`);
    return [pipeline, score];
  }));
  const systems = Object.fromEntries(pipelines.map((pipeline) => [pipeline, scores[pipeline].system]));
  const summarizeGroups = (field) => Object.fromEntries(
    Object.keys(scores.raw[field]).map((group) => [group,
      Object.fromEntries(pipelines.map((pipeline) => [pipeline, scores[pipeline][field][group]])),
    ]),
  );
  const cases = scores.raw.cases.map((raw, index) => ({
    id: raw.id,
    language: raw.language,
    categories: raw.categories,
    expected: raw.expected,
    pipelines: Object.fromEntries(pipelines.map((pipeline) => {
      const row = scores[pipeline].cases[index];
      return [pipeline, {
        system: systems[pipeline], actual: row.actual,
        status: row.status, firstDifference: row.firstDifference,
      }];
    })),
  }));
  const regressions = [];
  const changesFromRaw = Object.fromEntries(pipelines.filter((pipeline) => pipeline !== "raw").map((pipeline) => {
    const gained = [];
    const lost = [];
    for (const row of cases) {
      const rawExact = row.pipelines.raw.status === "exact";
      const candidateExact = row.pipelines[pipeline].status === "exact";
      if (!rawExact && candidateExact) gained.push(row.id);
      if (rawExact && !candidateExact) {
        lost.push(row.id);
        regressions.push({
          pipeline, system: systems[pipeline], id: row.id,
          language: row.language, categories: row.categories,
          proseGuard: row.categories.includes("guard") && row.categories.includes("prose"),
          expected: row.expected, raw: row.pipelines.raw.actual,
          actual: row.pipelines[pipeline].actual,
          firstDifference: row.pipelines[pipeline].firstDifference,
        });
      }
    }
    return [pipeline, {
      gainedExact: gained.length, lostExact: lost.length,
      netExact: gained.length - lost.length,
      exactMatchRateDelta: scores[pipeline].summary.exactMatchRate - scores.raw.summary.exactMatchRate,
      gainedCaseIds: gained, lostCaseIds: lost,
    }];
  }));
  // Guard mismatches are reported even when the raw submission was already wrong.
  const proseGuardFailures = cases.filter((row) => row.categories.includes("guard") && row.categories.includes("prose"))
    .flatMap((row) => pipelines.filter((pipeline) => row.pipelines[pipeline].status !== "exact")
      .map((pipeline) => ({
        id: row.id, pipeline, system: systems[pipeline], expected: row.expected,
        actual: row.pipelines[pipeline].actual,
        firstDifference: row.pipelines[pipeline].firstDifference,
      })));
  const allExact = pipelines.every((pipeline) => scores[pipeline].summary.exact === scores[pipeline].summary.total);
  return {
    schemaVersion: 1,
    corpus: corpus.id,
    systems,
    evidence: "Submitted text only; no recognition, vocabulary processing, deterministic transform or rewrite was executed.",
    comparison: "Exact Unicode string equality; no trimming, case folding, or normalization.",
    summary: Object.fromEntries(pipelines.map((pipeline) => [pipeline, scores[pipeline].summary])),
    languages: summarizeGroups("languages"),
    categories: summarizeGroups("categories"),
    changesFromRaw,
    regressions,
    proseGuardFailures,
    cases,
    allExact,
    recommendation: {
      requiresManualEvaluation: true,
      enableAutomaticTransforms: false,
      text: "Manual evaluation on representative dictation and prose guards is required before considering any configuration change. These submitted synthetic cases do not authorize enabling automatic transforms.",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [manifestPath, corpusPath] = process.argv.slice(2);
    if (!manifestPath || process.argv.length > 4)
      throw new Error("Usage: node scripts/compare-technical-dictation.mjs <manifest.json> [corpus.json]");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest?.schemaVersion !== 1)
      throw new Error("Expected schemaVersion 1 comparison manifest");
    const corpus = JSON.parse(await readFile(corpusPath ?? new URL("../fixtures/technical-dictation.json", import.meta.url), "utf8"));
    const report = compareTechnicalDictation(corpus, manifest);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.allExact && report.regressions.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
