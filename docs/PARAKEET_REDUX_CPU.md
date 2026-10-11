# Parakeet Redux

Parakeet Redux is a speech engine for Linux x64 that runs on the CPU. It appears
next to R2T2 in Settings → Speech, in Models and in the tray. R2T2 remains the
default engine.

Redux uses Moondream's packed ternary checkpoint of NVIDIA Parakeet TDT v3
(177,774,490 bytes of weights) and Photon's Kestrel 0.9.1 CPU runtime directly.
It does not instantiate the Photon API client or its telemetry reporter.
Attribution: Moondream and NVIDIA Parakeet TDT v3;
[model weights and CC BY 4.0 license](https://huggingface.co/moondream/parakeet-redux).

## Behavior

- **Availability:** offered only where `reduxSupported()` is true (Linux x64). It is not shown on other platforms.
- **Packages:** `kestrel==0.9.1` and `moondream==2.6.1` install into the normal speech runtime (`speech-venv`) beside the R2T2 packages. Existing Linux installs need **Update setup** once.
- **Checkpoint:** the app downloads the checkpoint pinned to revision `2bf128600aac4b16946f7ed8372e56117fe5e23b` on first load and verifies it. It is kept as a resumable verified snapshot in the app's model cache, so later loads run offline.
- **Switching:** R2T2 and Redux switch in the app without a restart.
- **Buffered:** Redux transcribes after capture ends and has no live typing. Dictation is buffered until capture ends, including when an older profile enables live typing.
- **Language:** detected automatically. The decoder does not accept a forced language.
- **Startup:** the worker runs a synthetic speech warmup before it reports the model ready.
- **Capabilities:** the speech worker reports backend `photon-cpu` and model family `redux`.

## Native evidence

Coordinator measurement, 11 October 2026: Intel Core i9-13900K, CachyOS x86_64,
Python 3.11, PyTorch 2.13.0 CUDA build from the normal speech runtime (Redux
runs on the CPU), Kestrel 0.9.1. The repository's 4.59-second `test-audio.m4a`
fixture returned `Hello, how are you?` in approximately 0.1 seconds after a load
and warmup of approximately 2.5 seconds.

Earlier preview validation on an Intel Core i5-7500 (four cores, AVX2), CachyOS
x86_64, Python 3.12.15, Kestrel 0.9.1 and PyTorch 2.14.1+cpu. The machine has an
AMD GPU; CUDA was not used. The same fixture returned `Hello, how are you?` in
approximately 0.37 seconds after loading. Initial load and warmup took
approximately 21 seconds. A locally packaged desktop also passed file-import
transcription and the full recorder-to-transcript flow using a synthetic
microphone stream containing this fixture, reporting Redux / CPU execution
metadata.

These are single-machine fixture results, not a language accuracy benchmark or
validation of pasting into another app.

## Remaining integration work

- Broader CPU and platform validation. Native evidence so far is two single-machine Linux x86_64 measurements.
- Accuracy benchmark: Dutch and English comparison against R2T2 on consented audio, following [Model research](MODEL_RESEARCH.md). Fixture timings are not accuracy results.
- Possible CUDA execution. Kestrel currently runs on the CPU only.
