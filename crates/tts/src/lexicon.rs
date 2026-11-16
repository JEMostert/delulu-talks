//! Dutch respellings for English developer words inside Dutch sentences. Supertonic
//! reads a Dutch chunk with Dutch phonetics, so "build" became "beeld" and "release
//! notes" "release notice" in the spike; "rielies noots" is heard as intended.
//! The built-in table is `data/lexicon-nl.tsv`; [`Lexicon::extend_from_file`] adds
//! the user's own entries on top.
use std::path::Path;

const BUILTIN: &str = include_str!("../data/lexicon-nl.tsv");

#[derive(Debug, Clone, Default)]
pub struct Lexicon {
    /// Lowercase phrase → respelling, longest phrase first.
    entries: Vec<(String, String)>,
}

impl Lexicon {
    pub fn builtin() -> Lexicon {
        let mut lexicon = Lexicon::default();
        lexicon.extend_from_str(BUILTIN);
        lexicon
    }

    /// Adds `word<TAB>respelling` lines; `#` starts a comment. A later entry for the
    /// same phrase replaces the earlier one. Returns how many lines were used.
    pub fn extend_from_str(&mut self, text: &str) -> usize {
        let mut used = 0;
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if line.trim_start().starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let Some((word, spoken)) = line.split_once('\t') else {
                continue;
            };
            let (word, spoken) = (word.trim().to_lowercase(), spoken.trim().to_string());
            if word.is_empty() || spoken.is_empty() {
                continue;
            }
            self.entries.retain(|(w, _)| *w != word);
            self.entries.push((word, spoken));
            used += 1;
        }
        self.entries.sort_by(|a, b| {
            b.0.chars()
                .count()
                .cmp(&a.0.chars().count())
                .then(a.0.cmp(&b.0))
        });
        used
    }

    /// Adds the entries of a user file. A missing file is not an error.
    pub fn extend_from_file(&mut self, path: &Path) -> std::io::Result<usize> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(self.extend_from_str(&text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(e),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Replaces whole-word matches, longest phrase first, keeping a leading capital.
    /// Text already replaced is not matched again.
    pub fn apply(&self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let lower: Vec<char> = chars
            .iter()
            .map(|c| c.to_lowercase().next().unwrap_or(*c))
            .collect();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        'outer: while i < chars.len() {
            let at_word_start = i == 0 || !chars[i - 1].is_alphanumeric();
            if at_word_start && chars[i].is_alphanumeric() {
                for (word, spoken) in &self.entries {
                    let w: Vec<char> = word.chars().collect();
                    let end = i + w.len();
                    if end <= chars.len()
                        && lower[i..end] == w[..]
                        && (end == chars.len() || !chars[end].is_alphanumeric())
                    {
                        if chars[i].is_uppercase() {
                            let mut s = spoken.chars();
                            if let Some(first) = s.next() {
                                out.extend(first.to_uppercase());
                                out.push_str(s.as_str());
                            }
                        } else {
                            out.push_str(spoken);
                        }
                        i = end;
                        continue 'outer;
                    }
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_terms_in_dutch_are_respelled_by_whole_word_and_longest_phrase() {
        let lexicon = Lexicon::builtin();
        assert_eq!(
            lexicon.apply("Release notes noemen twaalf fixes; main staat klaar."),
            "Rielies noots noemen twaalf fikses; meen staat klaar."
        );
        // Not inside longer words, and Dutch words are left alone.
        assert_eq!(
            lexicon.apply("De mainframe en de fixesset blijven."),
            "De mainframe en de fixesset blijven."
        );
    }

    #[test]
    fn user_entries_override_and_extend_the_builtin_table() {
        let mut lexicon = Lexicon::builtin();
        let used = lexicon
            .extend_from_str("# mine\nmain\tmeeen!\nDelulu\tdeloeloe\nbroken line without tab\n");
        assert_eq!(used, 2);
        assert_eq!(lexicon.apply("Delulu main"), "Deloeloe meeen!");
        let missing = lexicon
            .extend_from_file(Path::new("/nonexistent/lexicon-nl.tsv"))
            .unwrap();
        assert_eq!(missing, 0);
    }
}
