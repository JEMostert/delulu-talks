import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Synthetic scorer contracts: no model, microphone or native accuracy claims.
function score(reference, text, includeResult = true) {
  const temporary = mkdtempSync(join(tmpdir(), "delulu-numeric-score-"));
  try {
    const corpus = join(temporary, "corpus.json");
    const results = join(temporary, "results.json");
    writeFileSync(corpus, JSON.stringify({ schemaVersion: 1, id: "synthetic-numeric", fixtures: [{ id: "case", language: "nl", reference }] }));
    writeFileSync(results, JSON.stringify({ transcripts: includeResult ? [{ id: "case", text }] : [] }));
    const result = spawnSync(process.execPath, [new URL("./score-speech-corpus.mjs", import.meta.url).pathname, results, corpus], { encoding: "utf8" });
    return { exitCode: result.status, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("decimal separator and currency changes remain visible in exact scoring", () => {
  const { report } = score("€ 12,50", "$ 12.50");
  expect(report.scores[0].exactMatch).toBe(false);
  expect(report.scores[0].characterEdits).toBe(2);
  // Normalized WER intentionally cannot establish numeric-format fidelity.
  expect(report.summary.wordErrorRate).toBe(0);
});

test("a dropped leading zero is an error, including in normalized word scoring", () => {
  const { report } = score("toestel 007", "toestel 7");
  expect(report.scores[0].characterEdits).toBe(2);
  expect(report.summary.wordErrorRate).toBe(0.5);
});

test("ambiguous date reordering is not normalized into an apparent match", () => {
  const { report } = score("04/05/2027", "05/04/2027");
  expect(report.scores[0].exactMatch).toBe(false);
  expect(report.scores[0].wordEdits).toBe(2);
});

test("missing recognition and explicitly empty recognition have different outcomes", () => {
  const missing = score("08:05", "", false);
  expect(missing.exitCode).toBe(2);
  expect(missing.report.scores[0].status).toBe("missing");
  const empty = score("08:05", "");
  expect(empty.exitCode).toBe(0);
  expect(empty.report.scores[0].status).toBe("scored");
  expect(empty.report.summary.wordErrorRate).toBe(1);
});
