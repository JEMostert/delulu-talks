# Native profile permission observations

Run only when native checks are authorized, once on each owner's machine:

```sh
node scripts/profile-permissions.mjs --run --profile /explicit/application-data/directory > permissions-report.json
```

Use the real application data directory shown in diagnostics. The runner reads metadata for that directory, settings/history files and cache directories. It writes/reads/deletes synthetic files only inside newly created, uniquely named probe directories in that profile and the OS temporary directory. It never reads transcript contents, changes permissions or follows inspected symlinks. It removes only its own exact files and empty directories.

POSIX reports show owner and permission bits; extended ACLs and sandbox policy remain outside that check. Windows reports query native ACLs with bounded PowerShell and identify broad write allow entries; effective access still depends on deny rules and memberships. Missing paths/tools and inaccessible metadata are reported as unknown. Reports redact paths and user/group identities using a new salt for each run.

Keep each report with machine/OS context and the checked-out SHA. This runner has not been executed under the current no-checks instruction. No Mac/Windows/Linux acceptance is implied by its presence.
