# Delulu Talks personal desktop rebuild

## Product contract

A quiet, local voice companion: invoke a shortcut, speak, and receive useful text in the app already in focus. The main window is a comfortable place to recover a result, improve a draft, teach a word, or manage the device. Linux/Wayland is the reference platform; retain portable desktop fallbacks.

## Acceptance criteria

- One visual system: semantic color tokens, light/dark/system themes, consistent type, spacing, controls, cards, dialogs, empty states, and feedback.
- Home prioritizes recording readiness and recent useful output. Technical settings are progressively disclosed.
- Every existing workflow remains accessible: dual transcripts, corrections, Magic, vocabulary expansion, imports, alignment, exports, model selection, shortcuts, tray and overlay.
- Drafts survive navigation. Failures never silently erase successful text; recovery operations are clearly labeled.
- Shared Python environment mutations are serialized. Install specifications are maintained separately from orchestration; installed versions are recorded for diagnosis. Failed setup reports a useful recovery action.
- Updates do not interrupt capture, inference, or setup. Downloads are explicit and display progress; unsupported package types receive a manual release link.
- Settings/history migrations retain existing user data. No accounts or cloud inference are introduced.
- Type checking, meaningful regression tests, production build, Python validation, visual walkthroughs, and available desktop smoke checks pass. Hardware and other-OS checks that cannot run are documented honestly.

## Milestones

### 1. Foundations and design
- [x] Add shared UI primitives, semantic tokens, themes, responsive layout and reduced-motion support.
- [x] Rebuild navigation, app header, status feedback, onboarding and dialogs.
- [x] Extract workspace state/actions from the visual shell; serialize settings updates and surface failures consistently.

### 2. Daily workflows
- [x] Redesign Home and History around recent results, review, search and copy/recovery.
- [x] Preserve original transcripts and corrections; add an explicit remember-correction flow.
- [x] Add paste-last from the tray and a delayed paste action in the app.
- [x] Preserve Magic and Speech Lab state across navigation; improve empty/busy/error states.
- [x] Refine Wordbook into an editable, searchable collection with voice expansions.

### 3. Runtime and maintenance
- [x] Extract worker transport, serialize shared-environment setup, and prevent conflicting runtime operations.
- [x] Introduce runtime dependency manifests and installed-version diagnostics.
- [x] Add hardware/system checks, copyable diagnostics, setup progress, and actionable repair UI.
- [x] Guard updater operations and expose manual releases for unsupported installs.

### 4. Finish
- [x] Restyle every page using shared primitives and purposeful copy.
- [x] Extend regression tests for concurrency, update safety and data behavior.
- [x] Run browser workflows at desktop and compact sizes, both themes, and keyboard/dialog checks.
- [x] Run build and desktop/runtime checks available locally; update README and architecture docs.

## Design direction

Warm neutral surfaces, restrained green accent, generous whitespace, quiet borders, a compact sidebar and readable transcript typography. Dark mode uses the same semantic tokens. Recording gets a distinct live state; errors use an accessible alert with an action. No promotional dashboards or unrelated account/team screens.

## Boundaries

The user authorized pushing the completed rebuild to `master` and updating the release automation. Version tags run the verification workflow before native packaging and publication. The user's installed application and model data are not replaced by the development checks.

Package signing and native runtime verification on unavailable operating systems require their respective environments. Avoid speculative accuracy promises; performance claims require real-audio measurements.


## Validation record — 0.6.0, 6 September 2026

- 53 Bun regression tests passed, including worker crash/timeout handling, setup serialization, update restart safety, recording retry, delivered transcript selection, and overlay shutdown without orphan helpers.
- Eight Playwright browser workflows passed, including all pages at 1280 px and 860 px in both themes, draft retention, Wordbook editing, original/corrected transcripts, focus containment, synthetic microphone capture and cancellation during permission requests.
- Type checking, formatting, production build, Python syntax checks and `git diff --check` passed.
- Isolated Electron smoke passed: sandboxed preload, settings persistence, diagnostics and license/setup dialog.
- Real Electron inference passed using the existing licensed local runtime and cached models: sample WAV → Python worker → session transcript → correction → JSON export → deletion. Saved history stayed empty. Temporary test data was removed.
- Offline worker smoke exercised CrisperWhisper Medium and Qwen Magic on the reference RTX 4090. The 4.57-second sample transcribed in about 0.21 seconds after model loading; the short Magic task took about 1.15 seconds. These are warm smoke measurements, not accuracy or general performance benchmarks.
- Linux AppImage, pacman and tar.xz packages built successfully.
- The refined SVG retains the original cyan microphone, midnight-blue hexagon and orbital motif. Desktop PNG/ICO/ICNS assets derive from the SVG; light/dark and 16–256 px rendering were inspected.

## Remaining platform validation

The automated desktop smoke intentionally skips global shortcuts, native overlay and paste into other applications; these depend on desktop permissions and compositor behavior. Existing integration regression tests pass, but a manual end-to-end shortcut/paste check is still needed on the installed release. A completely fresh runtime download/install and Windows/macOS model execution were not exercised locally. Cross-platform package builds run in GitHub Actions; packages remain unsigned. The runtime manifest pins the reference environment but is not a portable hash lock.
