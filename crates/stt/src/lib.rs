//! Speech to text as the app and the daemon see it: the models, the language setting,
//! the Whisper prompt and the transcript. The engines themselves (Whisper through
//! whisper.cpp, Parakeet through ONNX Runtime) run in `delulu-engine stt`, a process
//! of its own (crates/engine), so this crate links neither ggml nor ONNX Runtime.
use std::path::Path;

mod prompt;
pub use prompt::{flipped, Prompt};

/// The speech engines are rows of the shared model registry (`delulu-models`), which
/// also downloads them. Whisper runs on the GPU and follows the language setting and
/// context prompt; Parakeet runs on the CPU and detects the language.
pub use delulu_models::{Engine as EngineKind, Model as ModelInfo, ModelFile};

pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";

/// The speech-to-text models, in registry order.
pub fn models() -> Vec<&'static ModelInfo> {
    delulu_models::with_role(delulu_models::Role::Stt).collect()
}
pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    delulu_models::get(id).filter(|m| m.role == delulu_models::Role::Stt)
}
pub fn is_downloaded(dir: &Path, id: &str) -> bool {
    model_info(id).is_some_and(|m| m.installed(dir))
}
/// True when the file is in `dir` at its expected size.
pub fn file_ready(dir: &Path, file: &ModelFile) -> bool {
    file.ready(dir)
}
/// Whisper's languages as (code, name), in its own order (whisper.cpp v1.8.3's table;
/// `delulu-engine`'s tests check it against the linked whisper.cpp).
pub fn languages() -> Vec<(&'static str, &'static str)> {
    LANGUAGES.to_vec()
}
const LANGUAGES: [(&str, &str); 100] = [
    ("en", "english"),
    ("zh", "chinese"),
    ("de", "german"),
    ("es", "spanish"),
    ("ru", "russian"),
    ("ko", "korean"),
    ("fr", "french"),
    ("ja", "japanese"),
    ("pt", "portuguese"),
    ("tr", "turkish"),
    ("pl", "polish"),
    ("ca", "catalan"),
    ("nl", "dutch"),
    ("ar", "arabic"),
    ("sv", "swedish"),
    ("it", "italian"),
    ("id", "indonesian"),
    ("hi", "hindi"),
    ("fi", "finnish"),
    ("vi", "vietnamese"),
    ("he", "hebrew"),
    ("uk", "ukrainian"),
    ("el", "greek"),
    ("ms", "malay"),
    ("cs", "czech"),
    ("ro", "romanian"),
    ("da", "danish"),
    ("hu", "hungarian"),
    ("ta", "tamil"),
    ("no", "norwegian"),
    ("th", "thai"),
    ("ur", "urdu"),
    ("hr", "croatian"),
    ("bg", "bulgarian"),
    ("lt", "lithuanian"),
    ("la", "latin"),
    ("mi", "maori"),
    ("ml", "malayalam"),
    ("cy", "welsh"),
    ("sk", "slovak"),
    ("te", "telugu"),
    ("fa", "persian"),
    ("lv", "latvian"),
    ("bn", "bengali"),
    ("sr", "serbian"),
    ("az", "azerbaijani"),
    ("sl", "slovenian"),
    ("kn", "kannada"),
    ("et", "estonian"),
    ("mk", "macedonian"),
    ("br", "breton"),
    ("eu", "basque"),
    ("is", "icelandic"),
    ("hy", "armenian"),
    ("ne", "nepali"),
    ("mn", "mongolian"),
    ("bs", "bosnian"),
    ("kk", "kazakh"),
    ("sq", "albanian"),
    ("sw", "swahili"),
    ("gl", "galician"),
    ("mr", "marathi"),
    ("pa", "punjabi"),
    ("si", "sinhala"),
    ("km", "khmer"),
    ("sn", "shona"),
    ("yo", "yoruba"),
    ("so", "somali"),
    ("af", "afrikaans"),
    ("oc", "occitan"),
    ("ka", "georgian"),
    ("be", "belarusian"),
    ("tg", "tajik"),
    ("sd", "sindhi"),
    ("gu", "gujarati"),
    ("am", "amharic"),
    ("yi", "yiddish"),
    ("lo", "lao"),
    ("uz", "uzbek"),
    ("fo", "faroese"),
    ("ht", "haitian creole"),
    ("ps", "pashto"),
    ("tk", "turkmen"),
    ("nn", "nynorsk"),
    ("mt", "maltese"),
    ("sa", "sanskrit"),
    ("lb", "luxembourgish"),
    ("my", "myanmar"),
    ("bo", "tibetan"),
    ("tl", "tagalog"),
    ("mg", "malagasy"),
    ("as", "assamese"),
    ("tt", "tatar"),
    ("haw", "hawaiian"),
    ("ln", "lingala"),
    ("ha", "hausa"),
    ("ba", "bashkir"),
    ("jw", "javanese"),
    ("su", "sundanese"),
    ("yue", "cantonese"),
];

/// What automatic detection chooses from when the stored set holds no Whisper language.
/// The settings store has the same default.
pub const DEFAULT_ALLOWED_LANGUAGES: [&str; 2] = ["nl", "en"];
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Language {
    /// Detect the language, choosing only among these codes.
    Auto(Vec<String>),
    Fixed(String),
}
impl Language {
    /// `allowed` applies only when `s` is "auto".
    pub fn from_setting(s: &str, allowed: &[String]) -> Self {
        if s == "auto" {
            Self::Auto(allowed.to_vec())
        } else {
            Self::Fixed(s.into())
        }
    }
}
#[derive(Debug, Clone)]
pub struct Transcript {
    pub text: String,
    pub language: String,
    pub audio_ms: u64,
    pub elapsed_ms: u64,
}

/// Parakeet v3's languages that whatlang knows (all but Maltese), by ISO 639-1 code.
const PARAKEET_LANGUAGES: [(whatlang::Lang, &str); 24] = {
    use whatlang::Lang::*;
    [
        (Bul, "bg"),
        (Hrv, "hr"),
        (Ces, "cs"),
        (Dan, "da"),
        (Nld, "nl"),
        (Eng, "en"),
        (Est, "et"),
        (Fin, "fi"),
        (Fra, "fr"),
        (Deu, "de"),
        (Ell, "el"),
        (Hun, "hu"),
        (Ita, "it"),
        (Lav, "lv"),
        (Lit, "lt"),
        (Pol, "pl"),
        (Por, "pt"),
        (Ron, "ro"),
        (Slk, "sk"),
        (Slv, "sl"),
        (Spa, "es"),
        (Swe, "sv"),
        (Rus, "ru"),
        (Ukr, "uk"),
    ]
};
/// Common short words that only one of Dutch and English uses ("is", "in", "we" and
/// "me" are in both). Trigram detection often confuses the two on a short phrase.
const DUTCH_WORDS: &[&str] = &[
    "de", "het", "een", "en", "ik", "je", "jij", "mijn", "niet", "wat", "van", "dat", "die", "met",
    "voor", "op", "naar", "kan", "kun", "wil", "moet", "zijn", "er", "maar", "ook", "dit", "deze",
    "hoe", "waar", "wel", "geen", "om", "te", "aan", "bij", "uit", "nog", "mij", "u", "uw",
    "jullie", "wij", "ze", "hij", "zij", "heb", "heeft", "hebben", "graag", "kunnen", "ga", "gaan",
    "mag", "wordt", "worden", "dan", "als", "ben", "bent",
];
const ENGLISH_WORDS: &[&str] = &[
    "the", "a", "an", "and", "to", "of", "are", "am", "my", "i", "you", "your", "can", "it",
    "that", "this", "what", "with", "for", "on", "not", "do", "does", "be", "have", "has",
    "please", "how", "at", "from", "was", "will", "would", "want", "need", "get", "there", "they",
    "our", "just", "then", "if", "or", "but", "no", "yes", "change",
];
/// Guess a text's language: Parakeet does not say which language it heard, and the
/// prompt keeps the previous sentence only in the clip's language. Another
/// language needs whatlang to be sure; Dutch versus English goes by common words, then
/// by whatlang choosing between just those two. None for text with no letters.
pub fn guess_language(text: &str) -> Option<&'static str> {
    let code = |lang| {
        PARAKEET_LANGUAGES
            .iter()
            .find(|(l, _)| *l == lang)
            .map(|(_, code)| *code)
    };
    let guess = whatlang::Detector::with_allowlist(PARAKEET_LANGUAGES.map(|(l, _)| l).to_vec())
        .detect(text);
    if let Some(info) = &guess {
        if info.is_reliable() && !matches!(info.lang(), whatlang::Lang::Nld | whatlang::Lang::Eng) {
            return code(info.lang());
        }
    }
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let hits = |list: &[&str]| words.iter().filter(|w| list.contains(&w.as_str())).count();
    let (dutch, english) = (hits(DUTCH_WORDS), hits(ENGLISH_WORDS));
    if dutch != english {
        return Some(if dutch > english { "nl" } else { "en" });
    }
    // An unsure guess on a few words is often far off ("New loan." as Hungarian).
    match guess {
        Some(info) if info.is_reliable() => code(info.lang()),
        _ => whatlang::Detector::with_allowlist(vec![whatlang::Lang::Nld, whatlang::Lang::Eng])
            .detect(text)
            .and_then(|info| code(info.lang())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_model_is_a_whisper_model() {
        assert_eq!(
            model_info(DEFAULT_MODEL).unwrap().engine,
            EngineKind::Whisper
        );
        assert_eq!(models()[0].id, DEFAULT_MODEL);
    }
    #[test]
    fn guesses_parakeet_language() {
        assert_eq!(guess_language("Blokkeer mijn kaart."), Some("nl"));
        assert_eq!(guess_language("Ik wil mijn saldo zien."), Some("nl"));
        assert_eq!(guess_language("Freeze my card."), Some("en"));
        assert_eq!(guess_language("Can I change my address?"), Some("en"));
        assert_eq!(guess_language("Can I get a new business loan?"), Some("en"));
        assert_eq!(guess_language("Kan ik geld storten?"), Some("nl"));
        assert_eq!(
            guess_language("Please move the meeting to Thursday at half past three."),
            Some("en")
        );
        assert_eq!(
            guess_language("Bitte verschieben Sie das Treffen auf Donnerstag um halb vier."),
            Some("de")
        );
        assert_eq!(guess_language("42"), None);
    }
}
