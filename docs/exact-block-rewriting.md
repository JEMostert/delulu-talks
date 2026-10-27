# Exact saved blocks during rewriting

Every writing style uses the same service boundary. The service separates enabled saved shortcut blocks from surrounding prose before calling the model. It copies the protected blocks directly into the result and retains their separators. Spoken shortcut triggers still expand to the saved replacement.

Already expanded blocks must preserve their own bytes. Two enabled saved blocks can differ only in case: for example, `https://API.Example` and `https://api.example`. Case-insensitive trigger matching previously chose the first rule for both blocks and could silently change a command URL, flag, or identifier. `splitForRewrite` (`split_for_rewrite` in Rust) recognizes an exact existing saved replacement before choosing the matching trigger's expansion, preserving the block actually present in the source.

A blocks-only source needs no model request. A failure on the final prose segment rejects the operation instead of returning an incomplete rewrite; the unchanged source can be explicitly retried.

Saving shortcuts now retains entered indentation and trailing whitespace in both the UI payload and settings normalization. Persisted personalized/rewrite text, rewrite IPC source/output, delivery selection, and TXT export also retain those bytes rather than trimming a block at the transcript edge. Emptiness validation still uses trimmed text. Existing data already trimmed by older versions cannot recover discarded whitespace.

`cargo test -p delulu-domain personalization` and `bun run test:unit` (`tests/unit/personalization.test.ts`) keep exact multiline shortcut blocks outside rewriting and leave addresses, paths and commands exact.

In the Tauri app the splitter lives in `delulu-domain` (`text/personalization.rs`) and the rewrite service in `delulu-speech` (`asr.rs`). `cargo test -p delulu-domain personalization` checks that exact multiline shortcut blocks stay outside rewriting; the per-preset service test with case-colliding blocks is not ported yet. Run `bun run test` for the complete unit suite. No check uses downloaded models, native inference, or personal text.

Protection applies to enabled saved shortcut expansions. Ordinary prose, arbitrary unsaved code, and model-generated factual correctness remain outside this guarantee. Rewriting remains optional Qwen 3.5 behavior; R2T2 speech is unchanged.
