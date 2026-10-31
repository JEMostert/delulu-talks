//! What the station remembers in `radio/station.json`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA: u32 = 1;
pub const MAX_HISTORY: usize = 60;
pub const MAX_REQUESTS: usize = 10;
pub const MAX_REQUEST_CHARS: usize = 160;
pub const MAX_TEXT_CHARS: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Energy {
    Low,
    #[default]
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Vocals {
    #[default]
    Vocal,
    Instrumental,
    /// The writer picks per song.
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Length {
    Short,
    #[default]
    Medium,
    Long,
}

impl Length {
    /// YuE2's maximum duration; a song may end sooner.
    pub fn seconds(self) -> u32 {
        match self {
            Length::Short => 90,
            Length::Medium => 180,
            Length::Long => 240,
        }
    }
}

/// How often the presenter speaks between songs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Host {
    Off,
    /// After every third song.
    #[default]
    Sometimes,
    /// After every song.
    Often,
}

impl Host {
    pub fn every(self) -> Option<u32> {
        match self {
            Host::Off => None,
            Host::Sometimes => Some(3),
            Host::Often => Some(1),
        }
    }
}

/// The listener's steering. Applies to songs not yet written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Direction {
    pub mood: String,
    pub genres: Vec<String>,
    pub energy: Energy,
    pub vocals: Vocals,
    pub language: String,
    pub length: Length,
    pub host: Host,
    pub theme: String,
}

impl Default for Direction {
    fn default() -> Self {
        Direction {
            mood: "warm".into(),
            genres: vec!["electronic".into(), "chamber pop".into()],
            energy: Energy::Medium,
            vocals: Vocals::Vocal,
            language: "English".into(),
            length: Length::Medium,
            host: Host::Sometimes,
            theme: String::new(),
        }
    }
}

/// One-line, printable, bounded text; None when nothing is left.
pub fn clean_text(value: &str, max_chars: usize) -> Option<String> {
    let joined = value
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let text: String = joined.chars().take(max_chars).collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

impl Direction {
    /// Bounded, single-line values; the writer sees them as data.
    pub fn sanitized(mut self) -> Direction {
        self.mood = clean_text(&self.mood, MAX_TEXT_CHARS).unwrap_or_else(|| "warm".into());
        self.language = clean_text(&self.language, 24).unwrap_or_else(|| "English".into());
        self.theme = clean_text(&self.theme, MAX_REQUEST_CHARS).unwrap_or_default();
        self.genres = self
            .genres
            .iter()
            .flat_map(|g| g.split(','))
            .filter_map(|g| clean_text(g, 32))
            .take(4)
            .collect();
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Song,
    /// A short presenter segment.
    Break,
}

/// A finished, playable programme item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub subtitle: String,
    /// Sectioned lyrics; section tags only for instrumentals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    /// What the presenter says, for captions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    pub seconds: f64,
    /// File name in `radio/audio/`.
    pub file: String,
    pub created_at: i64,
    /// The listener request this song answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    /// Models, seed, device, timings, import origin.
    #[serde(default)]
    pub provenance: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub text: String,
    pub created_at: i64,
    /// Title of the song that answered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<String>,
}

/// What the writer decided for an item being made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub title: String,
    pub subtitle: String,
    /// YuE2 style prompt (songs).
    #[serde(default)]
    pub style: String,
    /// Sectioned lyrics; for an instrumental only its section tags (the form).
    /// `writer::conditioning_lyrics` turns this into YuE2's lyrics input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default)]
    pub instrumental: bool,
}

/// The one item being made. Persisted after every step so a restart resumes it:
/// a written draft is kept and the music is made again from it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: Kind,
    pub attempt: u32,
    pub seed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<Request>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<Draft>,
    pub started_at: i64,
    #[serde(default)]
    pub step_started_at: i64,
    #[serde(default)]
    pub writer_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub songs: u64,
    pub breaks: u64,
    pub failures: u64,
    /// Brief to playable audio, last finished song.
    pub last_song_seconds: Option<f64>,
    pub last_song_audio_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub version: u32,
    /// Making new items. Off on every start; Play turns it on.
    pub on_air: bool,
    pub direction: Direction,
    pub now: Option<Item>,
    /// Ready, in airing order.
    pub queue: Vec<Item>,
    /// Played, newest first.
    pub history: Vec<Item>,
    pub requests: Vec<Request>,
    pub job: Option<Job>,
    pub last_error: Option<String>,
    /// No new attempt before this time (unix ms) after repeated failures.
    pub cooldown_until: Option<i64>,
    pub songs_since_break: u32,
    pub stats: Stats,
    pub volume: f32,
}

impl Default for State {
    fn default() -> Self {
        State {
            version: SCHEMA,
            on_air: false,
            direction: Direction::default(),
            now: None,
            queue: Vec::new(),
            history: Vec::new(),
            requests: Vec::new(),
            job: None,
            last_error: None,
            cooldown_until: None,
            songs_since_break: 0,
            stats: Stats::default(),
            volume: 0.8,
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_single_line_and_bounded() {
        assert_eq!(clean_text("  a\n\tb\u{7}c  ", 10).as_deref(), Some("a b c"));
        assert_eq!(clean_text(" \n ", 10), None);
        assert_eq!(clean_text("abcdef", 3).as_deref(), Some("abc"));
    }

    #[test]
    fn direction_sanitizes_genres_and_defaults() {
        let d = Direction {
            mood: "\n".into(),
            genres: vec![
                "soul, jazz".into(),
                " ".into(),
                "a".into(),
                "b".into(),
                "c".into(),
            ],
            language: String::new(),
            ..Direction::default()
        }
        .sanitized();
        assert_eq!(d.mood, "warm");
        assert_eq!(d.language, "English");
        assert_eq!(d.genres, ["soul", "jazz", "a", "b"]);
    }

    #[test]
    fn state_tolerates_missing_fields() {
        let s: State = serde_json::from_str(r#"{"onAir":true}"#).unwrap();
        assert!(s.on_air);
        assert_eq!(s.version, SCHEMA);
        assert_eq!(s.direction, Direction::default());
    }
}
