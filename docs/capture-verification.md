# Capture verification

Capture is native in the Tauri app: `src-tauri/crates/delulu-audio` records through cpal on its own thread, encodes 16 kHz mono WAV and reports levels, trailing silence, limits and input loss. The renderer only displays the recorder's state.

## Current checks

- `cargo test -p delulu-audio`: recorder block processing, levels and retained audio, the sample cap, the trailing-silence countdown, pause/resume, 16 kHz WAV encoding with cancellation, resampling, the voice-activity detector and the playback queue. These run without a microphone.
- `cargo test -p delulu-audio -- --ignored --nocapture`: an opt-in hardware smoke test that records from the default input while a listening capture is open, then plays a tone and a capture cue.
- `cargo test -p delulu-speech`: the dictation state machine over a fake recorder: a release before the microphone opens stops that capture once, failed inference keeps its audio for one retry, audio stopped while paused is transcribed exactly once, an unacknowledged pause fails the capture, presses during paste never open the microphone, silence and quick taps are not microphone errors, and a lost input keeps its audio.
- `bunx playwright test tests/e2e/recording.pw.ts`: the renderer's controls and microphone picker follow the desktop status and device list.

## Capture command ownership

The dictation service creates a unique session ID for each accepted Start. UI, tray and shortcut controls share this service, so duplicate Starts do not acquire another identity. Pause, resume, stop and cancel reach the native recorder with that ID. Stop commits audio only for the current stopping session and consumes its ID before processing, so duplicate or abandoned submissions cannot create another transcript or delivery. Cancel consumes the ID immediately. A retained failed recording remains available through the explicit Retry path.

These checks do not establish physical microphone or hotplug behavior on every platform, OS hotkey registration, native tray input, system paste, or MLX/CUDA inference. Those retain their separate hardware/manual evidence requirements.
