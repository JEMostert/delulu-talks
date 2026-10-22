//! Reported transcript languages (`src/transcriptLanguage.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;
use crate::types::LanguageStatus;

regexes! {
    LANGUAGE_CODE = r"^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$", "";
    LETTERS = r"\p{L}+", "gu";
}

/// Backend-reported metadata is separate from a requested decoder hint.
pub fn normalize_reported_language(value: &Value) -> Option<String> {
    let code = js::trim(value.as_str()?).to_lowercase();
    if code.is_empty()
        || code == "und"
        || code == "unknown"
        || code == "mixed"
        || js::utf16_len(&code) > 32
        || !LANGUAGE_CODE.is_match(&code)
    {
        return None;
    }
    Some(code)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedLanguageMetadata {
    pub recognized_language: Option<String>,
    pub recognized_languages: Vec<String>,
    pub language_status: LanguageStatus,
}

/// Normalizes `recognizedLanguage`, `recognizedLanguages` and
/// `languageStatus` from a backend result or a stored record.
pub fn normalize_language_metadata(value: &Value) -> NormalizedLanguageMetadata {
    let empty = serde_json::Map::new();
    let source = value.as_object().unwrap_or(&empty);
    let null = Value::Null;
    let status = source.get("languageStatus").and_then(Value::as_str);
    let single = normalize_reported_language(source.get("recognizedLanguage").unwrap_or(&null));
    let single_value;
    let raw: &[Value] = match source.get("recognizedLanguages") {
        Some(Value::Array(items)) => items,
        _ => match &single {
            Some(code) => {
                single_value = [Value::String(code.clone())];
                &single_value
            }
            None => &[],
        },
    };
    let normalized: Vec<Option<String>> = raw.iter().take(128).map(normalize_reported_language).collect();
    let mut languages: Vec<String> = Vec::new();
    for code in normalized.iter().flatten() {
        if !languages.contains(code) {
            languages.push(code.clone());
        }
    }
    let unknown = |languages| NormalizedLanguageMetadata {
        recognized_language: None,
        recognized_languages: languages,
        language_status: LanguageStatus::Unknown,
    };
    if status == Some("unknown") || raw.len() > 128 || normalized.iter().any(Option::is_none) {
        return unknown(languages);
    }
    if languages.len() > 1 {
        return NormalizedLanguageMetadata {
            recognized_language: None,
            recognized_languages: languages,
            language_status: LanguageStatus::Mixed,
        };
    }
    if languages.len() == 1
        && status != Some("mixed")
        && (status == Some("reported") || single.as_ref() == Some(&languages[0]))
    {
        return NormalizedLanguageMetadata {
            recognized_language: Some(languages[0].clone()),
            recognized_languages: languages,
            language_status: LanguageStatus::Reported,
        };
    }
    unknown(languages)
}

// Frequent words unique to one of the languages with spoken formatting. Words
// both languages use, such as "is", "in", "was" and "of", are left out.
const DUTCH: &str = "de het een en ik je jij ze zij hij niet ook maar dat die dit deze van voor met naar op heb hebben heeft ben bent zijn wordt worden kan kunnen moet wil gaan ga gaat nog wel dan toen omdat als bij uit om tot wat hoe waar wie hier daar nu morgen vandaag daarna echt mijn jouw onze hun mij zo heel veel geen iets alles";
const ENGLISH: &str = "the a an and i you they he she it not also but that this these those for with to on have has am are were be been will would can could should must going go goes still already then because if at from what how where who there here now tomorrow today my your our their so very much no some all his her really just";

/// Guess Dutch or English from frequent words, for text whose language the
/// speech model did not report: R2T2 reports none for Dutch speech full of
/// English terms. Returns `None` unless one language clearly dominates.
pub fn guess_text_language(text: &str) -> Option<&'static str> {
    let (mut nl, mut en) = (0, 0);
    let lower = text.to_lowercase();
    for word in LETTERS.find_iter(&lower) {
        let word = word.as_str();
        if DUTCH.split(' ').any(|known| known == word) {
            nl += 1;
        }
        if ENGLISH.split(' ').any(|known| known == word) {
            en += 1;
        }
    }
    if nl >= 2 && nl >= 2 * en {
        Some("nl")
    } else if en >= 2 && en >= 2 * nl {
        Some("en")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_language_guesses_follow_output_that_reported_no_language() {
        assert_eq!(
            guess_text_language("Ik heb de typescript code naar github gepusht en daarna kubectl appie gedraaid op het kubernetes cluster met postgresql en redis"),
            Some("nl")
        );
        assert_eq!(
            guess_text_language("I was AFK, but my teammate hit a clutch in ranked Valorant. GG, the cooldown on his ult was really OP."),
            Some("en")
        );
        assert_eq!(guess_text_language("Ik was Eka, maar mijn teammate had een clutch in ranked van Orant"), Some("nl"));
        assert_eq!(guess_text_language("GitHub Kubernetes PostgreSQL"), None);
        assert_eq!(guess_text_language("Ik push the code"), None);
    }

    #[test]
    fn language_metadata_is_reported_mixed_or_unknown() {
        let reported = normalize_language_metadata(&json!({"recognizedLanguage": " EN "}));
        assert_eq!(reported.recognized_language.as_deref(), Some("en"));
        assert_eq!(reported.language_status, LanguageStatus::Reported);
        let mixed = normalize_language_metadata(&json!({"recognizedLanguages": ["en", "nl", "en"]}));
        assert_eq!(mixed.recognized_languages, ["en", "nl"]);
        assert_eq!(mixed.language_status, LanguageStatus::Mixed);
        let invalid = normalize_language_metadata(&json!({"recognizedLanguages": ["en", "??"]}));
        assert_eq!(invalid.language_status, LanguageStatus::Unknown);
        assert_eq!(invalid.recognized_languages, ["en"]);
        let unreported = normalize_language_metadata(&json!({"recognizedLanguages": ["en"]}));
        assert_eq!(unreported.language_status, LanguageStatus::Unknown);
        assert_eq!(normalize_reported_language(&json!("und")), None);
    }
}
