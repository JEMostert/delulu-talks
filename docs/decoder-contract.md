# Installed audio decoder contracts

Run the opt-in suite with a speech runtime's Python, or an isolated environment
containing the decoder packages pinned in `electron/runtime/manifest.ts`:

```sh
/path/to/speech-venv/bin/python scripts/decoder-contract.py --backend linux
/path/to/speech-venv/bin/python scripts/decoder-contract.py --backend windows
/path/to/mac-speech-venv/bin/python scripts/decoder-contract.py --backend mlx
```

The Windows decoder path can be checked on Linux because this test never calls
CUDA or constructs a model. That result establishes its decoder behavior on
Linux; it is not a native Windows result. The MLX path requires Apple Silicon
and its installed MLX Audio runtime. Missing packages or unsupported codecs fail
explicitly. The suite installs nothing and downloads no models.

Fixtures are generated in a disposable directory: mono and stereo PCM WAV,
44.1/48/11.025 kHz inputs, stereo FLAC and Ogg Vorbis, corrupt data, a valid
zero-frame WAV, and a nonexistent file. It calls the actual adapter's
`transcribe` method with only recognition replaced by a PCM recorder. Installed
decoders, stereo mixing and resampling run normally. Checks cover finite mono
float32 output, waveform values, frame counts and duration, rejected inputs
never reaching recognition, and byte-for-byte source preservation. The waveform
comparison ignores 20 ms at each boundary for resampler transients; its maximum
interior tolerance is 0.003, including the lossy Ogg fixture. Generated fixtures
contain no speech or personal data.

Successful output is JSON labeled `installed-decoder-with-inference-stub` with
`nativeInference: false`, OS/Python/package versions, and each completed case.
Failures exit nonzero and report their cause. Decoder fallback warnings on
stderr are expected for deliberately corrupt media. This suite proves neither
recognition accuracy nor GPU execution, packaging, or manual desktop behavior.
Ordinary dependency-free unit tests do not run this suite implicitly.

Implementation evidence for issue #258: all ten contracts passed for both the
Linux Worker decode path and the Windows adapter decode path on Linux using an
isolated Python 3.11 environment with NumPy 2.3.5, SoundFile 0.13.1, soxr 1.0.0,
and librosa 0.11.0. The same Windows path also passed on Python 3.14. These runs
used real installed decoders and stubbed recognition. Mac MLX and native
Windows execution remain unverified; use the commands above on those machines.
