# Technical dictation corpus

`fixtures/technical-dictation.json` contains invented Dutch/English speech prompts and exact reference text. Cases combine ordinary prose with package names, flags, paths, numbers, Unicode and code symbols. They are evaluation inputs, not recordings or claims about current R2T2 accuracy. Explicit spelling instructions make technical references intentional; the prose cases guard against unwanted transformations.

Capture each candidate pipeline's output in a separate JSON file:

```json
{
  "schemaVersion": 1,
  "system": "R2T2 raw output, revision and decode settings recorded separately",
  "outputs": [{ "id": "case-id-from-corpus", "text": "actual unmodified output" }]
}
```

Use the case IDs from the corpus; record actual output verbatim, including whitespace. Do not copy reference text into submissions unless clearly identifying that file as a synthetic scorer fixture. Retain raw recognition separately when evaluating parsing, vocabulary corrections or optional Qwen rewriting.

```sh
node scripts/score-technical-dictation.mjs outputs.json > report.json
```

The scorer compares every case using exact Unicode string equality. It does not trim, normalize accents, fold case or forgive punctuation. Missing cases count against the total so partial submissions cannot inflate the reported rate. Reports include language/category totals, mismatches, missing IDs and the first differing Unicode code-point index. Unknown IDs, duplicate IDs and invalid schemas fail instead of silently dropping data. Exit codes: 0 for all exact, 1 for mismatch/missing, 2 for invalid input.

The tool reads only the supplied files and emits JSON. It does not execute dictated commands, load models, fetch weights, enable automatic transforms, or alter history/settings. Reports contain submitted text and references; save them where you intend to retain evaluation content. Native accuracy measurements still require consented audio, hardware/runtime provenance and a separately authorized evaluation run.

Implementation is UNVERIFIED: tests, builds, typechecks, formatting, benchmark execution and native inference were skipped per user instruction.
