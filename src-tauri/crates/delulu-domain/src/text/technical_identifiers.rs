//! Spoken identifier commands and protection of technical literals
//! (`src/technicalIdentifiers.ts`).

use regex::Captures;
use unicode_normalization::UnicodeNormalization;

use crate::js;

use super::TextPart;

/// Explicit identifier styles; ordinary prose is never interpreted as an identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifierStyle {
    Camel,
    Pascal,
    Snake,
    Kebab,
    Literal,
}

fn spoken_digit(word: &str) -> Option<&'static str> {
    Some(match word {
        "zero" | "nul" => "0",
        "one" | "een" | "één" => "1",
        "two" | "twee" => "2",
        "three" | "drie" => "3",
        "four" | "vier" => "4",
        "five" | "vijf" => "5",
        "six" | "zes" => "6",
        "seven" | "zeven" => "7",
        "eight" | "acht" => "8",
        "nine" | "negen" => "9",
        _ => return None,
    })
}

regexes! {
    LETTER = r"^\p{L}\p{M}*$", "u";
    WORD = r"^(?:\p{L}\p{M}*|\p{N})+$", "u";
    IDENTIFIER = r"^[\p{L}_][\p{L}\p{M}\p{N}_]*$", "u";
    KEBAB_IDENTIFIER = r"^\p{L}[\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$", "u";
    SPACES_OR_TABS = r"[ \t]+", "u";
    // `(^|…)` is a real prefix group in the TypeScript; the trailing lookahead
    // `(?=$|[^…])` is consumed outside the logical match `m`.
    COMMANDS = r"(?P<m>(?P<prefix>^|[^\p{L}\p{M}\p{N}_])(?P<marker>camel[ \t]+case|pascal[ \t]+case|snake[ \t]+case|kebab[ \t]+case|literal[ \t]+spelling)[ \t]+(?P<body>[^\r\n]*?)[ \t]+(?:end[ \t]+identifier|einde[ \t]+naam))(?:$|[^\p{L}\p{M}\p{N}_])", "giu";
}

/// Build an identifier from an explicitly requested body, or return `None` without guessing.
/// Words use NFC Unicode letters/marks/numbers separated by spaces or tabs. Acronyms are
/// normalized like other words: "HTTP client" becomes "httpClient" or "HttpClient".
/// Literal spelling accepts individual letters/digits, EN/NL digit names, underscore /
/// laag streepje, and capital X / hoofdletter X. Whole words are deliberately refused.
pub fn parse_technical_identifier(body: &str, style: IdentifierStyle) -> Option<String> {
    if js::utf16_len(body) > 1024 || body.contains(['\r', '\n']) {
        return None;
    }
    let normalized: String = body.nfc().collect();
    let normalized = normalized.trim_matches([' ', '\t']);
    if normalized.is_empty() {
        return None;
    }
    let tokens: Vec<&str> = SPACES_OR_TABS.split(normalized).collect();

    let result = if style == IdentifierStyle::Literal {
        let mut characters = String::new();
        let mut index = 0;
        while index < tokens.len() {
            let token = tokens[index];
            let lower = token.to_lowercase();
            if lower == "capital" || lower == "hoofdletter" {
                let next = tokens.get(index + 1).filter(|next| LETTER.is_match(next))?;
                characters.push_str(&next.to_uppercase());
                index += 1;
            } else if lower == "underscore" || token == "_" {
                characters.push('_');
            } else if lower == "laag" && tokens.get(index + 1).is_some_and(|next| next.to_lowercase() == "streepje") {
                characters.push('_');
                index += 1;
            } else if let Some(digit) = spoken_digit(&lower) {
                characters.push_str(digit);
            } else if LETTER.is_match(token) || (token.len() == 1 && token.as_bytes()[0].is_ascii_digit()) {
                characters.push_str(token);
            } else {
                return None;
            }
            index += 1;
        }
        characters
    } else {
        if !tokens.iter().all(|token| WORD.is_match(token)) {
            return None;
        }
        let words: Vec<String> = tokens.iter().map(|token| token.to_lowercase()).collect();
        let capitalize = |token: &String| {
            let mut characters = token.chars();
            characters.next().map_or_else(String::new, |first| first.to_uppercase().chain(characters).collect())
        };
        match style {
            IdentifierStyle::Camel => {
                words[0].clone() + &words[1..].iter().map(capitalize).collect::<String>()
            }
            IdentifierStyle::Pascal => words.iter().map(capitalize).collect(),
            IdentifierStyle::Snake => words.join("_"),
            IdentifierStyle::Kebab => words.join("-"),
            IdentifierStyle::Literal => unreachable!(),
        }
    };
    let valid = if style == IdentifierStyle::Kebab { &KEBAB_IDENTIFIER } else { &IDENTIFIER };
    valid.is_match(&result).then_some(result)
}

fn style_for(marker: &str) -> IdentifierStyle {
    match SPACES_OR_TABS.replace_all(&marker.to_lowercase(), " ").as_ref() {
        "camel case" => IdentifierStyle::Camel,
        "pascal case" => IdentifierStyle::Pascal,
        "snake case" => IdentifierStyle::Snake,
        "kebab case" => IdentifierStyle::Kebab,
        _ => IdentifierStyle::Literal,
    }
}

/// Render only complete, explicitly delimited single-line identifier commands.
pub fn render_identifier_commands(text: &str) -> String {
    js::replace(&COMMANDS, text, js::always, |caps: &Captures<'_>| {
        let style = style_for(&caps["marker"]);
        match parse_technical_identifier(&caps["body"], style) {
            Some(parsed) => format!("{}{parsed}", &caps["prefix"]),
            None => caps["m"].to_owned(),
        }
    })
}

/// A protected span, as byte offsets into the text (the TypeScript used
/// UTF-16 offsets; the spans cover the same characters).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TechnicalRange {
    pub start: usize,
    pub end: usize,
}

regexes! {
    LETTER_NUMBER = r"[\p{L}\p{N}_]", "u";
    EMAIL_CHARACTER = r"[\p{L}\p{N}_.+-]", "u";
    FENCED = r"```[^\r\n]*\r?\n[\s\S]*?(?:```|$)", "g";
    INLINE_CODE = r"`[^`\r\n]+`", "g";
    URL = r#"\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+"#, "giu";
    EMAIL = r"[\p{L}\p{N}_.+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+", "gu";
    QUOTED_PATH = r#"["'](?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^"'\r\n]*["']"#, "g";
    ROOTED_PATH = r#"(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^\s<>"'`]+"#, "gu";
    RELATIVE_PATH = r"(?P<m>[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)+)(?:$|[^\p{L}\p{N}_])", "gu";
    VERSION = r"(?P<m>v?\d+(?:\.\d+)+(?:[-+][\p{L}\p{N}.-]+)?)(?:$|[^\p{L}\p{N}_])", "gu";
    FLAG = r#"--[\p{L}\p{N}][\p{L}\p{N}_-]*(?:=[^\s<>"'`]+)?"#, "gu";
    PROMPT_LINE = r"^[\t ]*(?:\$|>)\s*[^\r\n]+", "gm";
    COMMAND_LINE = r"^[\t ]*(?:sudo\s+)?(?:git|npm|npx|bun|pnpm|yarn|node|python3?|pip3?|cargo|rustc|docker|kubectl|ffmpeg|curl|wget|ssh|rsync|chmod|chown|rm|mv|cp|mkdir|cmake|bash|zsh|powershell|pwsh|cmd(?:\.exe)?)(?:[\t ][^\r\n]*|$)", "gm";
    GO_LINE = r"^[\t ]*go\s+(?:build|run|test|mod|get|install|fmt|vet|generate|version|env|list|clean|tool)(?:[\t ][^\r\n]*|$)", "gm";
}

// Only explicit literals are protected. Spoken symbols remain recognizer text;
// this does not guess an address/path from ordinary Dutch or English prose.
pub fn technical_ranges(text: &str) -> Vec<TechnicalRange> {
    let before = |caps: &Captures<'_>| js::char_before(text, js::logical(caps).start());
    let email_lookbehind = |caps: &Captures<'_>| !js::char_matches(&EMAIL_CHARACTER, before(caps));
    let word_lookbehind = |caps: &Captures<'_>| !js::char_matches(&LETTER_NUMBER, before(caps));
    let mut ranges = Vec::new();
    let mut add = |found: Vec<Captures<'_>>| {
        ranges.extend(found.iter().map(|caps| {
            let span = js::logical(caps);
            TechnicalRange { start: span.start(), end: span.end() }
        }))
    };
    add(js::scan(&FENCED, text, js::always));
    add(js::scan(&INLINE_CODE, text, js::always));
    add(js::scan(&URL, text, js::always));
    add(js::scan(&EMAIL, text, email_lookbehind));
    add(js::scan(&QUOTED_PATH, text, js::always));
    add(js::scan(&ROOTED_PATH, text, word_lookbehind));
    add(js::scan(&RELATIVE_PATH, text, word_lookbehind));
    add(js::scan(&VERSION, text, word_lookbehind));
    add(js::scan(&FLAG, text, word_lookbehind));
    add(js::scan(&PROMPT_LINE, text, js::always));
    add(js::scan(&COMMAND_LINE, text, js::always));
    add(js::scan(&GO_LINE, text, js::always));
    ranges.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<TechnicalRange> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(previous) if range.start <= previous.end => previous.end = previous.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

pub fn split_technical_text(text: &str) -> Vec<TextPart> {
    let mut parts = Vec::new();
    let mut cursor = 0;
    for range in technical_ranges(text) {
        if range.start > cursor {
            parts.push(TextPart::new(&text[cursor..range.start], false));
        }
        parts.push(TextPart::new(&text[range.start..range.end], true));
        cursor = range.end;
    }
    if cursor < text.len() || parts.is_empty() {
        parts.push(TextPart::new(&text[cursor..], false));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_commands_render_only_explicit_bodies() {
        assert_eq!(render_identifier_commands("call camel case http client end identifier now"), "call httpClient now");
        assert_eq!(render_identifier_commands("Pascal Case voice  service einde naam."), "VoiceService.");
        assert_eq!(render_identifier_commands("literal spelling capital x underscore twee end identifier"), "X_2");
        assert_eq!(render_identifier_commands("snake case hello world end identifiers"), "snake case hello world end identifiers");
        assert_eq!(parse_technical_identifier("whole words", IdentifierStyle::Literal), None);
        assert_eq!(parse_technical_identifier("über café", IdentifierStyle::Kebab).as_deref(), Some("über-café"));
    }

    #[test]
    fn protects_literals_but_not_prose() {
        let text = "see https://a.dev/x, run `ls` in ./src/app or /tmp/x and v1.2.3, mail me@x.org\nnpm test --watch";
        let protected: Vec<_> = split_technical_text(text).into_iter().filter(|p| p.protected).map(|p| p.text).collect();
        assert_eq!(protected, ["https://a.dev/x,", "`ls`", "./src/app", "/tmp/x", "v1.2.3", "me@x.org", "npm test --watch"]);
        assert_eq!(split_technical_text(""), [TextPart::new("", false)]);
        // A version directly followed by a letter backtracks to a shorter match.
        let ranges = technical_ranges("1.2.3a");
        assert_eq!(ranges, [TechnicalRange { start: 0, end: 3 }]);
    }
}
