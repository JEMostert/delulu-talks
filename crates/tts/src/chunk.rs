//! Sentence splitting for streaming. Supertonic speaks a whole chunk in one pass, so
//! the app streams by sentence: short chunks reach the speaker sooner, and synthesis
//! of the next sentence overlaps playback of the current one.

/// A sentence shorter than this joins the next one.
pub const MERGE_BELOW: usize = 40;
/// A longer sentence is split at commas. Upstream's greedy 300-character merging is
/// not used: it makes ~20 s chunks that can take longer to synthesize than the
/// previous one takes to play.
pub const MAX_CHARS: usize = 300;

/// Words ending in a period that do not end a sentence.
const ABBREVIATIONS: &[&str] = &[
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "ph.d.", "etc.", "e.g.", "i.e.", "vs.",
    "inc.", "ltd.", "co.", "corp.", "st.", "no.", "approx.", "bijv.", "o.a.", "d.w.z.", "enz.",
    "nr.", "ca.", "m.b.t.", "i.p.v.", "t.o.v.", "z.s.m.", "mvg.", "evt.", "incl.", "excl.",
    "m.a.w.",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sentence {
    pub text: String,
    /// The last sentence of a paragraph (a blank line follows).
    pub paragraph_end: bool,
}

fn is_abbreviation(word: &str) -> bool {
    let lower = word.trim_start_matches(['(', '"', '\'']).to_lowercase();
    if ABBREVIATIONS.contains(&lower.as_str()) {
        return true;
    }
    // A single initial ("J.") or a dotted acronym ("U.S.").
    let letters: Vec<&str> = lower.trim_end_matches('.').split('.').collect();
    letters
        .iter()
        .all(|l| l.chars().count() == 1 && l.chars().all(char::is_alphabetic))
}

/// Splits on `.`, `!`, `?` and `…` at word ends (closing quotes and brackets may
/// follow), except after known abbreviations and initials. Newlines inside a
/// paragraph are spaces; blank lines end paragraphs.
pub fn split_sentences(text: &str) -> Vec<Sentence> {
    let mut out = Vec::new();
    let normalized = text.replace("\r\n", "\n");
    for paragraph in normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let mut current: Vec<&str> = Vec::new();
        let start = out.len();
        for word in paragraph.split_whitespace() {
            current.push(word);
            let core = word.trim_end_matches(['"', '\'', ')', ']', '»', '”', '’']);
            let ends = core.ends_with(['.', '!', '?', '…']);
            if ends && !(core.ends_with('.') && is_abbreviation(core)) {
                out.push(Sentence {
                    text: current.join(" "),
                    paragraph_end: false,
                });
                current.clear();
            }
        }
        if !current.is_empty() {
            out.push(Sentence {
                text: current.join(" "),
                paragraph_end: false,
            });
        }
        if out.len() > start {
            out.last_mut().expect("non-empty").paragraph_end = true;
        }
    }
    if let Some(last) = out.last_mut() {
        last.paragraph_end = false;
    }
    out
}

/// Splits `text` into pieces of at most `max` characters: at `;` or `,` closest to
/// the middle first, then at the last space. Each piece keeps its punctuation.
pub fn split_long(text: &str, max: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return vec![text.to_string()];
    }
    let middle = chars.len() / 2;
    let breaks = |set: &[char]| -> Option<usize> {
        chars
            .iter()
            .enumerate()
            .filter(|&(i, c)| {
                set.contains(c) && i + 1 < chars.len() && chars[i + 1] == ' ' && i > 0
            })
            .map(|(i, _)| i)
            .min_by_key(|&i| i.abs_diff(middle))
    };
    let at = breaks(&[';', ','])
        .or_else(|| breaks(&[':', '-']))
        .map(|i| i + 1)
        .or_else(|| chars[..max].iter().rposition(|&c| c == ' '))
        .filter(|&i| i > 0)
        .unwrap_or(max);
    let head: String = chars[..at].iter().collect();
    let tail: String = chars[at..].iter().collect();
    let mut out = split_long(head.trim(), max);
    out.extend(split_long(tail.trim(), max));
    out.retain(|p| !p.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(s: &[Sentence]) -> Vec<&str> {
        s.iter().map(|s| s.text.as_str()).collect()
    }

    #[test]
    fn abbreviations_and_initials_do_not_end_sentences() {
        let s = split_sentences(
            "Dit geldt bijv. voor de app, o.a. de CLI. Ask Dr. Smith, e.g. about J. Doe! Done? Yes… “Klaar.” Next",
        );
        assert_eq!(
            texts(&s),
            [
                "Dit geldt bijv. voor de app, o.a. de CLI.",
                "Ask Dr. Smith, e.g. about J. Doe!",
                "Done?",
                "Yes…",
                "“Klaar.”",
                "Next",
            ]
        );
    }

    #[test]
    fn versions_and_file_names_stay_inside_their_sentence() {
        let s =
            split_sentences("Version 1.5.0 is out. I changed src/main.rs and config.json today.");
        assert_eq!(
            texts(&s),
            [
                "Version 1.5.0 is out.",
                "I changed src/main.rs and config.json today."
            ]
        );
    }

    #[test]
    fn blank_lines_mark_paragraph_ends_but_not_the_last_sentence() {
        let s = split_sentences("One.\nStill one paragraph.\n\nTwo.\r\n\r\nThree.");
        assert_eq!(
            texts(&s),
            ["One.", "Still one paragraph.", "Two.", "Three."]
        );
        let ends: Vec<bool> = s.iter().map(|s| s.paragraph_end).collect();
        assert_eq!(ends, [false, true, true, false]);
    }

    #[test]
    fn long_text_splits_at_the_comma_nearest_the_middle() {
        let text = format!(
            "{}, {}, {}.",
            "a".repeat(100),
            "b".repeat(100),
            "c".repeat(100)
        );
        let parts = split_long(&text, 300);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].ends_with(','));
        assert!(parts.iter().all(|p| p.chars().count() <= 300));
    }

    #[test]
    fn long_text_without_punctuation_splits_at_a_space() {
        let text = vec!["word"; 100].join(" ");
        let parts = split_long(&text, 300);
        assert!(parts.len() >= 2);
        assert!(parts
            .iter()
            .all(|p| p.chars().count() <= 300 && !p.starts_with(' ')));
        assert_eq!(parts.join(" "), text);
    }
}
