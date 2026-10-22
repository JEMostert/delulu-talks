//! Explicit delivery formatting commands (`src/spokenFormatting.ts`).

use std::sync::LazyLock;

use regex::Regex;

use crate::js;

const EN: &[(&str, &str)] = &[("command new paragraph", "\n\n"), ("command new line", "\n")];
const NL: &[(&str, &str)] = &[("commando nieuwe alinea", "\n\n"), ("commando nieuwe regel", "\n")];

regexes! {
    WORD_CHARACTER = r"[\p{L}\p{M}\p{N}_]", "u";
    QUOTATION = r#"["'“”‘’]"#, "u";
}

// Look-around is checked by hand; neither command is a prefix of the other.
static EN_PATTERN: LazyLock<Regex> = LazyLock::new(|| js::regex("command new paragraph|command new line", "giu"));
static NL_PATTERN: LazyLock<Regex> = LazyLock::new(|| js::regex("commando nieuwe alinea|commando nieuwe regel", "giu"));

/// Explicit delivery formatting; caller retains the original recognition text.
pub fn format_spoken_commands(text: &str, language: &str) -> String {
    let (pattern, grammar) = match language.to_lowercase().as_str() {
        "en" => (&*EN_PATTERN, EN),
        "nl" => (&*NL_PATTERN, NL),
        _ => return text.to_owned(),
    };
    let is_word = |ch| js::char_matches(&WORD_CHARACTER, ch);
    let found = js::scan(pattern, text, |caps| {
        let span = caps.get(0).unwrap();
        !is_word(js::char_before(text, span.start())) && !is_word(js::char_at(text, span.end()))
    });
    let mut cursor = 0;
    let mut output = String::with_capacity(text.len());
    for caps in found {
        let span = caps.get(0).unwrap();
        // Quoted command names are ordinary text, for example documentation.
        if js::char_matches(&QUOTATION, js::char_before(text, span.start()))
            || js::char_matches(&QUOTATION, js::char_at(text, span.end()))
        {
            continue;
        }
        let key = span.as_str().to_lowercase();
        let Some((_, replacement)) = grammar.iter().find(|(phrase, _)| *phrase == key) else { continue };
        output.push_str(text[cursor..span.start()].trim_end_matches([' ', '\t']));
        output.push_str(replacement);
        cursor = span.end();
        // Punctuation attached to the command and its separating spaces belong to
        // the command, while punctuation in the preceding prose stays untouched.
        if text[cursor..].starts_with([',', '.', '!', '?', ';', ':']) {
            cursor += 1;
        }
        while text[cursor..].starts_with([' ', '\t']) {
            cursor += 1;
        }
    }
    output.push_str(&text[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_become_breaks_unless_quoted() {
        assert_eq!(format_spoken_commands("First point. Command new line, second", "en"), "First point.\nsecond");
        assert_eq!(format_spoken_commands("a commando nieuwe alinea b", "NL"), "a\n\nb");
        assert_eq!(format_spoken_commands("say \"command new line\"", "en"), "say \"command new line\"");
        assert_eq!(format_spoken_commands("command new line", "de"), "command new line");
    }
}
