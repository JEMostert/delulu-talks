# Mac support: keep R2T2, use MLX

Current implementation, 29 September 2026. **Native R2T2 inference has not been validated in this Linux development environment.** Installation and decoder contract tests use substitutes for unavailable Apple libraries. They prove adapter behavior, not Metal execution, actual recognition quality, or Mac permission/paste behavior.

## What changed

The previous Mac route substituted Qwen3-ASR-0.6B and served it through vLLM Metal. The new route selects `r2t2Mlx` on native Apple Silicon, loads the R2T2 BF16 MLX conversion directly, and keeps R2T2 on Linux vLLM CUDA and Windows native PyTorch CUDA. CUDA is NVIDIA's backend; its absence on a Mac does not mean the underlying Qwen-derived weights cannot run through another implementation.

The checkpoint is [`mlx-community/Confucius4-R2T2-bf16`](https://huggingface.co/mlx-community/Confucius4-R2T2-bf16), pinned to revision `747f5fc5f84bc9976baa2f02714e2fed67ed8611`. It is an unquantized conversion of the user's preferred fine-tune. The download is approximately 4.1 GB; inference and runtime installation require additional memory/disk space. No local HTTP service is needed.

The runtime pins `mlx==0.32.2`, `mlx-audio[stt]==0.5.7`, and `transformers==5.15.0`. The loader API was inspected at MLX Audio tag `v0.5.7`, commit `94c7716212b2228f178d2f9c7619a591fd1b0b78`. [MLX Audio source](https://github.com/Blaizzy/mlx-audio/tree/v0.5.7) supplies the Qwen3-ASR architecture loader and local audio decoding.

Requirements remain macOS 15+ and native arm64 Python 3.12. Intel Macs and Rosetta Python are unsupported in this setup. A tested memory recommendation still needs native measurement. Speech remains buffered until recording stops; installing a streaming-capable checkpoint does not implement R2T2's stable-prefix streaming loop. The adapter requests 30-second chunks from MLX Audio; upstream silence-based splitting can vary their duration. A global 4,096-token guard rejects partial long transcripts rather than presenting truncated output as complete.

A static checkpoint audit matched all 707 stored BF16 tensor keys/shapes to the pinned MLX loader. This is actual file/architecture evidence, but it does not exercise Metal inference, decoder output, or native memory behavior.

## Installation and migration

1. Install native Python 3.12, for example `brew install python@3.12`, and FFmpeg for formats requiring conversion.
2. If discovery picks another Python, set the native interpreter's absolute path in Settings → Runtime.
3. Open Models and choose Install/Update setup or Repair for the speech runtime. Existing vLLM Metal environments do not contain the new MLX Audio dependencies.
4. Let checkpoint loading and synthetic decoder warmup finish before recording. Choose Dutch or English explicitly when appropriate.
5. Check Microphone permission for recording and Accessibility permission if automatic paste fails.

Runtime repair creates a new generation and preserves the previous activation until validation. Settings, cached models, and history remain outside the app bundle. Old Qwen history entries retain their model attribution; active speech settings migrate to R2T2 MLX. Existing files are never relabeled as R2T2 results.

A corrupted settings/history file now stops loading with an explicit preserved-file error. Restore a known valid backup or repair the JSON before reopening; do not delete personal data as an installation workaround.

## Native release acceptance

The historical [v0.9.4 validation](mac-release-validation.md) concerns the previous Qwen/vLLM Metal route. Its successful inference does **not** validate this adapter.

| Evidence                                      | What it establishes                                                                                                   | What remains unverified                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Historical Qwen3-ASR-0.6B / vLLM Metal record | The older backend executed fixture inference and package replacement on its recorded Mac                              | Current R2T2 checkpoint, direct MLX Audio loader, current decoder and memory behavior     |
| Current dependency-free contracts             | R2T2 routing, language hints, chunk/token guards, failure cleanup and source preservation with synthetic dependencies | Native Metal execution, recognition quality and actual allocator release                  |
| Recorded BF16 key/shape audit                 | Checkpoint layout matched the pinned loader                                                                           | Loading/warmup/inference on an actual Apple Silicon machine                               |
| Package check without runtime                 | Package replacement, persistent fixtures and manual-update guidance                                                   | Speech inference, live microphone, Accessibility and focus/paste into another application |

No tested RAM minimum, sustained latency target or thermal budget is established for this R2T2 route. Chunk requests and token guards bound the adapter's behavior but are not measurements of peak memory or recognition quality. R2T2-only speech selection does not remove optional Qwen 3.5 rewriting; it uses its separate Python environment and may compete for the same physical memory.

On a real Apple Silicon Mac:

1. Verify clean runtime installation and `pip check`; record OS, chip, RAM, Python, and package versions.
2. Transcribe consented Dutch and English microphone audio, silence, and the repository fixture.
3. Verify WAV/FLAC/MP3/M4A imports, language hints, timing, repeated unload/reload, and memory reclamation. Test words spanning chunk boundaries, silence-based splits, and the recoverable error when long audio exhausts the global token budget.
4. Restart offline with cached weights and prove transcription still works.
5. Upgrade an existing Mac profile and verify settings, historical attribution, corrections, and failure rollback.
6. Exercise permission denial/re-grant, shortcut behavior, sleep/wake, and paste into actual applications.
7. Build the package and run the isolated package replacement check. Record native evidence in a new document before publishing this backend as validated.

After Models finishes setup, use the active speech generation’s Python and already-cached weights with the [native inference harness](NATIVE_HARNESS.md). The previous desktop/package smoke test commands were removed from the focused test suite. Record actual hardware, checkpoint/runtime revisions, permission behavior, microphone recognition and delivery into applications separately; passing unit/browser tests does not establish native inference.
