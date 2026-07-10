# Delulu Talks

A private, local-first desktop dictation studio built with Tauri, React, Rust, and current Hugging Face speech models.

## What changed

This release is a ground-up product and interface rebuild. The old wall of model settings has been replaced by four specialist engines, with MOSS remaining the default meeting-first experience:

- **MOSS Transcribe Diarize 0.9B** — speaker-aware meetings, timestamps, acoustic events, and native hotwords.
- **Cohere Transcribe 03-2026** — high-accuracy long-form transcription across 14 languages.
- **NVIDIA Nemotron 3.5 ASR Streaming 0.6B** — lightweight, low-latency multilingual dictation.
- **NVIDIA Parakeet TDT 0.6B v3** — optional high-throughput offline dictation across 25 European languages.

The app now includes:

- Global hold-to-talk or toggle shortcut
- Custom word bank with hotwords, “sounds like” aliases, and text expansions
- Smart output that preserves speaker labels only for multi-speaker audio
- Searchable, private local transcript history
- Reliable clipboard copy with optional automatic paste and a manual `Ctrl+V` fallback
- Isolated local Python environment and guided per-model setup
- One-click Python environment removal and clean model re-bootstrap
- Responsive dashboard, model studio, history, settings, and a compact recording overlay
- Browser-safe development bridge for UI work outside the Tauri shell

## Development

Requirements:

- Bun
- Rust stable
- Python 3.11 or 3.12
- Platform audio development libraries required by CPAL

```bash
bun install
bun run tauri dev
```

The frontend alone can be previewed with demo data:

```bash
bun run dev
```

## Local model setup

Open **Model studio**, select an engine, then choose **Set up selected model**. Delulu Talks creates an isolated Python environment under its application data directory and downloads the selected weights from Hugging Face.

MOSS setup installs the official `MOSS-Transcribe-Diarize` package. Cohere and Nemotron use Transformers 5.4 or newer. A CUDA GPU is recommended for MOSS and Cohere; Nemotron is the lightest option.

If setup becomes damaged or a model dependency changes, open **Settings → Runtime & storage**, choose **Remove Python environment**, then return to Model studio and set up the selected model again. This removes only the app-managed environment; settings, vocabulary, history, and downloaded Hugging Face model caches are preserved.

## Verification

```bash
bun run build
python3 -m py_compile src-tauri/python/transcription_engine.py
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Data and privacy

Recorded audio is written to a temporary WAV file, transcribed locally, and deleted immediately after processing. Settings and optional transcript history remain in the platform application-data folder. The network is only needed for dependency and model downloads.

## Linux notes

The default Tauri command uses XWayland so the recording overlay can remain above other applications and stay positioned just above the desktop application bar:

```bash
bun run tauri dev
```

Audio devices are enumerated lazily when Settings is opened. ALSA may print a JACK or OSS warning while probing system-configured compatibility devices that are not installed; this does not mean the default microphone failed. The single `libayatana-appindicator` deprecation warning comes from Tauri's current Linux tray dependency and does not affect dictation or tray behavior.

Full sidecar diagnostics for the most recent transcription failure are stored as `last-asr-error.log` beside the app settings file. The overlay filters unrelated Hugging Face download warnings so the actionable error remains visible.

## Project layout

```text
src/
  components/       app shell and recording overlay
  pages/            focused product surfaces
  bridge.ts         typed Tauri/browser boundary
  data.ts           model and language catalog
  types.ts          shared frontend domain types
src-tauri/
  python/           four-engine transcription adapter
  src/lib.rs        audio capture, persistence, shortcuts, and commands
```

Licensed under the terms in [LICENSE](LICENSE).
