# Audio capture boundary

All speech backends use buffered dictation. The renderer captures microphone audio, flushes the final worklet batch, releases capture resources, and submits the complete recording through validated IPC. The main process writes a temporary WAV for the local worker, then preserves the transcript before clipboard/paste delivery.

The unfinished live-streaming experiment and unused acoustic-stream prototype were removed during the unit test rebuild. The evaluated upstream rolling API could lose held-back final tokens or join words incorrectly across audio windows; the alternate API repeatedly processed cumulative audio. Neither route met the app's text-preservation and development-maintenance goals.

There is no active streaming IPC, PCM sender, live paste session, or streaming worker adapter. Worker requests reject unsupported stream commands and `streaming: true`. [Worker transport bounds](worker-bounds.md) still apply to buffered requests and results.

The retained Chromium tests verify final partial audio delivery, repeated stop/cancel safety, and resource cleanup. Focused dictation units verify capture identity, inference failure/retry, delivery truth, and history privacy. See [testing](VERIFICATION.md) for commands.
