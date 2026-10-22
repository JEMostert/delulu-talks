//! Spoken punctuation commands for dictation (`src/dictationFormatting.ts`).

use std::sync::LazyLock;

use regex::Regex;

use crate::js;
use crate::types::{CustomWord, DictationFormatting, RuleKind};

use super::personalization::{personalize, rule_kind, split_for_rewrite};
use super::TextPart;

const EN_COMMANDS: &[(&str, &str)] = &[
    ("insert comma", ","),
    ("insert period", "."),
    ("insert question mark", "?"),
    ("insert exclamation mark", "!"),
    ("insert colon", ":"),
    ("insert semicolon", ";"),
    ("insert new line", "\n"),
    ("insert new paragraph", "\n\n"),
];

const NL_COMMANDS: &[(&str, &str)] = &[
    ("voeg komma in", ","),
    ("voeg punt in", "."),
    ("voeg vraagteken in", "?"),
    ("voeg uitroepteken in", "!"),
    ("voeg dubbele punt in", ":"),
    ("voeg puntkomma in", ";"),
    ("voeg nieuwe regel in", "\n"),
    ("voeg nieuwe alinea in", "\n\n"),
];

regexes! {
    WORD_CHARACTER = r"[\p{L}\p{M}\p{N}_]", "u";
    NO_SPACE_BEFORE = r#"[\s.,!?;:)}\]"'”’]"#, "u";
}

fn command_pattern(commands: &[(&str, &str)]) -> Regex {
    let mut phrases: Vec<&str> = commands.iter().map(|(phrase, _)| *phrase).collect();
    phrases.sort_by_key(|phrase| std::cmp::Reverse(js::utf16_len(phrase)));
    // Look-behind and look-ahead are checked in `spoken_commands`. No command is
    // a prefix of another, so checking the look-ahead after matching is exact.
    js::regex(&format!(r"(?P<m>[ \t]*(?P<phrase>{})[ \t]*)", phrases.join("|")), "giu")
}

static EN_PATTERN: LazyLock<Regex> = LazyLock::new(|| command_pattern(EN_COMMANDS));
static NL_PATTERN: LazyLock<Regex> = LazyLock::new(|| command_pattern(NL_COMMANDS));

fn is_word(ch: Option<char>) -> bool {
    js::char_matches(&WORD_CHARACTER, ch)
}

/// `wordCharacter.test(text[i])` on one UTF-16 unit: half of a surrogate pair never matches.
fn unit_is_word(ch: Option<char>) -> bool {
    ch.is_some_and(|ch| ch.len_utf16() == 1) && is_word(ch)
}

fn escaped(text: &str, index: usize) -> bool {
    text.as_bytes()[..index].iter().rev().take_while(|&&byte| byte == b'\\').count() % 2 == 1
}

/// Protect only balanced literal delimiters; apostrophes inside words stay prose.
fn literals(text: &str) -> Vec<TextPart> {
    let mut parts = Vec::new();
    let mut cursor = 0;
    let mut index = 0;
    while let Some(opener) = js::char_at(text, index) {
        let quote = matches!(opener, '`' | '"' | '\'' | '“' | '‘');
        if escaped(text, index) || !quote || (matches!(opener, '\'' | '‘') && unit_is_word(js::char_before(text, index))) {
            index += opener.len_utf8();
            continue;
        }
        let mut delimiter = opener.to_string();
        if opener == '`' {
            while text[index + delimiter.len()..].starts_with('`') {
                delimiter.push('`');
            }
        }
        let closer = match opener {
            '“' => "”".to_owned(),
            '‘' => "’".to_owned(),
            _ => delimiter.clone(),
        };
        let find_from = |from: usize| text[from..].find(closer.as_str()).map(|found| found + from);
        let mut end = find_from(index + delimiter.len());
        while let Some(at) = end {
            let after = at + closer.len();
            let inside_word = (closer == "'" || closer == "’")
                && unit_is_word(js::char_before(text, at))
                && unit_is_word(js::char_at(text, after));
            let longer_fence = opener == '`' && (js::char_before(text, at) == Some('`') || text[after..].starts_with('`'));
            if !(escaped(text, at) || inside_word || longer_fence) {
                break;
            }
            end = find_from(after);
        }
        let Some(at) = end else {
            index += if opener == '`' { delimiter.len() } else { opener.len_utf8() };
            continue;
        };
        if index > cursor {
            parts.push(TextPart::new(&text[cursor..index], false));
        }
        let end = at + closer.len();
        parts.push(TextPart::new(&text[index..end], true));
        cursor = end;
        index = end;
    }
    if cursor < text.len() {
        parts.push(TextPart::new(&text[cursor..], false));
    }
    parts
}

fn spoken_commands(text: &str, language: &str) -> String {
    let (pattern, commands) = if language == "nl" { (&*NL_PATTERN, NL_COMMANDS) } else { (&*EN_PATTERN, EN_COMMANDS) };
    let accept = |caps: &regex::Captures<'_>| {
        let phrase = caps.name("phrase").unwrap();
        let before = js::char_before(text, phrase.start());
        let after = js::char_at(text, phrase.end());
        let behind_ok = !is_word(before)
            && !matches!(before, Some(apostrophe @ ('\'' | '’'))
                if is_word(js::char_before(text, phrase.start() - apostrophe.len_utf8())));
        let ahead_ok = !is_word(after)
            && !matches!(after, Some(apostrophe @ ('\'' | '’'))
                if is_word(js::char_at(text, phrase.end() + apostrophe.len_utf8())));
        behind_ok && ahead_ok
    };
    js::replace(pattern, text, accept, |caps| {
        let matched = &caps["m"];
        let key = caps["phrase"].to_lowercase();
        let Some((_, inserted)) = commands.iter().find(|(phrase, _)| *phrase == key) else {
            return matched.to_owned();
        };
        if inserted.starts_with('\n') {
            return (*inserted).to_owned();
        }
        let following = js::char_at(text, caps.name("m").unwrap().end());
        let had_space = matched.ends_with([' ', '\t']);
        let space = had_space && following.is_some() && !js::char_matches(&NO_SPACE_BEFORE, following);
        format!("{inserted}{}", if space { " " } else { "" })
    })
}

/// Applies vocabulary rules and, in spoken mode for English or Dutch, the
/// spoken punctuation commands, outside quoted literals and saved blocks.
pub fn format_dictation(text: &str, words: &[CustomWord], mode: DictationFormatting, language: &str) -> String {
    if mode != DictationFormatting::Spoken || (language != "en" && language != "nl") {
        return personalize(text, words, None);
    }
    let corrections: Vec<CustomWord> = words.iter().filter(|word| rule_kind(word) == RuleKind::Correction).cloned().collect();
    literals(text)
        .into_iter()
        .map(|literal| {
            if literal.protected {
                return literal.text;
            }
            split_for_rewrite(&literal.text, words, None)
                .into_iter()
                .map(|part| {
                    if part.protected {
                        part.text
                    } else {
                        spoken_commands(&personalize(&part.text, &corrections, None), language)
                    }
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_commands_insert_punctuation_outside_literals() {
        let spoken = DictationFormatting::Spoken;
        assert_eq!(format_dictation("hello insert comma world insert period", &[], spoken, "en"), "hello, world.");
        assert_eq!(format_dictation("eerst voeg nieuwe regel in dan", &[], spoken, "nl"), "eerst\ndan");
        assert_eq!(format_dictation("say \"insert comma\" now", &[], spoken, "en"), "say \"insert comma\" now");
        assert_eq!(format_dictation("don't insert comma's", &[], spoken, "en"), "don't insert comma's");
        assert_eq!(format_dictation("a insert comma b", &[], DictationFormatting::Preserve, "en"), "a insert comma b");
    }
}
