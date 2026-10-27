# Delulu Talks architecture

## Product contract

A local desktop voice companion. A global shortcut starts native microphone capture in the Rust backend; the backend owns transcription, optional rewriting (the `magic` runtime), and delivery to the previous app. The main window provides recent results and Rewrite, History (transcripts and file transcription), Words (word packs and text shortcuts), Voice (Siren for spoken output, Sonar for the hands-free agent loop with Pilot as the local tool router) and Settings (per-feature sections that also set up the speech and rewrite models). Linux/Wayland is the reference desktop.

The app is a [Tauri 2](https://tauri.app/) shell with a Rust backend and the React renderer in the system webview: WebKitGTK on Linux and WKWebView on macOS. Windows is not supported. It replaced the Electron app in v0.1.0; [ADR 0006](decisions/0006-tauri-and-native-audio.md) records why. The [architecture decision records](decisions/README.md) explain the transport, backend catalog, runtime packaging, history-storage and voice choices, including their deferred requirements.

## Layout

```text
src/                        React renderer (pages, components, hooks, shared TypeScript types)
  desktopBridge.ts          installs window.delulu over Tauri invoke/listen
src-tauri/                  app crate: Tauri setup, IPC router and handlers, windows, tray, menus, plugins, CLI subcommands
  crates/delulu-core        error contract, event sink, profile/resource paths, atomic writes
  crates/delulu-domain      wire types (src/types.ts), catalogs, IPC request validation, shared text logic
  crates/delulu-runtime     Python discovery, venv generations, installer, worker client + protocol, diagnostics
  crates/delulu-audio       native capture, resampling, WAV, trailing silence, cues, listening VAD, playback
  crates/delulu-desktop     paste, clipboard, global shortcuts (portal), overlay supervisor, tray state, autostart, permissions
  crates/delulu-data        settings/history storage, migrations, backups, retention, exports, caches, import queue
  crates/delulu-speech      speech + Magic lifecycle, dictation pipeline, paste-last, file transcription
  crates/delulu-voice       Siren voice output, the Sonar loop, agent inbox and bridge, `delulu-talks mcp`
backend/python              persistent Python workers (speech, rewriting, voice) and their tests
backend/overlay/pill.py     GTK4 layer-shell recording pill
```

Leaf crates (`domain`, `runtime`, `audio`, `desktop`) depend only on `delulu-core` and crates.io, never on each other or on `tauri`. Where they need a value owned elsewhere they take it as a parameter; where they need an app-level integration (a window, a plugin, storage) they define a trait the app crate implements (`NativeShortcuts`, `MacPillFactory`, `LoginItems`, `delulu_speech::Profile`, `delulu_voice::VoiceProfile`). The service crates (`data`, `speech`, `voice`) build on the leaves. The app crate builds every service once (`src-tauri/src/services.rs`) and routes IPC, tray items and shortcuts to them.

Wire types serialize exactly like the TypeScript types (camelCase fields, string unions as renamed enums, absent versus `null` preserved), and errors are `delulu_core::DomainError` with the codes and user-facing wording the renderer already handles. `delulu-data` treats persisted JSON with JavaScript object semantics (key order, number formatting), so a profile written by the Electron releases loads and saves byte-for-byte the same way.

## Boundaries

- `src/components/OceanController.tsx` provides the persistent icon-only capture controls. `QuickSettings.tsx` opens essential preferences; `OceanBackground.tsx` renders the sea from layered gradients with Tailwind animations: no images, canvas or GPU. `src/styles/` defines the Deep Sea tokens, primitives, shell and working sheets.
- `src/App.tsx` assembles the shell and pages. `hooks/useWorkspace.ts` owns subscriptions, serialized settings patches, transcript actions and feedback. `hooks/useTheme.ts` applies system/light/dark appearance.
- `src/components/ui` supplies shared switches, setting rows, alerts, empty states and native modal dialogs. `TranscriptCard` owns review/edit/restore/remember-word interactions for both Home and History. All pages remain usable in compact desktop windows.
- Secondary pages are lazy loaded. Visited pages use React Activity to preserve drafts while suspending hidden effects; capture and submitted backend operations remain owned outside these views. Rewrite preview/apply/undo belongs to shared transcript review; model installation belongs to the Settings section of the feature that uses it. No cloud draft storage is used.
- `src/bridge.ts` is the typed renderer boundary; `src/desktopBridge.ts` installs `window.delulu` with the `DeluluApi` shape over three Tauri commands. `ipc_invoke` returns an envelope (`{ transport: "delulu-operation-v1", ok, value | error }`), `ipc_send` is fire-and-forget, and `ipc_bytes` returns a raw `ArrayBuffer` (used by `lab:loadSource`). Channel names and argument order are the Electron ones (`settings:update`, `history:setTitle`, …), and backend events are Tauri events with the same channel names (`settings:changed`, `runtime:statusChanged`, `recorder:level`, …). `src/preview.ts` contains explicitly labeled browser sample data for `bun run dev:web`; native actions there explain that the desktop app is required.
- `src-tauri/src/ipc/router.rs` validates every request a second time with `delulu-domain::ipc_requests` (same arity, limits and truncation as the renderer's `parseIpcRequest`) before a handler in `src-tauri/src/handlers/` sees it. Only the `main` webview may call `ipc_*`; anything else gets `UNTRUSTED_SENDER`. The renderer has no file-system or shell access; native file selections and drag-and-drop paths are allowlisted for file transcription in History (`src-tauri/src/lab.rs`). WebKitGTK media capture is disabled (`src-tauri/src/webview_linux.rs`): the renderer never touches the microphone.
- `src-tauri/src/lib.rs`, `shell.rs` and `tray.rs` own lifecycle, single-instance flags, close-to-tray, tray menu and icons, login items and settings side effects (`settings.rs`).
- `delulu-audio` owns capture and playback. WebKitGTK only starts `getUserMedia` for a focused window, and dictation records while another app is focused, so the microphone is native: cpal (through handy-cpal) on its own thread per stream, with the PulseAudio host on Linux (pipewire-pulse on PipeWire systems) and an ALSA fallback and CoreAudio on macOS. `Recorder` produces 16 kHz mono WAV with levels, trailing silence, duration limits, input-loss detection and cues; `ListenCapture` runs the voice-activity detector for listening sessions; `Player` plays queued PCM gaplessly and exposes its level as the echo reference. The renderer only displays state.
- `delulu-speech` owns the dictation state machine over the native recorder, delivery with paste recovery, retry audio, paste-last, file transcription, and speech and Magic model lifecycle (`asr.rs`). `delulu-runtime::worker` owns the persistent Python JSON-lines transport, request IDs, bounded logs, timeouts and crash cleanup. A timed-out worker is terminated and all queued requests are rejected.
- `delulu-runtime::installer` owns Python discovery, environment creation, package installation, compatibility checking and installed-version recording. `manifest.rs` contains direct dependency pins; Linux x64 transitive constraints are bundled for Magic only. A serial queue serializes runtime setup. No shell string is used to execute user-provided Python paths.
- `delulu-desktop` owns delivery and desktop integration: paste through the RemoteDesktop portal, klipper, xdotool, osascript or SendKeys; a long-lived clipboard owner with restore; GlobalShortcuts portal registration with hold and toggle gestures on Wayland (tauri-plugin-global-shortcut elsewhere, `src-tauri/src/shortcuts.rs`); the overlay supervisor; tray state; autostart and permission checks.
- `delulu-voice` owns the voice runtime, its worker and the speech queue. `delulu-domain::voice` turns text into chunks (kept in step with `src/voiceMarkup.ts`, `src/speakableText.ts` and `src/voiceChunks.ts`); the worker synthesizes one chunk per request and `delulu-audio::Player` plays it while the next is synthesized. `bridge.rs` serves a token-protected local socket for `delulu-talks mcp`, the MCP server and CLI coding agents run (`mcp.rs`). Sonar (`talk.rs`) owns the microphone for the live agent loop and routes each finished utterance through Pilot or straight to the active agent. See [Siren](SIREN.md).
- `delulu-runtime::diagnostics` reports memory, Python, FFmpeg, package versions and local data paths on demand. It does not send diagnostics anywhere.
- `delulu-core::paths` keeps the profile where the Electron releases kept it: `~/.config/Delulu Talks` (Linux), `~/Library/Application Support/Delulu Talks` (macOS); development builds use `Delulu Talks Dev`, and `DELULU_USER_DATA_DIR` overrides both.

### Linux desktop specifics

- The GlobalShortcuts and RemoteDesktop portals accept a host app only when `delulu-talks.desktop` is installed (`delulu-desktop::portal`). Packages install one; development builds write one to `~/.local/share/applications` when no entry of that name exists (`src-tauri/src/desktop_entry.rs`).
- The overlay pill needs layer-shell. KDE Plasma and wlroots compositors have it; GNOME does not, so the overlay is unavailable there and the main window and tray carry recording state.
- Clipboard: KDE and wlroots use data-control (`ext-data-control-v1` / `zwlr-data-control`); GNOME has neither, so the clipboard goes through X11 via Xwayland, with `wl-copy`/`wl-paste` as a bounded last resort (`delulu-desktop::clipboard`).

## Runtime lifecycle

Speech, Magic and Voice run in separate Python environments and worker processes to keep backend dependency graphs and GPU/process ownership independent. CUDA speech (R2T2 through PyTorch/Transformers on Linux) and optional Qwen 3.5 rewriting have different requirements; Apple Silicon speech uses direct MLX Audio with a pinned R2T2 conversion. The user picks one of three speech sizes. Small (Canary 180M) and Medium (Parakeet TDT 0.6B v2 for English, v3 for automatic detection) run on the CPU through sherpa-onnx in `onnx_speech.py`; Large is R2T2. The speech runtime has two profiles: a CPU profile with only sherpa-onnx and audio packages, and a full profile that adds PyTorch/CUDA or MLX for R2T2 and also contains the CPU packages. Setup installs the profile the selected size needs; switching down from Large needs no setup because the full profile also runs Small and Medium. The separation remains mandatory even when direct Transformers versions match. Each desktop worker rejects commands for the other role, and newly installed generations carry a role marker checked by readiness. Python import overrides, user site packages, and external pip configuration cannot redirect managed setup into another environment. Generated Python, Hugging Face module, Torch extension and Triton caches are scoped under `runtime-cache/<role>`; downloaded model weights remain shared. Unmarked legacy generations remain usable through their existing readiness checks. Setup is serialized across both runtimes. A setup request is deduplicated; conflicting desktop operations are rejected with a useful message. Installed package versions are recorded per runtime after `pip check` succeeds. Releases detect the legacy shared `asr-venv`, preserve it when it is a usable Magic environment, and present the new speech environment as an explicit setup update.

Direct dependency versions and Linux constraints were taken from the reference machine and verified with its installed engines. Portable platforms share direct version pins but resolve their own platform-specific transitive wheels; model execution still needs native validation on those platforms. The manifest is not a cross-platform hash lock. Linux CUDA environment creation requires Python 3.11–3.13; native Apple Silicon speech requires arm64 Python 3.12. The MLX Audio adapter is implemented with mocked contract coverage, but native inference validation is still required. See [Mac support](MAC_SUPPORT.md).

Pinned models stay loaded. Unpinned models stay warm until the idle delay expires; the dictation service no longer immediately unloads them after each result. Reset removes only the virtual environment. Model caches, transcript history and settings remain.

Idle unloading checks actual capture ownership, runtime maintenance and pending speech/writing requests before stopping either worker. A blocked deadline defers another full idle interval without changing engine status. Requests reserve ownership before awaiting readiness, and requests arriving during an unload wait for it to finish before loading a new worker. Timer policy uses the latest saved residency settings, including changes made during inference; shutdown prevents completion callbacks from rearming idle timers. These ownership contracts are tested with controlled transports and clocks, without GPU inference or a native memory-release claim.

An errored speech or writing worker stays failed until an explicit Load/Repair or transcript retry requests recovery. Keep-loaded policy does not retry errors, including after an operation finishes or a pending readiness check returns. Automatic loads retain the engine failure generation across every asynchronous readiness/unload wait and worker response, so a newer failure cannot be overwritten by a stale load result or rejection, including when speech cleanup is still waiting. Deferred residency changes still apply to healthy engines. Error causes and session-only retry audio remain available through the existing recovery controls; no automatic restart loop or background model download is introduced.

The native GTK4 overlay keeps a dark ocean-blue palette for visibility over arbitrary apps. It is click-through and does not own recording or inference logic. Unsupported desktops use the main window and tray without the overlay.

## Data and recovery

Settings and persisted history use temporary-file replacement with restricted permissions. Missing files initialize normally; parse/read failures preserve existing files and produce an actionable error instead of silently resetting them. In-memory state is updated only after a successful write. Settings updates are partial patches, serialized in both the workspace and the Rust backend (`src-tauri/src/settings.rs`) to prevent stale whole-object saves from undoing unrelated preferences.

`WorkspaceRoot` owns the capture controls and queued saves outside the presentation error boundary. A render/lifecycle failure replaces the view with recovery controls while native microphone capture and pending saves continue. Stop and save submits active capture normally. The recovery view reads diagnostics independently, bounds service waits to five seconds, and exposes rejected calls for intentional retry. The backend checks current capture, runtime, settings queue and update state synchronously before reloading; renderer-local queued saves also block the reload button. An outer boundary covers controller initialization failures: interrupted unsent capture is explicitly disclosed, while submitted inference remains owned by the desktop process. React boundaries do not recover a terminated webview process or a failure before the renderer bundle starts.

Recovery retains up to 12 recent editable text-field values, with a combined 500,000-character limit, in session memory for explicit copying. These can include already saved edits, retain whitespace and Unicode, and are kept separate from diagnostic reports. They are not written to disk or automatically applied; reload clears these recovery copies. Password, read-only and disabled fields are excluded. Saved transcript originals, settings and runtime environments are not reset by recovery.

The Python worker returns unmodified R2T2 speech text. On Apple Silicon, MLX Audio decodes/resamples audio, loads the pinned BF16 conversion with strict weights, and warms the decoder before Ready. Buffered inference remains the active workflow. The backend creates a separate `personalizedText` field (`delulu-domain` `text/personalization.rs`, kept in step with `src/personalization.ts`); Unicode whole-phrase matching never cascades. Original speech is preserved beside user corrections and Magic output. Home, History, exports and paste-last share the text selection helpers.

When history saving is disabled, newly produced records remain in a bounded session map for review, corrections and exports; they are not written to history. Existing saved history remains until explicitly cleared. Deletion clears both saved and session records, including paste-last references.

Temporary microphone and FFmpeg WAV files are deleted after success or failure. A failed microphone submission can remain in memory for retry during the current process. Retry reuses it; Discard releases it; a later successful transcription replaces it. It is not recoverable after closing or crashing the app. Imported source audio is never modified.

Native intended-only transcription is the default. Manual writing is independent of the automatic-writing toggle and model residency. Manual rewrites preview before apply and validate the record has not changed in the meantime. Exact shortcut blocks remain outside the model; surrounding text fragments are rewritten in place and rejoined with the unchanged blocks. Editing source invalidates an old rewrite; undoing a rewrite reveals personalized or edited speech again. Magic is optional in the dictation pipeline. Failed rewriting falls back to the speech transcript. A preserve-facts prompt is an instruction to the model, not a guarantee; users can inspect source and output. Silence produces no history entry, clipboard change or paste.

## Updates

App updates use tauri-plugin-updater against a signed `latest.json` on the latest GitHub release (`src-tauri/src/updates.rs`). Downloads are explicit, progress is visible, a verified download is kept when asked to check again, and install + restart is blocked while capture, inference or setup is active. Self-updating installations are the Linux AppImage and the macOS app bundle. Development builds and the deb, rpm and pacman packages report updates as unsupported; they update through the package manager or a new download, and the tray links to the releases page.

The release workflow (`.github/workflows/release.yml`) runs on `v*.*.*` tags whose version matches `package.json`: it runs CI, builds with tauri-action on Ubuntu 22.04 (AppImage, deb, rpm), macOS (arm64 dmg + updater archive), signs updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`, checks bundled resources with `scripts/package-resources.mjs`, repackages the deb as the pacman package `delulu-talks-bin` (`packaging/arch/PKGBUILD`) in an Arch container, verifies the assets (`scripts/verify-release.mjs`) and publishes with `docs/releases/<tag>.md` as notes. macOS packages are not code-signed.

## Command-line entry points

- `delulu-talks mcp …`: the Siren MCP server (`delulu-voice`, stdio) and CLI; it runs before Tauri starts, so it needs no window and no Node. See [Siren](SIREN.md).
- `delulu-talks restore-profile …`: validates or restores a profile backup into a new isolated directory. See [profile recovery](PROFILE_RECOVERY.md).
- `delulu-talks --read-clipboard` / `--stop-speaking`: forwarded to the running instance.
- Debug builds only: `DELULU_DEV_SCRIPT` runs a JSON list of IPC steps through the same router at startup (`src-tauri/src/dev_script.rs`), and `DELULU_IPC_LOG=1` logs every request's channel and outcome.

## Verification

- `bun run test`: renderer unit tests (`bun test`), dependency-free Python units, and `cargo test --workspace` for data preservation, protocol bounds, state machines, exact text blocks, delivery/retry and runtime rollback.
- `bun run test:e2e`: Playwright checks of the renderer in the browser preview (idle ocean, recording state display). Capture itself is native and is not exercised in the browser.
- `bun run format:check`, `bun run typecheck`, `bun run build` and, in CI, `cargo clippy --workspace --all-targets -- -D warnings` on Linux and macOS.
- `src-tauri/crates/delulu-audio/tests/hardware.rs` holds ignored tests that need a real microphone and speakers.

## Architecture review

The useful boundaries carried over from the Electron app: validated IPC, worker ownership, separate runtime environments, atomic writes, and shared transcript actions. The Rust port moved capture and playback out of the renderer and split the backend into crates with one direction of dependency, which replaces the crowded `electron/main.ts`.

The JSON-lines transport has per-worker budgets of 4 MiB request bytes, eight pending requests, 8 MiB stdout lines and 80,000 retained stderr bytes. Admission failures reject only the excess request; stdout overflow stops the generation and requires explicit recovery. Python independently bounds input and validates a complete response before emitting any prefix. See [worker protocol bounds](worker-bounds.md) for byte/delimiter rules, failure semantics and subprocess evidence.

The largest functional gaps are native evidence for the Mac build (built in CI but not run on real hardware) and the missing echo canceller for Sonar. Capture still buffers audio until Stop. Platform shortcuts/paste, runtime capability metadata, and durable storage schemas deserve clearer contracts before profiles or persistent import queues expand their use.

## Direction

[The GitHub roadmap](https://github.com/JEMostert/delulu-talks/issues/14) is kept as a record of the broader plan. The current scope is the desktop app described here; [model research](MODEL_RESEARCH.md) records speech model candidates and the limits of source-level compatibility evidence.
