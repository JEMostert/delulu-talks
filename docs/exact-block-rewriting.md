# Exact saved blocks during rewriting

All four writing presets—Polish, Shorten, Organize, and Build a prompt—use the same service boundary. The service separates enabled saved shortcut blocks from surrounding prose before calling the model. It copies the protected blocks directly into the result and retains their separators. Spoken shortcut triggers still expand to the saved replacement.

Already expanded blocks must preserve their own bytes. Two enabled saved blocks can differ only in case: for example, `https://API.Example` and `https://api.example`. Case-insensitive trigger matching previously chose the first rule for both blocks and could silently change a command URL, flag, or identifier. `splitForRewrite` now recognizes an exact existing saved replacement before choosing the matching trigger's expansion, preserving the block actually present in the source.

`electron/services/protectedRewrite.test.ts` runs the production service once per preset with deterministic model output. It covers repeated case-colliding blocks, CRLF, tabs, leading indentation, Unicode, surrounding prose, case-insensitive spoken triggers, and a blocks-only result with zero model requests. A failure on the final prose segment rejects the operation instead of returning an incomplete rewrite; the unchanged source can be explicitly retried. All four new cases fail against the previous splitter and pass with the preservation fix.

Run `bun test electron/services/protectedRewrite.test.ts` for these contracts or `bun run test` for the complete unit evidence report. Electron imports and model loading/output are stubbed in isolated subprocesses. The splitter and service assembly run as production code, without downloaded models, native inference, or personal text.

Protection applies to enabled saved shortcut expansions. Ordinary prose, arbitrary unsaved code, and model-generated factual correctness remain outside this guarantee. Rewriting remains optional Qwen 3.5 behavior; R2T2 speech is unchanged.
