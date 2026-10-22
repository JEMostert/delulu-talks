# Electron → Tauri migration

Working document for the rewrite on the `tauri` branch. It records the decisions, the contracts every crate codes against, and progress. It is deleted (or folded into ARCHITECTURE.md) at cutover.

## Decisions

- **Tauri 2, full Rust backend.** Every Electron main-process module (`electron/`) and every shared `src/` module it imports is ported to Rust. The React renderer stays; only its bridge changes.
- **Native audio.** Phase 0 showed WebKitGTK 2.52 only starts `getUserMedia` for a focused window (`GetUserMediaRequiresFocus`) and, even with that feature disabled, hangs every request after the first while unfocused. Dictation always records while another app is focused, so capture, level metering, trailing silence, capture cues, listening VAD and voice playback move to Rust (cpal; PulseAudio host on Linux via pipewire-pulse, CoreAudio, WASAPI). The renderer only displays state. This also removes the 500 MiB WAV and PCM IPC transfers.
- **Webview works for the UI.** `color-mix`, `:has`, `backdrop-filter`, `dvh`, `@layer`, `<dialog>`, module workers and gesture-free AudioContext all pass in WebKitGTK 2.52. Raw binary IPC round-trips 8 MiB in ~80 ms.
- **Profile location unchanged.** `~/.config/Delulu Talks` (Linux), `~/Library/Application Support/Delulu Talks`, `%APPDATA%\Delulu Talks`; `Delulu Talks Dev` for dev builds; `DELULU_USER_DATA_DIR` overrides. See `delulu-core::paths`.
- **Python workers unchanged.** `backend/python/*` keeps its JSON-lines protocol; the overlay stays `backend/overlay/pill.py`.
- **Voice MCP server becomes a subcommand** (`delulu-talks mcp`), so agents no longer need Node or `ELECTRON_RUN_AS_NODE`.
- **Packaging:** AppImage (auto-update), rpm (Fedora), deb, pacman `.pkg.tar.zst` (CachyOS/Arch, built from the Tauri binary in CI), macOS arm64 dmg + updater archive, Windows NSIS. Releases restart at v0.1.0; old Electron releases and tags are removed at cutover.

## Layout

```
src-tauri/                  app crate: Tauri setup, IPC router, windows, tray, menus, plugins
  crates/delulu-core        error contract, EventSink, AppPaths, atomic writes   (frozen; ask before changing)
  crates/delulu-domain      src/types.ts + shared src/*.ts logic + IPC request validation
  crates/delulu-runtime     Python discovery/venvs/installer, worker client + protocol, diagnostics
  crates/delulu-audio       native capture, resampling, WAV, trailing silence, cues, VAD, playback
  crates/delulu-desktop     paste, clipboard, global shortcuts (portal), overlay supervisor, tray host, autostart, permissions
  crates/delulu-data        storage (settings/history), migrations, backups, retention, exports, caches   (wave 2)
  crates/delulu-speech      asr + magic lifecycle, dictation pipeline, paste-last, import queue runner   (wave 2)
  crates/delulu-voice       voice output, listening sessions, agent bridge, MCP server   (wave 2)
backend/python, backend/overlay   unchanged worker and overlay scripts
```

Rules:

- Leaf crates (`domain`, `runtime`, `audio`, `desktop`) depend only on `delulu-core` and crates.io, never on each other or on `tauri`. Where they need a value owned elsewhere (settings fields, paths) they take it as a parameter. Where they need an app-level integration (a Tauri window, a plugin), they define a trait the app crate implements.
- Each crate declares its own dependency versions in its own `Cargo.toml`. Do not edit `src-tauri/Cargo.toml`.
- Wire types serialize exactly like the TypeScript types: `#[serde(rename_all = "camelCase")]`, string unions as enums with explicit renames, optional fields `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none", default)]`. Where TypeScript distinguishes absent from `null`, preserve it.
- Errors are `delulu_core::DomainError` with the same codes the TypeScript raised. Messages shown to users keep the TypeScript wording.
- Tests: port the existing tests that guard real behavior (data preservation, protocol bounds, state machines); no exhaustive new suites. `cargo test -p <crate>` must pass and `cargo clippy -p <crate>` should be clean.
- Build with a private target directory to avoid lock contention between parallel work: `CARGO_TARGET_DIR=/tmp/delulu-target-<crate>`.

## Renderer transport

The preload is replaced by `src/desktopBridge.ts`, which installs `window.delulu` with the same `DeluluApi` shape:

- Request/response: `invoke("ipc_invoke", { channel, args })` → `Envelope` (`{ transport: "delulu-operation-v1", ok, value | error }`). Channel names and argument order are the Electron ones (`settings:update`, `history:setTitle`, …). The renderer keeps validating with `parseIpcRequest`; Rust validates again (`delulu-domain::ipc_requests`) with the same arity, limits and truncation.
- Fire-and-forget: `invoke("ipc_send", { channel, args })`; invalid payloads are ignored.
- Binary responses: `invoke("ipc_bytes", { channel, args })` returns a raw `ArrayBuffer` (used by `lab:loadSource`; the renderer derives the MIME type from the extension).
- Events: Tauri events named exactly like the Electron channels (`settings:changed`, `runtime:statusChanged`, …), payload = the TypeScript value.
- Only the `main` window may call `ipc_*` (the Rust router checks the webview label and returns `UNTRUSTED_SENDER` otherwise).

### API changes from the Electron `DeluluApi`

Removed (capture/playback are native now): `recordingStarted`, `recordingLimitReached`, `recordingPauseChanged`, `recordingSilence`, `recorderReady`, `recordingFailed`, `recordingInputChanged`, `recordingLevel`, `submitRecording`, `onRecorderCommand`, `onVoicePlay`, `onVoiceStopPlayback`, `reportVoicePlayback`, `reportListenEvent`, `onListenCommand`, `resolveAudioFiles(files: File[])`.

Added:

| Method | Channel | Notes |
|---|---|---|
| `listMicrophones(): Promise<MicrophoneDevice[]>` | `audio:inputs` | first entry is `{ deviceId: "default", label: "System default" }` |
| `onMicrophonesChanged(cb: (devices) => void)` | event `audio:inputsChanged` | |
| `listSpeakers(): Promise<MicrophoneDevice[]>` | `audio:outputs` | voice output selection; same shape |
| `onRecordingLevel(cb: (level: number) => void)` | event `recorder:level` | 0–1, ~20 Hz while recording |
| `onFilesDropped(cb: (paths: string[]) => void)` | event `window:filesDropped` | native drag-and-drop paths |
| `resolveAudioPaths(paths: string[]): Promise<AudioFileSelection[]>` | `lab:resolveAudioPaths` | replaces `resolveAudioFiles` |
| `testCaptureCue(): Promise<void>` | `audio:testCue` | plays the start cue at the configured volume |

Unchanged in shape: everything else, including `onStatus` (now also carries recording state from the native recorder), `getVoiceStatus`/`onVoiceStatus`, `speak`, listening start/stop/status.

## Native audio contract (`delulu-audio`)

- `Recorder` — one capture at a time: `start(RecorderOptions { device_id, trailing_silence: Option<{seconds, threshold_db}>, max_duration, cues })`, `pause`, `resume`, `stop() -> Recording { wav_16k_mono: Vec<u8>, duration_ms, diagnostics: CaptureDiagnostics }`, `cancel`. Emits `RecorderEvent` (`Started`, `Level(f32)`, `Silence { remaining_seconds: Option<f32>, stop: bool }`, `LimitReached`, `InputChanged { message, input_lost }`, `Failed(message)`, `PauseChanged(bool)`) through a callback/channel. Mirrors `src/recorder.ts` + `captureInput.ts` + `trailingSilence.ts` + `captureLimits.ts`.
- `ListenCapture` — continuous capture with the `src/voiceActivity.ts` detector; emits speech start/end and completed utterance WAVs; supports pause/resume and barge-in using the playback reference level.
- `Player` — gapless queued PCM (`i16` LE mono at a given sample rate) per utterance with volume and output device; emits started/finished/stopped per utterance and exposes a reference level for barge-in. Mirrors `src/voicePlayer.ts`.
- `Cues` — start/stop tones from `src/captureCues.ts`.
- `inputs()/outputs()` device listing with a stable `deviceId`; `"default"` follows the system.

## Progress

- [x] Phase 0 probe (WebKitGTK capabilities, native capture spike)
- [x] Workspace + `delulu-core`
- [x] `delulu-domain`
- [x] `delulu-runtime`
- [x] `delulu-audio`
- [x] `delulu-desktop`
- [x] Renderer bridge (`src/desktopBridge.ts`) and removal of renderer capture/playback
- [ ] `delulu-data`
- [ ] `delulu-speech`, `delulu-voice`
- [ ] App crate: router, handlers, tray, windows, plugins, MCP subcommand
- [ ] Packaging + CI (AppImage, rpm, deb, pacman, dmg, NSIS, updater signing)
- [ ] Docs, cleanup (remove `electron/`, electron-builder, Electron deps), release reset, v0.1.0
