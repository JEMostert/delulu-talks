# Exact saved blocks during rewriting

All four writing presets—Polish, Shorten, Organize, and Build a prompt—use the same service boundary. The service separates enabled saved shortcut blocks from surrounding prose before calling the model. It copies the protected blocks directly into the result and retains their separators. Spoken shortcut triggers still expand to the saved replacement.

Already expanded blocks must preserve their own bytes. Two enabled saved blocks can differ only in case: for example, `https://API.Example` and `https://api.example`. Case-insensitive trigger matching previously chose the first rule for both blocks and could silently change a command URL, flag, or identifier. `splitForRewrite` now recognizes an exact existing saved replacement before choosing the matching trigger's expansion, preserving the block actually present in the source.

The Electron app's `electron/services/protectedRewrite.test.ts` ran the production service once per preset with deterministic model output. It covered repeated case-colliding blocks, CRLF, tabs, leading indentation, Unicode, surrounding prose, case-insensitive spoken triggers, and a blocks-only result with zero model requests. A failure on the final prose segment rejects the operation instead of returning an incomplete rewrite; the unchanged source can be explicitly retried. The original four cases failed against the previous splitter; their initial fixed revision passed before further save/delivery boundary changes.

Saving shortcuts now retains entered indentation and trailing whitespace in both the UI payload and settings normalization. Persisted personalized/rewrite text, rewrite IPC source/output, delivery selection, and TXT export also retain those bytes rather than trimming a block at the transcript edge. Emptiness validation still uses trimmed text. Existing data already trimmed by older versions cannot recover discarded whitespace.

The storage contract includes real temporary settings/history write and reopen. The earlier browser case (`tests/e2e/shortcut-exact.pw.ts`) and the isolated Electron apply/copy/export/reopen fixture (`scripts/exact-block-smoke.mjs`) have been removed.

In the Tauri app the splitter lives in `delulu-domain` (`text/personalization.rs`) and the rewrite service in `delulu-speech` (`asr.rs`). `cargo test -p delulu-domain personalization` checks that exact multiline shortcut blocks stay outside rewriting; the per-preset service test with case-colliding blocks is not ported yet. Run `bun run test` for the complete unit suite. No check uses downloaded models, native inference, or personal text.

Protection applies to enabled saved shortcut expansions. Ordinary prose, arbitrary unsaved code, and model-generated factual correctness remain outside this guarantee. Rewriting remains optional Qwen 3.5 behavior; R2T2 speech is unchanged.
