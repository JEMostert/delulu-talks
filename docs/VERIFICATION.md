# Verification evidence

A passing test command proves its stated scope. It does not validate an untested
platform, real model, physical microphone, focus behavior, or automatic paste.
Use the reporting commands below for review handoffs. Every run prints its
boundary and writes an ignored JSON report in `artifacts/verification/`, including
HEAD, dirty working-tree state, OS/architecture, exact command, timestamps, exit
status, scope and all four evidence categories. Failures produce failed evidence
and retain the failing exit code. Unperformed categories remain `not-run`.

| Command                                            | Evidence              | Actual boundary                                                                                                                                                 |
| -------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                                     | fixture-only + mocked | Logic, temporary storage/process fixtures and mocked Electron/model adapters. No GPU model.                                                                     |
| `bun run test:python`                              | mocked                | Python adapter contracts with fake framework/model modules.                                                                                                     |
| `bun run test:e2e`                                 | mocked                | Real Chromium and synthetic audio capture with preview/mock backend IPC.                                                                                        |
| `bun run test:desktop`                             | fixture-only          | Real isolated Electron, preload, IPC and persistence; no inference or manual delivery check.                                                                    |
| `bun run test:mac-package -- path/to/App.app`      | fixture-only          | Actual Mac package replacement/relaunch with synthetic stored data. The reporting command rejects runtime arguments; use a separate native transcription check. |
| `bun run test:native -- …`                         | native-inference      | Explicit cached-model transcription on the machine running the command.                                                                                         |
| `bun run test:manual -- --record observation.json` | manual-desktop        | Human-observed evidence, recorded as an attestation rather than automated approval.                                                                             |

Here `fixture-only` means behavior without model inference. A native inference
run can use fixture audio and still belongs to `native-inference`. An automated
Electron check is not a manual desktop observation. Typecheck, format and build
are static checks and carry no functional evidence category. Direct `bun test`,
Python unittest, Playwright or smoke-script calls remain useful for investigation
but do not generate the review evidence artifact; rerun the reporting command
before handing off a complete suite result.

`bun run test:evidence` lists evidence for the current HEAD, preserving every
run's result and dirty state; it does not turn a previous failure into a pass or
combine different SHAs into one approval. CI uses the reporting commands and
uploads reports even after a failed suite. Browser reporting requires its own
server on an automatically selected unused port and refuses to reuse another checkout's existing preview. The port is recorded with the result. Skipped CI steps have no report and
therefore establish no evidence. Reports describe suite boundaries, not a
coverage guarantee for every assertion or branch. Reporting commands run complete suites and reject filters/help/list options that could produce a success without executing tests. Use raw commands for targeted investigations. Record skipped cases and
limitations in the PR handoff. Reports from dirty trees need a clean committed
rerun for an exact-SHA review.

## Opt-in native checks

Ordinary tests never load or download speech/rewrite models. Native checks use
the already-installed runtime and pre-downloaded cache, with offline mode enabled.
Provide a local metadata JSON file describing the actual hardware and installed
checkpoint/runtime revisions; these fields are explicitly **supplied metadata**,
not values discovered or independently validated by the reporting wrapper.
The smoke scripts additionally emit a private observation containing the worker model identity or application transcript model attribution, selected backend, fixture SHA-256 and nonempty transcript length.
The runtime smoke records the worker's actual model/device and installed package
versions; the desktop smoke records application transcript model attribution and Electron's
platform backend selection. The wrapper requires this observation and rejects
non-R2T2 results or a backend mismatch, even if the command exits successfully.
It records sizes and timings, never the transcript. Supply provenance separately:

```json
{
  "modelId": "r2t2",
  "backend": "cuda-vllm",
  "hardware": "Actual GPU/Mac model and memory",
  "modelRevision": "Installed checkpoint commit",
  "runtimeRevision": "Installed package versions or runtime revision"
}
```

Use `mlx`, `cuda-vllm` or `cuda-transformers` for the corresponding speech
backend. Replace the descriptive values with actual observed values. Run:

```sh
bun run test:native -- --metadata /path/native-metadata.json --python /path/to/runtime/python --cache /path/to/cached-models
bun run test:desktop -- --metadata /path/native-metadata.json /path/to/runtime-data
```

The native smoke transcribes `test-audio.m4a`; this establishes execution, not
Dutch/English recognition accuracy. Add `--magic` to the native command or
`--writing` to the desktop command only when verifying the separately installed
optional rewriting runtime. Desktop `--lifecycle` exercises repeated native
speech load/unload. These checks are opt-in and fail when their prerequisites
are unavailable. A failed load/inference produces failed native evidence. The package reporting command rejects runtime arguments because a native warmup cannot be called fixture-only; use the native or desktop transcription command for inference evidence.

## Manual desktop observations

Create a local observation JSON file after actually performing the checks. Set
`sha` to the full tested HEAD and record the native platform, observer, time,
hardware, expected/observed behavior, failures and artifact references. This
example documents the shape, not a completed observation:

```json
{
  "kind": "manual-desktop",
  "sha": "FULL_TESTED_COMMIT_SHA",
  "observer": "Observer name",
  "observedAt": "2026-09-29T12:00:00Z",
  "platform": "linux",
  "hardware": "Actual desktop and devices",
  "checks": [
    {
      "action": "Record fixture speech and paste into the chosen editor",
      "expected": "Exactly one transcript in the intended destination",
      "observed": "Describe the actual result",
      "result": "passed"
    }
  ],
  "artifacts": ["Local recording/screenshot or observation log reference"],
  "limitations": "Checks/platforms not exercised, or none"
}
```

Use `failed` for an unsuccessful check; the recording command then exits with a
failure. Successful human observations are `recorded`, distinct from an automated
`passed` result. The wrapper validates the record structure and HEAD, not the
truth of a human observation. Keep transcript contents and personal paths out of
published evidence. Local reports are ignored by Git; review their contents
before sharing them. Historical Mac Qwen/vLLM results do not validate the current
R2T2 MLX adapter.
