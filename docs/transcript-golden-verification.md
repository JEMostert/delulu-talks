# Golden transcript verification

`tests/fixtures/golden-transcripts.json` contained invented Dutch and English transcripts with fixed source, personalization, correction, and rewrite expectations. Saved shortcut expansions include leading indentation, newlines, Unicode, a path containing a space, command flags, package versions, and punctuation.

The Electron app's service test (`electron/services/transcriptGolden.test.ts`) constructed the production `AsrService` and exercised personalization, `applyTranscriptEdit`, `rewriteMagic`, and delivery selection against this fixture, with only model loading and responses replaced. It was removed before the Tauri rewrite, together with the fixture and browser journey; currently `cargo test -p delulu-domain personalization` keeps exact multiline shortcut blocks outside rewriting and leaves addresses, paths and commands exact. Exact shortcut blocks must never reach the model, and the service must reassemble their bytes unchanged.

The browser tests exercised the real History review controls: inspect speech and result, save a correction, generate a rewrite preview, explicitly apply it, undo it, and restore the personalized result. They asserted `textContent` directly to detect whitespace corruption that normalized text matching could conceal. They also verified that a preview does not change the current result, apply/undo pass the expected current-text baseline, and the original speech survives every operation. Desktop IPC and rewrite output are fixture-backed; persistence and native inference were not exercised by these browser cases.

Run:

```sh
cargo test -p delulu-domain personalization
```

The browser journey (`tests/e2e/transcript-golden.pw.ts`) and the fixture file are no longer in the repository; the record below describes those removed checks.

Two temporary regression experiments demonstrated that the service cases fail when protected blocks are sent to the model or when a correction overwrites the source transcript. Both mutations were removed before committing.

These are deterministic regression tests for transformations and review journeys. They establish neither recognition accuracy nor Qwen output quality. Protected blocks are registered shortcut expansions; arbitrary code-like text is not promised model-independent preservation. No microphone, downloaded model, GPU, native Mac/Windows inference, or personal transcript is required.
