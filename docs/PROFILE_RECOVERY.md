# Isolated profile recovery

Migration backups preserve raw settings/history with a versioned manifest and SHA-256 hashes. Recovery never overwrites an existing profile or edits corrupt source files. Use the CLI even when profile corruption prevents Electron from opening.

```sh
# Read-only plan; no target directory is created.
bun scripts/profile-restore.mjs \
  --backup "/damaged/profile/migration-backups/migration-..." \
  --target "/separate/new-profile"

# Revalidates immediately before creating a new isolated profile.
bun scripts/profile-restore.mjs \
  --backup "/damaged/profile/migration-backups/migration-..." \
  --target "/separate/new-profile" --restore
```

If the snapshot was copied out of its original migration-backups directory, supply `--source-profile /original/profile`. Source and target cannot be parents/children of one another; the target must not exist and its parent must already exist. Settings are required. Missing history fails by default; `--settings-only` explicitly restores settings and initializes empty history when a payload was absent or removed after history deletion. A manifest that claims a missing file always fails.

The dry run checks manifest ownership/version, supported file names, checksums, settings workflow compatibility, vocabulary/transcript shapes, supported historical model attribution, size/count limits and isolation. Settings files are bounded at 8 MiB and history at 256 MiB/500 records; oversized input fails without truncation. Original bytes are copied after validation; legacy settings remain unversioned and migrate only when the new profile is opened. Runtime/model directories are not copied or changed.

Errors identify file paths and JSON parse causes. Successful plans/reports omit transcript contents. Restore creates owner-only target/files where the filesystem supports those modes and records restore provenance. Failure removes only the newly created target; source profile and backup remain intact. Close the application before opening the restored profile with `DELULU_USER_DATA_DIR` pointing to its absolute directory. This command does not open the application or run inference.

Implementation is UNVERIFIED: no restore, dry-run invocation, tests, builds or native filesystem checks were run while authoring it.
