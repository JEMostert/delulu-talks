# Native inference harness

This is opt-in code for real cached R2T2 inference, not recorded hardware evidence. The shared `NativeInferenceHarness` uses the production worker transport. `scripts/native-inference.mjs` provides a CLI; `scripts/benchmark-speech.mjs` uses the same load/transcribe/cleanup path. Source and unpacked packaged worker scripts can be supplied explicitly.

Run only when the application and other GPU inference are idle, using an existing speech interpreter and already cached weights. The harness never installs runtimes or intentionally downloads models: child processes set offline flags. MLX conversion may populate its conversion cache, so use a copied cache for isolation if the working cache must remain unchanged. Optional Qwen rewriting is a separate runtime and is not invoked here.

```sh
bun scripts/native-inference.mjs --run \
  --python "/existing/speech/runtime/bin/python" \
  --cache "/isolated/copied/models" \
  --audio "/consented/fixture.wav" \
  --language nl --cycles 1 --repeats 3 \
  --output "/new/native-result.json"
```

For Windows, point `--python` to the native runtime's `Scripts/python.exe`. For an unpacked package, add `--worker /package/resources/python/transcription_engine.py`. A package resource run exercises its Python adapters; it does not establish that its Electron application launches or that native installation/replacement works.

The report records actual runtime/package metadata, CUDA device information where available, worker source hashes, source and converted audio hashes, observed R2T2/device identity, load/request timing and unload status. Output is redacted by default: it includes text lengths, not transcript text. `--include-text` explicitly includes supplied fixture transcripts. New report paths are exclusively created with owner file permissions where supported, so prior evidence is not silently replaced.

Audio is converted to mono 16 kHz PCM16 in an owned temporary directory, with bounded conversion time and output duration; source audio remains unchanged. Up to ten load/transcribe/unload cycles and twenty requests per cycle are available. Worker timeouts and bounded shutdown use the production transport. A successful run reports observed inference/unload, not calibrated accuracy, returned GPU memory, native clipboard/paste, package launch or sleep/wake behavior. Those acceptance checks remain separate.

Current implementation is UNVERIFIED. No native invocation, GPU inference, conversion, download, test or build was run while authoring this change.
