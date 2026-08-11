# Delulu Talks

Private, local-first desktop dictation rebuilt on Electron and CrisperWhisper 2.0.

Delulu Talks keeps a fast speech model ready behind a system-wide shortcut, creates a clean intended transcript and an exact verbatim transcript, optionally rewrites the chosen version through local Qwen Magic, then copies or pastes the finished result. Its Magic workspace also turns existing drafts into polished notes, concise messages, structured documents, or detailed prompts. It is designed for Linux/Wayland first while remaining packageable for macOS and Windows.

## Highlights

- Electron main process, sandboxed React renderer, narrow typed preload API, tray, overlay, and direct XDG GlobalShortcuts portal support on Wayland
- All four standard Nyra Labs CrisperWhisper 2.0 checkpoints: Small, Medium, Turbo, and Large
- Medium is the balanced default; **Keep selected model loaded** is enabled by default and can be disabled in Settings
- Local Magic rewrites with official Apache-2.0 Qwen 3.5 checkpoints at 0.8B, 2B, and 4B; the 2B model is the balanced default
- Explicit rewrite boundaries: preserve source facts or allow reviewable assumptions for richer prompts and technical briefs
- Configurable shortcut delivery pipeline: speech → optional Magic preset → clipboard → automatic paste
- Speech and Magic can stay resident together; unpinned models use a configurable 1–60 minute idle-unload delay
- Intended, verbatim, and CT2 dual transcription with conditional long-form continuation and hallucination mitigation
- Non-destructive transcript correction: edit either view for copy/TXT export and restore the untouched model output at any time
- Linux x64 CTranslate2 acceleration, Large + Turbo speculative decoding, and portable Transformers fallback
- Speech Lab for audio/video import, Verbatimize, forced alignment, and word-level timelines
- Private local history, speech-pattern insights, deterministic vocabulary replacements, and TXT/JSON/SRT/VTT export
- Automatic paste where the desktop permits it, with an honest clipboard fallback when Wayland has no input tool
- An app-managed Python environment; Nyra weights download only after explicit acceptance, while optional Apache-2.0 Qwen weights install on demand

The technical design is in [Architecture](docs/ARCHITECTURE.md). The competitor research and product direction are in [Product research](docs/PRODUCT_RESEARCH.md).

## Run locally

Requirements:

- [Bun](https://bun.sh/)
- Python 3.10–3.13 (3.11 or 3.12 recommended)
- FFmpeg for compressed audio or video imports
- On Linux/Wayland, `wtype`, `ydotool`, `dotool`, or `xdotool` for automatic paste; clipboard copy works without them

```bash
bun install
bun run dev
```

For a renderer-only preview with safe demo data:

```bash
bun run dev:web
```

On CachyOS/Arch, the useful system packages are:

```bash
sudo pacman -S ffmpeg wtype
```

On first launch, open **Models & runtime** and choose **Install engine**. A focused modal summarizes the Nyra terms and continues installation after acceptance. The app creates an isolated Python environment inside its application-data directory. On Linux x64, Auto selects Nyra's CTranslate2 backend; other platforms use Transformers. Open **Magic** and choose **Install model** when you want the optional Qwen writing runtime.

## Build and package

```bash
bun run typecheck
bun test
bun run build
python3 -m py_compile electron/python/transcription_engine.py
bun run dist:linux
```

Linux packaging produces AppImage, pacman, and `tar.xz` artifacts. The release workflow builds native Linux, macOS, and Windows packages on version tags.

## Model and code licenses

Delulu Talks is MIT-licensed. CrisperWhisper's inference code is also MIT, but its model weights are separate: the standard 2.0 weights use the Nyra Health Non-Commercial Research License, commercial use requires a license from Nyra, and Pro weights are commercial-only. Delulu Talks does not bundle weights and does not offer Pro downloads. See [Nyra's license explanation](https://github.com/nyrahealth/CrisperWhisper#license) and the [weight license](https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md). The optional [Qwen 3.5 checkpoints](https://huggingface.co/Qwen/Qwen3.5-2B) are Apache-2.0 licensed.

## Privacy and storage

Microphone recordings are written to a temporary WAV only after capture, processed locally, and deleted in a `finally` path after success or failure. Imported media is never modified; temporary FFmpeg conversions are also deleted. Settings, optional transcript history, non-destructive text corrections, the Python environment, and downloaded model cache stay under Electron's platform application-data directory. No telemetry or cloud transcription is implemented.

The old Tauri data directory is detected on Linux so settings and history can migrate forward once. Removed model selections are mapped to CrisperWhisper Medium.

## Project layout

```text
electron/
  main.ts             lifecycle, windows, tray, shortcuts, validated IPC
  preload.ts          isolated renderer API
  services/           ASR lifecycle, dictation, storage, paste, export
  python/             persistent two-model speech + Magic worker
src/
  components/         Electron app shell and recording overlay
  pages/              Dictation, Magic, Speech Lab, History, Wordbook, Models, Settings
  bridge.ts           typed Electron/browser boundary
  recorder.ts         renderer microphone capture and 16 kHz WAV encoder
  data.ts             CrisperWhisper, Qwen, and language catalogs
```

Licensed under the terms in [LICENSE](LICENSE).
