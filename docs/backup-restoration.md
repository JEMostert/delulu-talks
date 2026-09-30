# Backup restoration dry run

`node scripts/backup-restore-dry-run.mjs --source /path/to/backup --target /path/to/new-isolated-profile --profile /path/to/any-custom-active-profile`

The `backup:dry-run` package command accepts the same arguments. This offline
Node command reads files and prints a structured JSON report to stdout. It never
starts Electron, installs runtimes, creates the target, copies data or changes
any profile. Do not redirect its output into a source or active profile file.

A supported backup directory contains both committed `settings.json` and
`history.json` from one stopped-app snapshot. Settings must contain the complete
current `workflowVersion: 1` field set, including vocabulary and the paste-last
delay. History is the current plain array of transcript records. Missing fields,
invalid JSON, duplicate JSON keys/record identities, unsupported values, unknown
fields and values that storage would truncate, default or discard block the dry
run. Historical `qwen3Asr` attribution is supported; it never enables that engine.
Optional correction, personalization and rewriting layers are checked separately
from the required original speech text.

Each finding has a severity, code, field/file path, explanation and action. The
report contains counts and file sizes, never transcript contents or setting
values. Exit status `0` means the supported settings/history payload and target
passed these checks, `1` means blocked, and `2` means invalid command arguments
or an unexpected inspection failure. A successful dry run is an inspection of
that moment, not an actual restore or a native filesystem/power-loss guarantee.

The target must be empty or absent, outside the backup and outside all known app
profiles and their ancestors. Symlinks and existing target parents are resolved
before comparing paths. Standard production/development paths, Linux legacy
paths and `DELULU_USER_DATA_DIR` are protected automatically. Declare every other
custom active profile with repeatable `--profile` arguments; the tool cannot
identify arbitrary profiles that were not declared. Protection is for paths on
the current host; run this command on the intended restoration machine.

Read all warnings before a separate manual restore with the app stopped. A
cross-platform backup may select the host's R2T2 backend on first launch, and an
older vocabulary entry may infer its correction/shortcut kind. Extra backup
entries are listed explicitly as excluded. Model/runtime/cache/audio directories
are outside this format and must be retained separately. Profile/job backup
domains, future schema versions and unversioned legacy settings block this tool;
use a compatible app to migrate a separate copy rather than dropping that data.
There is no general profile/job restore or automatic migration feature here.

The JSON pair has no snapshot manifest, checksum or transaction marker. This
command cannot prove both files were captured at the same time, detect omitted
records from an otherwise valid array, or establish that the app is stopped.
Keep the original backup and damaged profile intact. After an explicitly chosen
manual copy to the isolated target, reopen that target and inspect the result
before adopting it as an active profile.

Implementation status: **UNVERIFIED — tests, builds, typechecks, format checks and
runtime checks were not run per the current issue-work instruction.**
