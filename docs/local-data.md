# Local data overview

Settings → Local data reads file metadata from the active user-data profile. It lists history, settings, model cache, runtimes and temporary audio separately, with absolute locations, logical byte sizes, file counts and a checked timestamp. Refresh does not modify files, read transcript contents, load models or validate runtime readiness.

History and settings include their `.tmp` write files. Model cache includes the app's Hugging Face cache and converted checkpoints. Runtimes includes dedicated speech/writing environments and retained legacy `asr-venv`, including generation directories. Temporary audio includes failed recordings kept for deliberate retry. Imported source audio, exports, external backups, legacy profiles outside the active profile, and other files the webview or the app keeps are outside this view.

Missing paths show “Not present.” Permission failures, files removed during a scan, and a 100,000-entry limit per location show partial results with a lower-bound size and the reason. Symbolic links are reported and excluded: cache snapshot links do not double-count blobs, and linked external locations are not scanned. Hard-linked regular files count at each path. Sizes are logical file bytes rather than allocated blocks; scans are not atomic snapshots. The browser preview reports that the desktop app is required instead of fabricating measurements.

Verification: `cargo test -p delulu-data local_data` counts files and reports missing locations against a temporary profile. The earlier browser journey (`tests/e2e/localData.pw.ts`) and packaged-app fixture (`bun run test:local-data`) were removed before the Tauri rewrite. No check runs native model inference or uses personal data.
