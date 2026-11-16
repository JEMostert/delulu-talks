//! The station: a bounded programme ahead of playback, one item made at a time.
//!
//! Production and playback have separate clocks. Every production step is persisted,
//! so a restart continues the same job from its last finished step. New items are
//! only made while the station is on air, and only start while the host says the GPU
//! may be used (not while dictating).
//!
//! Items are stored as Ogg Opus with their measured loudness. A station made before
//! that holds WAV files; a background pass converts them one at a time (see
//! `convert`), and both formats play meanwhile.
use crate::audio::{self, Audio, Content};
use crate::mix::{self, Context, Draw, GenreLock, Mix, Rng};
use crate::model::*;
use crate::writer;
use crate::RadioError;
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Ready programme with YuE2, which makes a song in about its own length: at most
/// this many items…
pub const BUFFER_ITEMS: usize = 3;
/// …and at least two songs or this much audio.
pub const BUFFER_SECONDS: f64 = 360.0;
pub const BUFFER_SONGS: usize = 2;
/// With ACE-Step a song takes under a minute, so one ready song next to the one on
/// air covers it, dictation pauses included. A shorter programme lets a new
/// direction or request reach the air a song sooner.
pub const ACE_BUFFER_ITEMS: usize = 2;
pub const ACE_BUFFER_SECONDS: f64 = 150.0;
pub const ACE_BUFFER_SONGS: usize = 1;
const RETRY_COOLDOWN_MS: i64 = 20_000;
const MIN_SONG_SECONDS: f64 = 20.0;
const MIN_BREAK_SECONDS: f64 = 2.0;
/// The fade on a song the model had not finished when it reached its length.
const FADE_SECONDS: f64 = 4.0;
/// The WAV conversion waits this long after start, so it does not slow the app's own
/// start, and then runs at a lower CPU priority.
const CONVERT_DELAY: Duration = Duration::from_secs(20);

/// What production needs from the app. Implemented by Delulu with the cleanup
/// helper, the native music helper and `delulu speak`; by fakes in tests.
pub trait Backend: Send + Sync {
    /// Continue a rendered Gemma prompt. `Err(Busy)` when dictation holds the model.
    fn write(&self, prompt: String, max_tokens: u32, seed: u32) -> Result<String, RadioError>;
    /// False while dictation is active: a new GPU step must not start.
    fn may_start(&self) -> bool;
    fn voice_ready(&self) -> bool;
    /// Speak `text` in `lang` ("nl" or "en") into `out`. Returns how the voice is
    /// credited, which says it is AI-generated.
    fn speak(&self, text: &str, lang: &str, out: &Path) -> Result<String, RadioError>;
    /// Make the music for `draft` into `out`. `Err(Cancelled)` when stopped (off air
    /// or quitting), `Err(Unavailable)` when the model or helper is missing. Returns
    /// what to record about how it was made.
    /// `seconds` is YuE2's maximum and ACE-Step's exact length; `music` says which
    /// engine and settings to use.
    fn compose(
        &self,
        draft: &Draft,
        seed: u64,
        seconds: u32,
        music: &Music,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError>;
    /// Something visible changed.
    fn changed(&self);
}

/// Points in storing an item where the conversion tests simulate a kill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Half the Opus file is on disk.
    Writing,
    /// The verified Opus file is in `audio/`, the state does not name it yet.
    Written,
    /// The state names the Opus file; the WAV is still there.
    Saved,
}

/// What a conversion pass did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Conversion {
    pub converted: usize,
    pub failed: usize,
    /// Size of the converted files before and after.
    pub bytes_before: u64,
    pub bytes_after: u64,
}

/// What the production loop should do next.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    /// Nothing to make; sleep until woken.
    Idle,
    /// Try again after this long.
    Wait(Duration),
    /// Continue right away.
    Continue,
}

#[derive(Default)]
struct Wake {
    flag: Mutex<bool>,
    cond: Condvar,
}

pub struct Station {
    root: PathBuf,
    state: Mutex<State>,
    wake: Wake,
}

fn io(path: &Path, e: std::io::Error) -> RadioError {
    RadioError::Io(format!("{}: {e}", path.display()))
}

fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// The name an item's file has once it is stored as Opus.
fn opus_name(file: &str) -> String {
    Path::new(file)
        .with_extension("opus")
        .to_string_lossy()
        .into_owned()
}

fn is_opus(file: &str) -> bool {
    file.ends_with(".opus")
}

fn content(kind: Kind) -> Content {
    match kind {
        Kind::Song => Content::Music,
        Kind::Break => Content::Speech,
    }
}

/// Every item the station holds, saved copies last.
fn items(s: &State) -> impl Iterator<Item = &Item> {
    s.now
        .iter()
        .chain(&s.queue)
        .chain(&s.history)
        .chain(&s.saved)
}

fn items_mut(s: &mut State) -> impl Iterator<Item = &mut Item> {
    s.now
        .iter_mut()
        .chain(s.queue.iter_mut())
        .chain(s.history.iter_mut())
        .chain(s.saved.iter_mut())
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Genres of the two latest songs, newest first; "" for a song without one
/// (a request), which breaks a run. Replays do not count.
fn recent_genres(s: &State) -> Vec<String> {
    s.queue
        .iter()
        .rev()
        .chain(s.now.iter())
        .chain(s.history.iter())
        .filter(|i| i.kind == Kind::Song && !i.is_replay())
        .take(2)
        .map(|i| i.genre.clone().unwrap_or_default())
        .collect()
}

/// Seeds the draw apart from the writer's own use of the job seed.
const DRAW_SALT: u64 = 0x6d69_7864_7261_7721;

fn invalid(message: impl Into<String>) -> RadioError {
    RadioError::Invalid(message.into())
}

/// Make a rename or new file in `dir` survive a power cut.
fn sync_dir(dir: &Path) -> Result<(), RadioError> {
    std::fs::File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| io(dir, e))
}

/// Encode `audio` into `temp` and read it back: it must decode to the same length
/// and not be near-silent where the source was not. Returns the loudness of what
/// will actually play.
fn write_opus(
    source: Audio,
    content: Content,
    temp: &Path,
    checkpoint: &dyn Fn(Step) -> bool,
) -> Result<Loudness, RadioError> {
    let bytes = audio::encode_opus(&source, content)?;
    let expected = (source.frames() as f64 * audio::OPUS_RATE as f64 / source.rate.max(1) as f64)
        .round() as usize;
    let peak = source.peak();
    // A song is tens of megabytes decoded: hold one copy at a time.
    drop(source);
    let mut file = std::fs::File::create(temp).map_err(|e| io(temp, e))?;
    let half = bytes.len() / 2;
    file.write_all(&bytes[..half]).map_err(|e| io(temp, e))?;
    if !checkpoint(Step::Writing) {
        return Err(RadioError::Cancelled);
    }
    file.write_all(&bytes[half..])
        .and_then(|_| file.sync_all())
        .map_err(|e| io(temp, e))?;
    drop(file);
    let stored = audio::decode_opus_file(temp)?;
    if stored.frames() != expected {
        return Err(RadioError::Audio(format!(
            "{} decodes to {} frames instead of {expected}",
            temp.display(),
            stored.frames()
        )));
    }
    if peak >= 0.01 && stored.peak() < peak * 0.5 {
        return Err(RadioError::Audio(format!(
            "{} decodes much quieter than its source",
            temp.display()
        )));
    }
    audio::measure(&stored)
}

impl Station {
    /// Load `root/station.json`. The station starts off air; a job in progress is kept.
    pub fn open(root: &Path) -> Result<Station, RadioError> {
        let convert = root.join("convert");
        for dir in [root.to_path_buf(), root.join("audio"), root.join("jobs")] {
            std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        }
        // A conversion that was interrupted starts that file again.
        let _ = std::fs::remove_dir_all(&convert);
        std::fs::create_dir_all(&convert).map_err(|e| io(&convert, e))?;
        let path = root.join("station.json");
        let mut state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<State>(&bytes).unwrap_or_else(|e| {
                let keep = root.join(format!("station.corrupt-{}.json", now_ms()));
                // Not `{e}`: serde can quote a listener's request it choked on.
                log::warn!(
                    "radio state unreadable ({:?} error at line {} column {}); kept as {}",
                    e.classify(),
                    e.line(),
                    e.column(),
                    keep.display()
                );
                let _ = std::fs::rename(&path, &keep);
                State::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(io(&path, e)),
        };
        state.on_air = false;
        if let Some(old) = state.legacy_direction.take() {
            state.mix = Mix::from_direction(old);
        }
        state.version = SCHEMA;
        state.mix = state.mix.clone().sanitized();
        let audio = root.join("audio");
        let exists = |i: &Item| audio.join(&i.file).is_file();
        state.now = state.now.take().filter(exists);
        state.queue.retain(exists);
        state.history.retain(exists);
        state.saved.retain(exists);
        let station = Station {
            root: root.to_path_buf(),
            state: Mutex::new(state),
            wake: Wake::default(),
        };
        {
            let mut s = station.lock();
            station.prune(&mut s);
            station.save(&s)?;
        }
        Ok(station)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn snapshot(&self) -> State {
        self.lock().clone()
    }

    pub fn audio_path(&self, item: &Item) -> PathBuf {
        self.root.join("audio").join(&item.file)
    }

    /// Decoded audio with the playback gain that evens out loudness applied.
    pub fn load_audio(&self, item: &Item) -> Result<Arc<Audio>, RadioError> {
        let (mut file, mut loudness) = self.stored(item);
        let mut decoded = audio::decode(&self.root.join("audio").join(&file));
        if decoded.is_err() {
            // Converted between the lookup and the read.
            let again = self.stored(item);
            if again.0 != file {
                (file, loudness) = again;
                decoded = audio::decode(&self.root.join("audio").join(&file));
            }
        }
        let mut audio = decoded?;
        audio::even_out(&mut audio, loudness);
        Ok(Arc::new(audio))
    }

    /// The file and loudness the station has now for `item`, which the caller may
    /// have copied before the conversion replaced its WAV.
    fn stored(&self, item: &Item) -> (String, Option<Loudness>) {
        let converted = opus_name(&item.file);
        let s = self.lock();
        let found = items(&s)
            .find(|i| i.file == item.file || i.file == converted)
            .map(|i| (i.file.clone(), i.loudness));
        found.unwrap_or_else(|| (item.file.clone(), item.loudness))
    }

    fn save(&self, state: &State) -> Result<(), RadioError> {
        self.write_state(state, false).map(|_| ())
    }

    /// `durable`: on disk before this returns, even across a power cut. Ok(false)
    /// when the state is saved but that could not be confirmed.
    fn write_state(&self, state: &State, durable: bool) -> Result<bool, RadioError> {
        let path = self.root.join("station.json");
        let temp = self.root.join("station.json.tmp");
        let bytes = serde_json::to_vec_pretty(state).expect("state json");
        std::fs::File::create(&temp)
            .and_then(|mut f| {
                f.write_all(&bytes)?;
                if durable {
                    f.sync_all()?;
                }
                Ok(())
            })
            .map_err(|e| io(&temp, e))?;
        std::fs::rename(&temp, &path).map_err(|e| io(&path, e))?;
        // Saved from here on: an error now must not make the caller undo it.
        if durable {
            if let Err(e) = sync_dir(&self.root) {
                log::warn!("radio: {e}");
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn persist(&self, state: &State) {
        if let Err(e) = self.save(state) {
            log::error!("radio: {e}");
        }
    }

    /// Delete audio no item refers to and job folders of finished jobs.
    fn prune(&self, state: &mut State) {
        let keep: HashSet<&str> = items(state).map(|i| i.file.as_str()).collect();
        if let Ok(entries) = std::fs::read_dir(self.root.join("audio")) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if !keep.contains(name.to_string_lossy().as_ref()) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let job = state.job.as_ref().map(|j| j.id.as_str());
        if let Ok(entries) = std::fs::read_dir(self.root.join("jobs")) {
            for entry in entries.flatten() {
                if Some(entry.file_name().to_string_lossy().as_ref()) != job {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    fn notify(&self) {
        *self.wake.flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.cond.notify_all();
    }

    /// Sleep up to `timeout`, or until something calls `notify`.
    pub fn sleep(&self, timeout: Option<Duration>) {
        let mut flag = self.wake.flag.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = timeout.map(|t| Instant::now() + t);
        while !*flag {
            match deadline {
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    flag = self
                        .wake
                        .cond
                        .wait_timeout(flag, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
                None => flag = self.wake.cond.wait(flag).unwrap_or_else(|e| e.into_inner()),
            }
        }
        *flag = false;
    }

    // ---- listener controls ----

    pub fn set_on_air(&self, on: bool) {
        let mut s = self.lock();
        s.on_air = on;
        if on {
            s.cooldown_until = None;
        }
        self.persist(&s);
        drop(s);
        self.notify();
    }

    pub fn on_air(&self) -> bool {
        self.lock().on_air
    }

    /// Draw the next song from the mix as it is now.
    fn draw(s: &State, seed: u64, request: bool) -> Draw {
        let recent = recent_genres(s);
        s.mix.draw(
            &mut Rng::new(seed ^ DRAW_SALT),
            &Context {
                recent: &recent,
                weights: &s.weights,
                lock: s.lock.as_ref().map(|l| l.genre.as_str()),
                request,
            },
        )
    }

    /// A job that is not written yet follows a changed mix or lock.
    fn redraw(s: &mut State) {
        let Some(job) = s.job.as_ref().filter(|j| j.draft.is_none()) else {
            return;
        };
        let seed = job.seed.wrapping_add(1);
        let draw = (job.kind == Kind::Song).then(|| Self::draw(s, seed, job.request.is_some()));
        if let Some(job) = s.job.as_mut() {
            job.seed = seed;
            job.draw = draw;
        }
    }

    /// Replace the mix. Applies to songs not written yet; queued songs keep theirs.
    pub fn set_mix(&self, mix: Mix) -> Mix {
        self.change_mix(|_| mix)
    }

    fn change_mix(&self, f: impl FnOnce(&Mix) -> Mix) -> Mix {
        let mut s = self.lock();
        s.mix = f(&s.mix).sanitized();
        Self::redraw(&mut s);
        let mix = s.mix.clone();
        self.persist(&s);
        mix
    }

    /// A random mix: a few genres and moods, a small surprise chance.
    pub fn shuffle(&self) -> Mix {
        let seed = uuid::Uuid::new_v4().as_u64_pair().0;
        self.change_mix(|m| m.shuffled(&mut Rng::new(seed)))
    }

    // ---- stations ----

    /// Built-in stations first, then the listener's.
    pub fn stations(&self) -> Vec<mix::Station> {
        let mut all = mix::builtin_stations();
        all.extend(self.lock().stations.iter().cloned());
        all
    }

    /// The station the mix sounds like now, if any.
    pub fn active_station(stations: &[mix::Station], mix: &Mix) -> Option<String> {
        let preset = mix.preset();
        stations
            .iter()
            .find(|st| st.preset.matches(&preset))
            .map(|st| st.id.clone())
    }

    /// Save the mix as a station; a station of the listener's with that name is updated.
    pub fn save_station(&self, name: &str) -> Result<mix::Station, RadioError> {
        let name = mix::station_name(name).ok_or_else(|| invalid("Give the station a name."))?;
        if mix::builtin_stations().iter().any(|b| same(&b.name, &name)) {
            return Err(invalid(format!(
                "{name} is a built-in station. Pick another name."
            )));
        }
        let mut s = self.lock();
        let preset = s.mix.preset();
        let station = if let Some(st) = s.stations.iter_mut().find(|st| same(&st.name, &name)) {
            st.name = name;
            st.preset = preset;
            st.clone()
        } else {
            if s.stations.len() >= mix::MAX_STATIONS {
                return Err(invalid(format!(
                    "You have {} stations. Delete one first.",
                    mix::MAX_STATIONS
                )));
            }
            let st = mix::Station {
                id: short_id(),
                name,
                preset,
                builtin: false,
            };
            s.stations.push(st.clone());
            st
        };
        self.persist(&s);
        Ok(station)
    }

    pub fn rename_station(&self, id: &str, name: &str) -> Result<(), RadioError> {
        let name = mix::station_name(name).ok_or_else(|| invalid("Give the station a name."))?;
        if mix::builtin_stations().iter().any(|b| b.id == id) {
            return Err(invalid("Built-in stations keep their name."));
        }
        let mut s = self.lock();
        let taken = mix::builtin_stations()
            .iter()
            .chain(&s.stations)
            .any(|st| st.id != id && same(&st.name, &name));
        if taken {
            return Err(invalid(format!("A station is already called {name}.")));
        }
        let st = s
            .stations
            .iter_mut()
            .find(|st| st.id == id)
            .ok_or_else(|| invalid("That station no longer exists."))?;
        st.name = name;
        self.persist(&s);
        Ok(())
    }

    pub fn delete_station(&self, id: &str) -> Result<(), RadioError> {
        if mix::builtin_stations().iter().any(|b| b.id == id) {
            return Err(invalid("Built-in stations cannot be deleted."));
        }
        let mut s = self.lock();
        s.stations.retain(|st| st.id != id);
        self.persist(&s);
        Ok(())
    }

    /// Tune the mix to a station; host and language stay.
    pub fn activate_station(&self, id: &str) -> Result<Mix, RadioError> {
        let station = self
            .stations()
            .into_iter()
            .find(|st| st.id == id)
            .ok_or_else(|| invalid("That station no longer exists."))?;
        Ok(self.change_mix(|m| m.with_preset(&station.preset)))
    }

    // ---- feedback, lock, saved songs ----

    /// Like or dislike a song (None takes it back). Moves its genre's draw weight
    /// within bounds; a second press of the same verdict changes nothing.
    pub fn feedback(&self, id: &str, feedback: Option<Feedback>) -> Result<(), RadioError> {
        let mut s = self.lock();
        let item = items(&s)
            .find(|i| i.id == id)
            .ok_or_else(|| invalid("That song is no longer on the station."))?;
        if item.kind != Kind::Song {
            return Err(invalid("Only songs can be liked or disliked."));
        }
        let (file, previous, genre) = (item.file.clone(), item.feedback, item.genre.clone());
        if previous == feedback {
            return Ok(());
        }
        let factor = |f: Option<Feedback>| match f {
            Some(Feedback::Like) => mix::WEIGHT_STEP,
            Some(Feedback::Dislike) => 1.0 / mix::WEIGHT_STEP,
            None => 1.0,
        };
        if let Some(genre) = genre {
            mix::adjust(&mut s.weights, &genre, factor(feedback) / factor(previous));
        }
        for i in items_mut(&mut s).filter(|i| i.file == file) {
            i.feedback = feedback;
        }
        self.persist(&s);
        Ok(())
    }

    /// Forget likes and dislikes, of one genre or all.
    pub fn reset_feedback(&self, genre: Option<&str>) {
        let mut s = self.lock();
        match genre {
            Some(g) => {
                s.weights.remove(&g.to_lowercase());
                for i in
                    items_mut(&mut s).filter(|i| i.genre.as_deref().is_some_and(|x| same(x, g)))
                {
                    i.feedback = None;
                }
            }
            None => {
                s.weights.clear();
                for i in items_mut(&mut s) {
                    i.feedback = None;
                }
            }
        }
        self.persist(&s);
    }

    /// Draw only the airing song's genre for `songs` songs (None: until unlocked).
    pub fn lock_genre(&self, songs: Option<u32>) -> Result<GenreLock, RadioError> {
        let mut s = self.lock();
        let genre = s
            .now
            .as_ref()
            .and_then(|i| i.genre.clone())
            .ok_or_else(|| invalid("This song has no genre to stay on."))?;
        let lock = GenreLock {
            genre,
            left: songs.map(|n| n.clamp(1, mix::MAX_LOCK_SONGS)),
        };
        s.lock = Some(lock.clone());
        Self::redraw(&mut s);
        self.persist(&s);
        Ok(lock)
    }

    pub fn unlock_genre(&self) {
        let mut s = self.lock();
        if s.lock.take().is_some() {
            Self::redraw(&mut s);
            self.persist(&s);
        }
    }

    /// Keep a song's audio and words out of clean-up.
    pub fn save_song(&self, id: &str) -> Result<(), RadioError> {
        let mut s = self.lock();
        let mut item = items(&s)
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| invalid("That song is no longer on the station."))?;
        if item.kind != Kind::Song {
            return Err(invalid("Only songs can be saved."));
        }
        if s.saved.iter().any(|i| i.file == item.file) {
            return Ok(());
        }
        if s.saved.len() >= MAX_SAVED {
            return Err(invalid(format!(
                "{MAX_SAVED} songs are saved already. Remove one first."
            )));
        }
        item.provenance.remove("replay");
        s.saved.insert(0, item);
        self.persist(&s);
        Ok(())
    }

    /// Let a song go again; its audio goes once nothing else plays or lists it.
    pub fn unsave_song(&self, id: &str) {
        let mut s = self.lock();
        let file = items(&s).find(|i| i.id == id).map(|i| i.file.clone());
        let before = s.saved.len();
        s.saved
            .retain(|i| i.id != id && Some(i.file.as_str()) != file.as_deref());
        if s.saved.len() != before {
            self.prune(&mut s);
            self.persist(&s);
        }
    }

    /// Air a saved song now, labelled as a replay; what was airing goes to history.
    pub fn air_saved(&self, id: &str) -> Result<Item, RadioError> {
        let mut s = self.lock();
        let mut item = s
            .saved
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| invalid("That song is no longer saved."))?;
        item.id = format!("replay-{}", short_id());
        item.provenance.insert("replay".into(), "true".into());
        Self::retire_now(&mut s);
        s.now = Some(item.clone());
        self.prune(&mut s);
        self.persist(&s);
        drop(s);
        self.notify();
        Ok(item)
    }

    /// The airing item ends: into history unless it was a replay.
    fn retire_now(s: &mut State) -> Option<Item> {
        let previous = s.now.take();
        if let Some(item) = previous.clone() {
            if !item.is_replay() {
                s.history.insert(0, item);
                s.history.truncate(MAX_HISTORY);
            }
        }
        previous
    }

    /// Choose the music engine and ACE-Step's language model. Applies from the next
    /// song the station makes; one already being made finishes as it started.
    pub fn set_music(&self, engine: MusicEngine, ace_lm: AceLm) -> Music {
        let mut s = self.lock();
        s.music.engine = engine;
        s.music.ace_lm = ace_lm;
        let music = s.music.clone();
        self.persist(&s);
        drop(s);
        // A smaller or larger programme may now be wanted.
        self.notify();
        music
    }

    /// ACE-Step finished a song with this engine build on this device (see
    /// `music::warm_key`): later songs no longer wait for shader preparation.
    pub fn set_ace_warm(&self, key: String) {
        let mut s = self.lock();
        if s.music.ace_warm.as_deref() != Some(key.as_str()) {
            s.music.ace_warm = Some(key);
            self.persist(&s);
        }
    }

    pub fn set_volume(&self, volume: f32) {
        let mut s = self.lock();
        s.volume = volume.clamp(0.0, 1.0);
        self.persist(&s);
    }

    /// Queue a listener request for the next song that is not written yet.
    pub fn request(&self, text: &str) -> Result<Request, RadioError> {
        let text = clean_text(text, MAX_REQUEST_CHARS)
            .ok_or_else(|| RadioError::Invalid("Type what you would like to hear.".into()))?;
        let mut s = self.lock();
        let pending = s
            .requests
            .iter()
            .filter(|r| r.answered_by.is_none())
            .count();
        if pending >= 3 {
            return Err(RadioError::Invalid(
                "Three requests are already waiting. Try again after the next song.".into(),
            ));
        }
        let request = Request {
            id: short_id(),
            text,
            created_at: now_ms(),
            answered_by: None,
        };
        s.requests.push(request.clone());
        let overflow = s.requests.len().saturating_sub(MAX_REQUESTS);
        s.requests.drain(..overflow);
        self.persist(&s);
        drop(s);
        self.notify();
        Ok(request)
    }

    /// The finished item to air next, without taking it.
    pub fn next_up(&self) -> Option<Item> {
        self.lock().queue.first().cloned()
    }

    /// End the current item (finished or skipped) and air the next: the queue first,
    /// otherwise a labelled replay of an earlier song. None = nothing to play yet.
    pub fn advance(&self) -> Option<Item> {
        let mut s = self.lock();
        let previous = Self::retire_now(&mut s);
        let next = if s.queue.is_empty() {
            replay(&s.history, previous.as_ref())
        } else {
            Some(s.queue.remove(0))
        };
        s.now = next.clone();
        self.prune(&mut s);
        self.persist(&s);
        drop(s);
        self.notify();
        next
    }

    /// Air `item` now if nothing is airing (first press of Play).
    pub fn ensure_now(&self) -> Option<Item> {
        let current = self.lock().now.clone();
        current.or_else(|| self.advance())
    }

    /// Imported or manually placed items go straight into history.
    pub fn import(&self, item: Item, source: &Path) -> Result<(), RadioError> {
        let target = self.root.join("audio").join(&item.file);
        if !target.exists() {
            std::fs::copy(source, &target).map_err(|e| io(&target, e))?;
        }
        let mut s = self.lock();
        if s.history.iter().any(|i| i.id == item.id) {
            return Ok(());
        }
        s.history.push(item);
        s.history.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        s.history.truncate(MAX_HISTORY);
        self.persist(&s);
        Ok(())
    }

    // ---- production ----

    fn needs_more(s: &State) -> bool {
        let songs = s.queue.iter().filter(|i| i.kind == Kind::Song).count();
        let seconds: f64 = s.queue.iter().map(|i| i.seconds).sum();
        let (items, min_songs, min_seconds) = match s.music.engine {
            MusicEngine::Yue2 => (BUFFER_ITEMS, BUFFER_SONGS, BUFFER_SECONDS),
            MusicEngine::AceStep => (ACE_BUFFER_ITEMS, ACE_BUFFER_SONGS, ACE_BUFFER_SECONDS),
        };
        s.queue.len() < items && (songs < min_songs || seconds < min_seconds)
    }

    /// The last finished song a break can talk about.
    fn last_song(s: &State) -> Option<Item> {
        s.queue
            .iter()
            .rev()
            .chain(s.now.iter())
            .chain(s.history.iter())
            .find(|i| i.kind == Kind::Song)
            .cloned()
    }

    fn plan(&self, s: &mut State, voice_ready: bool) -> Job {
        let wants_break = s.mix.host.every().is_some_and(|n| s.songs_since_break >= n)
            && voice_ready
            && s.queue
                .last()
                .or(s.now.as_ref())
                .is_some_and(|i| i.kind == Kind::Song);
        let kind = if wants_break { Kind::Break } else { Kind::Song };
        let request = if kind == Kind::Song {
            s.requests.iter().find(|r| r.answered_by.is_none()).cloned()
        } else {
            None
        };
        let seed = uuid::Uuid::new_v4().as_u64_pair().0;
        let draw = (kind == Kind::Song).then(|| Self::draw(s, seed, request.is_some()));
        Job {
            id: format!(
                "{}-{}",
                if kind == Kind::Song { "song" } else { "break" },
                short_id()
            ),
            kind,
            attempt: 0,
            seed,
            request,
            draft: None,
            started_at: now_ms(),
            step_started_at: now_ms(),
            writer_ms: 0,
            draw,
        }
    }

    fn update_job(&self, f: impl FnOnce(&mut Job)) {
        if let Err(e) = self.try_update_job(f) {
            log::error!("radio: {e}");
        }
    }

    /// Like `update_job`, but the change must reach disk.
    fn try_update_job(&self, f: impl FnOnce(&mut Job)) -> Result<(), RadioError> {
        let mut s = self.lock();
        if let Some(job) = s.job.as_mut() {
            f(job);
        }
        self.save(&s)
    }

    fn job_dir(&self, job: &Job) -> PathBuf {
        self.root.join("jobs").join(&job.id)
    }

    /// Run one production step.
    pub fn work(&self, backend: &dyn Backend) -> Next {
        let job = {
            let mut s = self.lock();
            if s.job.is_none() {
                if !s.on_air || !Self::needs_more(&s) {
                    return Next::Idle;
                }
                if s.cooldown_until.is_some_and(|t| t > now_ms()) {
                    return Next::Wait(Duration::from_millis(
                        (s.cooldown_until.unwrap_or(0) - now_ms()).max(100) as u64,
                    ));
                }
                drop(s);
                let voice = backend.voice_ready();
                s = self.lock();
                let job = self.plan(&mut s, voice);
                s.job = Some(job);
                self.persist(&s);
            }
            if !s.on_air {
                return Next::Idle;
            }
            // A song planned before the mix existed is drawn now.
            if let Some(job) = s
                .job
                .as_ref()
                .filter(|j| j.kind == Kind::Song && j.draw.is_none() && j.draft.is_none())
            {
                let draw = Self::draw(&s, job.seed, job.request.is_some());
                if let Some(job) = s.job.as_mut() {
                    job.draw = Some(draw);
                }
                self.persist(&s);
            }
            s.job.clone().expect("job")
        };
        let result = if job.draft.is_none() {
            self.write(backend, &job)
        } else if job.kind == Kind::Break {
            self.speak(backend, &job)
        } else {
            self.music(backend, &job)
        };
        match result {
            Ok(next) => next,
            Err(RadioError::Busy) => Next::Wait(Duration::from_secs(2)),
            Err(RadioError::Cancelled) => Next::Wait(Duration::from_secs(1)),
            Err(RadioError::Unavailable(message)) => {
                let mut s = self.lock();
                if s.last_error.as_deref() != Some(message.as_str()) {
                    s.last_error = Some(message);
                    self.persist(&s);
                    drop(s);
                    backend.changed();
                }
                Next::Wait(Duration::from_secs(10))
            }
            Err(e) => {
                self.failed(&job, e.to_string());
                backend.changed();
                Next::Continue
            }
        }
    }

    fn write(&self, backend: &dyn Backend, job: &Job) -> Result<Next, RadioError> {
        if !backend.may_start() {
            return Err(RadioError::Busy);
        }
        let (mix, recent, last) = {
            let s = self.lock();
            (
                s.mix.clone(),
                writer::recent(&s.history, &s.queue),
                Self::last_song(&s),
            )
        };
        let started = Instant::now();
        let seed32 = (job.seed ^ (job.seed >> 32)) as u32;
        let draft = match job.kind {
            Kind::Song => {
                let direction = job
                    .draw
                    .clone()
                    .unwrap_or_else(|| mix.draw(&mut Rng::new(job.seed), &Context::default()))
                    .brief(&mix);
                let instrumental = writer::instrumental(&direction, job.seed);
                let (prompt, tokens) = writer::song_prompt(
                    &direction,
                    instrumental,
                    job.request.as_ref().map(|r| r.text.as_str()),
                    &recent,
                    job.seed,
                );
                let reply = backend.write(prompt, tokens, seed32)?;
                writer::parse_song(&reply, &direction, instrumental)?
            }
            Kind::Break => {
                let Some(last) = last else {
                    // Nothing to talk about; make a song instead.
                    self.update_job(|j| j.kind = Kind::Song);
                    return Ok(Next::Continue);
                };
                let lang = crate::voice::host_language(&mix.language);
                // The next song is not drawn yet: tease the mood of the one before.
                let mood = last
                    .mood
                    .clone()
                    .or_else(|| mix.enabled_moods().first().cloned())
                    .unwrap_or_else(|| "warm".into());
                let (prompt, tokens) = writer::break_prompt(&last, &mood, lang);
                let reply = backend.write(prompt, tokens, seed32)?;
                writer::parse_break(&reply, &last)?
            }
        };
        let ms = started.elapsed().as_millis() as u64;
        self.update_job(|j| {
            j.draft = Some(draft);
            j.writer_ms = ms;
            j.step_started_at = now_ms();
        });
        backend.changed();
        Ok(Next::Continue)
    }

    fn music(&self, backend: &dyn Backend, job: &Job) -> Result<Next, RadioError> {
        if !backend.may_start() {
            return Err(RadioError::Busy);
        }
        let draft = job.draft.clone().expect("draft");
        let dir = self.job_dir(job);
        std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        let out = dir.join("song.wav");
        let _ = std::fs::remove_file(&out);
        let (length, music) = {
            let s = self.lock();
            let length = job
                .draw
                .as_ref()
                .map(|d| d.length)
                .or(s.mix.length)
                .unwrap_or_default();
            (length.seconds(), s.music.clone())
        };
        self.update_job(|j| j.step_started_at = now_ms());
        backend.changed();
        let provenance = backend.compose(&draft, job.seed, length, &music, &out)?;
        let mut audio = audio::decode(&out)?;
        let checks = audio::check(&audio, MIN_SONG_SECONDS)?;
        audio::normalize(&mut audio);
        // Cut at the length limit rather than ended by the model: end softly.
        if provenance.get("truncated").is_some_and(|v| v == "true") {
            audio::fade_out(&mut audio, FADE_SECONDS);
        }
        self.finish(job, &draft, audio, checks.seconds, provenance)?;
        backend.changed();
        Ok(Next::Continue)
    }

    fn speak(&self, backend: &dyn Backend, job: &Job) -> Result<Next, RadioError> {
        if !backend.may_start() {
            return Err(RadioError::Busy);
        }
        let draft = job.draft.clone().expect("draft");
        let dir = self.job_dir(job);
        std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        let out = dir.join("speech.wav");
        let _ = std::fs::remove_file(&out);
        let lang = crate::voice::host_language(&self.lock().mix.language);
        let voice = backend.speak(draft.script.as_deref().unwrap_or_default(), lang, &out)?;
        let mut audio = audio::decode(&out)?;
        let checks = audio::check(&audio, MIN_BREAK_SECONDS)?;
        audio::normalize(&mut audio);
        let mut provenance = BTreeMap::new();
        provenance.insert("voice".into(), voice);
        self.finish(job, &draft, audio, checks.seconds, provenance)?;
        backend.changed();
        Ok(Next::Continue)
    }

    fn finish(
        &self,
        job: &Job,
        draft: &Draft,
        audio: Audio,
        seconds: f64,
        mut provenance: BTreeMap<String, String>,
    ) -> Result<(), RadioError> {
        let file = format!("{}.opus", job.id);
        // Written in the job folder: pruning keeps it, and `audio/` only ever holds
        // complete files.
        let temp = self.job_dir(job).join(&file);
        let loudness = write_opus(audio, content(job.kind), &temp, &|_| true)?;
        provenance.insert("writer".into(), "Gemma 4 E4B".into());
        provenance.insert("seed".into(), job.seed.to_string());
        provenance.insert(
            "writerSeconds".into(),
            format!("{:.1}", job.writer_ms as f64 / 1000.0),
        );
        let made = (now_ms() - job.started_at) as f64 / 1000.0;
        provenance.insert("madeSeconds".into(), format!("{made:.1}"));
        let item = Item {
            id: job.id.clone(),
            kind: job.kind,
            title: draft.title.clone(),
            subtitle: draft.subtitle.clone(),
            lyrics: draft.lyrics.clone(),
            script: draft.script.clone(),
            seconds,
            file: file.clone(),
            created_at: now_ms(),
            request: job.request.as_ref().map(|r| r.text.clone()),
            provenance,
            loudness: Some(loudness),
            genre: job.draw.as_ref().and_then(|d| d.genre.clone()),
            mood: job.draw.as_ref().and_then(|d| d.mood.clone()),
            surprise: job.draw.as_ref().is_some_and(|d| d.surprise),
            feedback: None,
        };
        let target = self.root.join("audio").join(&file);
        let mut s = self.lock();
        std::fs::rename(&temp, &target).map_err(|e| io(&target, e))?;
        if let Some(request) = &job.request {
            if let Some(r) = s.requests.iter_mut().find(|r| r.id == request.id) {
                r.answered_by = Some(item.title.clone());
            }
        }
        // A song drawn under the lock uses up one of its songs.
        let used = job
            .draw
            .as_ref()
            .filter(|d| d.locked)
            .and_then(|d| d.genre.as_deref());
        if let (Some(genre), Some(lock)) = (used, s.lock.as_mut()) {
            if same(genre, &lock.genre) {
                if let Some(left) = lock.left.as_mut() {
                    *left = left.saturating_sub(1);
                    if *left == 0 {
                        s.lock = None;
                    }
                }
            }
        }
        match job.kind {
            Kind::Song => {
                s.songs_since_break += 1;
                s.stats.songs += 1;
                s.stats.last_song_seconds = Some(made);
                s.stats.last_song_audio_seconds = Some(seconds);
            }
            Kind::Break => {
                s.songs_since_break = 0;
                s.stats.breaks += 1;
            }
        }
        s.queue.push(item);
        s.job = None;
        s.last_error = None;
        self.prune(&mut s);
        self.persist(&s);
        Ok(())
    }

    /// One retry with a fresh draft and seed, then a cooldown before a new job.
    fn failed(&self, job: &Job, message: String) {
        log::warn!("radio: {} failed: {message}", job.id);
        let mut s = self.lock();
        s.stats.failures += 1;
        s.last_error = Some(message);
        if job.attempt == 0 {
            if let Some(j) = s.job.as_mut() {
                j.attempt = 1;
                j.seed = j.seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                j.draft = None;
                j.step_started_at = now_ms();
            }
        } else {
            s.job = None;
            s.cooldown_until = Some(now_ms() + RETRY_COOLDOWN_MS);
        }
        let _ = std::fs::remove_dir_all(self.job_dir(job));
        self.persist(&s);
    }

    /// The production loop; returns when `stop` is set. Items still stored as WAV
    /// are converted alongside, on a thread of their own.
    pub fn run(&self, backend: &dyn Backend, stop: &AtomicBool) {
        std::thread::scope(|scope| {
            if items(&self.lock()).any(|i| !is_opus(&i.file)) {
                let spawned = std::thread::Builder::new()
                    .name("radio-convert".into())
                    .spawn_scoped(scope, || {
                        lower_priority();
                        let start = Instant::now();
                        while start.elapsed() < CONVERT_DELAY {
                            if stop.load(Ordering::SeqCst) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(250));
                        }
                        let done = self.convert(stop);
                        log::info!(
                            "radio: stored {} items as Opus ({:.1} MB → {:.1} MB), {} failed",
                            done.converted,
                            done.bytes_before as f64 / 1e6,
                            done.bytes_after as f64 / 1e6,
                            done.failed
                        );
                    });
                if let Err(e) = spawned {
                    log::error!("radio: conversion thread: {e}");
                }
            }
            while !stop.load(Ordering::SeqCst) {
                match self.work(backend) {
                    Next::Continue => {}
                    Next::Wait(d) => self.sleep(Some(d)),
                    Next::Idle => self.sleep(Some(Duration::from_secs(30))),
                }
            }
        });
    }

    /// Store every item that is not Opus yet as Opus, one file at a time, until done
    /// or `stop`. Interrupt-safe: a kill at any point leaves a consistent station,
    /// and the next pass continues. A file that fails stays as it is.
    pub fn convert(&self, stop: &AtomicBool) -> Conversion {
        // Only a checkpoint cancels.
        self.convert_with(stop, &|_| true).unwrap_or_default()
    }

    fn convert_with(
        &self,
        stop: &AtomicBool,
        checkpoint: &dyn Fn(Step) -> bool,
    ) -> Result<Conversion, RadioError> {
        let mut done = Conversion::default();
        let mut failed = HashSet::new();
        while !stop.load(Ordering::SeqCst) {
            let next = items(&self.lock())
                .map(|i| i.file.clone())
                .find(|f| !is_opus(f) && !failed.contains(f));
            let Some(file) = next else { break };
            match self.convert_file(&file, checkpoint) {
                Ok(Some((before, after))) => {
                    done.converted += 1;
                    done.bytes_before += before;
                    done.bytes_after += after;
                }
                Ok(None) => {}
                Err(RadioError::Cancelled) => return Err(RadioError::Cancelled),
                Err(e) => {
                    log::warn!("radio: could not store {file} as Opus: {e}");
                    done.failed += 1;
                    failed.insert(file);
                }
            }
        }
        Ok(done)
    }

    /// Convert one file. The WAV is deleted only after the Opus file is complete,
    /// verified, in `audio/`, and the saved state names it. None = no item uses
    /// the file any more.
    fn convert_file(
        &self,
        file: &str,
        checkpoint: &dyn Fn(Step) -> bool,
    ) -> Result<Option<(u64, u64)>, RadioError> {
        let audio_dir = self.root.join("audio");
        let source = audio_dir.join(file);
        let Some(kind) = items(&self.lock()).find(|i| i.file == file).map(|i| i.kind) else {
            return Ok(None);
        };
        let before = std::fs::metadata(&source)
            .map_err(|e| io(&source, e))?
            .len();
        let decoded = audio::decode(&source)?;
        let name = opus_name(file);
        let temp = self.root.join("convert").join(format!("{name}.part"));
        let result = write_opus(decoded, content(kind), &temp, checkpoint);
        let loudness = match result {
            Ok(l) => l,
            Err(RadioError::Cancelled) => return Err(RadioError::Cancelled),
            Err(e) => {
                let _ = std::fs::remove_file(&temp);
                return Err(e);
            }
        };
        let target = audio_dir.join(&name);
        let after = std::fs::metadata(&temp).map_err(|e| io(&temp, e))?.len();
        // Under the lock: pruning never sees the new file without an item naming it.
        let mut s = self.lock();
        if !items(&s).any(|i| i.file == file) {
            drop(s);
            let _ = std::fs::remove_file(&temp);
            return Ok(None);
        }
        std::fs::rename(&temp, &target).map_err(|e| io(&target, e))?;
        sync_dir(&audio_dir)?;
        if !checkpoint(Step::Written) {
            return Err(RadioError::Cancelled);
        }
        for item in items_mut(&mut s).filter(|i| i.file == file) {
            item.file = name.clone();
            item.loudness = Some(loudness);
        }
        let durable = match self.write_state(&s, true) {
            Ok(durable) => durable,
            Err(e) => {
                // Memory must keep naming the WAV the saved state names, or pruning
                // would delete it.
                for item in items_mut(&mut s).filter(|i| i.file == name) {
                    item.file = file.to_string();
                    item.loudness = None;
                }
                let _ = std::fs::remove_file(&target);
                return Err(e);
            }
        };
        if !checkpoint(Step::Saved) {
            return Err(RadioError::Cancelled);
        }
        drop(s);
        // Unconfirmed: a power cut could still bring back a state naming the WAV.
        // Pruning removes it later.
        if durable {
            match std::fs::remove_file(&source) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    log::warn!("radio: {}: {e}", source.display())
                }
                _ => {}
            }
        }
        Ok(Some((before, after)))
    }

    pub fn wake(&self) {
        self.notify();
    }
}

impl Item {
    pub fn is_replay(&self) -> bool {
        self.provenance.get("replay").is_some_and(|v| v == "true")
    }
}

/// Conversion is background work; dictation and the desktop come first.
fn lower_priority() {
    // On Linux a thread id here changes only this thread.
    // SAFETY: plain system calls without pointers.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10);
    }
}

/// The most recent song that is neither the one that just ended nor its source.
fn replay(history: &[Item], previous: Option<&Item>) -> Option<Item> {
    let skip = previous.map(|p| p.file.as_str());
    let songs: Vec<&Item> = history.iter().filter(|i| i.kind == Kind::Song).collect();
    let pick = songs
        .iter()
        .find(|i| Some(i.file.as_str()) != skip)
        .or(songs.first())?;
    let mut item = (*pick).clone();
    item.id = format!("replay-{}", short_id());
    item.provenance.insert("replay".into(), "true".into());
    Some(item)
}

#[cfg(test)]
mod tests;
