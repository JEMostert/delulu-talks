//! Delulu Voice: spoken output, listening sessions, the local agent bridge
//! and the `delulu-talks mcp` server/CLI. Port of `electron/services/voice.ts`,
//! `listening.ts`, `voiceBridge.ts`, `backend/voice/delulu-voice-mcp.mjs` and
//! the voice orchestration in `electron/main.ts` / `electron/ipc/voice.ts`.
//!
//! The app crate implements two traits: [`VoiceProfile`] (settings, paths,
//! saving a settings patch) and [`ListenTranscriber`] (the speech service).
//! [`VoiceSystem`] wires the services together; the app only routes IPC
//! channels and builds the tray menu from [`VoiceSystem::tray_items`].

// `DomainError` is the workspace's shared (frozen) error contract.
#![allow(clippy::result_large_err)]

pub mod agent;
pub mod bridge;
pub mod client;
pub mod coordinator;
pub mod host;
pub mod listening;
pub mod mcp;
pub mod service;
pub mod system;

pub use agent::{
    agent_executable, install_voice_agent_script, install_voice_skill, refresh_legacy_agent_script, voice_agent_setup,
    MCP_SUBCOMMAND, VOICE_AGENT_SCRIPT,
};
pub use bridge::{
    bridge_endpoint, BridgeError, BridgeErrorCode, BridgeHandlers, BridgeResult, SpeakReply, VoiceBridge,
    VoiceBridgeSnapshot, VOICE_BRIDGE_FILE, VOICE_BRIDGE_PROTOCOL,
};
pub use host::{BoxFuture, ListenTranscriber, VoiceProfile};
pub use listening::{
    is_real_turn, sounds_like_own_speech, CaptureCommand, CaptureEvents, ListenBackend, ListenError, ListenErrorCode,
    ListeningService, NativeListenBackend, SpeechOutput,
};
pub use mcp::{run_cli, run_cli_with};
pub use service::{PlaybackEvents, ReadyCheck, SpeakHandle, VoiceOptions, VoicePlayback, VoiceService, VoiceWorker};
pub use system::{VoiceSystem, VoiceSystemConfig, VoiceTrayAction, VoiceTrayItem};
