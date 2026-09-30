# Manual rewrite cancellation

Each preview generation carries an opaque operation token. Cancel rewrite targets only that active manual operation, marks it cancelled before stopping the optional writing worker, and rejects its pending generation. Automatic writing and the separate speech worker are not selected by this token. Stop cleanup remains bounded by the existing worker lifecycle; a cancelled operation cannot publish its late result or start another source fragment.

The dialog retains its immutable source and prior preview; cancellation never writes a transcript, replaces an explicitly accepted rewrite, clears history, or applies a generated result. Apply stays explicit. Cancel cleanup blocks a new generation until ownership is released; retry uses a fresh token. A result already completed when Cancel arrives is discarded locally rather than being mistaken for a newly accepted output. Closing/unmounting the dialog ignores pending callbacks and requests cancellation of its owned operation.

Process-level cancellation unloads the writing worker because these buffered backends do not offer a safe in-process generation interrupt. Keep-loaded policy may subsequently reload weights, but it cannot resume the cancelled generation. This is not a native GPU memory-release claim. Preview-only mode continues to require the actual desktop backend for generation/cancellation.

UNVERIFIED: tests, builds, typechecks, formatting, browser/desktop checks, packaging and native inference were skipped per user instruction. Review/merge remains queued. Future integration must preserve the separate protected-edge/diff/preset/source-revision PRs and recovery correction #324.
