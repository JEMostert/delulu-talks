# Local deletion and reset boundaries

Clear history removes durable transcripts and their corrections/rewrites, the backend session map, the latest-record reference and renderer review lists. Deleting one transcript removes those references for its id. Neither operation removes settings, vocabulary rules, cached models or Python environments. A failed durable write retains the in-memory record and permits an explicit retry.

Paste last waits three seconds for focus. After that delay it resolves the requested id again: deleting/clearing it cancels delivery, and correcting it during the delay uses the current text. It does not substitute a different latest transcript. Clear history does not cancel ongoing capture or transcription; a newly completed operation can create a new record afterward. Previously exported files and an already populated system clipboard are outside clear history.

Reset Python environments is a distinct Models action. It stops workers and removes the speech and rewriting environment directories; settings, history and the model cache are excluded. This is not a factory reset or history deletion command.

Current checks: `cargo test -p delulu-data --test storage` verifies that deletion revokes backup copies and that retention requires a current preview, and `cargo test -p delulu-speech` verifies that paste last delivers after its countdown and cancels when the text changes. They use temporary profiles and fakes, no downloaded models and no user data.

An earlier Linux Electron fixture (`bun run test:data-deletion` through `scripts/test-evidence.mjs`) exercised clear, individual delete, correction during delayed delivery and a failed atomic clear with retry in four isolated profiles, including renderer reload and preserved settings/model/runtime sentinels; two preview browser journeys covered the History and Controls views. Those checks have been removed. None of these establish native Mac/Windows filesystem behavior, native inference, manual focus/delivery, or actual history-disabled inference.
