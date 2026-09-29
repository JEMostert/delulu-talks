# History filters

History combines search with an inclusive date range, speech model, transcript
language, recording/import source, and current rewrite status. Reset search and
filters restores the complete loaded history. Opening and closing a transcript's
review keeps those controls unchanged.

Sort history offers Newest first (the default) and Oldest first. Both use the
record's original creation time; editing or applying a rewrite does not move it.
Records with equal creation times use their stored ID in ascending, case-sensitive
order so refresh and incoming record order do not reshuffle them. Sorting works
on a copy of the filtered records and keeps the underlying history unchanged.

Search, all filters, and sort live in workspace memory for the current session.
They remain selected when navigating to another page and returning to History,
or if the History page remounts during workspace recovery. Reset search and
filters clears the query and filter controls while keeping the selected sort.
Restarting or reloading the application returns to the default view; these
preferences are not written to settings or transcript history.

Dates use the device's local calendar days, including the whole end day across
daylight-saving transitions. Either date may be left empty. A reversed range
shows an accessible error and no results until corrected or reset.

Speech model choices distinguish R2T2 CUDA, R2T2 MLX, and historical Qwen3 ASR
records. These identify stored results; historical models are not offered as
active speech engines. Language choices come from the loaded history, preserving
unknown historical codes. Source uses the stored `dictation` or `file` metadata.
The existing legacy normalizer assigns missing source metadata to dictation and
missing language metadata to English; filters cannot recover provenance absent
from those records. This change does not migrate or rewrite metadata.

Rewritten results have a current nonempty accepted rewrite. Undoing or clearing
that rewrite puts the record in Without rewrite even if historical rewrite model
metadata remains. Search still includes original recognition, personalization,
corrections, accepted rewrite text and filenames.

Filtering is local and read-only. It does not modify transcripts, settings,
source audio, or model runtimes. Clear history continues to confirm deletion of
**all** history records, including records hidden by filters. The existing
500-record loaded-history limit and session-only search state are unchanged;
retention/pagination and persisted search state have separate roadmap issues.

Verification uses pure filter contracts in multiple timezones and browser
journeys with synthetic desktop IPC history. Those checks establish renderer
behavior and data preservation, not native inference or OS-specific integration.
