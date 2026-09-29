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

## Retaining raw resource benchmarks

`scripts/benchmark_artifact.py` packages already-collected measurements and raw
files in a new directory. It does not invoke a runner, install models, measure
hardware or synthesize benchmark evidence. Its manifest requires the same
`provenance` object shown above, plus these fields:

```json
{
  "measurement_method": "Describe the actual clock, memory sampler and execution order.",
  "limitations": "Describe noise, missing samples and native evidence limitations.",
  "runs": [
    {"run_id": "warm-1", "case_id": "nl-short-001", "phase": "warm",
     "measurements": {"wall_time": {"value": 1.2, "unit": "seconds"}}},
    {"run_id": "warm-2", "case_id": "nl-short-001", "phase": "warm",
     "measurements": {"wall_time": {"value": 1.3, "unit": "seconds"}}}
  ],
  "artifacts": [{"role": "runner-log", "path": "runner-log.jsonl"}]
}
```

The numbers above illustrate syntax only; they are not measured Delulu results.
Add the required provenance object before using this manifest. Artifact paths
resolve against the manifest directory. Listed raw files can contain private
transcripts: retain them locally and share only after inspecting their contents.

```sh
python scripts/benchmark_artifact.py --manifest benchmark.json --output-directory retained-benchmark
```

Bundles retain the original manifest and exact raw file bytes with hashes. Runs
remain individually available. Summaries group by case, phase, metric and unit;
cold, load, warmup and warm measurements remain separate. Each group records its
sample count, mean, median, range, sample deviation and conditional standard
error. One observation has unknown spread. Conditional standard error assumes
independent observations; the tool does not assert that assumption or produce a
confidence interval. Missing resource measurements stay missing.

The destination must not exist; an interrupted copy removes only the newly
created incomplete bundle. Reports retain producing revisions, hardware and
decode metadata as user-supplied facts. **UNVERIFIED — checks not run per user
instruction**; no native benchmark evidence was generated for this change.

## Optional rewrite memory comparison

`scripts/sample_process_memory.py` observes an existing application's process
tree using `psutil` installed in a separate observer environment. It performs
read-only OS queries. It does not launch inference or alter the application's
settings, model residency, worker lifecycle, clipboard or history.

Run the application in the desired state first. Record producing hardware and
runtime provenance, including the optional rewrite model's actual revision in
runtime dependencies or decode settings. Supply the root application PID to
include both speech and rewrite descendants; using a speech-only PID misses a
separate rewrite worker. Collect separate sessions with rewriting unloaded and
loaded, using matching workloads, sampling intervals and steady windows:

```sh
python scripts/sample_process_memory.py --pid 12345 --provenance provenance.json \
  --rewrite-loaded no --duration 60 --steady-after 10 --output-directory speech-only-memory
python scripts/sample_process_memory.py --pid 12345 --provenance provenance.json \
  --rewrite-loaded yes --duration 60 --steady-after 10 --output-directory speech-rewrite-memory
```

PID `12345` is illustrative. The rewrite state is an operator declaration,
not automatically verified. Raw timestamped per-process RSS samples and summary
hashes remain available. Peak is the largest sampled process-tree RSS, not an
instantaneous OS high-water mark; steady resident memory is the mean/median
and range after the explicit steady-window start. Shared pages may be counted
multiple times, short-lived workers may be missed, and accelerator allocations
are not measured. Permission failures stop collection rather than silently
report a partial process tree. Interruptions retain partial evidence and their
termination reason. Repeat independent sessions and retain these raw files with
the benchmark artifact builder; do not equate correlated time samples with
independent benchmark repetitions.

**UNVERIFIED — checks not run per user instruction.** No memory sampler or
native inference was executed, and there are no measured memory results here.

## Experimental MLX conversion gates

`scripts/mlx_conversion_gate.py` evaluates supplied BF16 and quantized R2T2
reports with explicit per-case WER/fidelity and repeated sampled-RSS thresholds.
It does not execute a conversion or enable an app model. Its manifest contains:

- `comparison`: the full comparison manifest described above, with exactly two
  participants: a supported BF16 MLX baseline and an external quantized control.
- `baseline` and `candidate`: those participants' labels.
- `candidate_source_repository`: `netease-youdao/Confucius4-R2T2`, as an explicit
  operator declaration requiring later verification against actual weights.
- `max_case_wer_increase`: maximum absolute WER increase per case, within 0–1.
- `min_sampled_peak_memory_saving_fraction`: required fractional sampled RSS
  savings, greater than zero and less than one.
- `minimum_memory_sessions`: at least two independently collected sessions.
- `baseline_memory` and `candidate_memory`: arrays of memory summary paths.

```sh
python scripts/mlx_conversion_gate.py --manifest conversion-gate.json --output conversion-gate-report.json
```

Precision must identify BF16 for the baseline and 4-/8-bit quantization for the
candidate. Matching reference hashes, normalization, hardware, runtime and
decode settings are required. Each case must meet the WER threshold and retain
exact raw fidelity when the baseline has it. Undefined empty-reference WER
cannot pass automatically. Complete repeated memory sessions must use matching
sampling and rewrite-residency configurations; duplicate summaries are rejected.

A passed supplied-evidence gate remains provisional. Conversion lineage,
native compatibility, independent repetition and metadata correctness require
verification; sampled RSS is not accelerator allocation. The app continues to
offer its existing BF16 R2T2 adapter only. **UNVERIFIED — checks not run per user
instruction**; no conversion, quantized inference or quality evaluation has
been run for this implementation.

## Comparing distinct quality dimensions

`scripts/quality_dimensions.py` compares two or more participants against the
same reference files and human case annotations, preserving provenance and
raw/normalized metrics per case. It adds punctuation-character alignment,
explicit named-entity mention counts, exact numeric lexical forms, nonempty
output on annotated silence, and correction burden. There is no automatic
entity recognizer, spoken-number interpretation or semantic hallucination judge.

```json
{
  "normalization": "wer-basic-v1",
  "cases": [
    {"case_id": "nl-entity-001", "reference": "reference.txt",
     "annotations": {"speech_present": true, "named_entities": ["Amsterdam"]}}
  ],
  "participants": [
    {"label": "R2T2", "provenance": "r2t2-provenance.json",
     "hypotheses": {"nl-entity-001": {"path": "r2t2-hypothesis.txt"}}},
    {"label": "External control", "provenance": "control-provenance.json",
     "hypotheses": {"nl-entity-001": {"path": "control-hypothesis.txt"}}}
  ]
}
```

```sh
python scripts/quality_dimensions.py --manifest quality.json --output quality-report.json
```

All participants must cover exactly the same cases. References and hypotheses
remain untouched. Silence annotations require empty references. Named entities
are exact case-sensitive annotated reference strings; missing, extra and exact
mentions are separate. Numeric comparisons preserve lexical comma/point forms
and do not claim value equivalence. Punctuation sequence distance does not
establish grammatical correctness. Raw character edit distance is only a
correction proxy; optionally supply `measured_correction_seconds` and its
`correction_measurement_method` on each hypothesis to retain human measurements.
Omitted correction time remains unknown. No semantic hallucination rate or
human-effort conclusion is inferred from ordinary insertions.

**UNVERIFIED — checks not run per user instruction**. No native reference
comparison or human correction measurement was performed for this change.
