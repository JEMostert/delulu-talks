// Offline scoring only: consumes explicit transcripts, never records or loads models.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [resultsPath, corpusPath] = process.argv.slice(2);
if (!resultsPath) {
  throw new Error(
    "Usage: node scripts/score-speech-corpus.mjs <results.json> [corpus.json]",
  );
}
const corpus = JSON.parse(
  await readFile(
    corpusPath
      ? resolve(corpusPath)
      : fileURLToPath(
          new URL(
            "../tests/fixtures/speech/everyday-nl-en.json",
            import.meta.url,
          ),
        ),
    "utf8",
  ),
);
const results = JSON.parse(await readFile(resolve(resultsPath), "utf8"));
if (
  corpus.schemaVersion !== 1 ||
  !Array.isArray(corpus.fixtures) ||
  !Array.isArray(results.transcripts)
) {
  throw new Error(
    "Expected corpus schemaVersion 1 and results.transcripts array",
  );
}
const expectedIds = new Set();
for (const fixture of corpus.fixtures) {
  if (
    !fixture.id ||
    typeof fixture.reference !== "string" ||
    expectedIds.has(fixture.id)
  ) {
    throw new Error("Corpus has invalid or duplicate fixture IDs/references");
  }
  expectedIds.add(fixture.id);
}
const hypotheses = new Map();
for (const row of results.transcripts) {
  if (
    !expectedIds.has(row.id) ||
    hypotheses.has(row.id) ||
    typeof row.text !== "string"
  ) {
    throw new Error("Results contain unknown/duplicate IDs or non-string text");
  }
  hypotheses.set(row.id, row.text);
}
function distance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[hypothesis.length];
}
const words = (text) =>
  text
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
const scores = corpus.fixtures.map((fixture) => {
  if (!hypotheses.has(fixture.id))
    return { id: fixture.id, language: fixture.language, status: "missing" };
  const hypothesis = hypotheses.get(fixture.id);
  const referenceWords = words(fixture.reference);
  const wordEdits = distance(referenceWords, words(hypothesis));
  return {
    id: fixture.id,
    language: fixture.language,
    tags: fixture.tags,
    status: "scored",
    exactMatch: hypothesis === fixture.reference,
    characterEdits: distance(
      Array.from(fixture.reference),
      Array.from(hypothesis),
    ),
    referenceWords: referenceWords.length,
    wordEdits,
    wordErrorRate: referenceWords.length
      ? wordEdits / referenceWords.length
      : null,
  };
});
const scored = scores.filter((row) => row.status === "scored");
const referenceWords = scored.reduce((sum, row) => sum + row.referenceWords, 0);
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      corpus: corpus.id,
      evidence: results.evidence ?? "unspecified — no native accuracy claim",
      normalization:
        "Exact/character scores preserve bytes and Unicode code points; word scores use NFC, lowercase, and apostrophe-aware letter/number tokens.",
      summary: {
        expected: scores.length,
        scored: scored.length,
        missing: scores.length - scored.length,
        exactMatches: scored.filter((row) => row.exactMatch).length,
        wordErrorRate: referenceWords
          ? scored.reduce((sum, row) => sum + row.wordEdits, 0) / referenceWords
          : null,
      },
      scores,
    },
    null,
    2,
  ),
);
// Partial reports remain usable, but cannot silently count as a complete corpus run.
if (scored.length !== scores.length) process.exitCode = 2;
