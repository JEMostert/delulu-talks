# Parakeet Redux CPU adapter (experimental)

This prototype adds an opt-in Parakeet Redux engine for Linux CPU dictation.
The default speech engine remains R2T2. Redux uses the original packed ternary
Moondream checkpoint (177,774,490 bytes of weights) and Photon's Kestrel CPU
runtime directly. It does not instantiate the Photon API client or its
telemetry reporter. Attribution: Moondream and NVIDIA Parakeet TDT v3;
[model weights and CC BY 4.0 license](https://huggingface.co/moondream/parakeet-redux).

## Current setup boundary

Launch with `DELULU_REDUX_CPU=1`, then select **Parakeet Redux** in Models or
Settings. The option is hidden in normal launches and on unsupported platforms; this preview supports Linux x64 only. Other engines require restarting without the flag. This flag selects CPU-only speech dependency installation and
capability negotiation. Its dependencies use a separate `speech-redux-venv` cache so installing the preview does not replace the normal speech runtime. Redux detects the spoken language automatically;
its decoder does not accept a forced language. Dictation is buffered until
capture ends, including when an older profile enables live typing.

Model download is not yet integrated into the app. Prepare the immutable
checkpoint separately, using the Python environment's `huggingface_hub`:

```python
from pathlib import Path
from huggingface_hub import snapshot_download

revision = "2bf128600aac4b16946f7ed8372e56117fe5e23b"
directory = Path.home() / ".local/share/models/parakeet-redux"
snapshot_download(
    repo_id="moondream/parakeet-redux",
    revision=revision,
    local_dir=directory,
    allow_patterns=["config.json", "tokenizer.json", "ternary.json", "model.safetensors"],
)
(directory / "revision.txt").write_text(revision + "\n")
```

Set `DELULU_REDUX_MODEL_DIR` to use a different local checkpoint directory.
The adapter checks the revision marker and required files. Once the model is
prepared, inference uses only local files. Startup performs a synthetic speech
warmup before reporting the model ready.

## Native evidence

Validated on an Intel Core i5-7500 (four cores, AVX2), CachyOS x86_64,
Python 3.12.15, Kestrel 0.9.1 and PyTorch 2.14.1+cpu. The machine has an AMD
GPU; CUDA was not used.

The repository's 4.59-second `test-audio.m4a` fixture returned
`Hello, how are you?` in approximately 0.37 seconds after loading. Initial
load and warmup took approximately 21 seconds. A locally packaged desktop
also passed file-import transcription and the full recorder-to-transcript
flow using a synthetic microphone stream containing this fixture, reporting
Redux / CPU execution metadata. These are single-machine fixture results,
not a language accuracy benchmark or validation of pasting into another app.

## Remaining integration work

- Remove the environment flag requirement and negotiate/install by selected engine.
- Integrate checkpoint download, progress, integrity checks and cache management.
- Complete automatic-language messaging in remaining controls and diagnostics.
- Add in-app engine switching; the preview currently uses an isolated runtime and requires a restart to return to CUDA engines.
- Validate supported CPU architectures and platforms; current native evidence is Linux x86_64 only.
