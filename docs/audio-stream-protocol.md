# Audio capture and live typing

Every recording is captured completely, whatever else happens. The renderer captures microphone audio, flushes the final worklet batch, releases capture resources and submits the complete recording through validated IPC. The main process writes a temporary WAV for the local worker and preserves the transcript before clipboard or paste delivery. That buffered path is the source of truth for History.

## Live typing (v0.12.0)

When live typing is allowed, the same capture session also forwards audio while you speak:

1. The renderer converts captured samples to 16-bit PCM at the device's native rate and sends roughly every 200 ms over `recorder:stream` (`sessionId`, `sampleRate` 8–192 kHz, base64 PCM ≤ 300 kB). Pending samples are flushed before the final buffered merge.
2. The main process forwards each chunk, strictly in order, to the speech worker with `streamStart`, `streamAudio` and `streamFinish`. The worker resamples to 16 kHz with a stateful soxr stream, so chunk edges do not click.
3. Nemotron 3.5 Streaming decodes cache-aware RNNT chunks natively (560 ms look-ahead) and returns each new word. R2T2 has no incremental decoder in Transformers, so `PauseStreamer` cuts the audio at pauses of about 450 ms (or 12 s of continuous speech) and transcribes each phrase.
4. `LiveTyping` in the main process shapes every delta with the user's corrections and pastes it at the cursor. Pastes are serialized and coalesced, so text always lands in spoken order.

Live typing is allowed only when automatic paste is on, rewriting is off, spoken punctuation commands are off, the paste method can type, and the backend reports `streaming: true` (CUDA and CPU; not MLX). Otherwise the recording is delivered as before.

If the stream fails midway, nothing else is pasted: the full buffered transcript is copied to the clipboard instead, and the History record notes what happened. A cancelled recording drops the stream without pasting. The saved record carries delivery method `live`.

[Worker transport bounds](worker-bounds.md) apply to stream requests as well. Unit tests cover ordering, coalescing, failure and fallback (`electron/services/liveTyping.test.ts`, `dictation.test.ts`, `electron/python/live_segments_test.py`).
