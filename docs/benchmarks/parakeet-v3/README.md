# Parakeet TDT 0.6B v3 Q8: short dictation

2026-10-29, Ryzen AI 9 HX 370, RTX 5060 Ti 16 GB. Official [NVIDIA model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), revision and verified SHA-256 in source.json. NeMo-Speech.cpp nightly release metadata identifies commit 66d50d91b75a406becd95fbaf39d2c9c13e95d7c (2026-10-28); CPU and Vulkan native binaries. Existing GPU workloads were left running. Nine WAVs are described in manifest.json; synthetic clips and three human utterances are too small to generalize accuracy.

Run each backend sequentially: `nemo-speech bench asr WAV_DIR --model MODEL --device cpu -c 1 -n 3 --warmup 1 --save OUTPUT_DIR --json` (substitute `vulkan:0` for GPU). WAV_DIR contained only the nine manifest WAVs. Raw aggregate metrics and saved transcripts are alongside this file. Load and warmup are separate from per-item latency; they are CLI measurements, not full application startup. Three repeats reported zero transcript mismatches for either backend, and saved CPU and Vulkan transcripts match.

| Backend | Load | Warmup | Mean | p50 | p95 | RTFx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CPU | 31 ms | 513 ms | 218 ms | 172 ms | 380 ms | 22.4 |
| Vulkan | 204 ms | 316 ms | 39 ms | 34 ms | 56 ms | 126.1 |

GPU memory was 11,741 MiB of 16,311 MiB before and after the Vulkan process; transient peak was not sampled. Warmup varies substantially: an earlier overlapping run measured 5.18 s on Vulkan, so these are not reliable cold-start guarantees. Shared machine load and GPU workloads affect timing.

## Case observations

- English short and human quote: words match the references; punctuation/case omitted.
- English code: “Delulu” became “dululu” and “Vulkan” became “vulcan”.
- Dutch short: “Verplaats” became “we plaatst”; “half vier” became “half 4”.
- Dutch code and human-nl-0: words match apart from punctuation/case and spelling normalization of continuümmodel.
- Quiet human-nl-1 and its +20 dB copy: both transcribed, with “Varkens” rendered “vakers”; remaining words match.
- Digital silence: empty output, no false positive. This does not establish behavior on ambient noise.

## Corrected Whisper comparison

The production Whisper engine was rebuilt from current master with the quiet-audio
fix, then run sequentially over the same nine files, three passes. Mean warm
inference was 182.2ms, median 199ms; digital silence is included (0ms fast path).
Raw per-request results are in `whisper-fixed.json`. Parakeet Vulkan's mean of
38.6ms is substantially faster on this sample, but it is not an integrated app
backend and the tiny mixed corpus cannot establish representative accuracy.
Whisper's current engine accepts vocabulary prompts and fixed-language settings;
this comparison used automatic language selection with no vocabulary prompt.

The quiet Dutch clip now transcribes correctly in Whisper at original volume;
before the fix it was discarded. Its louder copy transcribes identically.
`quiet-gate-before.stdout` and `quiet-gate-after.stdout` record that reproduction,
digital silence and two deterministic three-second uniform noise probes (Python
Random seed 19, amplitude ±0.001 / ±0.003, 16kHz PCM16). After lowering the RMS
cutoff from 0.003 to 0.0001, digital silence still skips inference and neither
noise probe produced text. These probes are not a substitute for real ambient
noise recordings.

Recommendation: **Parakeet TDT 0.6B v3 Q8 is the best practical Parakeet candidate
for a future native backend**, but retain Whisper as the app default for this
release. The measured Parakeet output lacks punctuation/capitalization and still
misses names and some Dutch words; integrating it needs deliberate handling of
those differences, vocabulary behavior, language settings and downloads.

These are offline inference measurements, excluding recording, cleanup, pasting
and total dictation latency. Current Whisper loads its model and runs a warmup
before reporting per-request timings; both Parakeet runs do the same.
