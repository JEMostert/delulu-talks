# Settings and history persistence failures

Storage writes a temporary JSON file before replacing the saved file and publishing its new in-memory snapshot. A failed write retains the previous settings or history. Renderer commands keep correction drafts and rewrite previews until saving succeeds, and do not show a success notification for a rejected operation.

Settings coordination validates engine changes against active recording/inference before changing the shortcut. Shortcut registration holds status notifications until settings persistence succeeds. If registration or persistence fails, it restores the previous binding before publishing the final status. If the operating system or portal refuses restoration, the operation reports that failure and the shortcut status remains unavailable; it does not claim that the previous binding is active. Wayland restoration may require a new portal permission interaction.

`bun test electron/services/storageWrites.test.ts electron/services/settingsWrites.test.ts` uses real temporary-file write rejection. The settings coordinator test executes the production function with real storage and shortcut services, and fixture native registration/runtime ports; it covers write rejection, engine-busy validation, registration rejection, restoration failure, and intentional retry.

`bun run build && xvfb-run -a node scripts/settings-write-smoke.mjs` exercises actual Electron/preload/main IPC and native Linux shortcut registration with an isolated temporary profile. It verifies exact saved bytes, the previous effective shortcut, absence of successful rejected-change events, and successful retry. It runs in CI alongside the default desktop smoke. On a desktop session, omit `xvfb-run`.

`tests/e2e/persistence.pw.ts` covers renderer settings, corrections, rewrites, deletion, and clear-history rejection/retry with mocked desktop IPC. These checks do not establish native Mac/Windows filesystem behavior or Wayland portal restoration. No model runtime or personal settings/history are used.
