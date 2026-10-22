//! Parse Delulu Voice markup: Grok-style inline tags such as `[laugh]` and
//! wrapping styles such as `<whisper>…</whisper>`. Agents write this text, so
//! the parser is lenient: unknown tags are skipped with a warning, unclosed
//! styles close at the end, and anything that is not tag-shaped stays text.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::js;
use crate::voice::{VoiceEventTag, VoicePauseTag, VoiceStyle, VOICE_LIMITS};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceSegment {
    Text { text: String, styles: Vec<VoiceStyle> },
    Event { tag: VoiceEventTag, styles: Vec<VoiceStyle> },
    Pause { ms: u64, styles: Vec<VoiceStyle> },
}

impl VoiceSegment {
    pub fn styles(&self) -> &[VoiceStyle] {
        match self {
            VoiceSegment::Text { styles, .. } | VoiceSegment::Event { styles, .. } | VoiceSegment::Pause { styles, .. } => {
                styles
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedVoiceMarkup {
    pub segments: Vec<VoiceSegment>,
    pub warnings: Vec<String>,
    /// What a person would read: the text without tags.
    pub plain_text: String,
}

/// Spellings agents use for each sound, after lowercasing and hyphens → spaces.
fn event_alias(key: &str) -> Option<VoiceEventTag> {
    use VoiceEventTag::*;
    Some(match key {
        "laugh" | "laughs" | "laughing" => Laugh,
        "chuckle" | "chuckles" | "giggle" | "giggles" => Chuckle,
        "sigh" | "sighs" => Sigh,
        "gasp" | "gasps" => Gasp,
        "cough" | "coughs" => Cough,
        "clear throat" | "clears throat" => ClearThroat,
        "sniff" | "sniffs" => Sniff,
        "groan" | "groans" => Groan,
        "shush" => Shush,
        _ => return None,
    })
}

fn style_alias(key: &str) -> Option<VoiceStyle> {
    use VoiceStyle::*;
    Some(match key {
        "whisper" | "whispers" | "whispering" => Whisper,
        "happy" | "excited" => Happy,
        "angry" => Angry,
        "surprised" => Surprised,
        "scared" | "fear" => Scared,
        "sarcastic" => Sarcastic,
        "dramatic" => Dramatic,
        "narration" => Narration,
        "crying" => Crying,
        "slow" => Slow,
        "fast" => Fast,
        "soft" => Soft,
        "loud" => Loud,
        "emphasis" => Emphasis,
        _ => return None,
    })
}

/// Guards against runaway nesting from malformed input.
const MAX_STYLE_STACK: usize = 32;

enum Token {
    Text(String),
    Event(VoiceEventTag),
    Pause(u64),
    Open(VoiceStyle, String),
    Close(VoiceStyle, String),
}

static SQUARE_SEPARATORS: LazyLock<Regex> = LazyLock::new(|| js::regex(r"[\s_-]+", "g"));
static TIMED_PAUSE: LazyLock<Regex> =
    LazyLock::new(|| js::regex(r"^pause (\d+(?:\.\d+)?) ?(ms|s|sec|secs|seconds?)?$", ""));
static SQUARE_TAG: LazyLock<Regex> = LazyLock::new(|| js::regex(r"^[A-Za-z][A-Za-z _-]{1,23}$", ""));
static ACRONYM: LazyLock<Regex> = LazyLock::new(|| js::regex(r"^[A-Z]+$", ""));
static ANGLE_TAG: LazyLock<Regex> = LazyLock::new(|| js::regex(r"^<(\/?)([A-Za-z][A-Za-z_-]{1,23})\s*>", ""));
static CRLF: LazyLock<Regex> = LazyLock::new(|| js::regex(r"\r\n?", "g"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| js::regex(r"[^\S\n]+", "g"));
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| js::regex(r" ?\n[\s]*", "g"));
static SPACE_BEFORE_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| js::regex(r" +([.,!?;:…])", "g"));
static SPACE_AROUND_BREAK: LazyLock<Regex> = LazyLock::new(|| js::regex(r" +\n|\n +", "g"));
static DOUBLE_SPACE: LazyLock<Regex> = LazyLock::new(|| js::regex(r" {2,}", "g"));

fn square_key(content: &str) -> String {
    SQUARE_SEPARATORS.replace_all(&js::trim(content).to_lowercase(), " ").into_owned()
}

fn pause_ms(key: &str) -> Option<u64> {
    if key == "pause" {
        return Some(VoicePauseTag::Pause.ms());
    }
    if key == "long pause" {
        return Some(VoicePauseTag::LongPause.ms());
    }
    let timed = TIMED_PAUSE.captures(key)?;
    let value: f64 = timed[1].parse().ok()?;
    let ms = match timed.get(2) {
        Some(unit) if unit.as_str() != "ms" => value * 1000.0,
        _ => value,
    };
    Some(js::round(ms.max(0.0).min(VOICE_LIMITS.pause_ms as f64)) as u64)
}

/// `[word]` or `[two words]`; single letters, numbers and acronyms stay text.
fn looks_like_square_tag(content: &str) -> bool {
    let trimmed = js::trim(content);
    // [WIP], [TODO] and similar acronyms are part of the message, not markup.
    SQUARE_TAG.is_match(trimmed) && !ACRONYM.is_match(trimmed)
}

fn tokenize(input: &str, warnings: &mut Vec<String>) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, tokens: &mut Vec<Token>| {
        if !text.is_empty() {
            tokens.push(Token::Text(std::mem::take(text)));
        }
    };
    let mut index = 0;
    while let Some(ch) = js::char_at(input, index) {
        let next = js::char_at(input, index + ch.len_utf8());
        if ch == '\\' && matches!(next, Some('[' | '<')) {
            text.push(next.unwrap());
            index += 2;
            continue;
        }
        if ch == '[' {
            if let Some(offset) = input[index + 1..].find(']') {
                let end = index + 1 + offset;
                let content = &input[index + 1..end];
                // Markdown links keep their bracketed text: [label](url).
                if js::utf16_len(&input[index..end]) <= 41
                    && !content.contains(['[', '\n'])
                    && js::char_at(input, end + 1) != Some('(')
                {
                    let key = square_key(content);
                    let event = event_alias(&key);
                    let pause = pause_ms(&key);
                    if event.is_some() || pause.is_some() || looks_like_square_tag(content) {
                        flush(&mut text, &mut tokens);
                        if let Some(tag) = event {
                            tokens.push(Token::Event(tag));
                        } else if let Some(ms) = pause {
                            tokens.push(Token::Pause(ms));
                        } else {
                            warnings.push(format!("Unknown tag [{}] skipped", js::trim(content)));
                        }
                        index = end + 1;
                        continue;
                    }
                }
            }
        }
        if ch == '<' {
            let window = js::truncate_utf16(&input[index..], 32);
            if let Some(found) = ANGLE_TAG.captures(window) {
                let closing = !found[1].is_empty();
                // A word character before `<` is a generic type such as Array<string>.
                let generic = !closing
                    && js::char_before(input, index).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
                if !generic && !ACRONYM.is_match(&found[2]) {
                    flush(&mut text, &mut tokens);
                    let raw = found[0].to_owned();
                    match style_alias(&found[2].to_lowercase().replace('_', "-")) {
                        Some(style) if closing => tokens.push(Token::Close(style, raw)),
                        Some(style) => tokens.push(Token::Open(style, raw)),
                        None => warnings.push(format!("Unknown tag {raw} skipped")),
                    }
                    index += found[0].len();
                    continue;
                }
            }
        }
        text.push(ch);
        index += ch.len_utf8();
    }
    flush(&mut text, &mut tokens);
    tokens
}

/// Collapse spaces and tabs; keep single line breaks as sentence boundaries.
fn collapse(text: &str) -> String {
    let text = CRLF.replace_all(text, "\n");
    let text = SPACES.replace_all(&text, " ");
    LINE_BREAK.replace_all(&text, "\n").into_owned()
}

fn readable(text: &str) -> String {
    let text = collapse(text);
    let text = SPACE_BEFORE_PUNCTUATION.replace_all(&text, "${1}");
    let text = SPACE_AROUND_BREAK.replace_all(&text, "\n");
    let text = DOUBLE_SPACE.replace_all(&text, " ");
    js::trim(&text).to_owned()
}

fn unique(stack: &[VoiceStyle]) -> Vec<VoiceStyle> {
    let mut unique = Vec::new();
    for style in stack {
        if !unique.contains(style) {
            unique.push(*style);
        }
    }
    unique
}

pub fn parse_voice_markup(input: &str) -> ParsedVoiceMarkup {
    let mut warnings = Vec::new();
    let mut segments: Vec<VoiceSegment> = Vec::new();
    let mut stack: Vec<VoiceStyle> = Vec::new();
    let mut truncated = false;
    let active = |stack: &[VoiceStyle], warnings: &mut Vec<String>, truncated: &mut bool| {
        let mut unique = unique(stack);
        if unique.len() > VOICE_LIMITS.styles && !*truncated {
            *truncated = true;
            warnings.push(format!(
                "Only {} styles can apply at once; extra styles skipped",
                VOICE_LIMITS.styles
            ));
        }
        unique.truncate(VOICE_LIMITS.styles);
        unique
    };
    let tokens = tokenize(input, &mut warnings);
    for token in tokens {
        match token {
            Token::Open(style, raw) => {
                if stack.len() < MAX_STYLE_STACK {
                    stack.push(style);
                } else {
                    warnings.push(format!("Too many nested styles; {raw} skipped"));
                }
            }
            Token::Close(style, raw) => match stack.iter().rposition(|open| *open == style) {
                Some(at) => {
                    stack.remove(at);
                }
                None => warnings.push(format!("Closing tag {raw} had no opening tag")),
            },
            Token::Text(raw) => {
                let text = collapse(&raw);
                if js::trim(&text).is_empty() {
                    continue;
                }
                let styles = active(&stack, &mut warnings, &mut truncated);
                if let Some(VoiceSegment::Text { text: previous, styles: previous_styles }) = segments.last_mut() {
                    if *previous_styles == styles {
                        *previous = collapse(&format!("{previous}{text}"));
                        continue;
                    }
                }
                segments.push(VoiceSegment::Text { text, styles });
            }
            Token::Event(tag) => {
                let styles = active(&stack, &mut warnings, &mut truncated);
                segments.push(VoiceSegment::Event { tag, styles });
            }
            Token::Pause(ms) => {
                let styles = active(&stack, &mut warnings, &mut truncated);
                segments.push(VoiceSegment::Pause { ms, styles });
            }
        }
    }
    for style in unique(&stack) {
        warnings.push(format!("Unclosed tag <{style}> closed at the end"));
    }
    // Leading and trailing whitespace of the whole utterance carries nothing.
    if let Some(VoiceSegment::Text { text, .. }) = segments.first_mut() {
        *text = js::trim_start(text).to_owned();
    }
    if let Some(VoiceSegment::Text { text, .. }) = segments.last_mut() {
        *text = js::trim_end(text).to_owned();
    }
    let joined: String = segments
        .iter()
        .map(|segment| match segment {
            VoiceSegment::Text { text, .. } => text.as_str(),
            _ => " ",
        })
        .collect();
    let plain_text = readable(&joined);
    ParsedVoiceMarkup { segments, warnings, plain_text }
}

pub fn strip_voice_markup(input: &str) -> String {
    parse_voice_markup(input).plain_text
}

#[cfg(test)]
mod tests {
    use super::*;
    use VoiceStyle::*;

    fn text(text: &str, styles: &[VoiceStyle]) -> VoiceSegment {
        VoiceSegment::Text { text: text.into(), styles: styles.to_vec() }
    }

    #[test]
    fn plain_text_is_one_unstyled_segment() {
        let parsed = parse_voice_markup("  Done.   All tests pass.  ");
        assert_eq!(parsed.segments, [text("Done. All tests pass.", &[])]);
        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.plain_text, "Done. All tests pass.");
    }

    #[test]
    fn inline_sounds_become_events_in_order() {
        let parsed = parse_voice_markup("Okay, that one was my fault [laugh]. Fixed it.");
        assert_eq!(
            parsed.segments,
            [
                text("Okay, that one was my fault ", &[]),
                VoiceSegment::Event { tag: VoiceEventTag::Laugh, styles: vec![] },
                text(". Fixed it.", &[]),
            ]
        );
        assert_eq!(parsed.plain_text, "Okay, that one was my fault. Fixed it.");
    }

    #[test]
    fn accepts_aliases_case_and_spacing_variants() {
        let tags: Vec<String> = parse_voice_markup(
            "[Laughs] [ SIGHS ] [clear throat] [clear_throat] [giggle] [Chuckles] [gasps] [coughs] [clear-throat]",
        )
        .segments
        .iter()
        .map(|segment| match segment {
            VoiceSegment::Event { tag, .. } => tag.as_str().to_owned(),
            _ => "other".to_owned(),
        })
        .collect();
        assert_eq!(
            tags,
            ["laugh", "sigh", "clear-throat", "clear-throat", "chuckle", "chuckle", "gasp", "cough", "clear-throat"]
        );
    }

    #[test]
    fn pauses_carry_their_length_and_timed_pauses_are_clamped() {
        let pauses: Vec<u64> = parse_voice_markup(
            "a [pause] b [long-pause] c [long pause] d [pause 800ms] e [pause 2s] f [pause 60 seconds] g",
        )
        .segments
        .iter()
        .filter_map(|segment| match segment {
            VoiceSegment::Pause { ms, .. } => Some(*ms),
            _ => None,
        })
        .collect();
        assert_eq!(pauses, [400, 1200, 1200, 800, 2000, 5000]);
    }

    #[test]
    fn wrapping_styles_apply_to_their_span_and_nest() {
        let parsed = parse_voice_markup("Hi. <whisper>Between us, <slow>this was big</slow>.</whisper> Bye.");
        assert_eq!(
            parsed.segments,
            [
                text("Hi. ", &[]),
                text("Between us, ", &[Whisper]),
                text("this was big", &[Whisper, Slow]),
                text(".", &[Whisper]),
                text(" Bye.", &[]),
            ]
        );
        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.plain_text, "Hi. Between us, this was big. Bye.");
    }

    #[test]
    fn style_aliases_and_case_are_accepted() {
        let parsed = parse_voice_markup("<Whispering>a</Whispering><fear>b</fear>");
        let styles: Vec<_> = parsed.segments.iter().map(|segment| segment.styles().to_vec()).collect();
        assert_eq!(styles[..2], [vec![Whisper], vec![Scared]]);
    }

    #[test]
    fn events_inside_a_style_keep_that_style() {
        let parsed = parse_voice_markup("<happy>We shipped it [laugh]</happy>");
        assert_eq!(parsed.segments[1], VoiceSegment::Event { tag: VoiceEventTag::Laugh, styles: vec![Happy] });
    }

    #[test]
    fn closing_tags_close_the_most_recent_matching_style_leniently() {
        let parsed = parse_voice_markup("<soft><loud>a</soft>b</loud>c</whisper> d");
        assert_eq!(parsed.segments, [text("a", &[Soft, Loud]), text("b", &[Loud]), text("c d", &[])]);
        assert_eq!(parsed.warnings, ["Closing tag </whisper> had no opening tag"]);
    }

    #[test]
    fn unclosed_styles_close_at_the_end_with_a_warning() {
        let parsed = parse_voice_markup("<whisper>secret");
        assert_eq!(parsed.segments, [text("secret", &[Whisper])]);
        assert_eq!(parsed.warnings, ["Unclosed tag <whisper> closed at the end"]);
    }

    #[test]
    fn duplicate_styles_are_applied_once() {
        let parsed = parse_voice_markup("<slow><slow>a</slow>b</slow>c");
        let styles: Vec<_> = parsed.segments.iter().map(|segment| segment.styles().to_vec()).collect();
        assert_eq!(styles, [vec![Slow], vec![]]);
        assert_eq!(parsed.plain_text, "abc");
    }

    #[test]
    fn unknown_tag_shaped_tokens_are_skipped_with_a_warning() {
        let parsed = parse_voice_markup("Hello [dances wildly] there <shout>now</shout>.");
        assert_eq!(parsed.plain_text, "Hello there now.");
        assert_eq!(
            parsed.warnings,
            ["Unknown tag [dances wildly] skipped", "Unknown tag <shout> skipped", "Unknown tag </shout> skipped"]
        );
    }

    #[test]
    fn ordinary_brackets_and_comparisons_stay_literal() {
        for input in [
            "See note [1] and [x].",
            "- [ ] write tests",
            "Status [WIP] and [TODO].",
            "If a < b > c then a <= b and b >= c.",
            "It returns Array<string> or Map<K, V>.",
            "Use <T> here.",
            "Read [the docs](https://example.com) first.",
            "Escaped \\[laugh] tag",
        ] {
            let parsed = parse_voice_markup(input);
            assert!(parsed.warnings.is_empty(), "{input}");
            assert!(parsed.segments.iter().all(|segment| matches!(segment, VoiceSegment::Text { .. })), "{input}");
        }
        assert_eq!(strip_voice_markup("Escaped \\[laugh] and \\<whisper>"), "Escaped [laugh] and <whisper>");
        assert_eq!(strip_voice_markup("It returns Array<string>."), "It returns Array<string>.");
    }

    #[test]
    fn keeps_line_breaks_as_boundaries_and_collapses_other_whitespace() {
        let parsed = parse_voice_markup("First line\n\n\n  second\tline   ");
        assert_eq!(parsed.segments, [text("First line\nsecond line", &[])]);
    }

    #[test]
    fn whitespace_only_spans_between_tags_produce_no_segments() {
        let parsed = parse_voice_markup("[laugh] [sigh] <soft> </soft>");
        assert!(parsed.segments.iter().all(|segment| matches!(segment, VoiceSegment::Event { .. })));
        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.plain_text, "");
    }

    #[test]
    fn limits_the_number_of_simultaneous_styles() {
        let open: String = ["whisper", "happy", "angry", "surprised", "scared", "sarcastic", "dramatic", "narration", "crying"]
            .iter()
            .map(|style| format!("<{style}>"))
            .collect();
        let parsed = parse_voice_markup(&format!("{open}text"));
        assert_eq!(parsed.segments[0].styles().len(), 8);
        assert!(parsed.warnings[0].contains("Only 8 styles"));
    }

    #[test]
    fn segments_serialize_like_typescript() {
        let value = serde_json::to_value(text("a", &[Whisper])).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "text", "text": "a", "styles": ["whisper"]}));
    }
}
