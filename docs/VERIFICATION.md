# Testing

Keep this hobby project's suite focused on failures that break dictation, paste incorrect text, leak private results, or lose data. TypeScript covers the renderer, Python covers the workers, and Rust covers the backend crates.

| Command               | Scope                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `bun run test`        | Renderer, Python and Rust unit tests (`test:unit`, `test:python`, `test:rust`). The default check.  |
| `bun run test:unit`   | TypeScript units only, using Bun.                                                                   |
| `bun run test:python` | Python units using standard-library unittest. No model dependencies required.                       |
| `bun run test:rust`   | `cargo test --workspace` in `src-tauri`: every backend crate and the app crate.                     |
| `bun run test:e2e`    | Chromium browser-preview tests: recording controls follow the desktop status, ocean idle behavior.  |

Unit tests cover atomic persistence failures, corrupt/future profiles, history privacy and ownership, dictation retry/delivery, verified update download/restart safety, clipboard safety, protocol boundaries, runtime rollback, exact shortcut blocks, original/edit/rewrite preservation, and bounded private transcript retention. They use direct calls, fake model/desktop adapters and small temporary profiles; they never start the app, model workers or GPU runtimes. Native capture and playback have an opt-in hardware smoke test (`cargo test -p delulu-audio -- --ignored --nocapture`). There are no snapshot or visual-variant unit tests, coverage percentage targets, or subprocess fixtures.

Run `bun run test` during development. Run `bun run test:e2e` after renderer changes; install its browser once with `bunx playwright install chromium`. Tests are not attached to dev-server startup, build commands or Git hooks. CI runs the renderer and Python units, the browser tests, formatting, typechecking and a renderer build on Linux, plus `cargo test --workspace` and `cargo clippy` on Linux, macOS and Windows.

The old installer process fixtures and desktop/native smoke test suites have been removed. The [native inference harness](NATIVE_HARNESS.md) and the speech benchmark were removed with Electron and are not available in the Tauri app yet; `DELULU_DEV_SCRIPT` in debug builds can drive setup and dictation through the IPC router without the UI (see `src-tauri/src/dev_script.rs`). Unit/browser results do not establish physical microphone recognition, native GPU inference, or paste into another application.

Add a unit test when a meaningful bug threatens one of these behaviors. Prefer one scenario that asserts a user-visible outcome over exhaustive combinations or tests of constants, getters, styling and reporting machinery.
