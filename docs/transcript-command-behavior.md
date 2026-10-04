# Shared transcript command inventory

Recorded before ARC-07 extraction against master d241bf1. App assembles the same actions for Controls, History and Audio files; TranscriptCard/RewriteDialog own editing/preview state, useWorkspace owns capture/history/settings and queued writes, and main IPC owns durable records and revision checks. Extraction must preserve those boundaries.

| Command              | Existing behavior that must remain                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy                 | Copies exactly the requested visible/source text through the workspace action wrapper                                                                |
| Correct / restore    | Uses the existing workspace updateTranscript command; original model speech stays intact                                                             |
| Generate rewrite     | Delegates to local rewriting; preview does not mutate the transcript                                                                                 |
| Apply / undo rewrite | Sends id, result and expected source text to revision-checked IPC; publishes returned record and success only after resolution                       |
| Set up rewriting     | Navigates to Models; no second Writing workspace                                                                                                     |
| Remember correction  | Enforces current 500-rule limit, validates conflicts, preserves an existing rule id and merges unique aliases, then saves through the settings queue |
| Delete               | Removes the local record and announces success only after IPC succeeds                                                                               |
| Export               | Announces success only for a returned path; cancelled export produces no success toast                                                               |
| Clear history        | Clears visible history and announces success only after IPC succeeds                                                                                 |

The focused transcriptCommands service receives the workspace fields it uses and returns actions plus Clear history. App composes pages and supplies these shared commands; the service owns no capture, worker, persistence or presentation lifecycle. No new hook memoization, independent state or native APIs are introduced.

Existing correction, personalization, rewrite/error/undo and import browser journeys cover these commands. An additional cross-page journey applies a rewrite in Controls, reviews the original in History, undoes it there, and returns to Controls to verify the same record and original speech. This is preview/mock IPC evidence, not native inference or clipboard/paste validation.
