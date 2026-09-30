# Audio chunk protocol (STR-01)

Status: specified, implementation helpers available, transport/inference activation disabled. The current R2T2 MLX/CUDA runtimes continue to accept whole-recording `transcribe` requests. This contract does not establish incremental audio inference, stable partial text, hardware support or latency improvement. Generated-token streaming is not audio streaming.

Shared types, payload validation and the bounded receiver state live in `src/audioStreamProtocol.ts`. Reserved commands `streamStart`, `streamChunk`, `streamFinalize` and `streamCancel` are rejected by the current worker request validator. A future adapter must explicitly negotiate audio-stream version 1 and genuine incremental-audio support before sending them. Worker protocol version 1 remains unchanged.

## Identity and framing

Each stream message has `streamVersion: 1`, a globally fresh session ID (use a UUID), and its typed `kind`. The existing JSON-lines request envelope would carry `protocolVersion`, a unique request `id`, the reserved command and the stream payload. Request IDs identify individual request/replies; session IDs identify the recording. Streaming events use the same session ID and a separate event route; they must not resolve unrelated pending request IDs.

Allow one active audio session per speech worker generation. The adapter must check both the originating process generation and session ID before delivery. Do not reuse session IDs after cancellation, finalization, worker exit, timeout or restart. Reject foreign session input and ignore stale output from abandoned generations. IDs are ASCII letters, digits, underscores or hyphens, 1–128 characters.

## Audio and ordering

`start` declares mono 16,000 Hz `pcm-f32le`. A chunk holds standard padded base64 of little-endian float32 samples. Resample once at capture ingress; preserve continuous sample positions. The decoder must reject non-finite PCM samples before inference (the shared JSON helper validates encoded size, not float values).

Chunk `sequence` begins at zero and increases by exactly one. `offsetSamples` begins at zero and equals the sum of preceding sample counts. No gaps, repeats, overlaps, silence fabrication or reordering are allowed. Count actual samples, not wall-clock duration. Each nonempty chunk contains at most 16,000 samples (one second / 64,000 decoded bytes). The receiver validates session, version, payload length, sequence, offset and budgets before mutating state; a rejected chunk does not advance counters.

## Credits and bounded retention

The receiver retains at most eight chunks and 32,000 samples (two seconds / 128,000 decoded bytes, approximately 171 KB base64). It retains the in-flight head until inference consumes it; accepting a chunk does not return buffer credit. `peekChunk()` returns the head, `consumeChunk(sequence)` releases only that head, and `credit()` reports the next accepted sequence, consumed chunk count and remaining sample/chunk capacity. The `AudioStreamSession` helper owns this bounded unconsumed queue.

Total accepted audio is capped at 9,600,000 samples (ten minutes). Base64 payload validation occurs before retention; the enclosing transport must enforce serialized request/line byte limits before parsing. Transcript/event text must also be bounded; use at most 500,000 characters per transcript/final and 8,000 UTF-8 bytes for errors, consistent with existing worker responses. A future event parser must validate these limits and strictly increasing revision numbers.

The sender must honor both credits, allow at most one unacknowledged chunk request, and pause transmission at exhaustion. Do not accumulate an unbounded sender retry queue: keep at most the same eight chunks/two seconds in memory, including pending transmission. Preserve the original recording using the existing bounded capture/recovery path or a bounded disk spool for whole-recording fallback. If capture outruns available buffering, stop streaming, retain recoverable original audio and report the limit; never silently drop samples. Credits are absolute snapshots, applied in request order, not additive grants. A full receiver rejects admission without mutation; retry the identical chunk after consumption frees credit.

## Finalization and transcript stability

After the last chunk acceptance reply, send exactly one `finalize` with `chunkCount` equal to the next sequence and `totalSamples` equal to the accepted sample sum. A mismatch leaves the session open. A valid finalize moves it to draining; subsequent chunks, start and repeated finalize are rejected. Empty sessions may finalize with both counts zero.

Drain every accepted chunk in order, then flush backend state. Only then call `finish(text)` and emit exactly one final result. A second finish is rejected. Final output describes the full accepted audio, and only that result enters the normal final transcript/history/paste flow.

Partial `transcript` events carry strictly increasing `revision`, `committedText` and `provisionalText`. Committed text must be a prefix extension of its previous value; provisional text may change. Final text must preserve the last committed prefix. If the backend cannot guarantee those semantics, advertise partial audio support without committed text, or keep streaming disabled. Partial events never overwrite the preserved original final transcript or trigger auto-paste. The shared session helper validates audio/session lifecycle; transcript revision/prefix enforcement belongs to the future event adapter.

## Cancellation and failures

`cancel` can interrupt open or draining sessions. It clears queued PCM immediately and is idempotent for an already cancelled session. The adapter must stop in-flight backend work, suppress its late output, release backend session state, and emit `cancelled` only after those actions are complete. Cancellation does not erase the owner's original recording, raw transcripts or existing history. A final session cannot be cancelled retroactively.

A worker exit, request timeout, decode/inference failure or protocol violation terminates the stream; stop admission, release worker session state and suppress subsequent events. Retain original audio for explicit whole-recording retry. Do not automatically restart and append to a partial session: the next attempt uses a new generation/session ID and begins at sequence zero. The helper throws admission/state errors without silently clearing accepted audio; the adapter owns fatal-error cleanup and deadline enforcement. Existing transport and operation timeouts remain mandatory, including cancellation acknowledgement and final drain deadlines.

## Deferred integration

The helper is not attached to microphone capture, Python workers, inference or renderer events. Backend-specific decoding, capability negotiation, process-generation filtering, event validation, committed-prefix enforcement and cancellation/deadline execution remain activation prerequisites. Native incremental-audio behavior and latency claims require later measurements. Tests, builds, typechecks and native checks were not run for this change per current collaboration mode; it is UNVERIFIED.
