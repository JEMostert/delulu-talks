//! JavaScript string and regular-expression semantics the TypeScript sources
//! relied on, so ported logic behaves the same on the same input.
//!
//! - `trim()` and `\s` use the ECMAScript whitespace set (which includes
//!   U+FEFF and excludes U+0085), not Rust's `White_Space`.
//! - `\d`, `\w` and `\b` are ASCII in JavaScript, even with the `u` flag.
//! - `.` excludes every ECMAScript line terminator.
//! - Lengths and slices that the TypeScript took on strings are UTF-16 code
//!   units; the helpers here never split a surrogate pair.
//!
//! Rust's `regex` has no look-around. Ported patterns emulate a lookbehind
//! with [`scan`]'s `accept` callback (checked at the candidate position; a
//! rejected candidate retries one character later, exactly like a
//! backtracking engine) and a lookahead by consuming it outside the named
//! group `m`, which is then the logical match.

use regex::{Captures, Regex, RegexBuilder};

pub use delulu_core::util::{truncate_utf16, utf16_len};

/// ECMAScript `WhiteSpace` and `LineTerminator` code points.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

/// `Math.round`: halves round toward positive infinity.
pub fn round(value: f64) -> f64 {
    if value - value.floor() == 0.5 {
        value.ceil()
    } else {
        value.round()
    }
}

/// `Number.isSafeInteger`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// Byte offset of the UTF-16 index `units`, clamped to the end and moved
/// forward past a surrogate pair it would split.
pub fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        if count >= units {
            return index;
        }
        count += ch.len_utf16();
    }
    text.len()
}

/// UTF-16 index of a byte offset (a char boundary).
pub fn byte_to_utf16(text: &str, byte: usize) -> usize {
    utf16_len(&text[..byte])
}

/// The character after a byte offset, like `text[index]` on a char boundary.
pub fn char_at(text: &str, byte: usize) -> Option<char> {
    text.get(byte..).and_then(|rest| rest.chars().next())
}

/// The character before a byte offset, like `text[index - 1]`.
pub fn char_before(text: &str, byte: usize) -> Option<char> {
    text.get(..byte).and_then(|head| head.chars().next_back())
}

/// Whether a single character matches a character-class regex (`None`, the
/// position before the start or after the end, never matches).
pub fn char_matches(class: &Regex, ch: Option<char>) -> bool {
    ch.is_some_and(|ch| class.is_match(ch.encode_utf8(&mut [0; 4])))
}

/// The byte offset of the next character boundary after `byte`.
pub fn next_boundary(text: &str, byte: usize) -> usize {
    char_at(text, byte).map_or(text.len() + 1, |ch| byte + ch.len_utf8())
}

/// `String(number)` for the values that occur in messages.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i128)
    } else {
        format!("{value}")
    }
}

/// `String(value)` for a JSON value.
pub fn value_to_string(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.as_f64().map_or_else(|| number.to_string(), number_to_string),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => value_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Translates a JavaScript regular expression source to Rust `regex` syntax.
/// Look-around and back-references are not supported and panic, so a port
/// cannot silently change meaning.
pub fn translate(source: &str) -> String {
    let mut out = String::with_capacity(source.len() + 16);
    let mut chars = source.chars().peekable();
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                let next = chars.next().expect("dangling escape");
                match next {
                    'd' => out.push_str(if in_class { "0-9" } else { "[0-9]" }),
                    'D' => out.push_str("[^0-9]"),
                    'w' => out.push_str(if in_class { "0-9A-Za-z_" } else { "[0-9A-Za-z_]" }),
                    'W' => out.push_str("[^0-9A-Za-z_]"),
                    's' => {
                        if in_class {
                            out.push_str(WS);
                        } else {
                            out.push('[');
                            out.push_str(WS);
                            out.push(']');
                        }
                    }
                    'S' => {
                        out.push_str("[^");
                        out.push_str(WS);
                        out.push(']');
                    }
                    'b' if !in_class => out.push_str(r"(?-u:\b)"),
                    'B' if !in_class => out.push_str(r"(?-u:\B)"),
                    'u' => {
                        out.push_str(r"\x");
                        if chars.peek() == Some(&'{') {
                            for c in chars.by_ref() {
                                out.push(c);
                                if c == '}' {
                                    break;
                                }
                            }
                        } else {
                            let hex: String = chars.by_ref().take(4).collect();
                            out.push('{');
                            out.push_str(&hex);
                            out.push('}');
                        }
                    }
                    '1'..='9' => panic!("back-references are not supported: {source}"),
                    '/' => out.push('/'),
                    other => {
                        out.push('\\');
                        out.push(other);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
            }
            // A JavaScript class cannot nest; Rust would read `[` as a nested class.
            '[' => out.push_str(r"\["),
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '&' | '~' if in_class => {
                out.push('\\');
                out.push(ch);
            }
            '.' if !in_class => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
            '(' if !in_class && chars.peek() == Some(&'?') => {
                out.push('(');
                out.push(chars.next().unwrap());
                match chars.peek() {
                    Some('=' | '!') => panic!("look-around is not supported: {source}"),
                    Some('<') => {
                        out.push(chars.next().unwrap());
                        // Otherwise a named group: Rust accepts `(?<name>` too.
                        if let Some('=' | '!') = chars.peek() {
                            panic!("look-around is not supported: {source}");
                        }
                    }
                    _ => {}
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Compiles a JavaScript regex source with JavaScript flags (`i`, `m`; `g`,
/// `u` and `y` carry no meaning here).
pub fn regex(source: &str, flags: &str) -> Regex {
    RegexBuilder::new(&translate(source))
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .crlf(flags.contains('m'))
        .size_limit(256 << 20)
        .dfa_size_limit(64 << 20)
        .build()
        .unwrap_or_else(|error| panic!("invalid ported regex {source}: {error}"))
}

/// The logical match: the named group `m` when the pattern has one.
pub fn logical<'t>(caps: &Captures<'t>) -> regex::Match<'t> {
    caps.name("m").unwrap_or_else(|| caps.get(0).unwrap())
}

/// Successive non-overlapping matches, like `matchAll` with the `g` flag.
/// `accept` decides look-behind (and, where no shorter alternative can match
/// at the same start, look-ahead) conditions; a rejected candidate retries
/// one character after the start of its whole match.
pub fn scan<'t>(re: &Regex, text: &'t str, mut accept: impl FnMut(&Captures<'t>) -> bool) -> Vec<Captures<'t>> {
    let mut found = Vec::new();
    let mut position = 0;
    while position <= text.len() {
        let Some(caps) = re.captures_at(text, position) else { break };
        let whole = caps.get(0).unwrap();
        if !accept(&caps) {
            position = next_boundary(text, whole.start());
            continue;
        }
        let span = logical(&caps);
        position = if span.end() > span.start() { span.end() } else { next_boundary(text, span.end()) };
        found.push(caps);
    }
    found
}

/// `String.prototype.replace` with a global regex and a replacer function,
/// using [`scan`]'s matching rules. Only the logical span is replaced.
pub fn replace<'t>(
    re: &Regex,
    text: &'t str,
    accept: impl FnMut(&Captures<'t>) -> bool,
    mut replacer: impl FnMut(&Captures<'t>) -> String,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for caps in scan(re, text, accept) {
        let span = logical(&caps);
        out.push_str(&text[cursor..span.start()]);
        out.push_str(&replacer(&caps));
        cursor = span.end();
    }
    out.push_str(&text[cursor..]);
    out
}

/// Accept every candidate.
pub fn always(_: &Captures<'_>) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_and_classes_follow_javascript() {
        assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        let re = regex(r"^\w+\s\d$", "");
        assert!(re.is_match("ab_\u{FEFF}1"));
        assert!(!re.is_match("é 1"));
        assert!(regex("[[\\n]", "").is_match("["));
        assert!(!regex("^.$", "").is_match("\u{2028}"));
    }

    #[test]
    fn rounding_and_numbers_match_javascript() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(number_to_string(2.0), "2");
        assert_eq!(number_to_string(1.5), "1.5");
        assert_eq!(value_to_string(&serde_json::json!([1, null, "a"])), "1,,a");
    }

    #[test]
    fn scan_retries_rejected_lookbehind_one_character_later() {
        let re = regex("a+", "");
        let found: Vec<_> = scan(&re, "baaa a", |caps| char_before("baaa a", caps.get(0).unwrap().start()) != Some('b'))
            .iter()
            .map(|caps| caps.get(0).unwrap().as_str().to_owned())
            .collect();
        assert_eq!(found, ["aa", "a"]);
    }
}
