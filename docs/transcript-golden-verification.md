# Golden transcript verification

`tests/fixtures/golden-transcripts.json` contains invented Dutch and English transcripts with fixed source, personalization, correction, and rewrite expectations. Saved shortcut expansions include leading indentation, newlines, Unicode, a path containing a space, command flags, package versions, and punctuation.

The service tests construct the production `AsrService` and exercise personalization, `applyTranscriptEdit`, `rewriteMagic`, and delivery selection. Only model loading and model responses are replaced. Expected prose requests and output strings are stored independently in the fixture. Exact shortcut blocks must never reach the model, and the service must reassemble their bytes unchanged. The Electron import is isolated in a child process so its mock cannot affect other unit suites.

The browser tests exercise the real History review controls: inspect speech and result, save a correction, generate a rewrite preview, explicitly apply it, undo it, and restore the personalized result. They assert `textContent` directly to detect whitespace corruption that normalized text matching could conceal. They also verify that a preview does not change the current result, apply/undo pass the expected current-text baseline, and the original speech survives every operation. Desktop IPC and rewrite output are fixture-backed; persistence and native inference are not exercised by these browser cases.

Run:

```sh
bun test electron/services/transcriptGolden.test.ts
bun run test:e2e -- tests/e2e/transcript-golden.pw.ts
```

Two temporary regression experiments demonstrated that the service cases fail when protected blocks are sent to the model or when a correction overwrites the source transcript. Both mutations were removed before committing.

These are deterministic regression tests for transformations and review journeys. They establish neither recognition accuracy nor Qwen output quality. Protected blocks are registered shortcut expansions; arbitrary code-like text is not promised model-independent preservation. No microphone, downloaded model, GPU, native Mac/Windows inference, or personal transcript is required.
