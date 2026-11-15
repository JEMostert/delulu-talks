//! Native text to speech for Delulu Talks: Supertonic 3 (Supertone Inc., OpenRAIL-M)
//! on ONNX Runtime, on the CPU, in Dutch and English.
//!
//! The text front end is always built: [`plan`] splits a reply into sentences, picks
//! Dutch or English per sentence, spells out what the model would misread (numbers,
//! versions, file names, abbreviations, English developer words inside Dutch) and
//! sets the pause after each piece. [`trim`] cuts the model's padding silence.
//!
//! The model ([`Synthesizer`]) needs the `onnx` feature, which only `delulu-engine`
//! enables. It speaks one planned segment at a time, so a caller can play sentence
//! one while sentence two is being made.
pub mod chunk;
pub mod lang;
pub mod lexicon;
pub mod normalize;
pub mod trim;

#[cfg(feature = "onnx")]
mod supertonic;
#[cfg(feature = "onnx")]
mod synth;
#[cfg(feature = "onnx")]
pub use synth::{Spoken, SynthOptions, Synthesizer};

pub use lang::{Lang, LangChoice};
pub use lexicon::Lexicon;

/// The model's preset voices: five female, five male. Each speaks every language.
pub const VOICES: [&str; 10] = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
/// Agents' replies. A female default, so it differs from the radio host.
pub const DEFAULT_VOICE: &str = "F1";
/// Delulu FM's host (the voice every spike measurement used).
pub const DEFAULT_RADIO_VOICE: &str = "M1";
/// Denoising steps. The spike measured 8 as the quality default; 4 is about twice as
/// fast with the same Whisper transcripts, pending a listening test.
pub const DEFAULT_STEPS: usize = 8;
pub const MAX_STEPS: usize = 32;
/// Upstream's default speaking rate.
pub const DEFAULT_SPEED: f32 = 1.05;

/// Pause after a sentence, after a long sentence's comma split, and between paragraphs.
pub const SENTENCE_PAUSE_MS: u32 = 250;
pub const CLAUSE_PAUSE_MS: u32 = 120;
pub const PARAGRAPH_PAUSE_MS: u32 = 450;

pub fn is_voice(name: &str) -> bool {
    VOICES.contains(&name)
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Input(String),
    #[error("{0}")]
    Model(String),
}

/// One piece of speech: model-ready text in one language, then a pause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub lang: Lang,
    pub pause_after_ms: u32,
}

/// Turns a reply into the segments the model speaks, in order.
///
/// Sentences under [`chunk::MERGE_BELOW`] characters join the next sentence of the
/// same language (better prosody, fewer model calls), sentences over
/// [`chunk::MAX_CHARS`] are split at commas, and nothing else is merged, so the
/// first segment stays short and arrives fast.
pub fn plan(text: &str, choice: LangChoice, lexicon: &Lexicon) -> Vec<Segment> {
    let sentences = chunk::split_sentences(text);
    let langs = lang::assign(
        &sentences
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>(),
        choice,
    );
    let mut out: Vec<Segment> = Vec::new();
    // A short sentence waiting to be joined with the next one.
    let mut pending: Option<(String, Lang)> = None;
    for (sentence, lang) in sentences.iter().zip(langs) {
        let mut spoken = normalize::normalize(&sentence.text, lang);
        if lang == Lang::Nl {
            spoken = lexicon.apply(&spoken);
        }
        let spoken = spoken.trim().to_string();
        if spoken.is_empty() || !spoken.chars().any(char::is_alphanumeric) {
            continue;
        }
        let spoken = match pending.take() {
            Some((prev, prev_lang)) if prev_lang == lang => format!("{prev} {spoken}"),
            Some((prev, prev_lang)) => {
                push_split(&mut out, &prev, prev_lang, SENTENCE_PAUSE_MS);
                spoken
            }
            None => spoken,
        };
        if spoken.chars().count() < chunk::MERGE_BELOW && !sentence.paragraph_end {
            pending = Some((spoken, lang));
            continue;
        }
        let pause = if sentence.paragraph_end {
            PARAGRAPH_PAUSE_MS
        } else {
            SENTENCE_PAUSE_MS
        };
        push_split(&mut out, &spoken, lang, pause);
    }
    if let Some((prev, lang)) = pending {
        push_split(&mut out, &prev, lang, SENTENCE_PAUSE_MS);
    }
    if let Some(last) = out.last_mut() {
        last.pause_after_ms = 0;
    }
    out
}

fn push_split(out: &mut Vec<Segment>, text: &str, lang: Lang, pause: u32) {
    let parts = chunk::split_long(text, chunk::MAX_CHARS);
    let n = parts.len();
    for (i, part) in parts.into_iter().enumerate() {
        out.push(Segment {
            text: part,
            lang,
            pause_after_ms: if i + 1 == n { pause } else { CLAUSE_PAUSE_MS },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(segments: &[Segment]) -> Vec<(&str, Lang)> {
        segments.iter().map(|s| (s.text.as_str(), s.lang)).collect()
    }

    #[test]
    fn short_sentences_merge_forward_and_long_ones_stand_alone() {
        let segments = plan(
            "Done. I fixed the failing test and pushed the change to your branch. It passes now.",
            LangChoice::Auto,
            &Lexicon::builtin(),
        );
        assert_eq!(
            texts(&segments),
            [
                (
                    "Done. I fixed the failing test and pushed the change to your branch.",
                    Lang::En
                ),
                ("It passes now.", Lang::En),
            ]
        );
        assert_eq!(segments[0].pause_after_ms, SENTENCE_PAUSE_MS);
        assert_eq!(segments[1].pause_after_ms, 0);
    }

    #[test]
    fn each_sentence_gets_its_own_language_without_inline_tags() {
        let segments = plan(
            "De tests zijn weer groen en de main branch staat klaar voor review. The pull request is ready to merge into main.",
            LangChoice::Auto,
            &Lexicon::builtin(),
        );
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].lang, Lang::Nl);
        assert_eq!(segments[1].lang, Lang::En);
        assert!(
            segments.iter().all(|s| !s.text.contains('<')),
            "{segments:?}"
        );
        // The Dutch respelling applies to the Dutch sentence only.
        assert!(segments[0].text.contains("meen"), "{}", segments[0].text);
        assert!(segments[1].text.contains("main"), "{}", segments[1].text);
    }

    #[test]
    fn a_short_sentence_does_not_merge_into_another_language() {
        let segments = plan(
            "Klaar. The build passed on all three targets today.",
            LangChoice::Auto,
            &Lexicon::builtin(),
        );
        assert_eq!(segments.len(), 2, "{segments:?}");
        assert_eq!(segments[0].lang, Lang::Nl);
        assert_eq!(segments[1].lang, Lang::En);
    }

    #[test]
    fn a_long_sentence_splits_at_commas_with_a_short_pause() {
        let long = "This sentence keeps going, with a clause about the settings file that was read too early, \
                    another clause about the folder that did not exist yet when the app started, \
                    a third clause about the check that now runs first, and a final clause about the test \
                    that covers it so the crash cannot come back unnoticed in a later release.";
        let segments = plan(long, LangChoice::Fixed(Lang::En), &Lexicon::builtin());
        assert!(segments.len() >= 2, "{segments:?}");
        assert!(segments
            .iter()
            .all(|s| s.text.chars().count() <= chunk::MAX_CHARS));
        assert_eq!(segments[0].pause_after_ms, CLAUSE_PAUSE_MS);
    }

    #[test]
    fn paragraphs_get_a_longer_pause() {
        let segments = plan(
            "The first paragraph ends here after a while.\n\nThe second paragraph starts here and goes on.",
            LangChoice::Fixed(Lang::En),
            &Lexicon::builtin(),
        );
        assert_eq!(segments[0].pause_after_ms, PARAGRAPH_PAUSE_MS);
    }

    #[test]
    fn voices_and_defaults_match_the_registry() {
        assert_eq!(VOICES, delulu_models::SUPERTONIC_VOICES);
        assert_eq!(DEFAULT_VOICE, delulu_models::DEFAULT_AGENT_VOICE);
        assert_eq!(DEFAULT_RADIO_VOICE, delulu_models::DEFAULT_RADIO_VOICE);
    }

    #[test]
    fn text_without_words_plans_nothing() {
        assert!(plan(" ... -- 🙂 ", LangChoice::Auto, &Lexicon::builtin()).is_empty());
    }
}
