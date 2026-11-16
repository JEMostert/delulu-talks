//! What the station remembers in `radio/station.json`.
use crate::mix::{Draw, GenreLock, Mix};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 2: the mix replaced the single direction.
pub const SCHEMA: u32 = 2;
pub const MAX_HISTORY: usize = 60;
pub const MAX_REQUESTS: usize = 10;
pub const MAX_REQUEST_CHARS: usize = 160;
pub const MAX_TEXT_CHARS: usize = 80;
/// Saved songs keep their audio; this bounds the disk they take.
pub const MAX_SAVED: usize = 100;

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
    /// Drawn per song: about one in three instrumental.
    #[serde(rename = "any", alias = "either")]
    Any,
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
    /// YuE2's maximum duration (a song may end sooner); ACE-Step's exact length.
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

/// Which engine makes the music. YuE2 stays the default until the owner's
/// listening test; ACE-Step 1.5 is several times faster.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum MusicEngine {
    #[default]
    #[serde(rename = "yue2")]
    Yue2,
    #[serde(rename = "acestep")]
    AceStep,
}

/// ACE-Step's language model: by free graphics memory, or fixed by the listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum AceLm {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "0.6b")]
    Small,
    #[serde(rename = "4b")]
    Large,
}

impl AceLm {
    /// The value `delulu-engine music` takes.
    pub fn as_str(self) -> &'static str {
        match self {
            AceLm::Auto => "auto",
            AceLm::Small => "0.6b",
            AceLm::Large => "4b",
        }
    }
}

/// How the station makes its music. Applies from the next song made.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Music {
    pub engine: MusicEngine,
    pub ace_lm: AceLm,
    /// The engine build and device ACE-Step last finished a song with
    /// (`music::warm_key`). Until then the graphics driver still has to prepare
    /// ACE-Step's shaders, which makes the first song take minutes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ace_warm: Option<String>,
}

/// The brief one song is written to, drawn from the mix (`mix::Draw::brief`).
/// Before the mix it was the listener's single direction; old state files still
/// hold one, which `Mix::from_direction` migrates.
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
    /// Measured from the stored audio; playback evens items out with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<Loudness>,
    /// The genre and mood the song was drawn with; None for requests, breaks and
    /// songs from before the mix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    /// The genre came from outside the listener's pool.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub surprise: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<Feedback>,
}

/// The listener's verdict on a song; it moves its genre's draw weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Feedback {
    Like,
    Dislike,
}

/// EBU R128 measurement of an item's stored audio.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub lufs: f64,
    /// Highest true peak of any channel, dBTP.
    pub true_peak: f64,
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
    /// The sung language as an ISO code (`nl`, `en`), when the station's language
    /// is one ACE-Step knows. None for instrumentals and older drafts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
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
    /// What this song was drawn to be; None for breaks and jobs from before the mix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draw: Option<Draw>,
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
    pub mix: Mix,
    /// Read from a state file from before the mix, then migrated; never written.
    #[serde(rename = "direction", skip_serializing)]
    pub legacy_direction: Option<Direction>,
    /// Genre (lowercase) → draw weight from likes and dislikes; absent = 1.
    pub weights: BTreeMap<String, f32>,
    pub lock: Option<GenreLock>,
    /// The listener's own stations; the built-in ones are not stored.
    pub stations: Vec<crate::mix::Station>,
    /// Songs kept out of clean-up, newest first. Copies; their audio stays.
    pub saved: Vec<Item>,
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
    pub music: Music,
}

impl Default for State {
    fn default() -> Self {
        State {
            version: SCHEMA,
            on_air: false,
            mix: Mix::default(),
            legacy_direction: None,
            weights: BTreeMap::new(),
            lock: None,
            stations: Vec::new(),
            saved: Vec::new(),
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
            music: Music::default(),
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
        assert_eq!(s.mix, Mix::default());
        // A station from before the engine choice keeps YuE2.
        assert_eq!(s.music.engine, MusicEngine::Yue2);
    }
}
