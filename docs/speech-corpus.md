# Everyday Dutch/English reference corpus

`tests/fixtures/speech/everyday-nl-en.json` contains twenty invented reference sentences, equally split between Dutch and English. Stable IDs and tags cover names, places, diacritics, apostrophes, contractions, repetition, informal speech and punctuation. No personal recordings or real transcript content are included. Written diacritics are represented; regional speaker accents still require consented recordings.

Use the exact reference sentences when making future recordings, then submit raw R2T2 recognition output before vocabulary corrections or optional rewriting. Keep language selection, model/conversion/runtime revisions, decode settings, hardware and audio provenance in the results' `evidence` object. Do not attribute transformation fixture success to speech recognition quality.

The offline scorer consumes a JSON object with an `evidence` object and `transcripts` array of `{ "id": "nl-names", "text": "raw recognized text" }` entries:

```sh
node scripts/score-speech-corpus.mjs results.json > scores.json
```

An optional second argument selects another schema-version-1 corpus. Unknown or duplicate IDs fail. Missing IDs are explicitly reported and return exit code 2; a missing recording is never treated as empty recognized speech. An explicitly empty recognized string is scored as deletions. Reports include exact match, Unicode code-point edit distance and word error rate. Word scoring folds case, normalizes NFC and excludes punctuation; exact scores remain sensitive to spelling, punctuation, whitespace and contractions. Aggregate word error rate uses total edits divided by total reference words and may exceed 1 when there are many insertions.

The scorer does not start workers, access application data, record audio, download weights or run inference. Text fixtures alone establish no native accuracy, accent robustness or calibrated confidence. This change is UNVERIFIED: no tests, builds, typechecks, format checks, benchmarks or native inference were run per the issues-only instruction.
