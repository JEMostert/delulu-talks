//! The station: a bounded programme ahead of playback, one item made at a time.
//!
//! Production and playback have separate clocks. Every production step is persisted,
//! so a restart continues the same job from its last finished step. New items are
//! only made while the station is on air, and only start while the host says the GPU
//! may be used (not while dictating).
use crate::audio::{self, Audio};
use crate::model::*;
use crate::writer;
use crate::RadioError;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Ready programme: at most this many items…
pub const BUFFER_ITEMS: usize = 3;
/// …and at least two songs or this much audio.
pub const BUFFER_SECONDS: f64 = 360.0;
pub const BUFFER_SONGS: usize = 2;
const RETRY_COOLDOWN_MS: i64 = 20_000;
const MIN_SONG_SECONDS: f64 = 20.0;
const MIN_BREAK_SECONDS: f64 = 2.0;
/// The fade on a song the model had not finished when it reached its length.
const FADE_SECONDS: f64 = 4.0;

/// What production needs from the app. Implemented by Delulu with the cleanup
/// helper, the native music helper and `delulu speak`; by fakes in tests.
pub trait Backend: Send + Sync {
    /// Continue a rendered Gemma prompt. `Err(Busy)` when dictation holds the model.
    fn write(&self, prompt: String, max_tokens: u32, seed: u32) -> Result<String, RadioError>;
    /// False while dictation is active: a new GPU step must not start.
    fn may_start(&self) -> bool;
    fn voice_ready(&self) -> bool;
    fn speak(&self, text: &str, out: &Path) -> Result<(), RadioError>;
    /// Make the music for `draft` into `out`. `Err(Cancelled)` when stopped (off air
    /// or quitting), `Err(Unavailable)` when the model or helper is missing. Returns
    /// what to record about how it was made.
    fn compose(
        &self,
        draft: &Draft,
        seed: u64,
        max_seconds: u32,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError>;
    /// Something visible changed.
    fn changed(&self);
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

impl Station {
    /// Load `root/station.json`. The station starts off air; a job in progress is kept.
    pub fn open(root: &Path) -> Result<Station, RadioError> {
        for dir in [root.to_path_buf(), root.join("audio"), root.join("jobs")] {
            std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        }
        let path = root.join("station.json");
        let mut state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<State>(&bytes).unwrap_or_else(|e| {
                let keep = root.join(format!("station.corrupt-{}.json", now_ms()));
                log::warn!("radio state unreadable ({e}); kept as {}", keep.display());
                let _ = std::fs::rename(&path, &keep);
                State::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(io(&path, e)),
        };
        state.on_air = false;
        state.direction = state.direction.clone().sanitized();
        let audio = root.join("audio");
        let exists = |i: &Item| audio.join(&i.file).is_file();
        state.now = state.now.take().filter(exists);
        state.queue.retain(exists);
        state.history.retain(exists);
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

    pub fn load_audio(&self, item: &Item) -> Result<Arc<Audio>, RadioError> {
        audio::decode(&self.audio_path(item)).map(Arc::new)
    }

    fn save(&self, state: &State) -> Result<(), RadioError> {
        let path = self.root.join("station.json");
        let temp = self.root.join("station.json.tmp");
        let bytes = serde_json::to_vec_pretty(state).expect("state json");
        std::fs::write(&temp, bytes).map_err(|e| io(&temp, e))?;
        std::fs::rename(&temp, &path).map_err(|e| io(&path, e))
    }

    fn persist(&self, state: &State) {
        if let Err(e) = self.save(state) {
            log::error!("radio: {e}");
        }
    }

    /// Delete audio no item refers to and job folders of finished jobs.
    fn prune(&self, state: &mut State) {
        let keep: HashSet<&str> = state
            .now
            .iter()
            .chain(&state.queue)
            .chain(&state.history)
            .map(|i| i.file.as_str())
            .collect();
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

    pub fn set_direction(&self, direction: Direction) -> Direction {
        let mut s = self.lock();
        s.direction = direction.sanitized();
        // A job that is not written yet follows the new direction.
        if let Some(job) = s.job.as_mut().filter(|j| j.draft.is_none()) {
            job.seed = job.seed.wrapping_add(1);
        }
        let d = s.direction.clone();
        self.persist(&s);
        d
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
        let previous = s.now.take();
        if let Some(item) = previous.clone() {
            if !item.is_replay() {
                s.history.insert(0, item);
                s.history.truncate(MAX_HISTORY);
            }
        }
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
        s.queue.len() < BUFFER_ITEMS && (songs < BUFFER_SONGS || seconds < BUFFER_SECONDS)
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
        let wants_break = s
            .direction
            .host
            .every()
            .is_some_and(|n| s.songs_since_break >= n)
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
        Job {
            id: format!(
                "{}-{}",
                if kind == Kind::Song { "song" } else { "break" },
                short_id()
            ),
            kind,
            attempt: 0,
            seed: uuid::Uuid::new_v4().as_u64_pair().0,
            request,
            draft: None,
            started_at: now_ms(),
            step_started_at: now_ms(),
            writer_ms: 0,
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
        let (direction, recent, last) = {
            let s = self.lock();
            (
                s.direction.clone(),
                writer::recent(&s.history, &s.queue),
                Self::last_song(&s),
            )
        };
        let started = Instant::now();
        let seed32 = (job.seed ^ (job.seed >> 32)) as u32;
        let draft = match job.kind {
            Kind::Song => {
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
                let (prompt, tokens) = writer::break_prompt(&last, &direction.mood);
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
        let length = self.lock().direction.length.seconds();
        self.update_job(|j| j.step_started_at = now_ms());
        backend.changed();
        let provenance = backend.compose(&draft, job.seed, length, &out)?;
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
        backend.speak(draft.script.as_deref().unwrap_or_default(), &out)?;
        let mut audio = audio::decode(&out)?;
        let checks = audio::check(&audio, MIN_BREAK_SECONDS)?;
        audio::normalize(&mut audio);
        let mut provenance = BTreeMap::new();
        provenance.insert("voice".into(), "Chatterbox Turbo (bundled speaker)".into());
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
        let file = format!("{}.wav", job.id);
        audio::write_wav(&self.root.join("audio").join(&file), &audio)?;
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
            file,
            created_at: now_ms(),
            request: job.request.as_ref().map(|r| r.text.clone()),
            provenance,
        };
        let mut s = self.lock();
        if let Some(request) = &job.request {
            if let Some(r) = s.requests.iter_mut().find(|r| r.id == request.id) {
                r.answered_by = Some(item.title.clone());
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

    /// The production loop; returns when `stop` is set.
    pub fn run(&self, backend: &dyn Backend, stop: &AtomicBool) {
        while !stop.load(Ordering::SeqCst) {
            match self.work(backend) {
                Next::Continue => {}
                Next::Wait(d) => self.sleep(Some(d)),
                Next::Idle => self.sleep(Some(Duration::from_secs(30))),
            }
        }
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
