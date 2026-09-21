# Apple Silicon validation — v0.9.4

Validated on an arm64 Mac running macOS 26.6.2 on 2026-09-21. Mac support requires macOS 15+ and native arm64 Python 3.12. CUDA retains the existing R2T2 engine.

## Results

- Fresh isolated runtime installation through the application's `RuntimeInstaller`: Python 3.12.14, matched vLLM 0.29.0 CPU/arm64 and vLLM Metal 0.29.0 STT wheels. `pip check`, native imports, and actual MLX inference passed.
- Dutch and English WAV fixtures synthesized with the Mac's Xander and Daniel voices transcribed correctly. The repository's `test-audio.m4a`, converted to PCM WAV, returned “Hello, how are you?”. These are fixture tests, not a live user microphone session.
- Dutch: “Goedemorgen, dit is een test van Nederlandse spraakherkenning. De vergadering begint morgen om 9 uur.” English: “Good morning. This is a test of English speech recognition. The meeting starts tomorrow at 9 o'clock.” Warm inference was under one second for these short clips; this is not a general performance guarantee.
- Worker stop/restart and repeated unload/load/transcribe cycles passed. The packaged Electron app passed three cycles using the real model, plus session history, transcript correction, JSON export, and deletion checks.
- Simulated interrupted package downloads preserve the previous environment and succeed on retry. Incompatible Python is rejected before package download. HTTP failures and malformed responses produce errors. Model download/loading must complete a real warmup before reporting Ready.
- 83 Bun unit tests, 3 Python contract tests, 14 Playwright browser tests, TypeScript checks, formatting, and production build passed locally.
- ARM64 DMG and ZIP built. Packaged app replacement/relaunch preserves settings, history model attribution, corrections, and cached runtime. The Models page selects Qwen3-ASR and language settings show automatic detection.

## Compatibility boundaries

The pinned vLLM Qwen endpoint rejects `verbose_json`; Delulu requests `json`. Qwen automatically recognizes language, but this response omits the language tag. Delulu returns `und` instead of copying a potentially incorrect configured language. Duration is measured from the WAV, and processing/inference time is measured locally.

This hobby release is **not Developer ID signed or notarized**. Mac automatic update installation is disabled and the app explains the manual procedure: download the DMG, quit Delulu, replace the app, and reopen. Tests cover package replacement and relaunch, not a signed updater transition. Settings, models, and history live outside the app bundle.

Live microphone permission and pasting into other Mac applications still depend on the user's Microphone and Accessibility permissions. The shared correction/clipboard/paste pipeline has automated tests, but this validation did not type into the user's other applications. NVIDIA hardware was not available on this Mac; CUDA behavior has regression coverage, not a new hardware inference run.

## Reproduce

After installing the speech engine in Models, build the app:

```sh
bun install --frozen-lockfile
bun run build
CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --mac dmg zip --arm64 --publish never
```

Use an absolute `DATA_DIR` pointing to an existing Delulu data directory containing `speech-venv` and `models`. These checks use temporary profiles and link the runtime/cache; they do not edit the original settings or history.

```sh
node scripts/desktop-smoke.mjs "$DATA_DIR" --lifecycle
DELULU_TEST_EXECUTABLE="$PWD/release/mac-arm64/Delulu Talks.app/Contents/MacOS/Delulu Talks" node scripts/desktop-smoke.mjs "$DATA_DIR" --lifecycle
node scripts/mac-package-smoke.mjs "release/mac-arm64/Delulu Talks.app" "$DATA_DIR"
python3 -m unittest discover -s electron/python -p '*_test.py'
```

Without the optional data-directory argument, the package replacement check verifies first-run migration, persistent state, platform UI, and manual update guidance without downloading a model. The release workflow runs this check on its Mac runner.
