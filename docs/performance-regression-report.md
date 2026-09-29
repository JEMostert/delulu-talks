# Speech performance regression report

The benchmark keeps original and changed audio as separate inputs. The changed input prepends 300 ms of silence; both are converted to mono 16 kHz WAV, hashed and required to differ. Each repeat measures original then changed input; first request, repeated original, changed-input requests and model load/warmup remain separate. Same-file repetition may benefit from backend caching, so it cannot stand in for new dictation latency.

For later authorized native benchmarking with existing cached weights:

```sh
bun scripts/benchmark-speech.mjs /path/to/profile fixture.wav 10 > current.jsonl
node scripts/report-speech-performance.mjs current.jsonl baseline.jsonl > regression.json
```

The report command is offline and never runs inference. It requires complete finite measurements, distinct input hashes and unique numbered samples. It retains raw timing rows, repeat counts and nearest-rank p50/p95. Regression ratios require matching reported host hardware, language and both input hashes; use changed-input ratios when evaluating optimizations. Runtime/model revisions and GPU identity should accompany these artifacts separately: the script does not infer them from the CPU or claim matched quality. Silence prepending changes bytes but is not a substitute for a corpus of different speech content.

Low run counts, fixed input ordering and concurrent load limit confidence. The first request follows model warmup, so it is not a cold uninitialized inference measurement. No automatic accuracy or performance gate changes app defaults.

UNVERIFIED — no benchmark, native inference, tests, builds, typechecks or formatting checks were run per instruction. The report and benchmark changes require later verification.
