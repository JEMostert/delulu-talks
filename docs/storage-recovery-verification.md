# Storage recovery verification

Run `bun test electron/services/storage.test.ts`. These fixture-only checks use
real temporary files and the production StorageService with an isolated Electron
profile mock. They never read the owner's profile, backups, model cache or
runtime. The packaged legacy lookup scenarios run on Linux, where that migration
path exists; the corresponding tests explicitly skip on other platforms.

The suite covers:

- Corrupt settings/history, wrong top-level JSON types and unsupported workflow
  versions fail startup before migration writes. Source and companion data stay
  byte-identical, and a present invalid profile never falls back to legacy data.
- Incomplete settings `.tmp` and complete but uncommitted history `.tmp` files
  are not adopted as committed data. A normal reopen uses the destination files.
- Compatible backup restoration after corrupt settings, corrupt history or a
  future schema restores settings, original historical model identity,
  transcripts, saved corrections and rewrite results. The test copies backup
  files into a stopped profile and verifies the backup files remain unchanged.
- A real failed history staging write preserves existing settings or keeps
  missing settings absent; legacy settings/history remain byte-identical.
  Removing the obstruction allows an intentional retry.
- Isolated subprocess tests inject a final settings-rename failure after history
  publication. Production staging, reads and history rename use real files;
  the failed rename is simulated. Newly published history is rolled back,
  settings/legacy files stay preserved, and retry succeeds. A separately injected
  rollback failure surfaces both errors without reporting a complete migration.

The migration fix stages both outputs before publication, commits previously
absent history first, then settings. If the settings commit fails it removes
only history created by that migration attempt. Existing history is never
replaced by this rollback. Handled attempts remove their staged files. Legacy
source files are retained on success and failure.

Backup restoration here means restoring owner-provided compatible JSON files
with the app stopped; it does not create an automatic backup manager. Keep a
copy of the damaged files for diagnosis, restore both settings/history from the
same compatible backup, then reopen and inspect the recovered data. Incompatible
backups remain errors and are preserved. Runtime/model directories are outside
this restore workflow.

These results establish recovery behavior on the test machine's filesystem and
controlled failures. They do not establish power-loss durability, atomicity of
two renames across an abrupt process kill, or native Windows/macOS filesystem
semantics. Separate platform filesystem/packaging gates remain open.
