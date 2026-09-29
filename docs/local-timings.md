# Local pipeline timings

Each completed transcript may carry optional `timings` in milliseconds, retained in history and JSON exports. Rewrite previews show their measured readiness wait and worker round trips; applying a rewrite retains those measurements. No timing is reconstructed from text, file size, model settings or another operation.

- Capture finalization measures stopping/flushing/disposing the microphone graph, excluding measured PCM preparation.
- Audio preparation measures PCM merging/resampling/WAV encoding plus local recording writes, or imported-file decoding.
- Speech/writing readiness waits measure the service awaiting readiness, including any required load; a warm resident model can report a small wait.
- Worker round trips measure request completion and include protocol/processing overhead. They are not pure native inference measurements.
- Backend preprocessing and speech inference are measured at adapter boundaries. Internal vLLM preprocessing is opaque and is not reported as a separate measured stage.
- Clipboard publication measures Electron and any required desktop clipboard publication. Paste dispatch excludes that copy and includes permission/injection delays; it does not establish that the target application accepted the text.

Nested stages overlap. Do not sum the fields to obtain end-to-end latency. Missing fields mean unmeasured, and legacy aggregate processing-time fields keep their existing meaning. Measurements use process-local monotonic clocks; no cross-process timestamps are subtracted. No content, paths or telemetry are added by these fields.

UNVERIFIED: tests, builds, typechecks, formatting, browser/native inference, benchmarking and packaging checks were skipped under issues-only instructions. Later verification must cover adapters, persistence and delivery failures. Native GPU performance claims require actual measurements.
