# ADR 0004: local JSON history with separate transcript text layers

Status: accepted current storage; database/profile/job schemas deferred. Recorded 30 September 2026.

## Context

Recognition output, vocabulary personalization, user corrections, and optional rewriting are different facts. A correction must not erase the original speech. Corrupt data must not silently become a fresh empty profile. The existing personal workflow does not yet require a database migration.

## Decision

Keep settings and persisted history as local JSON owned by `StorageService`. Stage writes in a sibling temporary file and rename before publishing in-memory success. Missing files initialize normally; unreadable/malformed or unsupported profile data produces an error while preserving its source. Stale temporary files are not automatically adopted. The supported settings marker is `workflowVersion: 1`, with explicit legacy migration; this is not a general versioned transcript/job database schema.

Store original speech as `text`, alongside optional `personalizedText`, `editedText`, and `magicText` plus existing attribution fields. Shared text-selection helpers choose delivery without overwriting recognition. Editing invalidates an old rewrite; manual rewrite apply checks the expected current result, and undo reveals the prior layer.

Persisted history currently has a 500-record ceiling. With saving disabled, the main process retains a bounded session map for current review/export instead of writing new history. Clear/delete remove corresponding saved/session references. Failed audio retry is process memory, not crash recovery or a durable job queue.

## Consequences and alternatives

JSON is easy to inspect and back up, but each update rewrites its file and the ceiling is an actual limit. A SQLite migration, full-text indexing, revisions, configurable retention, and durable queues require measured need and tested migration contracts; they are not implied by this record. Reusing one mutable result field and silently replacing corrupt files with defaults are rejected.

A rename is not a multi-file transaction or a tested power-loss guarantee. Legacy migration stages both outputs and attempts rollback of newly published history on a later settings failure; rollback can itself fail and must be surfaced. Manual backup restoration remains distinct from an automatic backup feature. Restricted file modes on Linux do not establish native permission behavior on every filesystem/OS.

Owners: [storage](../../electron/services/storage.ts), [text selection](../../src/transcriptText.ts), [transcript commands](../../src/transcriptCommands.ts), [exports](../../electron/services/transcripts.ts). See [storage recovery](../storage-recovery-verification.md) and [architecture data/recovery boundaries](../ARCHITECTURE.md#data-and-recovery).
