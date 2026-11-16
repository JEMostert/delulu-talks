//! Dutch or English, per sentence. Supertonic needs one language per chunk: inline
//! language tags inside a chunk make it drop words (spike E3), so a reply that
//! switches language is spoken sentence by sentence, each in its own language.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Nl,
    En,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::Nl => "nl",
            Lang::En => "en",
        }
    }

    pub fn parse(code: &str) -> Option<Lang> {
        match code.trim().to_ascii_lowercase().as_str() {
            "nl" | "dutch" | "nederlands" => Some(Lang::Nl),
            "en" | "english" | "engels" => Some(Lang::En),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LangChoice {
    /// Detect per sentence.
    #[default]
    Auto,
    Fixed(Lang),
}

impl LangChoice {
    /// `auto`, `nl` or `en` (also `dutch`, `english`).
    pub fn parse(value: &str) -> Option<LangChoice> {
        if value.trim().eq_ignore_ascii_case("auto") {
            return Some(LangChoice::Auto);
        }
        Lang::parse(value).map(LangChoice::Fixed)
    }
}

/// Function words that occur in one language and rarely in the other. Words both
/// languages share ("in", "is", "was", "we", "of", "an", "al", "door") are left out.
const NL: &[&str] = &[
    "de",
    "het",
    "een",
    "en",
    "ik",
    "je",
    "jij",
    "jou",
    "jouw",
    "niet",
    "dat",
    "die",
    "deze",
    "dit",
    "op",
    "te",
    "met",
    "voor",
    "zijn",
    "er",
    "maar",
    "om",
    "ook",
    "als",
    "dan",
    "nog",
    "wel",
    "naar",
    "bij",
    "uit",
    "aan",
    "kan",
    "kun",
    "wordt",
    "worden",
    "werd",
    "heb",
    "hebt",
    "heeft",
    "hebben",
    "nu",
    "geen",
    "hij",
    "zij",
    "ze",
    "wij",
    "mijn",
    "hun",
    "tot",
    "moet",
    "moeten",
    "wat",
    "waar",
    "hoe",
    "omdat",
    "want",
    "alle",
    "alles",
    "klaar",
    "gedaan",
    "staat",
    "weer",
    "nieuwe",
    "nieuw",
    "goed",
    "graag",
    "even",
    "dus",
    "toch",
    "hier",
    "daar",
    "zo",
    "meer",
    "veel",
    "ben",
    "bent",
    "gaat",
    "ga",
    "zal",
    "zou",
    "wil",
    "wilt",
    "kunnen",
    "mag",
    "werkt",
    "gemaakt",
    "toegevoegd",
    "opgelost",
    "fout",
    "bestand",
    "welkom",
    "terug",
    "nummer",
    "liedje",
    "straks",
    "luister",
    "jullie",
    "onze",
    "ons",
    "zelf",
    "eerst",
    "daarna",
    "sinds",
    "zonder",
    "tijdens",
];
const EN: &[&str] = &[
    "the", "a", "and", "are", "to", "it", "that", "this", "for", "on", "with", "as", "be", "by",
    "not", "have", "has", "had", "i", "you", "your", "they", "he", "she", "but", "or", "from",
    "at", "will", "can", "all", "done", "ready", "now", "there", "what", "which", "when", "where",
    "how", "my", "our", "their", "been", "were", "would", "should", "could", "just", "into",
    "about", "after", "before", "because", "so", "if", "then", "than", "its", "it's", "i'm",
    "don't", "doesn't", "fixed", "added", "passes", "passed", "works", "file", "welcome", "back",
    "song", "next", "up", "here", "more", "some", "any", "every", "also", "still", "only", "very",
    "new", "made", "found",
];

/// Positive leans Dutch, negative English, zero undecided.
pub fn score(sentence: &str) -> i32 {
    let mut score = 0;
    for raw in sentence.split(|c: char| !(c.is_alphanumeric() || c == '\'')) {
        if raw.is_empty() {
            continue;
        }
        let word = raw.to_lowercase();
        if NL.contains(&word.as_str()) {
            score += 2;
        }
        if EN.contains(&word.as_str()) {
            score -= 2;
        }
        // Spelling hints, weak: Dutch digraphs, English "th"/"w" clusters.
        if word.contains("ij")
            || word.contains("oe")
            || word.contains("ui")
            || word.contains("sch")
            || word.contains("aa")
            || word.contains("uu")
        {
            score += 1;
        }
        if word.starts_with("th") || word.ends_with("ing") || word.ends_with("tion") {
            score -= 1;
        }
    }
    score
}

/// One language per sentence. Undecided sentences ("Done.", "Oké.") follow the
/// previous decided sentence, else the next one, else the reply's overall lean,
/// else English.
pub fn assign(sentences: &[&str], choice: LangChoice) -> Vec<Lang> {
    if let LangChoice::Fixed(lang) = choice {
        return vec![lang; sentences.len()];
    }
    let scores: Vec<i32> = sentences.iter().map(|s| score(s)).collect();
    let total: i32 = scores.iter().sum();
    let overall = if total > 0 { Lang::Nl } else { Lang::En };
    let decided = |s: i32| match s.signum() {
        1 => Some(Lang::Nl),
        -1 => Some(Lang::En),
        _ => None,
    };
    (0..sentences.len())
        .map(|i| {
            decided(scores[i])
                .or_else(|| scores[..i].iter().rev().find_map(|&s| decided(s)))
                .or_else(|| scores[i + 1..].iter().find_map(|&s| decided(s)))
                .unwrap_or(overall)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typical_agent_sentences_are_classified() {
        let cases = [
            ("Ik heb de fout gevonden en opgelost.", Lang::Nl),
            (
                "De merge conflict in de pull request is opgelost.",
                Lang::Nl,
            ),
            (
                "Kijk even naar PR #519, daar zit de fix voor de GPU crash in.",
                Lang::Nl,
            ),
            (
                "I fixed the failing test and pushed the change to your branch.",
                Lang::En,
            ),
            (
                "Version 2.3.1 fixes 17 bugs, including the crash in settings.toml.",
                Lang::En,
            ),
            ("The build passed.", Lang::En),
            ("Alles werkt weer.", Lang::Nl),
        ];
        for (text, want) in cases {
            assert_eq!(assign(&[text], LangChoice::Auto), [want], "{text}");
        }
    }

    #[test]
    fn undecided_sentences_follow_their_neighbours() {
        let s = [
            "Klaar.",
            "Ik heb de tests gedraaid.",
            "Oké.",
            "Now in English, the build is done.",
        ];
        assert_eq!(
            assign(&s, LangChoice::Auto),
            [Lang::Nl, Lang::Nl, Lang::Nl, Lang::En]
        );
        assert_eq!(assign(&["Oké."], LangChoice::Auto), [Lang::En]);
    }

    #[test]
    fn a_fixed_language_wins() {
        assert_eq!(
            assign(&["The build passed."], LangChoice::Fixed(Lang::Nl)),
            [Lang::Nl]
        );
    }

    #[test]
    fn choices_parse() {
        assert_eq!(LangChoice::parse("auto"), Some(LangChoice::Auto));
        assert_eq!(LangChoice::parse("NL"), Some(LangChoice::Fixed(Lang::Nl)));
        assert_eq!(
            LangChoice::parse("English"),
            Some(LangChoice::Fixed(Lang::En))
        );
        assert_eq!(LangChoice::parse("fr"), None);
    }
}
