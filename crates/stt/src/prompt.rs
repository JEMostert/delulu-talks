//! The Whisper prompt: context from earlier dictations, kept in its two parts until the
//! clip's language is known.
//!
//! Whisper reads the prompt as the text that came before the clip, and it follows that
//! text's language even when it is told to transcribe in another one: after an English
//! dictation, a Dutch clip can come out translated into English. So the previous
//! sentence only goes in when it is in the language chosen for this clip. The
//! vocabulary terms are names, not sentences, and always go in.
use crate::guess_language;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prompt {
    /// Vocabulary terms, already joined ("T3 Code, Tauri.").
    pub terms: Option<String>,
    /// The end of the previous dictation's text.
    pub sentence: Option<String>,
}

impl Prompt {
    /// The prompt for a clip in `language`: the terms, then the sentence if it is in
    /// that language. A sentence whose language cannot be told is left out: it costs
    /// some context, where a sentence in the wrong language costs the whole dictation.
    pub fn for_language(&self, language: &str) -> Option<String> {
        let sentence = self
            .sentence()
            .filter(|sentence| guess_language(sentence) == Some(language));
        join(self.terms(), sentence)
    }

    /// The prompt without the previous sentence.
    pub fn terms_only(&self) -> Option<String> {
        join(self.terms(), None)
    }

    fn terms(&self) -> Option<&str> {
        self.terms
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }

    fn sentence(&self) -> Option<&str> {
        self.sentence
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

fn join(terms: Option<&str>, sentence: Option<&str>) -> Option<String> {
    match (terms, sentence) {
        (Some(terms), Some(sentence)) => Some(format!("{terms} {sentence}")),
        (Some(one), None) | (None, Some(one)) => Some(one.to_string()),
        (None, None) => None,
    }
}

/// True when `text` is in another language than `chosen`, among those the clip could
/// have been in (`allowed`; empty means any). Then the previous sentence probably pulled
/// the text into its own language. A mixed sentence counts by its common words, so
/// Dutch with English names stays Dutch; text too short to tell is never a flip.
pub fn flipped(text: &str, chosen: &str, allowed: &[String]) -> bool {
    guess_language(text).is_some_and(|heard| {
        heard != chosen && (allowed.is_empty() || allowed.iter().any(|a| a == heard))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUTCH: &str = "Ik heb die bug gefixt, maar de pipeline is nog rood.";
    const ENGLISH: &str = "I fixed that bug, but the pipeline is still red.";

    fn prompt(terms: Option<&str>, sentence: &str) -> Prompt {
        Prompt {
            terms: terms.map(str::to_string),
            sentence: Some(sentence.to_string()),
        }
    }

    #[test]
    fn the_sentence_goes_in_only_in_the_clips_language() {
        let terms = Some("T3 Code, Tauri.");
        for (sentence, its, other) in [(DUTCH, "nl", "en"), (ENGLISH, "en", "nl")] {
            assert_eq!(
                prompt(None, sentence).for_language(its).as_deref(),
                Some(sentence)
            );
            assert_eq!(prompt(None, sentence).for_language(other), None);
            assert_eq!(
                prompt(terms, sentence).for_language(its),
                Some(format!("T3 Code, Tauri. {sentence}"))
            );
            assert_eq!(
                prompt(terms, sentence).for_language(other).as_deref(),
                Some("T3 Code, Tauri."),
                "the terms stay when the sentence goes"
            );
        }
    }

    #[test]
    fn a_dutch_sentence_with_english_names_is_dutch() {
        let mixed = prompt(None, "Kun je de pull request in GitHub even reviewen?");
        assert!(mixed.for_language("nl").is_some());
        assert_eq!(mixed.for_language("en"), None);
    }

    #[test]
    fn a_sentence_of_unknown_language_is_left_out() {
        assert_eq!(
            prompt(Some("GG."), "42").for_language("en").as_deref(),
            Some("GG.")
        );
        assert_eq!(Prompt::default().for_language("nl"), None);
    }

    #[test]
    fn flips_are_judged_within_the_allowed_languages() {
        let both = ["nl".to_string(), "en".to_string()];
        assert!(flipped(ENGLISH, "nl", &both));
        assert!(flipped(DUTCH, "en", &both));
        assert!(!flipped(DUTCH, "nl", &both));
        assert!(!flipped(
            "Kun je de pull request in GitHub even reviewen?",
            "nl",
            &both
        ));
        assert!(!flipped("42", "nl", &both), "nothing to judge");
        // German is not among the allowed languages, so it is not the other one.
        let german = "Bitte verschieben Sie das Treffen auf Donnerstag um halb vier.";
        assert!(!flipped(german, "nl", &both));
        assert!(
            flipped(german, "nl", &[]),
            "a fixed language allows no other"
        );
    }
}
