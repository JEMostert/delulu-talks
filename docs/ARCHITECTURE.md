# Delulu Talks architecture

## Product contract

A local desktop voice companion. A global shortcut records in the renderer; Electron owns transcription, optional Magic rewriting, and delivery to the previous app. The main window provides recent results, writing tools, personalization, file transcription, and maintenance. Linux/Wayland is the reference desktop.

## Boundaries

- `src/pages/HomePage.tsx` is the settings-first Controls workspace. It exposes capture, transcription, writing and delivery settings alongside a latest-output inspector. Microphone enumeration runs here and on Settings.
- `src/App.tsx` assembles the shell and pages. `hooks/useWorkspace.ts` owns subscriptions, serialized settings patches, transcript actions and feedback. `hooks/useTheme.ts` applies system/light/dark appearance.
- `src/components/ui` supplies shared switches, setting rows, alerts, empty states and native modal dialogs. `TranscriptCard` owns review/edit/restore/remember-word interactions for both Controls and History.
- `src/styles/tokens.css` defines semantic light/dark colors. `components.css` defines reusable controls. `workspace.css` handles the shell and page layouts. All pages remain usable in compact desktop windows.
- Visited pages remain mounted for the current workspace so drafts and long-running file operations survive navigation. Magic additionally keeps its draft in session storage. No cloud draft storage is used.
- `src/bridge.ts` is the typed Electron boundary. `src/preview.ts` contains explicitly labeled browser sample data. Native actions in preview explain that the desktop app is required; preview does not pretend to run inference.
- `electron/main.ts` owns lifecycle, tray, shortcuts, IPC registration and settings side effects. IPC accepts only the main window's top frame; the renderer has context isolation, sandboxing and no Node integration. Native file selections are allowlisted for Speech Lab.
- `electron/services/dictation.ts` owns capture and delivery state. The microphone controller serializes commands, handles cancellation during pending permissions, and flushes AudioWorklet samples before producing mono 16 kHz PCM WAV.
- `electron/services/asr.ts` owns speech and Magic model lifecycle. `electron/runtime/workerClient.ts` owns the persistent Python JSON-lines transport, request IDs, bounded logs, timeouts and crash cleanup. A timed-out worker is terminated and all queued requests are rejected.
- `electron/runtime/installer.ts` owns asynchronous Python discovery, environment creation, package installation, compatibility checking and installed-version recording. `manifest.ts` contains direct dependency pins; Linux x64 transitive constraints are bundled beside the Python worker. `SerialQueue` serializes shared-environment setup. No shell string is used to execute user-provided Python paths.
- `electron/runtime/diagnostics.ts` reports memory, Python, FFmpeg, package versions and local data paths on demand. It does not send diagnostics anywhere.

## Runtime lifecycle

Speech and Magic use independent model slots in one Python process. Setup is serialized across both runtimes. A setup request is deduplicated; conflicting desktop operations are rejected with a useful message. Installed package versions are recorded in `runtime-installed.txt` after `pip check` succeeds.

Direct dependency versions and Linux constraints were taken from the reference machine and verified with its installed engines. Portable platforms share direct version pins but resolve their own platform-specific transitive wheels; model execution still needs native validation on those platforms. The manifest is not a cross-platform hash lock. New environment creation requires Python 3.11–3.13.

Pinned models stay loaded. Unpinned models stay warm until the idle delay expires; the dictation service no longer immediately unloads them after each result. Reset removes only the virtual environment. Model caches, transcript history and settings remain.

The native GTK4 overlay keeps a dark ocean-blue palette for visibility over arbitrary apps. It is click-through and does not own recording or inference logic. Unsupported desktops use the main window and tray without the overlay.

## Data and recovery

Settings and persisted history use temporary-file replacement with restricted permissions. In-memory state is updated only after a successful write. Settings updates are partial patches, serialized in both the workspace and main process to prevent stale whole-object saves from undoing unrelated preferences.

The Python worker returns unmodified clean/verbatim speech and timings. `src/personalization.ts` creates a separate `personalizedText` field in Electron; Unicode whole-phrase matching never cascades. Original clean/verbatim speech is preserved beside user corrections and Magic output. Records remember the delivered transcript version. Controls, History, exports and paste-last share the text selection helpers.

When history saving is disabled, newly produced records remain in a bounded session map for review, corrections and exports; they are not written to history. Existing saved history remains until explicitly cleared. Deletion clears both saved and session records, including paste-last references.

Temporary microphone and FFmpeg WAV files are deleted after success or failure. A failed microphone submission can remain in memory for retry during the current process. Retry reuses it; Discard releases it; a later successful transcription replaces it. It is not recoverable after closing or crashing the app. Imported source audio is never modified.

Native intended-only transcription is the default. Manual writing is independent of the automatic-writing toggle and model residency. Manual rewrites preview before apply and validate the record has not changed in the meantime. Exact shortcut blocks remain outside the model; surrounding text fragments are rewritten in place and rejoined with the unchanged blocks. Editing source invalidates an old rewrite; undoing a rewrite reveals personalized or edited speech again. Magic is optional in the dictation pipeline. Failed rewriting falls back to the speech transcript. A preserve-facts prompt is an instruction to the model, not a guarantee; users can inspect source and output. Silence produces no history entry, clipboard change or paste.

## Updates

App updates are explicit downloads. The updater disables automatic installation on quit, retains a ready download when asked to check again, and blocks restart while capture, inference or setup is active. Linux automatic updates apply to AppImage installs; other Linux packages and source builds link to manual releases. Platform packages remain unsigned until signing is configured.

## Verification

- `bun test`: state, storage normalization, delivery/retry, export, portal, worker transport, update and queue regressions.
- `bun run test:e2e`: browser navigation/layout checks in both themes, editable personalization persistence, transcript corrections, modal focus, draft retention and real browser PCM capture using a synthetic microphone.
- `bun run test:desktop`: builds and launches Electron with isolated temporary user data. Checks sandboxed preload, settings IPC, diagnostics and setup dialogs without registering global shortcuts or changing login/desktop integration.
- `node scripts/desktop-smoke.mjs "/path/to/existing/user-data"`: opt-in real Electron inference using an already licensed runtime and cached models, with temporary settings/history and no clipboard/paste; checks correction/export/deletion with history saving disabled.
- `scripts/runtime-smoke.py`: opt-in offline inference using the committed audio sample and already-downloaded models. Reports timings and output sizes without printing transcript contents.
- `bun run format:check`, `bun run typecheck`, `bun run build`, Python syntax validation, and Linux packaging complete the local checks.
