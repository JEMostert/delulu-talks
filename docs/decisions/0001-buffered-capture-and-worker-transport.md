# ADR 0001: buffered capture and request/response worker transport

Status: accepted current behavior; acoustic streaming deferred. Recorded 30 September 2026.

## Context

R2T2 weights can support streaming, but loading those weights does not implement a streaming application. Capture, cancellation, model inference, and delivery have different owners. A partial hypothesis must not accidentally become committed history or destination text.

## Decision

Keep the current stop-to-transcribe workflow explicit. The renderer microphone controller flushes its PCM worklet and produces mono 16 kHz WAV. Electron's dictation service owns submission, inference, optional rewriting, and delivery. Persistent speech/writing Python workers use request IDs and newline-delimited command/result messages; terminal responses use the `@delulu:` prefix. Worker progress and diagnostic logs do not become terminal transcription results.

The transport is a versioned request/response protocol with bounded messages and backend capability negotiation. It has no active acoustic-session messages, committed-prefix events, or renderer partial-text contract. MLX Audio's buffered `generate` and its chunk splitting are implementation details of one request, not live R2T2 streaming.

## Consequences and alternatives

This keeps one completed transcript as the history/delivery boundary and avoids pretending buffered chunks are stable partial results. Long audio still costs memory and end-of-speech latency. Shipping hypotheses through the existing terminal-response path would blur cancellation and delivery ownership, so that shortcut is rejected.

True streaming requires an explicit session protocol, ordering/cancellation rules, stable-prefix semantics, native backend evidence, and a visible partial-versus-committed distinction before clipboard or paste. Those are separate implementation issues, not an outcome of this record. Protocol versioning and worker message/queue bounds are implemented separately from acoustic streaming. The unfinished live-streaming experiment was removed during the unit-suite rebuild; buffered capture remains the accepted behavior.

Owners: [microphone controller](../../src/WorkspaceRoot.tsx), [dictation service](../../electron/services/dictation.ts), [worker client](../../electron/runtime/workerClient.ts), [Python worker](../../electron/python/transcription_engine.py). See [capture verification](../capture-verification.md) for fixture boundaries.
