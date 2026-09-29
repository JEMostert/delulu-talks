# Provenance-bound transcript reports

`scripts/evaluation_report.py` combines supplied UTF-8 reference and hypothesis
files with explicit provenance. It imports the text evaluator from PR #381;
that dependency must land first. It never runs a speech model. Raw transcript
files remain untouched, and an existing report is never replaced.

```sh
python scripts/evaluation_report.py --reference reference.txt --hypothesis hypothesis.txt \
  --provenance provenance.json --case-id nl-short-001 --output report.json
```

Every report requires the following provenance shape. Replace illustrative
values with the actual producing runtime's values. Use `unknown` explicitly
when a fact was not recorded; do not substitute the evaluator machine's facts.
A conversion revision should identify the converted weights and source weights
(or explicitly record missing evidence). Decode settings should include the
actual generation parameters, chunking, preprocessing and sample rate.

```json
{
  "model": {
    "repository": "mlx-community/Confucius4-R2T2-bf16",
    "revision": "747f5fc5f84bc9976baa2f02714e2fed67ed8611",
    "conversion_provenance": "unknown"
  },
  "runtime": {
    "backend": "r2t2-mlx",
    "revision": "unknown",
    "dependencies": {"mlx-audio": "0.5.7"}
  },
  "hardware": {
    "os": "unknown", "processor": "unknown",
    "accelerator": "unknown", "memory": "unknown"
  },
  "decode": {
    "language": "nl", "precision": "bfloat16",
    "settings": {"sample_rate": 16000, "max_tokens": 4096}
  },
  "hypothesis_origin": "unknown"
}
```

The report stores input hashes, both evaluator hashes, raw fidelity metrics,
normalization operations and UTC creation time. Its provenance is explicitly
user supplied; producing a report does not establish native inference, model
compatibility, hardware performance, or a passed quality gate. The standalone
text-metrics script remains useful when no runtime provenance is available;
its output is a text comparison, not a model evaluation report.

Implementation status: **UNVERIFIED — checks not run per user instruction**.

## Reference comparisons and external controls

`scripts/evaluation_comparison.py` consumes provenance-bound reports, requires
matched reference bytes and normalization across every participant, and records
per-case raw fidelity and WER with the original report hashes. It refuses
missing/duplicate cases. The manifest must explicitly describe tradeoffs and
limitations; the tool does not invent conclusions or select a winner.

```json
{
  "title": "NL short utterances",
  "tradeoffs": "Describe observed accuracy/resource tradeoffs; state unavailable measurements.",
  "limitations": "Supplied transcripts only; native execution and resources not verified here.",
  "participants": [
    {"label": "R2T2 MLX", "role": "supported-r2t2-adapter", "reports": ["r2t2-report.json"]},
    {"label": "External reference", "role": "external-benchmark-control", "reports": ["control-report.json"]}
  ]
}
```

```sh
python scripts/evaluation_comparison.py --manifest comparison.json --output comparison-report.json
```

Relative report paths resolve against the manifest directory. Supported adapter
classification requires one of the app's two R2T2 checkpoint repositories. This
classification does not prove runtime compatibility. All other controls must
use `external-benchmark-control`; this records benchmark context and never
changes the app model catalog. Resource claims belong to actual measured
artifacts, not an inference from text accuracy. This comparison implementation
is **UNVERIFIED — checks not run per user instruction**.
