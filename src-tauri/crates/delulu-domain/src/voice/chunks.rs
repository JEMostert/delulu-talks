//! Plan synthesis chunks from parsed voice markup. The first chunk is short so
//! audio starts quickly; the next chunk is synthesized while the previous one
//! plays. A chunk never mixes speaking styles.
//!
//! Character counts are UTF-16 code units, like the TypeScript `length`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::js;
use crate::voice::markup::VoiceSegment;
use crate::voice::{VoicePart, VoiceStyle, VOICE_LIMITS};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChunk {
    pub styles: Vec<VoiceStyle>,
    pub parts: Vec<VoicePart>,
    /// Display text without tags.
    pub text: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChunkOptions {
    /// Default 140.
    pub first_chunk_characters: Option<usize>,
    /// Default 420.
    pub chunk_characters: Option<usize>,
}

/// Silence one chunk may carry, well inside the worker's 90-second audio limit.
const MAX_CHUNK_PAUSE_MS: u64 = 15_000;

/// `[.!?…;]+["'’”)\]]*(?=\s|$)`, with the look-ahead consumed outside `m`.
static SENTENCE_END: LazyLock<Regex> =
    LazyLock::new(|| js::regex(r#"(?P<m>[.!?…;]+["'’”)\]]*)(?:\s|$)"#, "g"));
static SPACE_BEFORE_PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| js::regex(r"\s+([.,!?;:…])", "g"));
static RUNS_OF_SPACE: LazyLock<Regex> = LazyLock::new(|| js::regex(r"\s{2,}", "g"));

/// Split at sentence punctuation followed by whitespace, and at line breaks.
fn sentences(text: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    for line in text.split('\n') {
        let mut start = 0;
        for caps in js::scan(&SENTENCE_END, line, js::always) {
            let end = js::logical(&caps).end();
            pieces.push(&line[start..end]);
            start = end;
        }
        pieces.push(&line[start..]);
    }
    pieces.into_iter().map(js::trim).filter(|piece| !piece.is_empty()).map(str::to_owned).collect()
}

/// Break an overlong sentence at a clause boundary, else a space, else anywhere.
fn fit(sentence: &str, limit: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut rest = sentence.to_owned();
    while js::utf16_len(&rest) > limit {
        let window = js::truncate_utf16(&rest, limit + 1);
        let units = |found: Option<usize>| found.map_or(-1, |byte| js::byte_to_utf16(window, byte) as i64);
        let clause = [", ", "; ", " — ", " - "].iter().map(|separator| units(window.rfind(separator))).max().unwrap();
        let space = units(window.rfind(' '));
        let third = limit as f64 / 3.0;
        let cut_units = if clause as f64 > third {
            clause as usize + 1
        } else if space as f64 > third {
            space as usize
        } else {
            limit
        };
        let cut = js::utf16_to_byte(&rest, cut_units);
        pieces.push(js::trim(&rest[..cut]).to_owned());
        rest = js::trim(&rest[cut..]).to_owned();
    }
    if !rest.is_empty() {
        pieces.push(rest);
    }
    pieces
}

fn display_text(parts: &[VoicePart]) -> String {
    let joined = parts
        .iter()
        .filter_map(|part| match part {
            VoicePart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let text = SPACE_BEFORE_PUNCTUATION.replace_all(&joined, "${1}");
    let text = RUNS_OF_SPACE.replace_all(&text, " ");
    js::trim(&text).to_owned()
}

struct Draft {
    styles: Vec<VoiceStyle>,
    parts: Vec<VoicePart>,
    characters: usize,
}

struct Planner {
    first: usize,
    later: usize,
    chunks: Vec<Draft>,
    current: Option<Draft>,
}

impl Planner {
    fn target(&self) -> usize {
        if self.chunks.is_empty() { self.first } else { self.later }
    }

    fn close(&mut self) {
        if let Some(draft) = self.current.take() {
            if draft.parts.iter().any(|part| !matches!(part, VoicePart::Pause { .. })) {
                self.chunks.push(draft);
            }
        }
    }

    fn open(&mut self, styles: &[VoiceStyle]) -> &mut Draft {
        self.current.get_or_insert_with(|| Draft { styles: styles.to_vec(), parts: Vec::new(), characters: 0 })
    }

    fn add(&mut self, styles: &[VoiceStyle], part: VoicePart, characters: usize) {
        if self.open(styles).parts.len() >= VOICE_LIMITS.chunk_parts {
            self.close();
        }
        let draft = self.open(styles);
        match (part, draft.parts.last_mut()) {
            (VoicePart::Text { text }, Some(VoicePart::Text { text: previous })) => {
                previous.push(' ');
                previous.push_str(&text);
                draft.characters += characters + 1;
            }
            (part, _) => {
                draft.parts.push(part);
                draft.characters += characters;
            }
        }
    }
}

pub fn plan_voice_chunks(segments: &[VoiceSegment], options: ChunkOptions) -> Vec<VoiceChunk> {
    let ceiling = VOICE_LIMITS.chunk_characters;
    let mut planner = Planner {
        first: ceiling.min(options.first_chunk_characters.unwrap_or(140).max(1)),
        later: ceiling.min(options.chunk_characters.unwrap_or(420).max(1)),
        chunks: Vec::new(),
        current: None,
    };

    for segment in segments {
        if planner.current.as_ref().is_some_and(|draft| draft.styles != segment.styles()) {
            planner.close();
        }
        match segment {
            VoiceSegment::Pause { ms, .. } => {
                // A pause belongs at the end of what came before it; leading ones carry nothing.
                let host = match planner.current.as_mut() {
                    Some(draft) if !draft.parts.is_empty() => Some(draft),
                    _ => planner.chunks.last_mut(),
                };
                // Stay inside the worker's part and audio limits however many pauses arrive.
                if let Some(host) = host {
                    let paused: u64 = host
                        .parts
                        .iter()
                        .map(|part| if let VoicePart::Pause { ms } = part { *ms } else { 0 })
                        .sum();
                    if host.parts.len() < VOICE_LIMITS.chunk_parts && paused + ms <= MAX_CHUNK_PAUSE_MS {
                        host.parts.push(VoicePart::Pause { ms: *ms });
                    }
                }
            }
            VoiceSegment::Event { tag, styles } => planner.add(styles, VoicePart::Event { tag: *tag }, 0),
            VoiceSegment::Text { text, styles } => {
                for sentence in sentences(text) {
                    for piece in fit(&sentence, ceiling) {
                        let length = js::utf16_len(&piece);
                        let target = planner.target();
                        if planner
                            .current
                            .as_ref()
                            .is_some_and(|draft| draft.characters > 0 && draft.characters + 1 + length > target)
                        {
                            planner.close();
                        }
                        planner.add(styles, VoicePart::Text { text: piece }, length);
                    }
                }
            }
        }
    }
    planner.close();

    let mut chunks = planner.chunks;
    if let Some(last) = chunks.last_mut() {
        while matches!(last.parts.last(), Some(VoicePart::Pause { .. })) {
            last.parts.pop();
        }
    }
    chunks
        .into_iter()
        .map(|Draft { styles, parts, .. }| VoiceChunk { text: display_text(&parts), styles, parts })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::markup::parse_voice_markup;
    use crate::voice::VoiceEventTag;

    fn plan(markup: &str) -> Vec<VoiceChunk> {
        plan_with(markup, ChunkOptions::default())
    }

    fn plan_with(markup: &str, options: ChunkOptions) -> Vec<VoiceChunk> {
        plan_voice_chunks(&parse_voice_markup(markup).segments, options)
    }

    fn sized(first: usize, later: usize) -> ChunkOptions {
        ChunkOptions { first_chunk_characters: Some(first), chunk_characters: Some(later) }
    }

    fn text_part(text: &str) -> VoicePart {
        VoicePart::Text { text: text.into() }
    }

    fn texts(chunks: &[VoiceChunk]) -> Vec<&str> {
        chunks.iter().map(|chunk| chunk.text.as_str()).collect()
    }

    #[test]
    fn a_short_briefing_is_one_chunk() {
        assert_eq!(
            plan("Done. All tests pass."),
            [VoiceChunk {
                styles: vec![],
                parts: vec![text_part("Done. All tests pass.")],
                text: "Done. All tests pass.".into()
            }]
        );
    }

    #[test]
    fn events_and_pauses_keep_their_order_inside_a_chunk() {
        assert_eq!(
            plan("Okay, that one was my fault [laugh]. Fixed it [pause] for real."),
            [VoiceChunk {
                styles: vec![],
                parts: vec![
                    text_part("Okay, that one was my fault"),
                    VoicePart::Event { tag: VoiceEventTag::Laugh },
                    text_part(". Fixed it"),
                    VoicePart::Pause { ms: 400 },
                    text_part("for real."),
                ],
                text: "Okay, that one was my fault. Fixed it for real.".into(),
            }]
        );
    }

    #[test]
    fn a_style_change_starts_a_new_chunk() {
        let chunks = plan("Hi there. <whisper>Between us, it was big.</whisper> Bye.");
        let summary: Vec<_> = chunks.iter().map(|chunk| (chunk.styles.clone(), chunk.text.as_str())).collect();
        assert_eq!(
            summary,
            [(vec![], "Hi there."), (vec![VoiceStyle::Whisper], "Between us, it was big."), (vec![], "Bye.")]
        );
    }

    #[test]
    fn the_first_chunk_is_short_so_audio_starts_quickly() {
        let sentence = "This sentence has exactly forty-six characters.";
        let all = [sentence; 12].join(" ");
        let chunks = plan_with(&all, sized(100, 200));
        assert_eq!(chunks[0].text, format!("{sentence} {sentence}"));
        assert!(chunks[1].text.len() <= 200);
        assert!(chunks[1].text.len() > 100);
        assert_eq!(texts(&chunks).join(" "), all);
    }

    #[test]
    fn sentences_split_at_punctuation_followed_by_space_not_inside_numbers() {
        let chunks = plan_with("It took 3.5 seconds. Version 2.0 shipped!", sized(10, 10));
        assert_eq!(texts(&chunks), ["It took 3.5 seconds.", "Version 2.0 shipped!"]);
    }

    #[test]
    fn line_breaks_are_boundaries() {
        let chunks = plan_with("Summary.\nFixed the bug.\nAdded tests.", sized(10, 10));
        assert_eq!(texts(&chunks), ["Summary.", "Fixed the bug.", "Added tests."]);
    }

    #[test]
    fn overlong_sentences_split_at_commas_then_spaces_within_the_ceiling() {
        let clause = "one two three four five six seven eight nine ten";
        let chunks = plan(&[clause; 20].join(", "));
        assert!(chunks.iter().all(|chunk| chunk.text.len() <= VOICE_LIMITS.chunk_characters));
        assert!(chunks.len() > 1);
        assert!(chunks[1].text.starts_with("one"));
        let words = "word ".repeat(400);
        assert!(plan(words.trim()).iter().all(|chunk| chunk.text.len() <= VOICE_LIMITS.chunk_characters));
        let lengths: Vec<_> = plan(&"x".repeat(1500)).iter().map(|chunk| chunk.text.len()).collect();
        assert_eq!(lengths, [600, 600, 300]);
    }

    #[test]
    fn leading_and_trailing_pauses_are_dropped_boundary_pauses_stay_with_the_previous_chunk() {
        assert_eq!(
            plan("[pause] Hello. [long-pause] <whisper>quiet</whisper> [pause]"),
            [
                VoiceChunk {
                    styles: vec![],
                    parts: vec![text_part("Hello."), VoicePart::Pause { ms: 1200 }],
                    text: "Hello.".into()
                },
                VoiceChunk { styles: vec![VoiceStyle::Whisper], parts: vec![text_part("quiet")], text: "quiet".into() },
            ]
        );
    }

    #[test]
    fn an_utterance_of_only_a_sound_is_still_spoken() {
        assert_eq!(
            plan("[laugh]"),
            [VoiceChunk { styles: vec![], parts: vec![VoicePart::Event { tag: VoiceEventTag::Laugh }], text: String::new() }]
        );
        assert!(plan("[pause] [long-pause]").is_empty());
        assert!(plan("").is_empty());
    }

    #[test]
    fn never_exceeds_the_part_limit() {
        let chunks = plan(&["a [laugh]"; 250].join(" "));
        assert!(chunks.iter().all(|chunk| chunk.parts.len() <= VOICE_LIMITS.chunk_parts));
        let events = chunks
            .iter()
            .flat_map(|chunk| &chunk.parts)
            .filter(|part| matches!(part, VoicePart::Event { .. }))
            .count();
        assert_eq!(events, 250);
    }
}
