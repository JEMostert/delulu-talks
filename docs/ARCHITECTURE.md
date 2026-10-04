# Delulu Talks architecture

## Product contract

A local desktop voice companion. A global shortcut records in the renderer; Electron owns transcription, optional Magic rewriting, and delivery to the previous app. The main window provides recent results, contextual transcript rewriting, personalization, file transcription, and maintenance. Linux/Wayland is the reference desktop.

The [architecture decision records](decisions/README.md) explain the current transport, backend catalog, runtime packaging, and history-storage choices, including their deferred requirements.

## Boundaries

- `src/components/OceanController.tsx` provides the persistent icon-only capture controls. `QuickSettings.tsx` opens essential preferences; `OceanBackground.tsx` renders a bounded procedural GPU ocean without React frame updates. `src/ocean.css` defines the shell and working sheets.
- `src/App.tsx` assembles the shell and pages. `hooks/useWorkspace.ts` owns subscriptions, serialized settings patches, transcript actions and feedback. `hooks/useTheme.ts` applies system/light/dark appearance.
- `src/components/ui` supplies shared switches, setting rows, alerts, empty states and native modal dialogs. `TranscriptCard` owns review/edit/restore/remember-word interactions for both Controls and History.
- `src/index.css` defines semantic light/dark tokens and reusable controls; Tailwind utilities in the components handle shell and page layouts. All pages remain usable in compact desktop windows.
- Secondary pages are lazy loaded. Visited pages use React Activity to preserve drafts while suspending hidden effects; capture and submitted backend operations remain owned outside these views. The standalone Writing workspace has been removed. Rewrite preview/apply/undo belongs to shared transcript review; model installation belongs to Models. No cloud draft storage is used.
- `src/bridge.ts` is the typed Electron boundary. `src/preview.ts` contains explicitly labeled browser sample data. Native actions in preview explain that the desktop app is required; preview does not pretend to run inference.
- `electron/main.ts` owns lifecycle, tray, shortcuts, IPC registration and settings side effects. IPC accepts only the main window's top frame; the renderer has context isolation, sandboxing and no Node integration. Native file selections are allowlisted for Speech Lab.
- `electron/services/dictation.ts` owns capture and delivery state. The microphone controller serializes commands, handles cancellation during pending permissions, and flushes AudioWorklet samples before producing mono 16 kHz PCM WAV.
- `electron/services/asr.ts` owns speech and Magic model lifecycle. `electron/runtime/workerClient.ts` owns the persistent Python JSON-lines transport, request IDs, bounded logs, timeouts and crash cleanup. A timed-out worker is terminated and all queued requests are rejected.
- `electron/runtime/installer.ts` owns asynchronous Python discovery, environment creation, package installation, compatibility checking and installed-version recording. `manifest.ts` contains direct dependency pins; Linux x64 transitive constraints are bundled for Magic only. `SerialQueue` serializes runtime setup. No shell string is used to execute user-provided Python paths.
- `electron/runtime/diagnostics.ts` reports memory, Python, FFmpeg, package versions and local data paths on demand. It does not send diagnostics anywhere.

## Runtime lifecycle

Speech and Magic run in separate Python environments and worker processes to keep backend dependency graphs and GPU/process ownership independent. Linux R2T2/vLLM, Windows R2T2/PyTorch, and optional Qwen 3.5 rewriting have different requirements; Apple Silicon speech uses direct MLX Audio with a pinned R2T2 conversion. R2T2 is the only speech model identity offered. The separation remains mandatory even when direct Transformers versions match. Each desktop worker rejects commands for the other role, and newly installed generations carry a role marker checked by readiness. Python import overrides, user site packages, and external pip configuration cannot redirect managed setup into another environment. Generated Python, Hugging Face module, Torch extension, Triton and vLLM caches are scoped under `runtime-cache/<role>`; downloaded model weights remain shared. Unmarked legacy generations remain usable through their existing readiness checks. Setup is serialized across both runtimes. A setup request is deduplicated; conflicting desktop operations are rejected with a useful message. Installed package versions are recorded per runtime after `pip check` succeeds. Releases detect the legacy shared `asr-venv`, preserve it when it is a usable Magic environment, and present the new speech environment as an explicit setup update.

Direct dependency versions and Linux constraints were taken from the reference machine and verified with its installed engines. Portable platforms share direct version pins but resolve their own platform-specific transitive wheels; model execution still needs native validation on those platforms. The manifest is not a cross-platform hash lock. Linux CUDA environment creation requires Python 3.11–3.13; Windows CUDA requires Python 3.12; native Apple Silicon speech requires arm64 Python 3.12. The MLX Audio adapter is implemented with mocked contract coverage, but native inference validation is still required. The Windows native PyTorch adapter also lacks native inference evidence here. See [Mac support](MAC_SUPPORT.md) and [Windows support](WINDOWS_SUPPORT.md).

Pinned models stay loaded. Unpinned models stay warm until the idle delay expires; the dictation service no longer immediately unloads them after each result. Reset removes only the virtual environment. Model caches, transcript history and settings remain.

Idle unloading checks actual capture ownership, runtime maintenance and pending speech/writing requests before stopping either worker. A blocked deadline defers another full idle interval without changing engine status. Requests reserve ownership before awaiting readiness, and requests arriving during an unload wait for it to finish before loading a new worker. Timer policy uses the latest saved residency settings, including changes made during inference; shutdown prevents completion callbacks from rearming idle timers. These ownership contracts are tested with controlled transports and clocks, without GPU inference or a native memory-release claim.

An errored speech or writing worker stays failed until an explicit Load/Repair or transcript retry requests recovery. Keep-loaded policy does not retry errors, including after an operation finishes or a pending readiness check returns. Automatic loads retain the engine failure generation across every asynchronous readiness/unload wait and worker response, so a newer failure cannot be overwritten by a stale load result or rejection, including when speech cleanup is still waiting. Deferred residency changes still apply to healthy engines. Error causes and session-only retry audio remain available through the existing recovery controls; no automatic restart loop or background model download is introduced.

The native GTK4 overlay keeps a dark ocean-blue palette for visibility over arbitrary apps. It is click-through and does not own recording or inference logic. Unsupported desktops use the main window and tray without the overlay.

## Data and recovery

Settings and persisted history use temporary-file replacement with restricted permissions. Missing files initialize normally; parse/read failures preserve existing files and produce an actionable error instead of silently resetting them. In-memory state is updated only after a successful write. Settings updates are partial patches, serialized in both the workspace and main process to prevent stale whole-object saves from undoing unrelated preferences.

`WorkspaceRoot` owns capture and queued saves outside the presentation error boundary. A render/lifecycle failure replaces the view with recovery controls while microphone capture and pending saves continue. Stop and save submits active capture normally. The recovery view reads diagnostics independently, bounds service waits to five seconds, and exposes rejected calls for intentional retry. The main process checks current capture, runtime, settings queue and update state synchronously before reloading; renderer-local queued saves also block the reload button. An outer boundary covers controller initialization failures: interrupted unsent capture is explicitly disclosed, while submitted inference remains owned by the desktop process. React boundaries do not recover a terminated renderer process or a failure before the renderer bundle starts.

Recovery retains up to 12 recent editable text-field values, with a combined 500,000-character limit, in session memory for explicit copying. These can include already saved edits, retain whitespace and Unicode, and are kept separate from diagnostic reports. They are not written to disk or automatically applied; reload clears these recovery copies. Password, read-only and disabled fields are excluded. Saved transcript originals, settings and runtime environments are not reset by recovery.

The Python worker returns unmodified R2T2 speech text. On Apple Silicon, MLX Audio decodes/resamples audio, loads the pinned BF16 conversion with strict weights, and warms the decoder before Ready. Buffered inference remains the active workflow; stable-prefix acoustic streaming is future work. `src/personalization.ts` creates a separate `personalizedText` field in Electron; Unicode whole-phrase matching never cascades. Original speech is preserved beside user corrections and Magic output. Controls, History, exports and paste-last share the text selection helpers.

When history saving is disabled, newly produced records remain in a bounded session map for review, corrections and exports; they are not written to history. Existing saved history remains until explicitly cleared. Deletion clears both saved and session records, including paste-last references.

Temporary microphone and FFmpeg WAV files are deleted after success or failure. A failed microphone submission can remain in memory for retry during the current process. Retry reuses it; Discard releases it; a later successful transcription replaces it. It is not recoverable after closing or crashing the app. Imported source audio is never modified.

Native intended-only transcription is the default. Manual writing is independent of the automatic-writing toggle and model residency. Manual rewrites preview before apply and validate the record has not changed in the meantime. Exact shortcut blocks remain outside the model; surrounding text fragments are rewritten in place and rejoined with the unchanged blocks. Editing source invalidates an old rewrite; undoing a rewrite reveals personalized or edited speech again. Magic is optional in the dictation pipeline. Failed rewriting falls back to the speech transcript. A preserve-facts prompt is an instruction to the model, not a guarantee; users can inspect source and output. Silence produces no history entry, clipboard change or paste.

## Updates

App updates are explicit downloads. The updater disables automatic installation on quit, retains a ready download when asked to check again, and blocks restart while capture, inference or setup is active. Linux automatic updates apply to AppImage installs; other Linux packages and source builds link to manual releases. Platform packages remain unsigned until signing is configured.

## Verification

- `bun run test`: fast TypeScript and dependency-free Python unit tests for data preservation, exact text blocks, delivery/retry, worker validation, and runtime rollback.
- `bun run test:e2e`: the two existing Chromium capture tests, using synthetic microphone audio to check final worklet flushing and cancellation cleanup.
- `bun run format:check`, `bun run typecheck`, and `bun run build`: source and production build checks.
- The [native inference harness](NATIVE_HARNESS.md) remains an optional manual hardware check using already-cached models. It does not run in the test suite.

## Architecture review

The current boundaries are useful: sandboxed IPC, worker ownership, separate runtime environments, atomic writes, and shared transcript actions. Retain them while extracting responsibilities that have become crowded. `electron/main.ts` is approximately 987 lines and `src/App.tsx` approximately 538 lines in this pass; IPC registration and transcript commands are the first candidates for focused modules. File size alone does not justify a rewrite.

The JSON-lines transport has per-worker budgets of 4 MiB request bytes, eight pending requests, 8 MiB stdout lines and 80,000 retained stderr bytes. Admission failures reject only the excess request; stdout overflow stops the generation and requires explicit recovery. Python independently bounds input and validates a complete response before emitting any prefix. See [worker protocol bounds](worker-bounds.md) for byte/delimiter rules, failure semantics and subprocess evidence.

The largest functional gap is native evidence for the new Mac and Windows adapters. Capture still buffers audio until Stop, and the JSON-lines transport has no acoustic streaming session protocol. Implement that protocol before promising live R2T2 output. Platform shortcuts/paste, runtime capability metadata, and durable storage schemas deserve clearer contracts before profiles or persistent import queues expand their use. The roadmap links those changes to observed behavior and failure-path acceptance.

## Direction

[The GitHub roadmap](https://github.com/JEMostert/delulu-talks/issues/14) maps ambitious work across the entire personal tool: native R2T2 evidence on the owner's machines, acoustic streaming, coding dictation, contextual rewriting, advanced profiles, batch imports, durable history, editor/CLI/API automation, and GPU optimization. Individual task issues retain section context, with area/priority labels and milestones. The 12 completed items record local implementation, not pushed changes or proven native Mac/Windows inference. Technical observability and data integrity guide the architecture; customer onboarding and public hardware certification are outside scope. [Model research](MODEL_RESEARCH.md) records candidates and the limits of source-level compatibility evidence.
