//! Vocabulary hints for R2T2 (`src/recognitionHints.ts`).

use std::collections::HashSet;

use crate::catalog::AUTO_LANGUAGE;
use crate::js;
use crate::types::{CustomWord, RuleKind};

use super::personalization::{rule_applies_to_language, rule_kind};

/// At most this many words, own words and word packs together, are hints.
pub const MAX_HINT_WORDS: usize = 150;
/// Matches the worker's MAX_HOTWORDS_CHARS.
pub const MAX_RECOGNITION_HINT_CHARS: usize = 3000;

regexes! {
    WHITESPACE = r"\s+", "gu";
}

/// Correct spellings from enabled vocabulary corrections, deduplicated in rule
/// order. Text shortcuts expand typed phrases rather than name spoken words, so
/// they are not hints. With automatic language detection (`language` is
/// [`AUTO_LANGUAGE`]), rules for every language apply.
pub fn hint_words(words: &[CustomWord], language: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for word in words {
        if !word.enabled || rule_kind(word) != RuleKind::Correction {
            continue;
        }
        if language != AUTO_LANGUAGE && !rule_applies_to_language(word, Some(language)) {
            continue;
        }
        let term = WHITESPACE.replace_all(js::trim(&word.term), " ").into_owned();
        // toLocaleLowerCase in the default locale.
        if term.is_empty() || !seen.insert(term.to_lowercase()) {
            continue;
        }
        terms.push(term);
    }
    terms
}

/// The comma-separated hotword prompt R2T2 biases recognition toward.
pub fn recognition_hints(words: &[CustomWord], language: &str) -> String {
    let mut hints = String::new();
    for term in hint_words(words, language).into_iter().take(MAX_HINT_WORDS) {
        let next = if hints.is_empty() { term } else { format!("{hints}, {term}") };
        if js::utf16_len(&next) > MAX_RECOGNITION_HINT_CHARS {
            break;
        }
        hints = next;
    }
    hints
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::WordPackId;
    use crate::word_packs::{active_rules, WORD_PACKS};

    fn rule(term: &str) -> CustomWord {
        CustomWord { id: term.into(), term: term.into(), enabled: true, ..CustomWord::default() }
    }

    fn with(mut word: CustomWord, edit: impl FnOnce(&mut CustomWord)) -> CustomWord {
        edit(&mut word);
        word
    }

    #[test]
    fn hints_list_enabled_correction_spellings_once_without_shortcuts() {
        let words = [
            rule("Kestrel"),
            rule("  Delulu   Talks "),
            rule("kestrel"),
            with(rule("Disabled"), |w| w.enabled = false),
            with(rule("my email"), |w| {
                w.kind = Some(RuleKind::Shortcut);
                w.replacement = "me@example.com".into();
            }),
            with(rule("sig"), |w| w.replacement = "Kind regards".into()),
        ];
        assert_eq!(recognition_hints(&words, "nl"), "Kestrel, Delulu Talks");
    }

    #[test]
    fn language_scoped_rules_apply_to_their_language_and_to_all_with_detection() {
        let words = [
            with(rule("Utrecht"), |w| w.language = Some("nl".into())),
            with(rule("Seattle"), |w| w.language = Some("en".into())),
            rule("GitHub"),
        ];
        assert_eq!(recognition_hints(&words, "nl"), "Utrecht, GitHub");
        assert_eq!(recognition_hints(&words, "en"), "Seattle, GitHub");
        assert_eq!(recognition_hints(&words, "auto"), "Utrecht, Seattle, GitHub");
    }

    #[test]
    fn hints_send_at_most_the_word_limit_within_the_character_limit() {
        let words: Vec<_> = (0..200).map(|index| rule(&format!("Term{index:03}"))).collect();
        let hints = recognition_hints(&words, "en");
        let hints: Vec<_> = hints.split(", ").collect();
        assert_eq!(hints.len(), MAX_HINT_WORDS);
        assert_eq!(hints.last(), Some(&"Term149"));
        let long: Vec<_> = (0..150).map(|index| rule(&format!("{}{index}", "x".repeat(40)))).collect();
        let capped = recognition_hints(&long, "en");
        assert!(capped.len() <= MAX_RECOGNITION_HINT_CHARS);
        assert!(!capped.ends_with(','));
    }

    #[test]
    fn own_words_come_before_pack_words_and_win_duplicates() {
        let rules = active_rules(&[rule("Delulu"), rule("github")], &[WordPackId::Programming]);
        let words = hint_words(&rules, AUTO_LANGUAGE);
        assert_eq!(words[..3], ["Delulu", "github", "TypeScript"]);
        assert!(!words.contains(&"GitHub".to_owned()));
        let all = hint_words(&active_rules(&[], &[WordPackId::Programming, WordPackId::Gaming]), AUTO_LANGUAGE);
        assert!(all.len() <= MAX_HINT_WORDS - 30);
        let ids: HashSet<_> = WORD_PACKS.iter().map(|pack| pack.id).collect();
        assert_eq!(ids.len(), WORD_PACKS.len());
    }
}
