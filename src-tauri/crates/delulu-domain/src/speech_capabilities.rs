//! Which recognition languages each speech model accepts (`src/speechCapabilities.ts`).

use crate::catalog::{AUTO_LANGUAGE, LANGUAGES};
use crate::types::{SpeechModelId, SpeechTier};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageBackend {
    Mlx,
    CudaVllm,
    CudaTransformers,
    OnnxCpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechBackendLanguageCapability {
    pub backend: LanguageBackend,
    pub hint_codes: &'static [&'static str],
    pub automatic_language: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechLanguageCapability {
    pub can_select_language: bool,
    pub can_request_automatic_language: bool,
    pub backends: Vec<SpeechBackendLanguageCapability>,
    /// `[code, label]` pairs from [`LANGUAGES`].
    pub languages: Vec<(&'static str, &'static str)>,
}

// Adapter input contract, not a measured recognition-quality guarantee. Keep
// this list aligned with Python LANGUAGE_NAMES, rather than exposing new UI
// languages automatically when the general language catalog grows.
const HINT_CODES: &[&str] = &[
    "en", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "el", "sv", "da", "fi", "no", "uk", "ru", "tr", "ar", "he", "hi",
    "zh", "ja", "ko", "vi",
];

pub const MLX_LANGUAGES: SpeechBackendLanguageCapability =
    SpeechBackendLanguageCapability { backend: LanguageBackend::Mlx, hint_codes: HINT_CODES, automatic_language: false };
pub const CUDA_VLLM_LANGUAGES: SpeechBackendLanguageCapability =
    SpeechBackendLanguageCapability { backend: LanguageBackend::CudaVllm, hint_codes: HINT_CODES, automatic_language: true };
/// The Transformers R2T2 processor detects the language when none is forced.
pub const CUDA_TRANSFORMERS_LANGUAGES: SpeechBackendLanguageCapability = SpeechBackendLanguageCapability {
    backend: LanguageBackend::CudaTransformers,
    hint_codes: HINT_CODES,
    automatic_language: true,
};

fn controls_for(backends: &[SpeechBackendLanguageCapability]) -> SpeechLanguageCapability {
    let languages: Vec<_> = LANGUAGES
        .iter()
        .copied()
        .filter(|(code, _)| backends.iter().all(|backend| backend.hint_codes.contains(code)))
        .collect();
    SpeechLanguageCapability {
        can_select_language: !languages.is_empty(),
        can_request_automatic_language: backends.iter().all(|backend| backend.automatic_language),
        backends: backends.to_vec(),
        languages,
    }
}

pub fn speech_language_capability(tier: SpeechTier, model: SpeechModelId) -> SpeechLanguageCapability {
    match tier {
        SpeechTier::Large => match model {
            SpeechModelId::R2t2 => controls_for(&[CUDA_VLLM_LANGUAGES, CUDA_TRANSFORMERS_LANGUAGES]),
            SpeechModelId::R2t2Mlx => controls_for(&[MLX_LANGUAGES]),
        },
        // Canary takes one of four forced languages. Parakeet runs its English model
        // for English and its multilingual model, which detects the language, for Automatic.
        SpeechTier::Small => controls_for(&[SpeechBackendLanguageCapability {
            backend: LanguageBackend::OnnxCpu,
            hint_codes: &["en", "de", "fr", "es"],
            automatic_language: false,
        }]),
        SpeechTier::Medium => controls_for(&[SpeechBackendLanguageCapability {
            backend: LanguageBackend::OnnxCpu,
            hint_codes: &["en"],
            automatic_language: true,
        }]),
    }
}

/// Keep a saved language the selected model accepts, or its closest default.
pub fn supported_speech_language(tier: SpeechTier, model: SpeechModelId, language: &str) -> String {
    let capability = speech_language_capability(tier, model);
    if language == AUTO_LANGUAGE {
        return if capability.can_request_automatic_language { language.into() } else { "en".into() };
    }
    if capability.languages.iter().any(|(code, _)| *code == language) {
        return language.into();
    }
    if tier == SpeechTier::Medium { AUTO_LANGUAGE.into() } else { "en".into() }
}

/// One sentence explaining how the selected model uses the language setting.
pub fn speech_language_help(tier: SpeechTier, language: &str) -> &'static str {
    match tier {
        SpeechTier::Small => "Canary transcribes the language you choose: English, German, French or Spanish.",
        SpeechTier::Medium if language == AUTO_LANGUAGE => {
            "Parakeet's multilingual model detects the language: 25 European languages, including Dutch and English."
        }
        SpeechTier::Medium => {
            "English uses Parakeet's English model. Choose Automatic detection for 25 other European languages."
        }
        SpeechTier::Large if language == AUTO_LANGUAGE => {
            "R2T2 detects the language, also when you switch between languages. Choose one to force it."
        }
        SpeechTier::Large => "Forces the speech model to this language. Automatic detection handles mixed languages.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(capability: &SpeechLanguageCapability) -> Vec<&str> {
        capability.languages.iter().map(|(code, _)| *code).collect()
    }

    #[test]
    fn small_offers_four_forced_languages_and_no_detection() {
        let small = speech_language_capability(SpeechTier::Small, SpeechModelId::R2t2);
        assert!(!small.can_request_automatic_language);
        assert_eq!(codes(&small), ["en", "de", "fr", "es"]);
    }

    #[test]
    fn medium_is_english_or_automatic_detection() {
        let medium = speech_language_capability(SpeechTier::Medium, SpeechModelId::R2t2);
        assert!(medium.can_request_automatic_language);
        assert_eq!(codes(&medium), ["en"]);
    }

    #[test]
    fn switching_size_keeps_a_language_the_new_model_accepts() {
        use SpeechModelId::*;
        use SpeechTier::*;
        assert_eq!(supported_speech_language(Small, R2t2, "fr"), "fr");
        assert_eq!(supported_speech_language(Small, R2t2, AUTO_LANGUAGE), "en");
        assert_eq!(supported_speech_language(Medium, R2t2, "fr"), AUTO_LANGUAGE);
        assert_eq!(supported_speech_language(Medium, R2t2, "en"), "en");
        assert_eq!(supported_speech_language(Large, R2t2, "nl"), "nl");
        assert_eq!(supported_speech_language(Large, R2t2, AUTO_LANGUAGE), AUTO_LANGUAGE);
        // R2T2 on MLX takes a selected language only.
        assert_eq!(supported_speech_language(Large, R2t2Mlx, AUTO_LANGUAGE), "en");
    }
}
