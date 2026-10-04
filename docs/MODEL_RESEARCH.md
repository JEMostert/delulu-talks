# Speech model choices for Delulu Talks

Reviewed 29 September 2026 using upstream model cards, source, and announcements. There is no measured basis here to replace the user's preferred R2T2 with a universally “better” model. Quality depends on language, microphone, noise, names, and latency/memory constraints. Candidate integration is separate from a supported, tested engine.

## Product decision and research scope

R2T2 is the default speech identity: direct MLX on Apple Silicon and PyTorch/Transformers on Linux and Windows CUDA. Since v0.12.0, NVIDIA Nemotron 3.5 ASR Streaming 0.6B is offered as a light alternative (about 1.3 GB of GPU memory, or CPU; Dutch FLEURS WER 11.5% against 7.9% in English in our quick check), chosen for native word-by-word streaming. Qwen 3.5 remains optional for rewriting. Validate those R2T2 adapters before widening feature claims. Other checkpoints in this document are external research references; they are not available in Models or planned app speech options. Parakeet supplies a smaller Dutch/English comparison, Voxtral supplies a streaming reference, and base Qwen3-ASR-1.7B measures the fine-tune's effect. A recent English-only model does not solve Dutch dictation.

| Candidate                   | Why it is relevant                                                              | Limitation / next check                                                                              | App status                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R2T2, original checkpoint   | User preference; fine-tune of Qwen3-ASR with a stable-prefix streaming protocol | Upstream primarily optimizes Chinese/English; Dutch quality needs matched evaluation                 | Transformers on Linux and Windows since v0.12.0 (vLLM removed); Windows requires native validation |
| R2T2 BF16 MLX conversion    | Preserves the preferred fine-tune on Apple Silicon; about 4.1 GB checkpoint     | Community conversion; verify equivalent behavior, actual memory, decoder output, and Metal execution | Adapter implemented; native validation pending                                                     |
| Parakeet TDT 0.6B v3        | Smaller 600M multilingual model; supports Dutch/English and timestamps          | Performance/quality need the same audio and hardware; it is not a newly discovered successor to R2T2 | External benchmark only                                                                            |
| Qwen3-ASR-1.7B              | Base-model control with Dutch and broad multilingual coverage                   | Different fine-tuning and decoding behavior; does not establish a superiority claim                  | External benchmark only; old 0.6B history identity retained                                        |
| Voxtral Realtime 4B         | Open weights, Dutch/English support, native streaming                           | Larger model and distinct runtime; verify Mac implementation, residency, and streaming tradeoffs     | External benchmark only                                                                            |
| Granite Speech 5.0 TurboCTC | Recent compact English ASR alternative                                          | English-only variant does not cover the Dutch workflow                                               | External English benchmark only                                                                    |

Sources: [R2T2 upstream](https://github.com/netease-youdao/Confucius4-R2T2), [MLX conversion](https://huggingface.co/mlx-community/Confucius4-R2T2-bf16), [NVIDIA Parakeet model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Qwen3-ASR documentation](https://huggingface.co/docs/transformers/main/model_doc/qwen3_asr), [Mistral announcement](https://mistral.ai/news/voxtral-transcribe-2/), and [IBM speech model overview](https://www.ibm.com/granite/docs/models/speech).

## What “streaming” must mean here

R2T2 acoustic streaming uses repeated audio windows, committed text, a delimiter, and token rollback. Upstream exposes configurable chunks and append-only output. Returning generated text tokens from an offline decoding request is not the same protocol. The new MLX adapter performs ordinary buffered generation after capture; it does not yet reproduce the trained streaming loop. [R2T2 upstream implementation](https://github.com/netease-youdao/Confucius4-R2T2) is the reference for that future work.

Mistral's February 2026 announcement distinguishes the open-weight Realtime model from Mini Transcribe V2's API offering. Do not assume an API-only batch model can be installed locally or that its speaker/timestamp features belong to the local streaming model. [Mistral announcement](https://mistral.ai/news/voxtral-transcribe-2/).

## Why direct MLX is plausible

The conversion's architecture is `qwen3_asr`. The pinned [MLX Audio v0.5.7 source](https://github.com/Blaizzy/mlx-audio/tree/v0.5.7) provides `load_model`, strict weight loading, `load_audio` at 16 kHz, and generation with language hints. The adapter loads a pinned local snapshot, warms the decoder, and returns model-reported language where available. This source-level compatibility is a reason to test on Mac, not proof of working inference.

Implementation pins:

- Mac checkpoint: `mlx-community/Confucius4-R2T2-bf16`, revision `747f5fc5f84bc9976baa2f02714e2fed67ed8611`.
- Mac packages: MLX `0.32.2`, MLX Audio `0.5.7`, Transformers `5.15.0`.
- Windows original checkpoint revision: `185ce639118ad1362d049ca0d8ed04b6ec5cd6c9`; native PyTorch/Transformers conversion and validation requirements are recorded in [Windows support](WINDOWS_SUPPORT.md).
- Inspected MLX Audio source commit: `94c7716212b2228f178d2f9c7619a591fd1b0b78`.

Weight licensing remains distinct from the app/code licenses. Link the original [R2T2 model license](https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE) for both original and converted weights; conversion does not change the upstream terms.

## A useful comparison

Collect consented Dutch/English examples spanning short commands, conversational messages, technical terms, names, dates, background noise, and code switching. Preserve reference text and audio outside ordinary app history unless the user opts in.

For each model/backend/revision, use identical files and decode settings where comparable. Report word errors, entity/number mistakes, punctuation, hallucinations on silence, and required corrections. Measure cold load, first warm request, changed-input request, p50/p95 finalization latency, peak memory, and laptop energy. Repeated identical inputs can make caches look like general speed improvements, so include changed audio.

Keep R2T2 as the app speech model. Change its decoding or precision defaults only after real native tests and a documented advantage on this workflow. Roadmap §§07, 13, 20, and 21 contain the implementation/evaluation tasks.
