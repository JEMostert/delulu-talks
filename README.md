<div align="center">
  <img src="build/icon.png" width="150" alt="Delulu Talks logo" />
  <h1>Delulu Talks</h1>
  <p><strong>Hold. Speak. Release. Your words land polished wherever you are typing.</strong></p>
  <p>
    <a href="https://github.com/JEMostert/delulu-talks/releases/latest"><img src="https://img.shields.io/github/v/release/JEMostert/delulu-talks?style=for-the-badge&amp;label=release&amp;color=087fbe&amp;labelColor=171914" alt="Latest release" /></a>
    <img src="https://img.shields.io/badge/Linux%20%C2%B7%20Windows%20%C2%B7%20macOS-Desktop-087fbe?style=for-the-badge&amp;labelColor=171914" alt="Linux, Windows, and macOS" />
    <img src="https://img.shields.io/badge/AI-local--first-087fbe?style=for-the-badge&amp;labelColor=171914" alt="Local-first AI" />
  </p>
  <p>
    <a href="https://github.com/JEMostert/delulu-talks/releases/latest"><strong>Download the latest release</strong></a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a> ·
    <a href="docs/PRODUCT_RESEARCH.md">Product research</a>
  </p>
</div>

---

Delulu Talks is private desktop dictation built around one system-wide shortcut. It keeps a fast speech model ready, understands both what you meant and exactly what you said, and can pass the result through a local Qwen model before delivering it to the app you were already using.

## One shortcut. The complete pipeline.

```text
Hold Meta + Z
          │
          ▼
     speak naturally
          │
          ▼
  CrisperWhisper 2.0 ──► intended + verbatim transcripts
          │
          ├── Magic disabled ──────────────────────────┐
          │                                            │
          └── Magic enabled ──► local Qwen rewrite ───┤
                                                       ▼
                                              clipboard + paste
```

Release the shortcut and Delulu Talks finishes the job. The native recording pill stays above your apps without stealing pointer or keyboard input, and automatic paste falls back honestly to the clipboard when the desktop blocks synthetic input.

## What it brings

| Feature | What it does |
| --- | --- |
| **System dictation** | Hold-to-talk by default, optional press-to-toggle, tray controls, and desktop-owned shortcut remapping. |
| **Two transcripts** | Native clean dictation by default. Optionally keep both clean and verbatim transcripts; originals remain available beside edits. |
| **Magic rewrites** | Optional local transformations with preview, apply and undo beside each transcript. Automatic rewriting is off by default. |
| **Native Wayland experience** | Uses XDG GlobalShortcuts, secure Remote Desktop paste, and a click-through layer-shell recording pill on supported desktops. |
| **Speech Lab** | Imports audio or video for transcription, Verbatimize, forced alignment, word timelines, and SRT/VTT export. |
| **Local by design** | Runs speech and writing models on your machine. There is no telemetry or cloud transcription. |

### Corrections and text shortcuts

Open **Settings → Personalization** or the shortcut on Controls. Corrections replace specific recognized text; text shortcuts expand a spoken trigger into an exact saved block. Each rule has a live text preview and conflicting triggers are rejected. Editing a transcript can suggest a correction to remember, with explicit confirmation.

Speech output and timing stay untouched. Personalization creates a separate result, and exact shortcut blocks stay outside the writing model; only the surrounding text is rewritten. Failed automatic rewriting delivers the preserved transcript instead. Subtitle exports use original speech timing.

Upgrading from an older release turns automatic rewriting and writing-model preloading off once, because earlier defaults did not establish an explicit choice. You can enable either independently afterward. Existing history and rules are retained. Old spelling-only entries are marked as needing a recognized phrase; historical transcripts cannot recover speech text already replaced by an older version.

## Controls on launch

Version 0.7 opens directly into the dictation controls. Microphone, language, shortcut, model, transcript mode, writing style and delivery switches are immediately accessible. A latest-output inspector provides Delivered/Clean/Verbatim views, correction and export beside the controls.

The interface uses ocean-blue and navy panels with light/dark/system themes. Settings is at the top of navigation. Writing, file transcription, model management, history and personalization share the same compact visual system. The application icon is a new wave-shaped D.

- **Configure quickly:** priority controls fit above the fold in compact desktop windows.
- **Recover results:** paste the latest transcript, retry failed audio from memory, or discard it explicitly.
- **Preserve originals:** corrections stay separate from clean/verbatim model output and optional rewrites.
- **Manage locally:** Settings → Runtime covers memory and backend choices; Settings → Application covers appearance and app updates.

## Pick the right-sized brain

Speech and Magic can stay loaded together. Pin the models you use every day, or let Delulu Talks unload them after a configurable idle period.

| Runtime | Available models | Good for |
| --- | --- | --- |
| **CrisperWhisper 2.0** | Small · Medium · Turbo · Large | Fast dictation through maximum transcription quality. Medium is the balanced default. |
| **Qwen 3.5 Magic** | 0.8B · 2B · 4B | Lightweight cleanup through richer prompt and technical-context enhancement. 2B is the balanced default. |

On Linux x64, Auto uses the accelerated CTranslate2 backend and supports Large + Turbo speculative decoding. Other platforms use the portable Transformers runtime.

## Install

Download the package for your platform from [GitHub Releases](https://github.com/JEMostert/delulu-talks/releases/latest).

### Linux

Run the AppImage directly:

```bash
chmod +x Delulu-Talks-*-linux-x86_64.AppImage
./Delulu-Talks-*-linux-x86_64.AppImage
```

Arch and CachyOS users can install the pacman package instead. A portable `tar.xz` is also included. Linux/Wayland is the primary and most thoroughly exercised platform.

### Windows and macOS

Use the Windows installer or the macOS DMG from the same release page. Current packages are not code-signed, so the operating system may ask you to confirm the first launch.

Supported installed packages check GitHub Releases for updates. Downloads are explicit, progress is visible, and restart waits until recording, inference, and setup are idle. Linux automatic updates use AppImage; pacman and portable packages link to manual downloads.

## Your first minute

1. Start Delulu Talks and work through the short setup intro.
2. Choose **Install engine**. A focused modal explains the Nyra model license and records acceptance before downloading anything.
3. Focus any text field, hold the <kbd>Windows</kbd>/<kbd>Meta</kbd> key + <kbd>Z</kbd>, speak, then release.
4. Dictate immediately with native clean output. Optionally open **Writing** to install Qwen, then use **Rewrite** beside any result. Automatic rewriting is a separate opt-in setting.

The app manages its own isolated Python environment and model cache inside the platform application-data directory. Setup uses versioned dependency specifications, checks package compatibility, and records installed versions. Models → device health check reports Python, FFmpeg, memory, and runtime details; Settings → Application offers repair and update controls.

## Run from source

You will need [Bun](https://bun.sh/), Python 3.11–3.13 (3.11 or 3.12 recommended), and FFmpeg for compressed audio or video imports.

```bash
bun install
bun run dev
```

For a renderer-only preview with safe demo data:

```bash
bun run dev:web
```

On Arch-based Wayland systems, install the native overlay dependencies with:

```bash
sudo pacman -S ffmpeg gtk4-layer-shell python-gobject python-cairo
```

## How it fits together

```text
Electron main process
├── lifecycle, tray, updater, global shortcuts, validated IPC
├── native Wayland overlay + secure paste services
├── persistent Python worker
│   ├── CrisperWhisper speech runtime
│   └── Qwen Magic runtime
└── sandboxed React renderer
    ├── Dictation + Magic
    ├── Audio files + History + Personalization
    └── Models + Settings + onboarding
```

<details>
<summary><strong>Build and package</strong></summary>

```bash
bun run typecheck
bun test
bun run test:e2e
bun run test:desktop
bun run build
python3 -m py_compile electron/python/transcription_engine.py
bun run dist:linux
```

Linux packaging produces AppImage, pacman, and `tar.xz` artifacts. The release workflow verifies browser and isolated desktop workflows, then builds native Linux, macOS, and Windows packages on version tags. A tag must match the package version before it can publish.

</details>

<details>
<summary><strong>Repository map</strong></summary>

```text
electron/
  main.ts             lifecycle, windows, tray, shortcuts, validated IPC
  preload.ts          isolated renderer API
  services/           ASR, dictation, overlay, shortcuts, storage, paste, export
  overlay/            GTK4 layer-shell recording pill helper
  python/             persistent speech + Magic worker
src/
  components/         Electron app shell components
  pages/              Dictation, Magic, Speech Lab, History, Models, Settings
  bridge.ts           typed Electron/browser boundary
  recorder.ts         microphone capture and 16 kHz WAV encoder
  data.ts             CrisperWhisper, Qwen, and language catalogs
```

</details>

## Privacy and licenses

Microphone recordings are written to a temporary WAV only after capture, processed locally, and deleted after success or failure. Failed captures can remain in memory for Retry during the session; Discard releases them, and closing the app loses that recovery copy. Imported media is never modified; temporary FFmpeg conversions are deleted too. Settings, optional transcript history, corrections, the Python environment, and downloaded models stay under Electron's application-data directory.

Delulu Talks is [MIT licensed](LICENSE). CrisperWhisper inference code is MIT, while its standard 2.0 weights use the Nyra Health Non-Commercial Research License; commercial use requires a separate Nyra license. Delulu Talks does not bundle weights or offer Pro downloads. Read [Nyra's license explanation](https://github.com/nyrahealth/CrisperWhisper#license) and the [weight license](https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md). Optional [Qwen 3.5 checkpoints](https://huggingface.co/Qwen/Qwen3.5-2B) are Apache-2.0 licensed.

<div align="center">
  <strong>Your voice stays yours.</strong>
</div>

## Development checks

```bash
bun run format:check
bun run typecheck
bun test
bunx playwright install chromium
bun run test:e2e
bun run test:desktop
```

The desktop smoke check uses temporary user data and skips global desktop integration. For opt-in real model verification with an existing runtime and cached models:

```bash
/path/to/asr-venv/bin/python scripts/runtime-smoke.py --cache /path/to/models --magic
```

To exercise the full Electron transcription, correction and export path with the same existing runtime:

```bash
bun run build
node scripts/desktop-smoke.mjs "/path/to/Delulu Talks user data"
```

This uses temporary settings/history, requires the existing model-license acceptance, disables clipboard/paste, and runs offline against cached models. The Python command above also runs offline against the included short audio sample. It is a smoke check, not a general accuracy benchmark. See [architecture](docs/ARCHITECTURE.md), [design system](docs/GUI_DESIGN.md), and the [rebuild plan and validation record](docs/REBUILD_PLAN.md).
