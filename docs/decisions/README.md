# Architecture decisions

These records explain the current implementation choices and their limits. They do not close the separate streaming, native inference, durable storage, or protocol-hardening implementation gates.

- [0001: buffered capture and worker transport](0001-buffered-capture-and-worker-transport.md)
- [0002: R2T2 speech and platform backends](0002-r2t2-speech-and-platform-backends.md)
- [0003: isolated runtime generations](0003-isolated-runtime-generations.md)
- [0004: local JSON history and text layers](0004-local-json-history-and-text-layers.md)
- [0005: local voice output with a lead-agent bridge](0005-local-voice-output.md)
- [0006: Tauri shell, Rust backend and native audio](0006-tauri-and-native-audio.md)

Future changes should update or supersede the relevant record while preserving why the previous choice existed.
