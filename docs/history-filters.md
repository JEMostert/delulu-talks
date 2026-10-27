# History filters

History combines search with quick filters: All, Dictation, Files and
Rewritten. Opening and closing a transcript's review keeps those controls
unchanged. The filter logic (`src/historyFilters.ts`) also supports an inclusive
date range, speech model and transcript language; when one of those is set
without a visible control, History offers **Clear hidden filters**.

Records are listed newest first by their original creation time; editing or
applying a rewrite does not move a record. Records with equal creation times use
their stored ID in ascending, case-sensitive order so refresh and incoming
record order do not reshuffle them. Sorting works on a copy of the filtered
records and keeps the underlying history unchanged (`src/historyView.ts`).

Search and filters live in workspace memory for the current session. They
remain selected when navigating to another page and returning to History, or
if the page remounts during workspace recovery. Restarting or reloading the
application returns to the default view; these preferences are not written to
settings or transcript history.

Dates use the device's local calendar days, including the whole end day across
daylight-saving transitions. A reversed or invalid range shows no results.
Source uses the stored `dictation` or `file` metadata. The legacy normalizer
assigns missing source metadata to dictation and missing language metadata to
English; filters cannot recover provenance absent from those records.

Rewritten results have a current nonempty accepted rewrite. Undoing or clearing
that rewrite removes the record from Rewritten even if historical rewrite model
metadata remains. Search still includes original recognition, personalization,
corrections, accepted rewrite text and filenames.

Search treats the query as a literal phrase, with Unicode case-insensitive
matching. A matching card shows highlighted excerpts labelled Original
recognition, Personalized text, Your correction, Accepted rewrite, or Source
filename. These excerpts expose matches in hidden stored layers without
changing which text the card delivers or its copy/edit actions. Long fields
show context around their first match, with ellipses for omitted text; each
matching layer gets its own excerpt. Clearing search removes the excerpts.

Filtering is local and read-only. It does not modify transcripts, settings,
source audio, or model runtimes. Clear history continues to confirm deletion of
**all** history records, including records hidden by filters.
