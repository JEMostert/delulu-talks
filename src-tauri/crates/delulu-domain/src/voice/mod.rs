//! Shared contracts for spoken output: Delulu Voice.
//!
//! The markup follows Grok's text-to-speech design: one-off inline tags in
//! square brackets fire a single sound, and wrapping tags change how a span is
//! spoken. See docs/VOICE.md for the specification.

pub mod chunks;
pub mod markup;
pub mod speakable;

use serde::{Deserialize, Serialize};

use crate::serde_js;
use crate::types::{DownloadBytes, EnginePhase, RuntimeLifecycle, SetupStage, SetupState};
use delulu_core::DomainFailure;

string_enum! {
    /// Small runs Kokoro on any CPU; Large runs Chatterbox Turbo on a GPU, with tags.
    pub enum VoiceEngineId { Kokoro = "kokoro", ChatterboxTurbo = "chatterbox-turbo" }
}

pub const VOICE_ENGINES: &[VoiceEngineId] = VoiceEngineId::ALL;

pub fn is_voice_engine_id(value: &str) -> bool {
    VoiceEngineId::parse(value).is_some()
}

string_enum! {
    pub enum VoiceTier { Small = "small", Large = "large" }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEngineInfo {
    pub id: VoiceEngineId,
    pub tier: VoiceTier,
    pub name: &'static str,
    pub runtime: &'static str,
    pub description: &'static str,
    pub download_size: &'static str,
    pub license: &'static str,
    pub repository: &'static str,
    pub revision: &'static str,
    /// Whether non-verbal sounds and speaking styles are performed natively.
    pub expressive: bool,
}

pub const KOKORO_INFO: VoiceEngineInfo = VoiceEngineInfo {
    id: VoiceEngineId::Kokoro,
    tier: VoiceTier::Small,
    name: "Kokoro 82M",
    runtime: "CPU · sherpa-onnx",
    description: "Clear, natural speech on any CPU, about five times faster than real time. Pauses and pacing tags work; laughs, sighs and emotions are skipped.",
    download_size: "~330 MB",
    license: "Apache-2.0",
    repository: "csukuangfj/kokoro-multi-lang-v1_0",
    revision: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b",
    expressive: false,
};

pub const CHATTERBOX_INFO: VoiceEngineInfo = VoiceEngineInfo {
    id: VoiceEngineId::ChatterboxTurbo,
    tier: VoiceTier::Large,
    name: "Chatterbox Turbo",
    runtime: "GPU · PyTorch",
    description: "Expressive speech that really laughs, sighs and whispers. Can speak in a voice cloned from a short clip. About 3 GB of GPU memory.",
    download_size: "~4 GB with its runtime",
    license: "MIT",
    repository: "ResembleAI/chatterbox-turbo",
    revision: "749d1c1a46eb10492095d68fbcf55691ccf137cd",
    expressive: true,
};

/// `VOICE_ENGINE_INFO[id]`.
pub fn voice_engine_info(id: VoiceEngineId) -> &'static VoiceEngineInfo {
    match id {
        VoiceEngineId::Kokoro => &KOKORO_INFO,
        VoiceEngineId::ChatterboxTurbo => &CHATTERBOX_INFO,
    }
}

string_enum! {
    pub enum VoiceAccent { American = "American", British = "British" }
}

string_enum! {
    pub enum VoiceGender { Female = "female", Male = "male" }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOption {
    pub id: &'static str,
    pub label: &'static str,
    pub accent: VoiceAccent,
    pub gender: VoiceGender,
}

const KOKORO_SPEAKERS: &[(&str, &str)] = &[
    ("af_heart", "Heart"),
    ("af_bella", "Bella"),
    ("af_nicole", "Nicole"),
    ("af_sarah", "Sarah"),
    ("af_sky", "Sky"),
    ("af_nova", "Nova"),
    ("af_river", "River"),
    ("af_jessica", "Jessica"),
    ("af_kore", "Kore"),
    ("af_aoede", "Aoede"),
    ("af_alloy", "Alloy"),
    ("am_michael", "Michael"),
    ("am_fenrir", "Fenrir"),
    ("am_puck", "Puck"),
    ("am_eric", "Eric"),
    ("am_liam", "Liam"),
    ("am_onyx", "Onyx"),
    ("am_adam", "Adam"),
    ("am_echo", "Echo"),
    ("bf_emma", "Emma"),
    ("bf_isabella", "Isabella"),
    ("bf_alice", "Alice"),
    ("bf_lily", "Lily"),
    ("bm_george", "George"),
    ("bm_fable", "Fable"),
    ("bm_lewis", "Lewis"),
    ("bm_daniel", "Daniel"),
];

/// Kokoro v1.0 English speakers; ids are the speaker names in the model metadata.
pub fn kokoro_voices() -> Vec<VoiceOption> {
    KOKORO_SPEAKERS
        .iter()
        .map(|&(id, label)| VoiceOption {
            id,
            label,
            accent: if id.starts_with('a') { VoiceAccent::American } else { VoiceAccent::British },
            gender: if id.as_bytes()[1] == b'f' { VoiceGender::Female } else { VoiceGender::Male },
        })
        .collect()
}

pub const DEFAULT_KOKORO_VOICE: &str = "af_heart";

pub fn is_kokoro_voice(value: &str) -> bool {
    KOKORO_SPEAKERS.iter().any(|(id, _)| *id == value)
}

/* Markup vocabulary */

string_enum! {
    /// One-off sounds: `[laugh]`. Pauses are silence of a fixed length.
    pub enum VoiceEventTag {
        Laugh = "laugh",
        Chuckle = "chuckle",
        Sigh = "sigh",
        Gasp = "gasp",
        Cough = "cough",
        ClearThroat = "clear-throat",
        Sniff = "sniff",
        Groan = "groan",
        Shush = "shush",
    }
}

pub const VOICE_EVENT_TAGS: &[VoiceEventTag] = VoiceEventTag::ALL;

string_enum! {
    pub enum VoicePauseTag { Pause = "pause", LongPause = "long-pause" }
}

impl VoicePauseTag {
    /// Silence inserted by `[pause]` and `[long-pause]` (`VOICE_PAUSES`).
    pub const fn ms(self) -> u64 {
        match self {
            VoicePauseTag::Pause => 400,
            VoicePauseTag::LongPause => 1200,
        }
    }
}

string_enum! {
    /// Wrapping styles: `<whisper>…</whisper>`. Emotions (whisper … crying)
    /// are Chatterbox-only; slow … emphasis are prosody styles.
    pub enum VoiceStyle {
        Whisper = "whisper",
        Happy = "happy",
        Angry = "angry",
        Surprised = "surprised",
        Scared = "scared",
        Sarcastic = "sarcastic",
        Dramatic = "dramatic",
        Narration = "narration",
        Crying = "crying",
        Slow = "slow",
        Fast = "fast",
        Soft = "soft",
        Loud = "loud",
        Emphasis = "emphasis",
    }
}

pub const VOICE_EMOTION_STYLES: &[VoiceStyle] = &[
    VoiceStyle::Whisper,
    VoiceStyle::Happy,
    VoiceStyle::Angry,
    VoiceStyle::Surprised,
    VoiceStyle::Scared,
    VoiceStyle::Sarcastic,
    VoiceStyle::Dramatic,
    VoiceStyle::Narration,
    VoiceStyle::Crying,
];
pub const VOICE_PROSODY_STYLES: &[VoiceStyle] =
    &[VoiceStyle::Slow, VoiceStyle::Fast, VoiceStyle::Soft, VoiceStyle::Loud, VoiceStyle::Emphasis];
pub const VOICE_STYLES: &[VoiceStyle] = VoiceStyle::ALL;

impl VoiceStyle {
    pub fn is_emotion(self) -> bool {
        VOICE_EMOTION_STYLES.contains(&self)
    }
}

/* Worker wire format (voice runtime role) */

/// A synthesis request is a short run of parts that share one style set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoicePart {
    Text { text: String },
    Event { tag: VoiceEventTag },
    Pause { ms: u64 },
}

/// `VOICE_LIMITS`.
#[derive(Debug, Clone, Copy)]
pub struct VoiceLimits {
    /// Characters accepted from one speak request (Grok accepts 15,000).
    pub request_characters: usize,
    /// Text characters in one synthesis chunk sent to the worker.
    pub chunk_characters: usize,
    /// Parts in one synthesis chunk.
    pub chunk_parts: usize,
    /// Longest single pause.
    pub pause_ms: u64,
    /// Styles active at once.
    pub styles: usize,
    /// Audio the worker may return for one chunk.
    pub chunk_audio_seconds: u64,
    /// Utterances waiting behind the one being spoken.
    pub queue: usize,
}

pub const VOICE_LIMITS: VoiceLimits = VoiceLimits {
    request_characters: 15_000,
    chunk_characters: 600,
    chunk_parts: 200,
    pause_ms: 5_000,
    styles: 8,
    chunk_audio_seconds: 90,
    queue: 20,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSynthesizeRequest {
    pub engine: VoiceEngineId,
    /// Kokoro speaker id; ignored by Chatterbox.
    pub voice: String,
    /// Absolute path of a reference clip for Chatterbox voice cloning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(serialize_with = "serde_js::f64")]
    pub speed: f64,
    pub styles: Vec<VoiceStyle>,
    pub parts: Vec<VoicePart>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSynthesizeResult {
    pub sample_rate: u32,
    /// Base64 little-endian 16-bit mono PCM.
    pub audio: String,
    #[serde(serialize_with = "serde_js::f64")]
    pub duration_ms: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub processing_time_ms: f64,
    pub engine: VoiceEngineId,
    pub device: String,
    /// Tags and styles this engine could not perform; they were skipped.
    pub unsupported: Vec<String>,
}

/* Desktop service */

string_enum! {
    pub enum VoiceSource { App = "app", Agent = "agent", Clipboard = "clipboard" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeakRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<VoiceSource>,
    /// Display label of the speaking agent, such as "Claude Code".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Stop current speech and clear the queue first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupt: Option<bool>,
    /// Turn code, paths and identifiers into speakable words (default on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalize: Option<bool>,
    /// Caller's id for this spoken response; interruptions report it. Generated when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
}

/// Exact chunk boundaries, measured from the synthesized audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTimestamp {
    pub text: String,
    #[serde(serialize_with = "serde_js::f64")]
    pub start_ms: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub end_ms: f64,
}

string_enum! {
    pub enum VoiceUtteranceOutcome {
        Queued = "queued",
        Speaking = "speaking",
        Spoken = "spoken",
        Stopped = "stopped",
        Interrupted = "interrupted",
        Failed = "failed",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeakResult {
    pub id: String,
    pub response_id: String,
    pub outcome: VoiceUtteranceOutcome,
    #[serde(serialize_with = "serde_js::f64")]
    pub duration_ms: f64,
    pub timestamps: Vec<VoiceTimestamp>,
    /// Markup problems: unknown or unclosed tags.
    pub warnings: Vec<String>,
    /// Tags the selected engine skipped.
    pub unsupported: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `position` is how many utterances are ahead; 0 starts right away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceQueued {
    pub id: String,
    pub response_id: String,
    pub position: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceUtteranceSummary {
    pub id: String,
    pub at: u64,
    pub source: VoiceSource,
    pub agent: Option<String>,
    /// Spoken text without markup, truncated for display.
    pub text: String,
    pub outcome: VoiceUtteranceOutcome,
    #[serde(serialize_with = "serde_js::f64")]
    pub duration_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceBridgeStatus {
    pub enabled: bool,
    pub listening: bool,
    /// Agent connections open right now.
    pub clients: u64,
    pub endpoint: Option<String>,
    pub error: Option<String>,
}

string_enum! {
    pub enum VoicePhase { Idle = "idle", Synthesizing = "synthesizing", Speaking = "speaking" }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCurrentUtterance {
    pub id: String,
    pub text: String,
    pub source: VoiceSource,
    pub agent: Option<String>,
    pub chunk: u64,
    pub chunks: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    #[serde(flatten)]
    pub lifecycle: RuntimeLifecycle,
    pub engine: EnginePhase,
    pub phase: VoicePhase,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_stage: Option<SetupStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_state: Option<SetupState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<DownloadBytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<DomainFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_required: Option<bool>,
    pub model: Option<VoiceEngineId>,
    pub current: Option<VoiceCurrentUtterance>,
    pub queued: u64,
    pub recent: Vec<VoiceUtteranceSummary>,
    pub bridge: VoiceBridgeStatus,
}

/// Copyable setup for coding agents; paths are resolved on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAgentSetup {
    /// MCP server and CLI entry point, installed beside the bridge file.
    pub script_path: String,
    /// How to run it.
    pub command: Vec<String>,
    pub node_found: bool,
    pub claude_code: String,
    pub codex: String,
    pub json: String,
    pub shell: String,
    pub instructions: String,
}

/// What the CEO agent is told about speaking; also served as MCP instructions.
pub const VOICE_AGENT_INSTRUCTIONS: &str = "You can talk to the user out loud with the delulu-voice speak tool. You are the lead agent: other agents and threads report to you, and only you speak to the user. Treat the user as your board and give them short spoken briefings.

When to speak:
- When work is done, when you are blocked, when you need a decision, or when something important broke or changed.
- Not for routine progress, and never once per subtask.

How to speak:
- One to three short sentences, like a colleague talking, not a report.
- Never read code, diffs, file contents, logs or long lists aloud. Name the file or the outcome instead.
- Ask one clear question when you need a decision.

Expressive markup (Grok-style):
- One-off sounds: [laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush]
- Pauses: [pause] [long-pause]
- Wrapping styles: <whisper>…</whisper> <happy>…</happy> <angry>…</angry> <surprised>…</surprised> <scared>…</scared> <sarcastic>…</sarcastic> <dramatic>…</dramatic> <narration>…</narration> <crying>…</crying>
- Pacing and volume: <slow>…</slow> <fast>…</fast> <soft>…</soft> <loud>…</loud> <emphasis>…</emphasis>
Use tags sparingly, where a person would really do it: \"[sigh] the build still fails on the cache path. Want me to try another way?\"";
