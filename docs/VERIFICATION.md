# Testing

Keep this hobby project's suite focused on failures that break dictation or lose data.

| Command                | Scope                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`         | Storage corruption/write failures, dictation and paste safety, installer recovery, worker messages. Uses temporary files and mocked desktop adapters. |
| `bun run test:python`  | Speech backend loading, transcription, cleanup and failure recovery with fake models. No downloads or GPU required.                                   |
| `bun run test:e2e`     | Chromium microphone capture, final audio flush and resource cleanup using synthetic audio.                                                            |
| `bun run test:desktop` | Optional real Electron/preload/IPC smoke check using an isolated temporary profile. Builds first.                                                     |

CI runs the unit, Python, browser and isolated desktop checks, plus formatting,
typechecking and a build. Release jobs build native packages.

For an optional real-model smoke check, use an existing runtime and model cache:

```sh
/path/to/runtime/python scripts/runtime-smoke.py --cache /path/to/models
```

Add `--magic` to exercise the optional rewriting model. This runs local inference
on `test-audio.m4a`; it is not an accuracy benchmark. Check real microphone,
shortcut and paste behavior manually on your target desktop before a release.

Add a regression test when fixing a meaningful bug. Avoid exhaustive UI variants,
repeated fixtures across layers, and tests of reporting machinery.
