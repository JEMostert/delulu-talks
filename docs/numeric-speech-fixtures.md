# Numeric fidelity fixtures

`tests/fixtures/speech/numbers-nl-en.json` adds twenty invented Dutch/English references for integers, currency, decimal and thousands separators, telephone formatting and leading zeros, times, dates, ambiguous numeric dates, fractions, percentages and negative ranges. It does not add an automatic formatter or guess a locale for ambiguous dates.

Record the references later with consent and compare raw recognition before rewriting or personalization. In ambiguous-date cases, retaining the explicitly dictated numeric sequence is the reference; interpreting it as a different calendar date is an error. Formatting alternatives should be recorded separately rather than silently normalized into the expected result.

Use the offline scorer from #105:

```sh
node scripts/score-speech-corpus.mjs results.json tests/fixtures/speech/numbers-nl-en.json > numeric-scores.json
```

Exact match and character edits detect numeric punctuation, symbols and leading-zero loss. Normalized word error rate deliberately ignores punctuation and currency symbols, so it must not be used alone to claim numeric fidelity. Added unexecuted scorer contracts cover decimal/currency corruption, dropped zeros, swapped dates and missing versus empty recognition.

UNVERIFIED — tests, builds, typechecks, formatting checks, benchmarks and native inference were skipped per user instruction. These invented text fixtures provide a future evaluation input; no real recognition accuracy or spoken-number policy has been validated.
