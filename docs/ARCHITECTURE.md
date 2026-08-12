# Delulu Talks 2.0 architecture

## Product contract

The core loop is deliberately short: invoke the global shortcut, record in the already-running renderer, transcribe through the resident speech model, optionally rewrite the chosen transcript through the resident Magic model, then deliver the final text to the clipboard/cursor. History keeps the Magic delivery beside the untouched intended and verbatim speech layers.

The visible start view is the working Dictation surface, not a home or onboarding page. The sidebar separates daily work (Dictation, Magic, Speech Lab, History) from configuration (Wordbook, Models & runtime), while a compact command bar keeps record/stop and runtime state available in every view.

The default is CrisperWhisper 2 Medium in dual mode with the model preloaded. This gives a clean intended transcript for everyday paste and a verbatim record for review and speech insights. Users can trade startup memory for first-use latency with **Settings → Keep selected model loaded**.

## Process boundaries

```text
global shortcut / tray / UI
              │
              ▼
Electron main process ── validated IPC ── sandboxed React renderer
      │                                      │
      │ lifecycle, files, clipboard          └─ Chromium microphone capture
      │
      ├─ persistent Python JSON-lines worker
      │       ├─ CrisperWhisper 2.0 / CT2 or Transformers
      │       └─ Qwen 3.5 / Transformers 5
      │
      └─ atomic settings + optional transcript history
```

- The renderer has no Node integration. `contextIsolation` and Chromium sandboxing are enabled.
- The preload exposes only typed, named operations. File paths for Speech Lab must originate from the native file picker and are allowlisted in memory before IPC accepts them.
- The main process owns global shortcuts, tray behavior, file reads/writes, clipboard delivery, and child processes. Wayland uses one XDG GlobalShortcuts session, subscribes to each Request response before invoking the portal method, and consumes both Activated and Deactivated for hold-to-dictate. The desktop owns remapping through its native shortcut editor. Other platforms use Electron's native press-only shortcut API.
- On Linux Wayland the Chromium UI compositor runs in software to avoid the native-Wayland/NVIDIA incompatibility seen on current Plasma stacks. This does not disable CUDA inference in the separate Python worker.
- Python messages carry a protocol prefix and request ID, so progress output cannot be parsed as a response. One worker owns independent speech and Magic slots so both selected models can remain resident simultaneously.
- Settings and history use atomic temporary-file replacement and permission mode `0600` where the platform supports it.

## Model lifecycle

1. No weights are bundled. Starting speech setup opens an in-context license dialog when the separate Nyra terms have not yet been accepted.
2. The app selects a compatible Python 3.10–3.13 interpreter and creates an isolated virtual environment under Electron's user-data directory.
3. Linux x64 Auto installs the CT2 and conversion extras. Other systems install the portable Transformers backend.
4. Setup downloads/converts only the selected checkpoint. The selected model can then remain resident or load on first dictation.
5. Changing model, backend, compute type, or speculative setting unloads the old runtime before a replacement is loaded.
6. Removing the environment preserves settings, history, and the model cache. The user can repair it without losing personal data.
7. Magic installs Transformers, PyTorch, the matching Torchvision processor dependency, and Qwen into the same isolated environment. It offers the official `Qwen/Qwen3.5-0.8B`, `-2B`, and `-4B` checkpoints. Qwen 3.5 has no official 8B checkpoint; 4B is the largest release below the configured ceiling.
8. Each model has an independent keep-resident setting. A shared configurable delay unloads any unpinned model after its last operation; disabling Magic unloads it immediately.

The four standard aliases resolve to `nyralabs/CrisperWhisper2.0_small`, `_medium`, `_turbo`, and `_large`. Large can instantiate Turbo as a CT2 speculative draft. Standard weights never receive Pro-only hotword prompts; custom vocabulary is applied as deterministic, case-insensitive post-processing instead.

## Transcription workflows

- **Dictation:** browser audio is mixed to mono, resampled to 16 kHz, encoded as PCM WAV, and sent to the worker after recording stops.
- **Dual:** CT2 calls `transcribe_dual` so intended and verbatim prompts share encoder/decoder work. Transformers performs the two supported passes sequentially.
- **Speech Lab:** native formats go directly to CrisperWhisper. Compressed media and video are normalized through the system FFmpeg binary to a temporary mono 16 kHz WAV.
- **Verbatimize:** combines a trusted clean transcript with the audio to recover audible fillers, repairs, cut-offs, and vocal events; word timing is requested when enabled.
- **Forced align:** assigns model-derived timing to a supplied exact transcript.
- **Correction:** manual edits are stored beside the original intended/verbatim model output. Copy and text export use the correction, while Restore removes only the edit and JSON retains both layers.
- **Delivery:** the selected intended/verbatim layer is sent through the configured Magic preset when Magic is enabled. The Magic result is retained beside its source, copied, and then pasted through platform automation. If Magic is off—or unavailable—the original transcript remains deliverable. Linux tries `wtype`, `ydotool`, `dotool`, then `xdotool`, and falls back to a clear clipboard-only result.

## Magic workflow

- **Source:** the workspace starts from the latest corrected intended transcript but accepts any local draft up to 50,000 characters.
- **Preset:** Polish, Concise, Detailed, and Prompt builder translate user intent into a controlled system instruction. Qwen runs in non-thinking mode for lower-latency direct output.
- **Accuracy boundary:** Preserve facts forbids new claims and requirements. Allow assumptions permits useful examples, constraints, and implementation details, while forbidding invented names, dates, measurements, credentials, or completed work and telling the model to expose uncertainty.
- **Prompt isolation:** transcript text is wrapped as untrusted source content; instructions contained inside it are rewritten rather than executed.
- **Review:** assumption-enabled results are visibly labeled before copy. The draft and result survive page navigation only for the current app session.

## Failure and privacy rules

- Microphone and converted-media temporary files are deleted after both successful and failed inference.
- A crashed worker rejects all outstanding requests and surfaces a concise last diagnostic rather than silently hanging.
- Model setup and load are serialized so repeated UI actions cannot create parallel environments or duplicate model loads.
- No audio retention, analytics, cloud API, account system, or network transcription exists. Network access is needed only for installing the runtime and downloading weights.
- The app never treats standard vocabulary as native hotword prompting because Nyra documents that feature as Pro-only.

## Packaging strategy

Electron Vite emits separate main, preload, and renderer bundles. Electron Builder packages AppImage, pacman, and `tar.xz` on Linux, a universal DMG/ZIP on macOS, and NSIS/ZIP on Windows. GitHub Actions builds on each native OS; it no longer installs Rust or WebKitGTK.
