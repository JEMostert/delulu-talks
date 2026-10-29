# Nemotron 3.5 Transcribe vs the current Whisper engine

Measured locally on 2026-10-29. Recommendation: retain Whisper large-v3-turbo
Q5_0 for this app on this machine. Nemotron runs locally at 4 bits, but the
available CPU path is too slow for the current dictation experience, and this
small corpus did not show a consistent transcription advantage.

## What ran

- Pre-fix app: existing `target/debug/examples/bench`, calling the production
  `delulu_stt::Engine`, large-v3-turbo Q5_0, Vulkan on RTX 5060 Ti 16GB.
- Candidate: **AtomicChat AD-IQ4_NL**, not NVIDIA NVFP4; 19,678,656,672-byte decoder
  plus 1,670,410,080-byte F16 encoder (21.35GB decimal together). Both SHA-256
  hashes matched Hugging Face LFS metadata. This is one particular 4-bit
  conversion, so results do not establish the behavior of other quantizations.
- NeMo-Speech.cpp nightly release from 2026-10-28, source commit
  `66d50d91b75a406becd95fbaf39d2c9c13e95d7c`, CPU, eight threads, one sequence,
  4096 context, 512 batch, MTP disabled, 256 output tokens maximum.
- Ryzen AI 9 HX 370, 96GB nominal RAM. GPU had 11,741MiB occupied before testing,
  principally by an existing Comfy process; it was left running.
- No transcript cleanup, no language hints in the main comparison. Both engines
  loaded once and warmed before two sequential passes over the same nine files.
- Follow-up: five Dutch files, one measured pass with `--language nl`.

The candidate files exceed even the GPU's total memory. The inspected SALM
runtime sets `n_gpu_layers` to either 999 or 0 in
`src/speechlm/salm_engine.cpp:425`; it does not expose a partial-offload setting
in this path. CPU inference was therefore tested. **These are practical local
backend results, not a same-GPU model speed comparison.**

## Measurements

| Measurement | Whisper Q5 / Vulkan | Nemotron IQ4 / CPU |
|---|---:|---:|
| Warm median, all nine cases, two passes | 201.5ms | 2809.9ms |
| Maximum warm request | 249ms | 3938.6ms |
| Candidate model load | not separately measured | 11.38s |

The median includes digital silence and the quiet clip that Whisper's app-level
silence gate rejects. Whisper's median over requests actually sent to the model
was 205.5ms. Whisper timing is the production transcription call; NeMo timing is
the benchmark's in-memory recognition request. Neither includes microphone
capture, text cleanup, or pasting into another app. NeMo's measured corpus ran
in 47.14 seconds for two passes; transcripts were stable between passes.

## Transcription observations

- Human English (JFK sample): both matched the reference words.
- Human Dutch FLEURS row 0: both captured the sentence, with differences around
  the year and `continuümmodel`. Nemotron writes the year in words; the simple
  scoring helper does not normalize number words to digits.
- Human Dutch FLEURS row 1: Nemotron transcribed the original quiet recording
  correctly. The pre-fix app returned empty text: RMS 0.002954 is below its
  0.003 gate, so Whisper inference never ran. The v1.1.2 fix is evaluated separately in `../parakeet-v3/README.md`. After multiplying amplitude by ten
  (+20dB), **both matched the reference words**. This is an audio-gate finding,
  not evidence that Whisper cannot recognize the recording.
- Synthetic English technical vocabulary: Whisper wrote `poll request` and
  `Vulcan`; Nemotron wrote `pull request`, `the Lulu talks`, and `Vulcan`.
  Neither consistently won on names.
- Synthetic Dutch, short: Whisper selected German. Nemotron produced English
  nonsense without a hint; with Dutch selected it produced
  `We plaatsen de verjaardag van de dag om half vier.` instead of
  `Verplaats de vergadering naar donderdag om half vier.`
- Synthetic Dutch, longer: Whisper made one word substitution. Nemotron produced
  English without a hint. The Dutch hint restored Dutch but still changed the
  instruction about saving changes into an instruction about starting measurements.
- Digital silence: both returned empty text.

Only two unique human Dutch clips, one human English clip, four synthetic clips,
one louder duplicate, and silence were tested: 43.81 seconds total. This cannot
establish representative WER, accent robustness, or performance on the user's
microphone. Per-case word-error counts in `summary.json` are exploratory edit
distances after Unicode normalization, lowercasing and punctuation removal,
not official Whisper benchmark normalization or a leaderboard comparison.

## Evidence and reproduction

`manifest.json` contains references and provenance. `summary.json` preserves both
engines' transcripts, including the Dutch-hint follow-up. `whisper.stdout`,
`nemo.json`, and `nemo-dutch-hint.json` contain raw measurements. This NeMo build
reports corpus-wide latency only; per-case candidate latency is left null.

Local fixtures are retained at `~/.cache/delulu-nemotron-eval/corpus/`, weights at
`~/.cache/delulu-nemotron-eval/models/`. The downloaded runtime is currently at
`/tmp/delulu-nemotron-eval/runtime/nemo-speech-nightly-linux-x86_64-cpu/`.
No application backend or default was changed.

```sh
python scripts/compare-stt.py \
  --corpus "$HOME/.cache/delulu-nemotron-eval/corpus" \
  --whisper target/debug/examples/bench \
  --nemo /tmp/delulu-nemotron-eval/runtime/nemo-speech-nightly-linux-x86_64-cpu/bin/nemo-speech \
  --model "$HOME/.cache/delulu-nemotron-eval/models/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-AD-IQ4_NL.gguf" \
  --output /tmp/delulu-nemotron-rerun --repetitions 2
```

Synthetic inputs were generated with `espeak-ng -v en-us` / `-v nl`, speed 160,
using the manifest reference, then converted with ffmpeg to 16kHz mono PCM16.
Human Dutch inputs are `google/fleurs`, config `nl_nl`, test rows 0 and 1,
dataset IDs 1927 and 1762. Human English is the bundled
`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav` sample.

Sources:

- [NVIDIA model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B)
- [Tested GGUF conversion and runtime instructions](https://huggingface.co/AtomicChat/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-GGUF)
- [Official runtime configuration](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/66d50d91b75a406becd95fbaf39d2c9c13e95d7c/docs/salm/configuration.md)
- [Runtime language-hint behavior](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/66d50d91b75a406becd95fbaf39d2c9c13e95d7c/docs/salm/transcripts.md)
- [FLEURS dataset](https://huggingface.co/datasets/google/fleurs)
