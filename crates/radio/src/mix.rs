//! The listener's mix: pools of genres and moods, a surprise chance, and choices
//! that may be "any". Every new song draws one genre, one mood and a concrete value
//! for every "any" from it (`Mix::draw`), so the station varies by itself. Named
//! mixes are stations; a few are built in.
use crate::model::{
    clean_text, Direction, Energy, Host, Length, Vocals, MAX_REQUEST_CHARS, MAX_SONG_SECONDS,
    MIN_SONG_SECONDS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The genres a new station offers, and whether each starts on.
pub const GENRES: &[(&str, bool)] = &[
    ("Soul", true),
    ("Jazz", true),
    ("Lo-fi", true),
    ("Ambient", false),
    ("House", true),
    ("Synthwave", true),
    ("Indie rock", true),
    ("Punk rock", false),
    ("Folk", false),
    ("Funk", true),
    ("Hip-hop", false),
    ("Classical", false),
    ("Reggae", false),
    ("Drum & bass", true),
    ("Dutch pop", false),
    ("Metal", false),
    ("Country", false),
    ("Techno", false),
];

pub const MOODS: &[(&str, bool)] = &[
    ("Warm", true),
    ("Dreamlike", true),
    ("Upbeat", true),
    ("Melancholy", false),
    ("Driving", true),
    ("Playful", false),
    ("Dark", false),
    ("Calm", true),
];

pub const MAX_GENRES: usize = 40;
pub const MAX_MOODS: usize = 24;
pub const MAX_NAME_CHARS: usize = 32;
pub const MAX_STATIONS: usize = 24;
pub const MAX_STATION_NAME_CHARS: usize = 24;
/// Songs a genre lock lasts unless the listener asks for another count.
pub const LOCK_SONGS: u32 = 5;
pub const MAX_LOCK_SONGS: u32 = 50;
/// Like and dislike multiply or divide a genre's draw weight by this, within bounds.
pub const WEIGHT_STEP: f32 = 1.5;
pub const WEIGHT_MIN: f32 = 0.25;
pub const WEIGHT_MAX: f32 = 4.0;
/// A new station's song lengths: 2:00 to 4:30.
pub const LENGTH_MIN_SECONDS: u32 = 120;
pub const LENGTH_MAX_SECONDS: u32 = 270;
/// Drawn lengths fall on this grid.
const LENGTH_STEP: u32 = 5;
/// Shuffle picks a surprise chance up to this.
pub const SHUFFLE_SURPRISE: u8 = 40;

/// "any" ↔ None for a choice the scheduler draws per song.
mod any {
    use serde::de::{DeserializeOwned, Error};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(v: &Option<T>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => v.serialize(s),
            None => s.serialize_str("any"),
        }
    }

    pub fn deserialize<'de, T: DeserializeOwned, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<T>, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        if value.as_str() == Some("any") || value.is_null() {
            return Ok(None);
        }
        T::deserialize(value).map(Some).map_err(D::Error::custom)
    }
}

/// One genre or mood of a pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub name: String,
    #[serde(default)]
    pub on: bool,
    /// Added by the listener, not from the catalogue. Set by the station.
    #[serde(default)]
    pub custom: bool,
}

/// What the listener steers. Applies to songs not yet written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mix {
    pub genres: Vec<Choice>,
    pub moods: Vec<Choice>,
    /// Percent chance (0–100) that a song comes from a genre that is off.
    pub surprise: u8,
    pub vocals: Vocals,
    #[serde(with = "any")]
    pub energy: Option<Energy>,
    /// Each song's length is drawn between these (seconds, 60–300); equal = fixed.
    pub length_min_seconds: u32,
    pub length_max_seconds: u32,
    pub host: Host,
    pub language: String,
    /// Optional free text every song is written around.
    pub theme: String,
}

fn catalogue(list: &[(&str, bool)]) -> Vec<Choice> {
    list.iter()
        .map(|(name, on)| Choice {
            name: (*name).into(),
            on: *on,
            custom: false,
        })
        .collect()
}

impl Default for Mix {
    fn default() -> Self {
        Mix {
            genres: catalogue(GENRES),
            moods: catalogue(MOODS),
            surprise: 15,
            vocals: Vocals::Any,
            energy: None,
            length_min_seconds: LENGTH_MIN_SECONDS,
            length_max_seconds: LENGTH_MAX_SECONDS,
            host: Host::Sometimes,
            language: "English".into(),
            theme: String::new(),
        }
    }
}

/// Within the lengths both engines reach, shortest first.
fn length_range(min: u32, max: u32) -> (u32, u32) {
    let clamp = |v: u32| v.clamp(MIN_SONG_SECONDS, MAX_SONG_SECONDS);
    let (a, b) = (clamp(min), clamp(max));
    (a.min(b), a.max(b))
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The catalogue's spelling of `name`, if it is in it.
fn known(list: &[(&str, bool)], name: &str) -> Option<String> {
    list.iter()
        .find(|(n, _)| same(n, name))
        .map(|(n, _)| (*n).to_string())
}

/// Clean, deduplicated names; every catalogue entry present (off when the listener
/// left it out); custom entries marked and bounded.
fn sanitize_pool(pool: Vec<Choice>, list: &[(&str, bool)], max: usize) -> Vec<Choice> {
    let mut out: Vec<Choice> = Vec::new();
    for choice in pool {
        let Some(name) = clean_text(&choice.name, MAX_NAME_CHARS) else {
            continue;
        };
        if out.iter().any(|c| same(&c.name, &name)) {
            continue;
        }
        let catalogued = known(list, &name);
        if catalogued.is_none() && out.iter().filter(|c| c.custom).count() + list.len() >= max {
            continue;
        }
        out.push(Choice {
            custom: catalogued.is_none(),
            name: catalogued.unwrap_or(name),
            on: choice.on,
        });
    }
    for (name, _) in list {
        if !out.iter().any(|c| same(&c.name, name)) {
            out.push(Choice {
                name: (*name).into(),
                on: false,
                custom: false,
            });
        }
    }
    out
}

/// Turn on exactly `names` (case-insensitive), adding unknown ones as custom.
fn select(pool: &[Choice], names: &[String]) -> Vec<Choice> {
    let mut out: Vec<Choice> = pool
        .iter()
        .map(|c| Choice {
            on: names.iter().any(|n| same(n, &c.name)),
            ..c.clone()
        })
        .collect();
    for name in names {
        if !out.iter().any(|c| same(&c.name, name)) {
            out.push(Choice {
                name: name.clone(),
                on: true,
                custom: true,
            });
        }
    }
    out
}

fn enabled(pool: &[Choice]) -> Vec<String> {
    pool.iter()
        .filter(|c| c.on)
        .map(|c| c.name.clone())
        .collect()
}

impl Mix {
    /// Bounded, single-line values; the writer sees them as data.
    pub fn sanitized(mut self) -> Mix {
        self.genres = sanitize_pool(self.genres, GENRES, MAX_GENRES);
        self.moods = sanitize_pool(self.moods, MOODS, MAX_MOODS);
        self.surprise = self.surprise.min(100);
        (self.length_min_seconds, self.length_max_seconds) =
            length_range(self.length_min_seconds, self.length_max_seconds);
        self.language = clean_text(&self.language, 24).unwrap_or_else(|| "English".into());
        self.theme = clean_text(&self.theme, MAX_REQUEST_CHARS).unwrap_or_default();
        self
    }

    /// A station from before the mix: its genres and mood on and nothing else, no
    /// surprise, its fixed choices kept, so it sounds as it did.
    pub fn from_direction(direction: Direction) -> Mix {
        let d = direction.sanitized();
        let (length_min_seconds, length_max_seconds) = d.length.range();
        let off = |list: &[(&str, bool)]| -> Vec<Choice> {
            catalogue(list)
                .into_iter()
                .map(|c| Choice { on: false, ..c })
                .collect()
        };
        Mix {
            genres: select(&off(GENRES), &d.genres),
            moods: select(&off(MOODS), std::slice::from_ref(&d.mood)),
            surprise: 0,
            vocals: d.vocals,
            energy: Some(d.energy),
            length_min_seconds,
            length_max_seconds,
            host: d.host,
            language: d.language,
            theme: d.theme,
        }
        .sanitized()
    }

    pub fn enabled_genres(&self) -> Vec<String> {
        enabled(&self.genres)
    }

    pub fn enabled_moods(&self) -> Vec<String> {
        enabled(&self.moods)
    }

    /// Draw what the next song is.
    pub fn draw(&self, rng: &mut Rng, ctx: &Context) -> Draw {
        let (genre, surprise, locked) = if ctx.request {
            // The request decides the song's style.
            (None, false, false)
        } else if let Some(genre) = ctx.lock {
            (Some(genre.to_string()), false, true)
        } else {
            let (genre, surprise) = self.draw_genre(rng, ctx);
            (genre, surprise, false)
        };
        let mood = if ctx.request {
            None
        } else {
            let on = self.enabled_moods();
            let pool = if on.is_empty() {
                self.moods.iter().map(|c| c.name.clone()).collect()
            } else {
                on
            };
            (!pool.is_empty()).then(|| pool[rng.below(pool.len())].clone())
        };
        Draw {
            genre,
            mood,
            surprise,
            locked,
            energy: self
                .energy
                .unwrap_or_else(|| [Energy::Low, Energy::Medium, Energy::High][rng.below(3)]),
            seconds: self.draw_seconds(rng),
            vocals: match self.vocals {
                Vocals::Any if rng.below(3) == 0 => Vocals::Instrumental,
                Vocals::Any => Vocals::Vocal,
                fixed => fixed,
            },
        }
    }

    /// A length on the 5-second grid within the range, every value equally likely.
    fn draw_seconds(&self, rng: &mut Rng) -> u32 {
        let (min, max) = length_range(self.length_min_seconds, self.length_max_seconds);
        min + LENGTH_STEP * rng.below(((max - min) / LENGTH_STEP + 1) as usize) as u32
    }

    /// The middle of the length range, for a song written before lengths were drawn.
    pub fn middle_seconds(&self) -> u32 {
        let (min, max) = length_range(self.length_min_seconds, self.length_max_seconds);
        (min + max) / 2
    }

    fn draw_genre(&self, rng: &mut Rng, ctx: &Context) -> (Option<String>, bool) {
        let on = self.enabled_genres();
        let off: Vec<String> = self
            .genres
            .iter()
            .filter(|c| !c.on)
            .map(|c| c.name.clone())
            .collect();
        let chosen = !on.is_empty();
        let listener: Vec<String> = if on.is_empty() {
            // Nothing chosen: any genre, which is what the listener asked for.
            self.genres.iter().map(|c| c.name.clone()).collect()
        } else {
            on
        };
        if listener.is_empty() {
            return (None, false);
        }
        // The listener's pool sets the repeat rule, for surprise picks too.
        // Three or more: never the last genre again. Two: never three in a row.
        let last = ctx.recent.first();
        let banned = match (listener.len(), last) {
            (3.., Some(last)) => Some(last),
            (2, Some(last)) if ctx.recent.get(1).is_some_and(|g| same(g, last)) => Some(last),
            _ => None,
        };
        let allowed = |pool: &[String]| -> Vec<String> {
            pool.iter()
                .filter(|g| banned.is_none_or(|b| !same(b, g)))
                .cloned()
                .collect()
        };
        let surprising = chosen && !off.is_empty() && rng.chance(self.surprise as f64 / 100.0);
        // A surprise that could only repeat the banned genre falls back to the pool.
        let (candidates, surprise) = match surprising.then(|| allowed(&off)) {
            Some(c) if !c.is_empty() => (c, true),
            _ => (allowed(&listener), false),
        };
        let weights: Vec<f64> = candidates
            .iter()
            .map(|g| weight(ctx.weights, g) as f64)
            .collect();
        let pick = candidates[rng.weighted(&weights)].clone();
        (Some(pick), surprise)
    }

    /// A random mix: a few genres and moods, a small surprise chance; the rest kept.
    pub fn shuffled(&self, rng: &mut Rng) -> Mix {
        let mut mix = self.clone();
        let roll = |pool: &mut Vec<Choice>, p: f64, at_least: usize, rng: &mut Rng| {
            for c in pool.iter_mut() {
                c.on = rng.chance(p);
            }
            while pool.iter().filter(|c| c.on).count() < at_least.min(pool.len()) {
                let off: Vec<usize> = (0..pool.len()).filter(|&i| !pool[i].on).collect();
                pool[off[rng.below(off.len())]].on = true;
            }
        };
        roll(&mut mix.genres, 0.3, 2, rng);
        roll(&mut mix.moods, 0.4, 1, rng);
        mix.surprise = (rng.below(SHUFFLE_SURPRISE as usize / 5 + 1) * 5) as u8;
        mix
    }

    /// What a station keeps of this mix: everything but the host and language.
    pub fn preset(&self) -> Preset {
        Preset {
            genres: self.enabled_genres(),
            moods: self.enabled_moods(),
            surprise: self.surprise,
            vocals: self.vocals,
            energy: self.energy,
            length_min_seconds: self.length_min_seconds,
            length_max_seconds: self.length_max_seconds,
            theme: self.theme.clone(),
        }
    }

    /// This mix tuned to `preset`; host, language and custom names are kept.
    pub fn with_preset(&self, preset: &Preset) -> Mix {
        Mix {
            genres: select(&self.genres, &preset.genres),
            moods: select(&self.moods, &preset.moods),
            surprise: preset.surprise,
            vocals: preset.vocals,
            energy: preset.energy,
            length_min_seconds: preset.length_min_seconds,
            length_max_seconds: preset.length_max_seconds,
            theme: preset.theme.clone(),
            ..self.clone()
        }
        .sanitized()
    }
}

/// A genre's draw weight from likes and dislikes; 1 when it has none.
pub fn weight(weights: &BTreeMap<String, f32>, genre: &str) -> f32 {
    weights
        .get(&genre.to_lowercase())
        .copied()
        .unwrap_or(1.0)
        .clamp(WEIGHT_MIN, WEIGHT_MAX)
}

/// The draw weight of a genre with `score` net likes: ×`WEIGHT_STEP` per net
/// like, within bounds.
pub fn score_weight(score: i32) -> f32 {
    WEIGHT_STEP
        .powi(score.clamp(-64, 64))
        .clamp(WEIGHT_MIN, WEIGHT_MAX)
}

/// Add `delta` net likes to a genre and set its weight from the total. Counting
/// verdicts rather than multiplying a bounded weight makes taking one back exact,
/// also after the weight reached a bound. A genre back at 0 is removed.
pub fn add_score(
    weights: &mut BTreeMap<String, f32>,
    scores: &mut BTreeMap<String, i32>,
    genre: &str,
    delta: i32,
) {
    let key = genre.to_lowercase();
    let score = scores.get(&key).copied().unwrap_or(0) + delta;
    if score == 0 {
        scores.remove(&key);
        weights.remove(&key);
    } else {
        scores.insert(key.clone(), score);
        weights.insert(key, score_weight(score));
    }
}

/// Scores for weights saved before scores were: the nearest whole number of net
/// likes. Weights are then set from the scores again.
pub fn sync_scores(weights: &mut BTreeMap<String, f32>, scores: &mut BTreeMap<String, i32>) {
    for (genre, w) in weights.iter() {
        if !scores.contains_key(genre) && w.is_finite() && *w > 0.0 {
            let score = (w.ln() / WEIGHT_STEP.ln()).round() as i32;
            if score != 0 {
                scores.insert(genre.clone(), score);
            }
        }
    }
    scores.retain(|_, s| *s != 0);
    *weights = scores
        .iter()
        .map(|(g, s)| (g.clone(), score_weight(*s)))
        .collect();
}

static NO_WEIGHTS: BTreeMap<String, f32> = BTreeMap::new();

/// What the scheduler knows when it draws a song.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// Genres of the latest songs, newest first.
    pub recent: &'a [String],
    pub weights: &'a BTreeMap<String, f32>,
    /// Only this genre while a lock holds.
    pub lock: Option<&'a str>,
    /// The song answers a listener request.
    pub request: bool,
}

impl Default for Context<'_> {
    fn default() -> Self {
        Context {
            recent: &[],
            weights: &NO_WEIGHTS,
            lock: None,
            request: false,
        }
    }
}

/// What one song was drawn to be. Stored on its job, so a restart writes the same.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draw {
    /// None for a request, which decides the style itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    /// The genre came from outside the listener's pool.
    #[serde(default)]
    pub surprise: bool,
    /// Drawn under a genre lock.
    #[serde(default)]
    pub locked: bool,
    pub energy: Energy,
    pub vocals: Vocals,
    /// The song's target length: ACE-Step's exact length, YuE2's maximum.
    pub seconds: u32,
}

impl Draw {
    /// The brief the writer turns into a song.
    pub fn brief(&self, mix: &Mix) -> Direction {
        Direction {
            mood: self.mood.clone().unwrap_or_default(),
            genres: self.genre.iter().cloned().collect(),
            energy: self.energy,
            vocals: self.vocals,
            language: mix.language.clone(),
            length: Length::nearest(self.seconds),
            host: mix.host,
            theme: mix.theme.clone(),
            seconds: self.seconds,
        }
    }
}

/// What a station sets: the enabled genres and moods and the sound choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preset {
    pub genres: Vec<String>,
    pub moods: Vec<String>,
    pub surprise: u8,
    pub vocals: Vocals,
    #[serde(with = "any")]
    pub energy: Option<Energy>,
    pub length_min_seconds: u32,
    pub length_max_seconds: u32,
    pub theme: String,
}

impl Default for Preset {
    fn default() -> Self {
        Mix::default().preset()
    }
}

impl Preset {
    /// Same sound, whatever the order or spelling of names.
    pub fn matches(&self, other: &Preset) -> bool {
        let key = |names: &[String]| {
            let mut v: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
            v.sort();
            v.dedup();
            v
        };
        key(&self.genres) == key(&other.genres)
            && key(&self.moods) == key(&other.moods)
            && (
                self.surprise,
                self.vocals,
                self.energy,
                self.length_min_seconds,
                self.length_max_seconds,
            ) == (
                other.surprise,
                other.vocals,
                other.energy,
                other.length_min_seconds,
                other.length_max_seconds,
            )
            && self.theme == other.theme
    }
}

/// A named mix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub preset: Preset,
    /// Shipped with the app; cannot be renamed or deleted.
    #[serde(default)]
    pub builtin: bool,
}

/// The stations every listener has.
pub fn builtin_stations() -> Vec<Station> {
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let station = |id: &str, name: &str, preset: Preset| Station {
        id: id.into(),
        name: name.into(),
        preset,
        builtin: true,
    };
    vec![
        station(
            "drift",
            "Drift",
            Preset {
                genres: names(&["Ambient", "Lo-fi", "Classical"]),
                moods: names(&["Dreamlike", "Calm"]),
                surprise: 0,
                vocals: Vocals::Instrumental,
                energy: Some(Energy::Low),
                length_min_seconds: 180,
                length_max_seconds: 300,
                theme: String::new(),
            },
        ),
        station(
            "groove",
            "Groove",
            Preset {
                genres: names(&["Soul", "Jazz", "Funk", "House"]),
                moods: names(&["Warm", "Upbeat"]),
                surprise: 10,
                vocals: Vocals::Any,
                energy: Some(Energy::Medium),
                length_min_seconds: 150,
                length_max_seconds: 240,
                theme: String::new(),
            },
        ),
        station(
            "explore",
            "Explore",
            Preset {
                genres: names(&["Synthwave", "Techno", "Drum & bass", "Hip-hop", "Reggae"]),
                moods: names(&["Playful", "Driving", "Dark", "Dreamlike"]),
                surprise: 35,
                vocals: Vocals::Any,
                energy: None,
                length_min_seconds: LENGTH_MIN_SECONDS,
                length_max_seconds: LENGTH_MAX_SECONDS,
                theme: String::new(),
            },
        ),
    ]
}

pub fn station_name(name: &str) -> Option<String> {
    clean_text(name, MAX_STATION_NAME_CHARS)
}

/// A genre lock: only this genre is drawn until unlocked or `left` songs are made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreLock {
    pub genre: String,
    /// None = until unlocked.
    #[serde(default)]
    pub left: Option<u32>,
}

/// A small seeded generator (SplitMix64): the same seed draws the same songs.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// 0..n; n must be above 0.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// 0.0..1.0
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// An index with probability proportional to its weight; `weights` not empty.
    pub fn weighted(&mut self, weights: &[f64]) -> usize {
        let total: f64 = weights.iter().sum();
        let mut at = self.unit() * total;
        for (i, w) in weights.iter().enumerate() {
            if at < *w {
                return i;
            }
            at -= w;
        }
        weights.len() - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mix(on: &[&str]) -> Mix {
        let names: Vec<String> = on.iter().map(|s| s.to_string()).collect();
        Mix {
            genres: select(&Mix::default().genres, &names),
            surprise: 0,
            ..Mix::default()
        }
    }

    /// Draw `n` songs in a row as the station does: each sees the ones before it.
    fn run(mix: &Mix, seed: u64, n: usize, weights: &BTreeMap<String, f32>) -> Vec<Draw> {
        let mut rng = Rng::new(seed);
        let mut recent: Vec<String> = Vec::new();
        (0..n)
            .map(|_| {
                let ctx = Context {
                    recent: &recent,
                    weights,
                    ..Context::default()
                };
                let d = mix.draw(&mut rng, &ctx);
                recent.insert(0, d.genre.clone().unwrap());
                d
            })
            .collect()
    }

    #[test]
    fn repeat_rules_hold_for_every_seed() {
        let weights = BTreeMap::new();
        for seed in 0..300 {
            let three = run(&mix(&["Soul", "Jazz", "Folk"]), seed, 40, &weights);
            assert!(three.windows(2).all(|w| w[0].genre != w[1].genre));
            let two = run(&mix(&["Soul", "Jazz"]), seed, 40, &weights);
            assert!(two
                .windows(3)
                .all(|w| !(w[0].genre == w[1].genre && w[1].genre == w[2].genre)));
        }
        // Surprise picks keep the rules too, also when only one genre is off.
        let off_one = |on: &[&str]| {
            let mut m = mix(on);
            for c in m.genres.iter_mut() {
                c.on = c.on || c.name != "Metal";
            }
            m.surprise = 100;
            m
        };
        for seed in 0..300 {
            let three = run(&off_one(&[]), seed, 40, &weights);
            assert_eq!(three.iter().filter(|d| d.surprise).count(), 20);
            assert!(three.windows(2).all(|w| w[0].genre != w[1].genre));
        }
        let mut two = mix(&["Soul", "Jazz"]);
        two.genres.retain(|c| c.on || c.name == "Metal");
        two.surprise = 100;
        for seed in 0..300 {
            let drawn = run(&two, seed, 40, &weights);
            assert!(drawn
                .windows(3)
                .all(|w| !(w[0].genre == w[1].genre && w[1].genre == w[2].genre)));
        }
        // One genre: always that one.
        let one = run(&mix(&["Metal"]), 1, 5, &weights);
        assert!(one.iter().all(|d| d.genre.as_deref() == Some("Metal")));
    }

    #[test]
    fn draws_are_deterministic_and_stay_in_the_pool() {
        let m = mix(&["Soul", "Jazz", "Folk", "Techno"]);
        let weights = BTreeMap::new();
        assert_eq!(run(&m, 42, 20, &weights), run(&m, 42, 20, &weights));
        let drawn = run(&m, 42, 60, &weights);
        assert!(drawn.iter().all(|d| !d.surprise
            && ["Soul", "Jazz", "Folk", "Techno"].contains(&d.genre.as_deref().unwrap())));
        // Every "any" became a concrete value and every mood is an enabled one.
        assert!(drawn.iter().all(
            |d| d.vocals != Vocals::Any && m.enabled_moods().contains(d.mood.as_ref().unwrap())
        ));
    }

    #[test]
    fn lengths_spread_over_the_range_and_stay_in_it() {
        let m = Mix::default();
        let drawn: Vec<u32> = run(&m, 11, 300, &BTreeMap::new())
            .iter()
            .map(|d| d.seconds)
            .collect();
        assert!(drawn
            .iter()
            .all(|s| (120..=270).contains(s) && s.is_multiple_of(5)));
        // Both ends come up, and no single length dominates.
        assert!(drawn.contains(&120) && drawn.contains(&270));
        let short = drawn.iter().filter(|s| **s < 170).count();
        assert!((60..140).contains(&short), "{short} of 300 under 2:50");
        // Out of range or reversed bounds are clamped and ordered; equal = fixed.
        let odd = Mix {
            length_min_seconds: 900,
            length_max_seconds: 10,
            ..Mix::default()
        }
        .sanitized();
        assert_eq!((odd.length_min_seconds, odd.length_max_seconds), (60, 300));
        let fixed = Mix {
            length_min_seconds: 200,
            length_max_seconds: 200,
            ..Mix::default()
        };
        assert!(run(&fixed, 2, 10, &BTreeMap::new())
            .iter()
            .all(|d| d.seconds == 200));
    }

    #[test]
    fn surprise_draws_from_genres_that_are_off() {
        let m = Mix {
            surprise: 100,
            ..mix(&["Soul", "Jazz"])
        };
        let drawn = run(&m, 7, 30, &BTreeMap::new());
        assert!(drawn
            .iter()
            .all(|d| d.surprise && !["Soul", "Jazz"].contains(&d.genre.as_deref().unwrap())));
        let some = Mix {
            surprise: 30,
            ..mix(&["Soul", "Jazz"])
        };
        let count = run(&some, 7, 400, &BTreeMap::new())
            .iter()
            .filter(|d| d.surprise)
            .count();
        assert!((80..160).contains(&count), "{count} of 400");
    }

    #[test]
    fn weights_shift_the_draw_within_bounds() {
        let mut weights = BTreeMap::new();
        let mut scores = BTreeMap::new();
        for _ in 0..10 {
            add_score(&mut weights, &mut scores, "Soul", 1);
            add_score(&mut weights, &mut scores, "jazz", -1);
        }
        assert_eq!(weight(&weights, "soul"), WEIGHT_MAX);
        assert_eq!(weight(&weights, "Jazz"), WEIGHT_MIN);
        let m = mix(&["Soul", "Jazz", "Folk", "Techno"]);
        let drawn = run(&m, 3, 400, &weights);
        let soul = drawn
            .iter()
            .filter(|d| d.genre.as_deref() == Some("Soul"))
            .count();
        let jazz = drawn
            .iter()
            .filter(|d| d.genre.as_deref() == Some("Jazz"))
            .count();
        assert!(soul > 3 * jazz, "soul {soul}, jazz {jazz}");
        // Back to neutral removes the entry.
        let (mut w, mut sc) = (BTreeMap::new(), BTreeMap::new());
        add_score(&mut w, &mut sc, "Soul", 1);
        add_score(&mut w, &mut sc, "Soul", -1);
        assert!(w.is_empty() && sc.is_empty());
    }

    #[test]
    fn lock_and_request_override_the_genre() {
        let m = mix(&["Soul", "Jazz", "Folk"]);
        let mut rng = Rng::new(9);
        let recent = vec!["Metal".to_string(), "Metal".to_string()];
        let weights = BTreeMap::new();
        let locked = m.draw(
            &mut rng,
            &Context {
                recent: &recent,
                weights: &weights,
                lock: Some("Metal"),
                request: false,
            },
        );
        assert_eq!(locked.genre.as_deref(), Some("Metal"));
        assert!(locked.locked);
        let request = m.draw(
            &mut rng,
            &Context {
                request: true,
                ..Context::default()
            },
        );
        assert_eq!((request.genre, request.mood), (None, None));
    }

    #[test]
    fn an_old_direction_becomes_a_mix_that_sounds_the_same() {
        let old: Direction = serde_json::from_str(
            r#"{"mood":"defiant","genres":["soul, boom bap"],"energy":"high","vocals":"either","language":"Dutch","length":"short","host":"often","theme":"night buses"}"#,
        )
        .unwrap();
        let m = Mix::from_direction(old);
        assert_eq!(m.enabled_genres(), ["Soul", "boom bap"]);
        assert!(m.genres.iter().any(|c| c.name == "boom bap" && c.custom));
        assert_eq!(m.enabled_moods(), ["defiant"]);
        assert_eq!(m.surprise, 0);
        assert_eq!(
            (m.vocals, m.energy, m.host),
            (Vocals::Any, Some(Energy::High), Host::Often)
        );
        assert_eq!(
            (m.length_min_seconds, m.length_max_seconds),
            Length::Short.range()
        );
        assert_eq!(
            (m.language.as_str(), m.theme.as_str()),
            ("Dutch", "night buses")
        );
        let drawn = run(&m, 5, 10, &BTreeMap::new());
        assert!(drawn.iter().all(|d| d.mood.as_deref() == Some("defiant")
            && d.energy == Energy::High
            && (75..=120).contains(&d.seconds)));
    }

    #[test]
    fn sanitizing_keeps_the_catalogue_and_bounds_custom_names() {
        let mut genres = vec![
            Choice {
                name: " soul \n".into(),
                on: true,
                custom: true,
            },
            Choice {
                name: "SOUL".into(),
                on: false,
                custom: false,
            },
        ];
        genres.extend((0..60).map(|i| Choice {
            name: format!("custom {i}"),
            on: true,
            custom: false,
        }));
        let m = Mix {
            genres,
            surprise: 250,
            ..Mix::default()
        }
        .sanitized();
        // The catalogue's spelling, on, not custom; every catalogue genre present.
        assert_eq!(
            m.genres[0],
            Choice {
                name: "Soul".into(),
                on: true,
                custom: false
            }
        );
        assert!(GENRES
            .iter()
            .all(|(n, _)| m.genres.iter().any(|c| c.name == *n)));
        assert_eq!(m.genres.len(), MAX_GENRES);
        assert!(m
            .genres
            .iter()
            .filter(|c| c.custom)
            .all(|c| c.name.starts_with("custom")));
        assert_eq!(m.surprise, 100);
    }

    #[test]
    fn shuffle_and_presets_round_trip() {
        let base = Mix {
            host: Host::Off,
            language: "Dutch".into(),
            ..Mix::default()
        };
        for seed in 0..50 {
            let s = base.shuffled(&mut Rng::new(seed));
            assert!(s.enabled_genres().len() >= 2 && !s.enabled_moods().is_empty());
            assert!(s.surprise <= SHUFFLE_SURPRISE && s.surprise.is_multiple_of(5));
            assert_eq!((s.host, s.language.as_str()), (Host::Off, "Dutch"));
        }
        for station in builtin_stations() {
            let tuned = base.with_preset(&station.preset);
            assert!(tuned.preset().matches(&station.preset), "{}", station.name);
            assert_eq!(tuned.host, Host::Off);
        }
    }
}
