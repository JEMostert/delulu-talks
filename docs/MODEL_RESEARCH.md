# Speech model choices for Delulu Talks

Reviewed 18 October 2026. English is the main dictation language; other languages are supported but secondary. The app offers three sizes, so owners of low-end hardware get a usable model and others get the most accurate one.

## Decision: three sizes

| Size   | Model                                                         | English WER   | Dutch WER | CPU speed (Ryzen 4750U) | Download | Runtime                  |
| ------ | ------------------------------------------------------------- | ------------- | --------- | ----------------------- | -------- | ------------------------ |
| Small  | Canary 180M Flash (en, de, fr, es)                            | 5.98%         | —         | ~22× real time          | 200 MB   | sherpa-onnx, CPU, INT8   |
| Medium | Parakeet TDT 0.6B v2 (English) / v3 (25 languages, automatic) | 4.11% / 4.83% | — / 7.66% | ~14× real time          | 630 MB   | sherpa-onnx, CPU, INT8   |
| Large  | R2T2 (fine-tune of Qwen3-ASR-1.7B)                            | 3.23%*        | 7.43%*    | GPU or Apple Silicon    | ~4 GB    | Transformers CUDA or MLX |

WER is FLEURS test at Q8_0 from the [Handy / transcribe.cpp benchmark](https://models.handy.computer/) (English) and its [Dutch table](https://models.handy.computer/languages/nl). *Measured on base Qwen3-ASR-1.7B, not the R2T2 fine-tune. Read speech, not dictation; check on your own audio before changing defaults.

Why these models:

- **Parakeet Redux removed.** It was Parakeet TDT v3 packed to ternary weights. The unpacked v3 is already mid-table (4.83% English); the packing adds error and it ran only on Linux x64.
- **Medium uses v2 for English** because it is more accurate in English than v3 (4.11% vs 4.83%) at the same size and speed. v3 is kept for Automatic, where it detects 25 European languages.
- **Small is Canary 180M** rather than Granite Speech 5.0 470M TurboCTC (4.61%, English only): at 0.47 GB Granite is barely smaller than Medium, while Canary is a clear step down in size and covers four languages.
- **Large stays R2T2**, the most accurate English model in the table that also detects 30 languages.
- **Runtime:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) wheels exist for Linux, Windows and macOS on Python 3.11–3.13 and bundle ONNX Runtime, so Small and Medium need no PyTorch or GPU. The INT8 exports are published by the sherpa-onnx project.

Considered and not adopted now:

- **Parakeet Unified EN 0.6B** (3.99% English): only a NeMo checkpoint; no ONNX export to run without PyTorch.
- **R2T2 at 8-bit** (about 2 GB, could run on strong CPUs): not implemented; Large remains BF16 on GPU or Apple Silicon.
- **TranscribePsy 254M** (Tether, 14 October 2026; 25 European languages, Apache-2.0): candidate replacement for Small once independent results exist ([announcement](https://qvac.tether.io/blog/on-device-speech-recognition-transcribepsy)).
- **Cohere Transcribe 2B**: strong on the English leaderboard, but no automatic language detection and gated downloads.
- **Granite Speech 4.1 2B**: Open ASR Leaderboard leader (5.33% average), but covers six languages and is the same size class as R2T2.
- **Moonshine, Nemotron, Qwen3-ASR-0.6B**: smaller or similar size with clearly worse accuracy (Qwen3-ASR-0.6B: 13.9% Dutch).

Sources: [Canary-1B-v2 & Parakeet-TDT-0.6B-v3 paper](https://arxiv.org/pdf/2509.14128), [Hugging Face Open ASR Leaderboard blog](https://huggingface.co/blog/open-asr-leaderboard), [Cohere Transcribe card](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026), [R2T2 upstream](https://github.com/netease-youdao/Confucius4-R2T2), [MLX conversion](https://huggingface.co/mlx-community/Confucius4-R2T2-bf16).

## What “streaming” must mean here

R2T2 acoustic streaming uses repeated audio windows, committed text, a delimiter, and token rollback. Upstream exposes configurable chunks and append-only output. Returning generated text tokens from an offline decoding request is not the same protocol. The new MLX adapter performs ordinary buffered generation after capture; it does not yet reproduce the trained streaming loop. [R2T2 upstream implementation](https://github.com/netease-youdao/Confucius4-R2T2) is the reference for that future work.

Mistral's February 2026 announcement distinguishes the open-weight Realtime model from Mini Transcribe V2's API offering. Do not assume an API-only batch model can be installed locally or that its speaker/timestamp features belong to the local streaming model. [Mistral announcement](https://mistral.ai/news/voxtral-transcribe-2/).

## Why direct MLX is plausible

The conversion's architecture is `qwen3_asr`. The pinned [MLX Audio v0.5.7 source](https://github.com/Blaizzy/mlx-audio/tree/v0.5.7) provides `load_model`, strict weight loading, `load_audio` at 16 kHz, and generation with language hints. The adapter loads a pinned local snapshot, warms the decoder, and returns model-reported language where available. This source-level compatibility is a reason to test on Mac, not proof of working inference.

Implementation pins:

- Mac checkpoint: `mlx-community/Confucius4-R2T2-bf16`, revision `747f5fc5f84bc9976baa2f02714e2fed67ed8611`.
- Mac packages: MLX `0.32.2`, MLX Audio `0.5.7`, Transformers `5.15.0`.
- Linux CUDA original checkpoint revision: `185ce639118ad1362d049ca0d8ed04b6ec5cd6c9`, loaded through PyTorch/Transformers.
- Inspected MLX Audio source commit: `94c7716212b2228f178d2f9c7619a591fd1b0b78`.

Weight licensing remains distinct from the app/code licenses. Link the original [R2T2 model license](https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE) for both original and converted weights; conversion does not change the upstream terms.

## A useful comparison

Collect consented Dutch/English examples spanning short commands, conversational messages, technical terms, names, dates, background noise, and code switching. Preserve reference text and audio outside ordinary app history unless the user opts in.

For each model/backend/revision, use identical files and decode settings where comparable. Report word errors, entity/number mistakes, punctuation, hallucinations on silence, and required corrections. Measure cold load, first warm request, changed-input request, p50/p95 finalization latency, peak memory, and laptop energy. Repeated identical inputs can make caches look like general speed improvements, so include changed audio.

Keep R2T2 as the Large model. Change its decoding or precision defaults only after real native tests and a documented advantage on this workflow. Roadmap §§07, 13, 20, and 21 contain the implementation/evaluation tasks.
