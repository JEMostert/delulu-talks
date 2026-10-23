//! Defaults and catalogs: `src/data.ts`, `src/rewritePresets.ts`,
//! `src/audioFormats.ts` and `src/captureLimits.ts`.

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Map;

use crate::types::*;
use crate::voice::{VoiceEngineId, DEFAULT_KOKORO_VOICE};

pub const DEFAULT_SHORTCUT: &str = "Super+Z";
pub const LEGACY_DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

pub fn default_settings() -> AppSettings {
    AppSettings {
        schema_version: Some(1),
        workflow_version: 1,
        onboarding_complete: false,
        theme: Theme::System,
        shortcut: DEFAULT_SHORTCUT.into(),
        shortcut_mode: ShortcutMode::Hold,
        model: SpeechModelId::R2t2,
        language: "en".into(),
        dictation_formatting: DictationFormatting::Preserve,
        python_command: "python3".into(),
        input_device_id: "default".into(),
        input_device_label: "System default".into(),
        trailing_silence_stop_enabled: false,
        trailing_silence_seconds: 5.0,
        trailing_silence_threshold_db: -45.0,
        auto_paste: true,
        paste_shortcut: PasteShortcut::Standard,
        paste_last_delay_seconds: 3.0,
        copy_to_clipboard: true,
        restore_clipboard_after_paste: false,
        spoken_formatting_commands: false,
        paste_portal_token: String::new(),
        keep_history: true,
        history_retention: Some(HistoryRetentionPolicy { max_age_days: None, max_count: None }),
        show_overlay: true,
        capture_sounds_muted: true,
        speech_engine: SpeechTier::Medium,
        history_limit: 50.0,
        capture_sound_volume: 0.15,
        preload_model: true,
        magic_enabled: false,
        magic_model: MagicModelId::Qwen35Medium,
        magic_preset: MagicPreset::Polish,
        magic_allow_inferences: false,
        preload_magic_model: false,
        model_idle_minutes: 15.0,
        memory_policy: MemoryPolicy::Independent,
        launch_at_login: false,
        menu_bar_only: false,
        custom_words: Vec::new(),
        word_packs: Vec::new(),
        vocabulary_hints: true,
        voice_enabled: false,
        voice_engine: VoiceEngineId::Kokoro,
        voice_name: DEFAULT_KOKORO_VOICE.into(),
        voice_clone: String::new(),
        voice_speed: 1.0,
        voice_volume: 0.9,
        voice_output_device_id: "default".into(),
        voice_interrupt_on_dictation: true,
        voice_normalize_text: true,
        voice_keep_loaded: false,
        voice_agent_bridge: false,
        voice_coordinator_mode: VoiceCoordinatorMode::Off,
        listen_sensitivity: 0.5,
        listen_silence_ms: 900.0,
        listen_barge_in: true,
        listen_barge_in_ms: 300.0,
        extra: Map::new(),
    }
}

/// `DEFAULT_SETTINGS` as JSON, for key and type checks.
pub static DEFAULT_SETTINGS_JSON: LazyLock<serde_json::Map<String, serde_json::Value>> = LazyLock::new(|| {
    match serde_json::to_value(default_settings()) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => unreachable!("settings serialize to an object"),
    }
});

fn variant(label: &str, revision: Option<&str>, conversion: &str, attribution_url: Option<&str>) -> ModelVariant {
    ModelVariant {
        label: label.into(),
        revision: revision.map(Into::into),
        conversion: conversion.into(),
        attribution_url: attribution_url.map(Into::into),
    }
}

const R2T2_LICENSE_NAME: &str = "NetEase Youdao Model Use License Agreement";
const R2T2_LICENSE_URL: &str = "https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE";

fn rewrite_provenance(repo: &str) -> ModelProvenance {
    ModelProvenance {
        license_name: "Apache 2.0".into(),
        license_url: format!("https://huggingface.co/{repo}/blob/main/LICENSE"),
        variants: vec![variant(
            "Optional rewriting",
            None,
            "Original Qwen checkpoint loaded through Transformers; no Delulu format conversion.",
            None,
        )],
    }
}

pub static MODELS: LazyLock<Vec<ModelInfo>> = LazyLock::new(|| {
    vec![
        ModelInfo {
            id: SpeechModelId::R2t2,
            model: ModelDescription {
                identity: SpeechIdentity::R2t2,
                backend_ids: vec![SpeechBackendId::TransformersCuda],
                runtime: "CUDA · Transformers".into(),
                download_size: "~4 GB".into(),
                hf_id: "netease-youdao/Confucius4-R2T2".into(),
                name: "R2T2".into(),
                description: "R2T2 speech recognition on NVIDIA GPUs through Transformers on Linux and Windows. About 4 GB of GPU memory.".into(),
                recommended: Some(true),
                provenance: ModelProvenance {
                    license_name: R2T2_LICENSE_NAME.into(),
                    license_url: R2T2_LICENSE_URL.into(),
                    variants: vec![variant(
                        "Linux and Windows CUDA",
                        Some("185ce639118ad1362d049ca0d8ed04b6ec5cd6c9"),
                        "Delulu converts original R2T2 keys in memory using the official Transformers mappings, with strict weight loading. Conversion cache: transformers-5.15.0-v1.",
                        Some("https://github.com/JEMostert/delulu-talks/blob/main/electron/python/r2t2_checkpoint.py"),
                    )],
                },
            },
        },
        ModelInfo {
            id: SpeechModelId::R2t2Mlx,
            model: ModelDescription {
                identity: SpeechIdentity::R2t2,
                backend_ids: vec![SpeechBackendId::MlxAudio],
                hf_id: "mlx-community/Confucius4-R2T2-bf16".into(),
                name: "R2T2".into(),
                runtime: "MLX Audio · BF16 · Apple Silicon".into(),
                download_size: "~4.1 GB".into(),
                description: "The Confucius4-R2T2 fine-tune runs directly through MLX on Apple Silicon. Uses an unquantized BF16 conversion, with selectable language. Requires macOS 15+ and native Python 3.12. Mac hardware validation is pending.".into(),
                recommended: Some(true),
                provenance: ModelProvenance {
                    license_name: R2T2_LICENSE_NAME.into(),
                    license_url: R2T2_LICENSE_URL.into(),
                    variants: vec![variant(
                        "Apple Silicon MLX",
                        Some("747f5fc5f84bc9976baa2f02714e2fed67ed8611"),
                        "Unquantized BF16 conversion of netease-youdao/Confucius4-R2T2. The publisher records mlx_audio.convert from the xocialize/mlx-audio fork at 1792021, MLX 0.32.2, on an Apple M5 Max. These are the conversion tools, not the app runtime versions.",
                        Some("https://huggingface.co/mlx-community/Confucius4-R2T2-bf16/blob/747f5fc5f84bc9976baa2f02714e2fed67ed8611/README.md"),
                    )],
                },
            },
        },
    ]
});

const NVIDIA_LICENSE_NAME: &str = "CC BY 4.0";
const NVIDIA_LICENSE_URL: &str = "https://creativecommons.org/licenses/by/4.0/";
const SHERPA_CONVERSION: &str =
    "INT8 ONNX export of the NVIDIA NeMo checkpoint, published by the sherpa-onnx project (k2-fsa). Delulu does not convert it further.";

pub static CANARY_MODEL: LazyLock<ModelDescription> = LazyLock::new(|| ModelDescription {
    identity: SpeechIdentity::Canary,
    backend_ids: vec![SpeechBackendId::OnnxCpu],
    runtime: "sherpa-onnx · CPU".into(),
    download_size: "200 MB".into(),
    hf_id: "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8".into(),
    name: "Canary 180M Flash".into(),
    description: "NVIDIA Canary 180M Flash on the CPU. The smallest option: English, German, French and Spanish, with punctuation. Speak, then stop to transcribe.".into(),
    recommended: None,
    provenance: ModelProvenance {
        license_name: NVIDIA_LICENSE_NAME.into(),
        license_url: NVIDIA_LICENSE_URL.into(),
        variants: vec![variant(
            "NVIDIA Canary 180M Flash · INT8",
            Some("9077164e0d3dd1d5353743e89ceaa1d3a770838c"),
            SHERPA_CONVERSION,
            Some("https://huggingface.co/nvidia/canary-180m-flash"),
        )],
    },
});

pub static PARAKEET_MODEL: LazyLock<ModelDescription> = LazyLock::new(|| ModelDescription {
    identity: SpeechIdentity::Parakeet,
    backend_ids: vec![SpeechBackendId::OnnxCpu],
    runtime: "sherpa-onnx · CPU".into(),
    download_size: "630 MB".into(),
    hf_id: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8".into(),
    name: "Parakeet TDT 0.6B".into(),
    description: "NVIDIA Parakeet TDT 0.6B on the CPU. English uses v2, the English model; Automatic uses v3, which detects 25 European languages. Speak, then stop to transcribe.".into(),
    recommended: None,
    provenance: ModelProvenance {
        license_name: NVIDIA_LICENSE_NAME.into(),
        license_url: NVIDIA_LICENSE_URL.into(),
        variants: vec![
            variant(
                "NVIDIA Parakeet TDT 0.6B v2 · English · INT8",
                Some("1ab9323565ddb038682214b292f588070a538ce2"),
                SHERPA_CONVERSION,
                Some("https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2"),
            ),
            variant(
                "NVIDIA Parakeet TDT 0.6B v3 · 25 languages · INT8",
                Some("2bda32ec70b097a55adaa07d9a7173915b43cc78"),
                SHERPA_CONVERSION,
                Some("https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"),
            ),
        ],
    },
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTierInfo {
    pub id: SpeechTier,
    pub name: &'static str,
    pub model: &'static str,
    pub download: &'static str,
    pub summary: &'static str,
    pub detail: &'static str,
    pub hardware: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

/// The three speech choices, smallest first. Small and Medium run on any CPU.
pub const SPEECH_TIERS: &[SpeechTierInfo] = &[
    SpeechTierInfo {
        id: SpeechTier::Small,
        name: "Small",
        model: "Canary 180M",
        download: "200 MB",
        summary: "Runs on almost any computer.",
        detail: "English, German, French and Spanish. Least accurate of the three.",
        hardware: "Any CPU",
        recommended: None,
    },
    SpeechTierInfo {
        id: SpeechTier::Medium,
        name: "Medium",
        model: "Parakeet 0.6B",
        download: "630 MB",
        summary: "Fast and accurate on the CPU.",
        detail: "English, or automatic detection across 25 European languages. Recommended for most computers.",
        hardware: "Any CPU",
        recommended: Some(true),
    },
    SpeechTierInfo {
        id: SpeechTier::Large,
        name: "Large",
        model: "R2T2",
        download: "~4 GB",
        summary: "Most accurate.",
        detail: "30 languages, automatic detection and vocabulary hints. Needs an NVIDIA GPU with about 4 GB of memory, or Apple Silicon.",
        hardware: "NVIDIA GPU or Apple Silicon",
        recommended: None,
    },
];

pub fn speech_tier_by_id(id: SpeechTier) -> &'static SpeechTierInfo {
    SPEECH_TIERS.iter().find(|tier| tier.id == id).unwrap_or(&SPEECH_TIERS[1])
}

pub static MAGIC_MODELS: LazyLock<Vec<MagicModelInfo>> = LazyLock::new(|| {
    let model = |id, hf_id: &str, name: &str, role: &str, description: &str, parameters: &str, memory: &str, speed: &str, recommended| {
        MagicModelInfo {
            id,
            hf_id: hf_id.into(),
            name: name.into(),
            role: role.into(),
            description: description.into(),
            parameters: parameters.into(),
            memory: memory.into(),
            speed: speed.into(),
            provenance: rewrite_provenance(hf_id),
            recommended,
        }
    };
    vec![
        model(
            MagicModelId::Qwen35Small,
            "Qwen/Qwen3.5-0.8B",
            "Qwen 3.5 · 0.8B",
            "Quick polish",
            "The lightest option for cleanup, concise notes, and fast everyday rewrites.",
            "0.8B",
            "~2 GB",
            "Fastest",
            None,
        ),
        model(
            MagicModelId::Qwen35Medium,
            "Qwen/Qwen3.5-2B",
            "Qwen 3.5 · 2B",
            "Best balance",
            "Stronger instruction following and structure without the footprint of the largest option.",
            "2B",
            "~4.5 GB",
            "Balanced",
            Some(true),
        ),
        model(
            MagicModelId::Qwen35Large,
            "Qwen/Qwen3.5-4B",
            "Qwen 3.5 · 4B",
            "Deepest rewrite",
            "Best for detailed prompts, coding context, and useful constraints the source only implied.",
            "4B",
            "~8.5 GB",
            "Deliberate",
            None,
        ),
    ]
});

/// Recognition-language setting that lets the speech engine detect the language.
pub const AUTO_LANGUAGE: &str = "auto";

pub const LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("de", "German"),
    ("nl", "Dutch"),
    ("fr", "French"),
    ("es", "Spanish"),
    ("pt", "Portuguese"),
    ("it", "Italian"),
    ("pl", "Polish"),
    ("cs", "Czech"),
    ("el", "Greek"),
    ("sv", "Swedish"),
    ("da", "Danish"),
    ("fi", "Finnish"),
    ("no", "Norwegian"),
    ("uk", "Ukrainian"),
    ("ru", "Russian"),
    ("tr", "Turkish"),
    ("ar", "Arabic"),
    ("he", "Hebrew"),
    ("hi", "Hindi"),
    ("zh", "Chinese"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("vi", "Vietnamese"),
];

/// Values the recognition-language setting accepts: automatic detection or a language.
pub fn setting_languages() -> impl Iterator<Item = (&'static str, &'static str)> {
    std::iter::once((AUTO_LANGUAGE, "Automatic")).chain(LANGUAGES.iter().copied())
}

pub fn model_by_id(id: SpeechModelId) -> &'static ModelInfo {
    MODELS.iter().find(|model| model.id == id).unwrap_or(&MODELS[0])
}

pub fn magic_model_by_id(id: MagicModelId) -> &'static MagicModelInfo {
    MAGIC_MODELS.iter().find(|model| model.id == id).unwrap_or(&MAGIC_MODELS[1])
}

/* Rewrite presets */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewritePreset {
    pub id: MagicPreset,
    pub label: &'static str,
    pub description: &'static str,
    pub example_source: &'static str,
    pub example_output: &'static str,
}

pub const REWRITE_PRESETS: &[RewritePreset] = &[
    RewritePreset {
        id: MagicPreset::SpokenCorrections,
        label: "Spoken corrections",
        description: "Keep your words. Remove only what you explicitly take back, plus the correction phrases. The original stays in history.",
        example_source: "I want a new logo. Also remake this feature. Oh no, never mind, don’t do the logo.",
        example_output: "Also remake this feature.",
    },
    RewritePreset {
        id: MagicPreset::Concise,
        label: "Shorten",
        description: "Remove repetition and filler while keeping facts, requests and uncertainty.",
        example_source: "I just wanted to say that the meeting is at 10 on Friday, and please bring the draft with you.",
        example_output: "The meeting is at 10 on Friday. Please bring the draft.",
    },
    RewritePreset {
        id: MagicPreset::Polish,
        label: "Polish",
        description: "Clean up grammar and speech artifacts, keeping your tone and detail.",
        example_source: "so I checked the draft and um the second paragraph needs a clearer example",
        example_output: "I checked the draft, and the second paragraph needs a clearer example.",
    },
    RewritePreset {
        id: MagicPreset::BulletPoints,
        label: "Bullet points",
        description: "Turn the existing points into concise bullets without adding tasks or priorities.",
        example_source: "The draft is ready. We still need to review the budget, and the launch might move to Friday.",
        example_output: "- The draft is ready.\n- We still need to review the budget.\n- The launch might move to Friday.",
    },
    RewritePreset {
        id: MagicPreset::ProfessionalMessage,
        label: "Professional message",
        description: "Write a brief, courteous message without inventing recipients or commitments.",
        example_source: "hey could you send me the revised draft by Friday I need it for the review",
        example_output: "Could you please send me the revised draft by Friday? I need it for the review.",
    },
    RewritePreset {
        id: MagicPreset::Structured,
        label: "Organize",
        description: "Group existing details under useful headings or bullets.",
        example_source: "The draft is ready. The budget still needs a review.",
        example_output: "Status\n- The draft is ready.\n\nNext step\n- Review the budget.",
    },
    RewritePreset {
        id: MagicPreset::Prompt,
        label: "Build a prompt",
        description: "Arrange the stated goal and constraints into a prompt.",
        example_source: "Improve the wording of the draft. Keep the dates unchanged.",
        example_output: "Revise the draft for clarity. Preserve all dates exactly.",
    },
];

pub fn is_magic_preset(value: &str) -> bool {
    REWRITE_PRESETS.iter().any(|preset| preset.id.as_str() == value)
}

/* Audio formats and capture limits */

pub const SUPPORTED_AUDIO_EXTENSIONS: &[&str] =
    &["wav", "flac", "mp3", "m4a", "ogg", "opus", "webm", "mp4", "mov", "mkv", "aac"];
pub const MAX_AUDIO_BATCH_FILES: usize = 50;
pub const MAX_AUDIO_FILE_BYTES: u64 = 500 * 1024 * 1024;

// These bounds apply to live microphone capture, independently of import size.
pub const MAX_CAPTURE_DURATION_MS: u64 = 10 * 60 * 1000;
pub const MAX_CAPTURE_PCM_BYTES: u64 = 128 * 1024 * 1024;
/// Float32 samples that fit in [`MAX_CAPTURE_PCM_BYTES`].
pub const MAX_CAPTURE_SAMPLES: u64 = MAX_CAPTURE_PCM_BYTES / 4;
/// Prefix for a capture that ended before any audio: a tap, not a failure.
pub const TOO_SHORT: &str = "Recording too short";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_sizes_are_offered_smallest_first_with_medium_recommended() {
        let ids: Vec<_> = SPEECH_TIERS.iter().map(|tier| tier.id).collect();
        assert_eq!(ids, [SpeechTier::Small, SpeechTier::Medium, SpeechTier::Large]);
        let recommended: Vec<_> = SPEECH_TIERS.iter().filter(|tier| tier.recommended.is_some()).map(|tier| tier.id).collect();
        assert_eq!(recommended, [speech_tier_by_id(SpeechTier::Medium).id]);
    }

    #[test]
    fn default_settings_serialize_like_typescript() {
        let json = &*DEFAULT_SETTINGS_JSON;
        assert_eq!(json.len(), 58);
        assert_eq!(json["historyRetention"], serde_json::json!({"maxAgeDays": null, "maxCount": null}));
        assert_eq!(json["historyLimit"], serde_json::json!(50));
        assert_eq!(json["captureSoundVolume"], serde_json::json!(0.15));
        assert_eq!(json["voiceEngine"], "kokoro");
        let round_trip: AppSettings = serde_json::from_value(serde_json::Value::Object(json.clone())).unwrap();
        assert_eq!(round_trip, default_settings());
    }
}
