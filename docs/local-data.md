# Local data overview

Settings → Local data reads file metadata from the active Electron user-data profile. It lists history, settings, model cache, runtimes and temporary audio separately, with absolute locations, logical byte sizes, file counts and a checked timestamp. Refresh does not modify files, read transcript contents, load models or validate runtime readiness.

History and settings include their `.tmp` write files. Model cache includes the app's Hugging Face cache and converted checkpoints. Runtimes includes dedicated speech/writing environments and retained legacy `asr-venv`, including generation directories. Temporary audio includes failed recordings kept for deliberate retry. Imported source audio, exports, external backups, legacy profiles outside the active profile, and other Electron files are outside this view.

Missing paths show “Not present.” Permission failures, files removed during a scan, and a 100,000-entry limit per location show partial results with a lower-bound size and the reason. Symbolic links are reported and excluded: cache snapshot links do not double-count blobs, and linked external locations are not scanned. Hard-linked regular files count at each path. Sizes are logical file bytes rather than allocated blocks; scans are not atomic snapshots. The browser preview reports that the desktop app is required instead of fabricating measurements.

Verification: `bun test electron/services/localData.test.ts`, `bunx playwright test tests/e2e/localData.pw.ts`, and `bun run test:local-data`. The last check runs the real Electron preload, main IPC and Settings controls against a disposable profile, verifies refresh, and compares retained fixture bytes. It does not run native model inference or use personal data.
