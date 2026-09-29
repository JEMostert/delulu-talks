# Windows CUDA support: native R2T2

Current implementation, 29 September 2026. **Native Windows inference has not been validated in this Linux development environment.** Contract tests check conversion, adapter behavior, and failure cleanup; they do not prove CUDA wheel installation or real Windows GPU inference.

## Runtime contract

Windows keeps the original `netease-youdao/Confucius4-R2T2` speech checkpoint, pinned to revision `185ce639118ad1362d049ca0d8ed04b6ec5cd6c9`. R2T2 is the only speech model; optional Qwen 3.5 rewriting remains separate.

The native adapter uses PyTorch CUDA and Transformers' Qwen3-ASR architecture. On the first load it converts the original checkpoint's configuration and weight keys, validates them strictly, and stores a reusable native checkpoint. The original safetensors checkpoint omits a tied output-head alias; the adapter restores that alias from the exact original embedding tensor before strict loading. It does not generate replacement weights. Using the architecture loader does not substitute the base Qwen speech checkpoint. A bounded silence decode warms the model before Ready. Recording is still buffered until Stop. Audio is decoded in segments of at most 30 seconds; exhausted 4,096-token generation budgets fail explicitly instead of returning silently truncated text. Recognition quality at segment boundaries still needs native testing.

The runtime requires Windows x64, an NVIDIA CUDA GPU, compatible drivers, and Python 3.12. It pins `torch==2.13.0+cu130` and `torchvision==0.28.0+cu130` from the official PyTorch CUDA 13.0 wheel index, `transformers==5.15.0`, and `accelerate==1.14.0`, alongside pinned audio, tokenizer, and tensor-loading dependencies in the runtime manifest. Native wheel availability, driver requirements, VRAM recommendations, latency, and recognition quality require recorded hardware validation.

The app does not install vLLM on Windows. [vLLM's installation documentation](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/#requirements) lists Linux as its supported operating system; WSL advice is not native Windows support. Linux keeps its existing vLLM route. See the runtime manifest for the authoritative package list.

## Conversion cache and provenance

The versioned cache lives under `model-cache/delulu-r2t2-transformers/transformers-5.15.0-v1/<checkpoint-revision>` (relative to the configured model-cache root). It stores the original BF16 conversion before the adapter chooses BF16 or FP16 for the actual GPU. A completed cache can be reused offline; staged incomplete conversions are discarded. Allow approximately another 4 GB of disk space in addition to the downloaded original checkpoint, runtime environment, and temporary conversion writes. Exact peak disk/RAM requirements need native measurement.

The extracted upstream conversion helpers retain their copyright notice; [third-party notices and the full Apache-2.0 license](THIRD_PARTY_NOTICES.md) record their source. This code license is separate from the checkpoint weight license.

## Installation and migration

1. Install x64 Python 3.12 and a suitable NVIDIA driver. FFmpeg is needed for compressed audio/video imports.
2. Select the interpreter in Settings → Runtime if discovery chooses another version.
3. Choose Install/Update setup or Repair in Models. Existing speech environments must be repaired to acquire the Windows-specific dependencies.
4. Wait for model load and decoder warmup before recording.

Repair creates a fresh environment generation, validates imports/dependencies, and switches activation transactionally. Failed setup preserves the old selection; failed initial loading rolls back activation. Settings, model cache, and transcript history remain outside the installed application.

## Native acceptance before a support claim

On a real Windows x64 NVIDIA machine, record OS, GPU/VRAM, driver, Python, resolved packages, model revision, and device selection. Verify fresh installation, `pip check`, actual Dutch/English microphone transcription, silence, imports, first conversion and its peak disk/RAM use, offline restart reusing the completed conversion cache, interrupted conversion cleanup, repeated unload/reload, and memory release. Check audio crossing 30-second boundaries for missing, repeated, or incorrectly split words, and verify token-limit exhaustion produces a recoverable error. Compare identical audio against the Linux R2T2 route to detect conversion/decode divergence.

Then validate shortcuts, clipboard/paste into ordinary and elevated applications, Unicode/spaced user paths, interrupted repair rollback, installer upgrade, and preserved historical attribution. Use the existing real-inference runtime and isolated Electron smoke harnesses only after the runtime is installed and weights are cached; close the everyday app first. Publish a new native record before describing this backend as validated.
