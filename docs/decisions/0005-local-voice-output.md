# ADR 0005: local voice output with a lead-agent bridge

Status: accepted. Recorded 22 October 2026. Linux CUDA validated on the reference machine; Mac and Windows voice runtimes pending native validation.

## Context

Delulu Talks turns speech into text. Coding agents answer in text the user has to read. The goal is a spoken loop: the user dictates to one lead agent, the lead agent coordinates its own subagents or threads, and only the lead agent speaks back, briefly and expressively. Grok's text-to-speech is the model for the interface: text in, audio out, inline tags for one-off sounds, wrapping tags for styles, streaming, and timestamps.

## Decision

Add a third Python runtime role, `voice`, with its own environment and worker, following ADR 0003. Offer two pinned models: Kokoro 82M through sherpa-onnx on the CPU (Small) and Chatterbox Turbo on PyTorch (Large, expressive, voice cloning). Chatterbox Turbo was chosen over Orpheus because it is MIT-licensed and ungated, needs about 3 GB of GPU memory instead of 7, runs about five times faster than real time on the reference GPU, and has native tokens for the sounds and styles the markup needs.

Parse markup and plan chunks in TypeScript (`src/voiceMarkup.ts`, `src/voiceChunks.ts`). The worker synthesizes one chunk per request and returns PCM, which keeps the existing request/response protocol: streaming comes from synthesizing the next chunk while the renderer plays the current one. Each engine adapter maps markup to what it can perform and reports what it skipped, instead of failing.

Coding agents reach Delulu through a token-protected local socket and a dependency-free MCP server/CLI copied into the user data directory. Delulu does not integrate with any particular agent product; Claude Code, Codex and T3 Code's providers all speak MCP. How the lead agent decides when to speak is an instruction to that agent, served as MCP instructions and copyable from the Voice page, not logic in Delulu.

## Consequences and alternatives

The voice runtime pins PyTorch 2.11 independently of speech and rewriting, because torchaudio stopped at 2.11 and Chatterbox needs it. `chatterbox-tts` is installed without its own dependency pins (PyTorch 2.6, Gradio), so `pip check` accepts exactly those known lines. Upgrading Chatterbox needs the import set re-verified.

Rejected: a single shared Python environment; vLLM-served Orpheus (gated weights, heavy, Linux-only serving); training a model; a network HTTP server (the socket is reachable only by the same user and needs no port); automatic integration with each agent's configuration files (Delulu shows commands instead of editing other tools' settings).

Starting a dictation interrupts speech by default, so the microphone does not record Delulu's own voice.

Owners (since ADR 0006): [contracts](../../src/voice.ts), [markup](../../src/voiceMarkup.ts), [speakable text](../../src/speakableText.ts), [chunks](../../src/voiceChunks.ts), [player](../../src-tauri/crates/delulu-audio/src/player.rs), [service](../../src-tauri/crates/delulu-voice/src/service.rs), [bridge](../../src-tauri/crates/delulu-voice/src/bridge.rs), [MCP server](../../src-tauri/crates/delulu-voice/src/mcp.rs), [engine](../../backend/python/voice_engine.py), [manifest](../../src-tauri/crates/delulu-runtime/src/manifest.rs). See [Siren](../SIREN.md).

## Amendment (v0.1.0, ADR 0006)

Playback and listening capture are native (`delulu-audio`), and the backend runs the markup and chunk logic in Rust (`delulu-domain::voice`). The MCP server and CLI are built into the app as `delulu-talks mcp`, so agents no longer need Node and nothing is copied into the user data directory. Listening mode has no WebRTC echo cancellation; see [ADR 0006](0006-tauri-and-native-audio.md).
