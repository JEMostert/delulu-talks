# Crash and restart boundaries

This describes the implemented storage and recovery paths. JSON storage checks are
described in [settings persistence](settings-persistence.md); they do not establish
power-loss guarantees.

| Data                         | Storage and normal lifetime                                                                                                                                        | Abrupt exit / restart                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings                     | `settings.json` in the user-data folder; updates stage JSON then rename before committing in-memory settings                                                       | Reopen reads the committed destination. An uncommitted `.tmp` is not adopted. Invalid/unsupported committed JSON is preserved and fails startup; restore a compatible owner-provided backup with the app stopped.                       |
| Saved transcripts            | `history.json`; includes original text, personalization, saved correction, rewrite and model/source provenance                                                     | Only a completed history write is durable. Startup reads committed history; staged `.tmp` output is ignored. An in-flight result before its history commit may be lost. No raw audio is stored in a history record.                     |
| Session-only transcripts     | Backend session map and last-transcript pointer when history saving is disabled                                                                                    | Lost when the app process exits. Renderer reload can request the current session map while that process remains alive. Enabling history later does not retroactively save old session results.                                          |
| Active microphone capture    | Native recorder (`delulu-audio`) buffers samples in the app process until Stop encodes the WAV                                                                     | Unsubmitted audio is lost when the app process exits. A renderer error or reload does not stop native capture; an app crash cannot reconstruct unsent samples.                                                                          |
| Failed-recording retry       | Backend retained submission, exposed by explicit Retry / Discard; no cross-session retry index                                                                     | App exit loses the retry reference. It is not restored from files on restart.                                                                                                                                                           |
| Temporary dictation audio    | The backend writes a generated `dictation-<milliseconds>-<UUIDv4>.wav` under `audio-cache` for local inference; handled completion/failure deletes it in `finally` | Abrupt exit can interrupt `finally`. Primary-instance startup removes matching prior-session regular files before starting any new worker, capture or import. It discards these remnants rather than inventing crash-recoverable Retry. |
| Converted import audio       | Legacy conversion writes generated `import-<milliseconds>-<UUIDv4>.wav` under `audio-cache`; handled conversion/inference paths remove generated output            | The same startup rule handles legacy top-level generated WAV remnants. Cleanup does not descend into or remove owned conversion directories.                                                                                            |
| Imported source media        | The user-selected source file is a read-only inference/conversion input; its basename may be recorded as provenance                                                | Startup cleanup does not delete source files or scan source directories. Source media outside the generated cache remains available for explicit re-import.                                                                             |
| Clipboard and injected paste | Managed by the OS/destination, outside committed transcript history                                                                                                | Restart cannot establish what the destination accepted or whether clipboard ownership survives. Retained transcript text remains the recovery source. Automatic paste failures offer an explicit Copy instead action.                   |
| Models and Python runtimes   | Cached weights and installed/activated runtime generations live outside audio-cache                                                                                | Temporary-audio cleanup never touches these directories. Worker/model in-memory state is lost; loading is a separate explicit/on-demand operation, and failures remain actionable.                                                      |

## Startup cleanup ownership and failure handling

The helper (`delulu-data::audio_cache_recovery`) runs once at startup, only
after the app holds its single-instance lock (`tauri-plugin-single-instance`), and before any new worker/capture/import is
created. A secondary launch forwards to the existing instance without running
cleanup. It inspects only immediate entries in Delulu's `audio-cache` directory.

A deletion candidate must match the exact legacy generated name, have a timestamp
strictly before this startup's cleanup boundary, be a regular file with one hard
link, and have a modification time before that boundary. The cache directory and
candidate entries are inspected with `lstat`; symlinks, directories, unknown
names, newer/future-dated entries and multiply linked files remain untouched.
The helper does not recurse, load audio, follow file links, delete model caches,
rewrite saved records or reset settings. Unlinking a generated temporary file is
not secure erasure of disk blocks, filesystem snapshots or backups.

If a file disappears during cleanup, that is treated as already removed. Other
inspection/removal failures are counted; up to twenty bounded diagnostics appear
in a native error message and local console. The app continues startup, and the
message explicitly says that prior-session audio may remain. Close the app
before inspecting those entries manually. A skipped unknown entry is preserved,
not represented as successfully cleaned. A later launch can retry failed entries.

## Durable commit limits

JSON rename provides the implemented destination-file commit boundary. Settings
and history are separate files; there is no combined crash transaction, journal,
automatic backup manager or guaranteed recovery of an in-flight transcript. The
storage code does not fsync each staged file and its parent directory, so a
completed API call is not evidence of power-loss durability on every filesystem.
Existing corrupt-profile and migration guards preserve source files rather than
silently starting a blank profile.

Crash verification should use a disposable profile with invented
transcripts and synthetic audio: abrupt exit before submission, during WAV write,
inference, history staging and rename; restart with history enabled/disabled;
renderer reload versus app restart; stale Retry loss; exact generated
remnants versus unrelated media, symlinks, hard links and conversion directories;
cleanup permission failures and retry; and singleton second launch during an
active recording. Record native filesystem/desktop results separately on macOS
and Linux. Never infer native MLX/CUDA recovery from mocked results.
