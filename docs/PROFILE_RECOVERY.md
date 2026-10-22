# Isolated profile recovery

Migration backups preserve raw settings/history with a versioned manifest and SHA-256 hashes. Recovery never overwrites an existing profile or edits corrupt source files. Use the CLI even when profile corruption prevents the app from opening. It is a subcommand of the app binary (`delulu-talks restore-profile`, replacing the Electron-era `scripts/profile-restore.mjs`) and runs without starting a window.

```sh
# Read-only plan; no target directory is created.
delulu-talks restore-profile \
  --backup "/damaged/profile/migration-backups/migration-..." \
  --target "/separate/new-profile"

# Revalidates immediately before creating a new isolated profile.
delulu-talks restore-profile \
  --backup "/damaged/profile/migration-backups/migration-..." \
  --target "/separate/new-profile" --restore
```

If the snapshot was copied out of its original migration-backups directory, supply `--source-profile /original/profile`. Source and target cannot be parents/children of one another; the target must not exist and its parent must already exist. Settings are required. Missing history fails by default; `--settings-only` explicitly restores settings and initializes empty history when a payload was absent or removed after history deletion. A manifest that claims a missing file always fails.

The dry run checks manifest ownership/version, supported file names, checksums, settings workflow compatibility, vocabulary/transcript shapes, supported historical model attribution, size/count limits and isolation. Settings files are bounded at 8 MiB and history at 256 MiB/500 records; oversized input fails without truncation. Original bytes are copied after validation; legacy settings remain unversioned and migrate only when the new profile is opened. Runtime/model directories are not copied or changed.

Errors identify file paths and JSON parse causes. Successful plans/reports omit transcript contents. Restore creates owner-only target/files where the filesystem supports those modes and records restore provenance. Failure removes only the newly created target; source profile and backup remain intact. Close the application before opening the restored profile with `DELULU_USER_DATA_DIR` pointing to its absolute directory. This command does not open the application or run inference.

The validation and restore logic is `src-tauri/crates/delulu-data/src/profile_restore.rs`; the CLI wrapper is `src-tauri/src/restore_cli.rs`. Use the AppImage path or `/usr/bin/delulu-talks` for the binary; on macOS and Windows run the executable inside the installed app. Native restores outside the unit tests are unverified.
