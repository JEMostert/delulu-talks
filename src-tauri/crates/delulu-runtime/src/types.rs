//! Minimal local copies of `src/types.ts`, `src/voice.ts` and
//! `src/recognitionHints.ts` values this crate needs. They serialize exactly
//! like the TypeScript unions so they can be unified with `delulu-domain`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SpeechModelId {
    #[serde(rename = "r2t2")]
    R2t2,
    #[serde(rename = "r2t2Mlx")]
    R2t2Mlx,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechTier {
    Small,
    Medium,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MagicModelId {
    #[serde(rename = "qwen35Medium")]
    Qwen35Medium,
    #[serde(rename = "phi4Mini")]
    Phi4Mini,
    #[serde(rename = "qwen35Small")]
    Qwen35Small,
    #[serde(rename = "qwen35Large")]
    Qwen35Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceEngineId {
    Kokoro,
    ChatterboxTurbo,
}

impl VoiceEngineId {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "kokoro" => Some(Self::Kokoro),
            "chatterbox-turbo" => Some(Self::ChatterboxTurbo),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupStage {
    RuntimeCheck,
    RuntimePrepare,
    RuntimePackages,
    RuntimeDownload,
    RuntimeInstall,
    RuntimeBuild,
    RuntimeValidate,
    ModelPrepare,
    ModelDownload,
    ModelLoad,
    ModelConversion,
    Warmup,
    ModelLoaded,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadBytesKind {
    Transfer,
    Reconstruction,
}

/// Observed downloader counters; aggregate totals may change during discovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadBytes {
    pub completed: u64,
    pub total: Option<u64>,
    pub kind: DownloadBytesKind,
}

/// `MAX_RECOGNITION_HINT_CHARS` from `src/recognitionHints.ts`.
pub const MAX_RECOGNITION_HINT_CHARS: usize = 3000;

/// `VOICE_EVENT_TAGS` from `src/voice.ts`.
pub const VOICE_EVENT_TAGS: &[&str] =
    &["laugh", "chuckle", "sigh", "gasp", "cough", "clear-throat", "sniff", "groan", "shush"];

/// `VOICE_STYLES` (emotion then prosody styles) from `src/voice.ts`.
pub const VOICE_STYLES: &[&str] = &[
    "whisper", "happy", "angry", "surprised", "scared", "sarcastic", "dramatic", "narration", "crying",
    "slow", "fast", "soft", "loud", "emphasis",
];

/// The worker-relevant subset of `VOICE_LIMITS` from `src/voice.ts`.
pub mod voice_limits {
    pub const CHUNK_CHARACTERS: usize = 600;
    pub const CHUNK_PARTS: usize = 200;
    pub const PAUSE_MS: f64 = 5_000.0;
    pub const STYLES: usize = 8;
    pub const CHUNK_AUDIO_SECONDS: f64 = 90.0;
}
