# Testing

Keep this hobby project's suite focused on failures that break dictation, paste incorrect text, leak private results, or lose data. The unit suite is rebuilt from scratch; the two existing browser tests are retained.

| Command               | Scope                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `bun run test`        | All high-value TypeScript and Python unit tests. The default quick check.                           |
| `bun run test:unit`   | TypeScript units only, using Bun.                                                                   |
| `bun run test:python` | Python units using standard-library unittest. No model dependencies required.                       |
| `bun run test:e2e`    | Existing Chromium microphone tests: final partial audio delivery and cancellation/resource cleanup. |

Unit tests cover atomic persistence failures, corrupt/future profiles, history privacy and ownership, dictation retry/delivery, verified update download/restart safety, clipboard safety, protocol boundaries, runtime rollback, exact shortcut blocks, original/edit/rewrite preservation, technical editing undo, and bounded private transcript retention. They use direct calls, fake model/desktop adapters and small temporary profiles; they never start Electron, model workers or GPU runtimes. There are no snapshot or visual-variant unit tests, coverage percentage targets, or subprocess fixtures.

Run `bun run test` during development. Run `bun run test:e2e` after capture/renderer changes; install its browser once with `bunx playwright install chromium`. Tests are not attached to dev-server startup, build commands or Git hooks. CI runs units, the existing browser tests, formatting, typechecking and a production build. Native CI jobs run TypeScript units on macOS and Windows too.

The old installer process fixtures and desktop/native smoke test suites have been removed. Optional hardware investigations use the existing [native inference harness](NATIVE_HARNESS.md) or benchmark tools. Unit/browser results do not establish physical microphone recognition, native GPU inference, or paste into another application.

Add a unit test when a meaningful bug threatens one of these behaviors. Prefer one scenario that asserts a user-visible outcome over exhaustive combinations or tests of constants, getters, styling and reporting machinery.
