//! Settings, vocabulary rules and the identifiers they select.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::serde_js;
use crate::voice::VoiceEngineId;
use crate::word_packs::WordPackId;

use super::HistoryRetentionPolicy;

string_enum! {
    pub enum Page {
        Home = "home",
        Lab = "lab",
        Models = "models",
        Vocabulary = "vocabulary",
        History = "history",
        Voice = "voice",
        Settings = "settings",
    }
}

string_enum! {
    pub enum SpeechModelId { R2t2 = "r2t2", R2t2Mlx = "r2t2Mlx" }
}

string_enum! {
    /// Speech model size the user picks: Small and Medium run on any CPU, Large is R2T2.
    pub enum SpeechTier { Small = "small", Medium = "medium", Large = "large" }
}

string_enum! {
    /// Historical Qwen speech results retain their identity; it is never an active engine.
    pub enum ModelId { R2t2 = "r2t2", R2t2Mlx = "r2t2Mlx", Qwen3Asr = "qwen3Asr" }
}

impl From<SpeechModelId> for ModelId {
    fn from(id: SpeechModelId) -> Self {
        match id {
            SpeechModelId::R2t2 => ModelId::R2t2,
            SpeechModelId::R2t2Mlx => ModelId::R2t2Mlx,
        }
    }
}

string_enum! {
    pub enum MagicModelId {
        Qwen35Small = "qwen35Small",
        Qwen35Medium = "qwen35Medium",
        Qwen35Large = "qwen35Large",
    }
}

string_enum! {
    pub enum MagicPreset {
        SpokenCorrections = "spoken-corrections",
        Polish = "polish",
        Concise = "concise",
        BulletPoints = "bullet-points",
        ProfessionalMessage = "professional-message",
        Structured = "structured",
        Prompt = "prompt",
    }
}

string_enum! {
    pub enum TranscriptSource { Dictation = "dictation", File = "file" }
}

string_enum! {
    pub enum PasteShortcut { Standard = "standard", Terminal = "terminal" }
}

string_enum! {
    pub enum ExportFormat { Txt = "txt", Json = "json", Md = "md" }
}

string_enum! {
    pub enum DictationFormatting { Preserve = "preserve", Spoken = "spoken" }
}

string_enum! {
    pub enum Theme { System = "system", Light = "light", Dark = "dark" }
}

string_enum! {
    pub enum ShortcutMode { Hold = "hold", Toggle = "toggle" }
}

string_enum! {
    pub enum MemoryPolicy { Independent = "independent", Balanced = "balanced" }
}

string_enum! {
    #[derive(Default)]
    pub enum VoiceCoordinatorMode {
        #[default]
        Off = "off",
        Lightweight = "lightweight",
        Conversational = "conversational",
    }
}


string_enum! {
    pub enum RuleKind { Correction = "correction", Shortcut = "shortcut" }
}

/// A vocabulary rule. Unknown persisted keys are preserved in `extra`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomWord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<RuleKind>,
    /// Omitted for legacy/global rules; scoped rules require a matching language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub id: String,
    pub term: String,
    pub sounds_like: String,
    /// Literal pronunciation/recognition variants; legacy soundsLike stays supported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    pub replacement: String,
    pub enabled: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Saved preferences. Unknown persisted keys are preserved in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u8>,
    /// Always 1.
    pub workflow_version: u8,
    pub onboarding_complete: bool,
    pub theme: Theme,
    pub shortcut: String,
    pub shortcut_mode: ShortcutMode,
    pub model: SpeechModelId,
    /// A language code, or "auto" where the speech engine detects it.
    pub language: String,
    pub dictation_formatting: DictationFormatting,
    pub python_command: String,
    pub input_device_id: String,
    pub input_device_label: String,
    pub trailing_silence_stop_enabled: bool,
    #[serde(serialize_with = "serde_js::f64")]
    pub trailing_silence_seconds: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub trailing_silence_threshold_db: f64,
    pub auto_paste: bool,
    pub paste_shortcut: PasteShortcut,
    #[serde(serialize_with = "serde_js::f64")]
    pub paste_last_delay_seconds: f64,
    pub copy_to_clipboard: bool,
    pub restore_clipboard_after_paste: bool,
    pub spoken_formatting_commands: bool,
    pub paste_portal_token: String,
    pub keep_history: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_retention: Option<HistoryRetentionPolicy>,
    pub show_overlay: bool,
    pub capture_sounds_muted: bool,
    /// Speech model size: Canary (small), Parakeet (medium) or R2T2 (large, GPU).
    pub speech_engine: SpeechTier,
    /// Saved transcripts beyond this many are removed, oldest first.
    #[serde(serialize_with = "serde_js::f64")]
    pub history_limit: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub capture_sound_volume: f64,
    pub preload_model: bool,
    pub magic_enabled: bool,
    pub magic_model: MagicModelId,
    pub magic_preset: MagicPreset,
    pub magic_allow_inferences: bool,
    pub preload_magic_model: bool,
    #[serde(serialize_with = "serde_js::f64")]
    pub model_idle_minutes: f64,
    pub memory_policy: MemoryPolicy,
    pub launch_at_login: bool,
    pub menu_bar_only: bool,
    pub custom_words: Vec<CustomWord>,
    /// Built-in word packs whose words apply alongside customWords.
    pub word_packs: Vec<WordPackId>,
    /// Send enabled vocabulary corrections to R2T2 as recognition hints.
    pub vocabulary_hints: bool,
    /// Spoken output. Off until the user turns it on in Voice.
    pub voice_enabled: bool,
    /// Kokoro (Small, CPU) or Chatterbox Turbo (Large, GPU, expressive).
    pub voice_engine: VoiceEngineId,
    /// Kokoro speaker id.
    pub voice_name: String,
    /// File name of a Chatterbox reference clip under voice/references; empty for the built-in voice.
    pub voice_clone: String,
    /// Speaking rate multiplier, 0.5–2.
    #[serde(serialize_with = "serde_js::f64")]
    pub voice_speed: f64,
    /// Playback volume, 0–1.
    #[serde(serialize_with = "serde_js::f64")]
    pub voice_volume: f64,
    /// Audio output device; "default" follows the system.
    pub voice_output_device_id: String,
    /// Starting a dictation stops speech, so you can answer right away.
    pub voice_interrupt_on_dictation: bool,
    /// Turn code, paths and identifiers into speakable words.
    pub voice_normalize_text: bool,
    /// Keep the voice model loaded instead of unloading it when idle.
    pub voice_keep_loaded: bool,
    /// Let local coding agents speak through the MCP server and CLI.
    pub voice_agent_bridge: bool,
    /// Optional local turn-taking helper; disabled for existing installations.
    #[serde(default)]
    pub voice_coordinator_mode: VoiceCoordinatorMode,
    /// Listening sessions: 0 hears only clear speech, 1 also quiet speech.
    #[serde(serialize_with = "serde_js::f64")]
    pub listen_sensitivity: f64,
    /// Quiet pause, in milliseconds, that ends an utterance.
    #[serde(serialize_with = "serde_js::f64")]
    pub listen_silence_ms: f64,
    /// Talking over Delulu stops its speech.
    pub listen_barge_in: bool,
    /// Sustained speech over playback, in milliseconds, needed to interrupt.
    #[serde(serialize_with = "serde_js::f64")]
    pub listen_barge_in_ms: f64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        crate::catalog::default_settings()
    }
}
