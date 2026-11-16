//! Dictation in the daemon (`DELULU_DAEMON=1`).
//!
//! [`Live`] carries out the dictation state machine's effects with the code the
//! app shares: the three stages of the stop path in `delulu-dictation`, one per
//! effect, the store for settings and History, and the dictation context. It
//! owns everything a dictation needs; the window, when open, is only a client.
//!
//! Everything that touches the machine (microphone, speech engine, cleanup
//! helper, portals, pill) goes through a [`Platform`]. The real one is
//! [`crate::desktop::DesktopPlatform`]; tests use a fake, so they need no
//! desktop, GPU or model.
//!
//! Effects start their work and return at once; results come back as inputs to
//! the state machine, which drops any result for a job that is no longer
//! current. That is what makes cancel safe while an engine is still busy.

use crate::server::{Daemon, Effects, HISTORY_PAGE};
use crate::{now_ms, wire};
use delulu_core::dictation::{Config, Effect, Input, JobId, Outcome, Phase};
use delulu_core::gesture::KeyEvent;
use delulu_desktop::hotkey::HotkeyStatus;
use delulu_desktop::insert::InsertStatus;
use delulu_dictation::cleanup::Cleaned;
use delulu_dictation::context::{Context, EXPIRE};
use delulu_dictation::stop::{self, InsertResult, Recorded, StopOutcome, StopPorts, StopRequest};
use delulu_overlay::PillState;
use delulu_proto::api::{Event, HistoryListParams};
use delulu_proto::state::*;
use delulu_store::{InsertMode, NewEntry, Settings, Store};
use delulu_stt::{Language, Transcript};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How often a level event goes out while recording, at most.
const LEVEL_INTERVAL: Duration = Duration::from_millis(33);
/// How long delivery waits for the hotkey to come up before copying instead.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(3);

/// Everything outside the daemon's own logic.
pub trait Platform: Send + Sync + 'static {
    /// Loads the speech model and starts the cleanup helper, reporting both.
    fn start_engines(&self, report: Reporter);
    fn start_capture(
        &self,
        device: Option<&str>,
        level: Box<dyn Fn(f32) + Send>,
    ) -> Result<(), String>;
    /// The recorded samples. Blocks until the recorder has stopped.
    fn stop_capture(&self) -> Recorded;
    fn discard_capture(&self);
    fn transcribe(
        &self,
        samples: Vec<f32>,
        language: Language,
        prompt: Option<String>,
    ) -> BoxFuture<'_, Result<Transcript, String>>;
    /// Cleans with the helper if it is ready right now; never waits for it, and
    /// falls back to the raw text on any failure.
    fn clean(
        &self,
        enabled: bool,
        language: String,
        raw: String,
        vocabulary: Vec<String>,
    ) -> BoxFuture<'_, Cleaned>;
    fn deliver(&self, text: String, mode: InsertMode, held: bool) -> BoxFuture<'_, InsertResult>;
    /// The Delulu Talks app is running, so it holds the shortcut itself.
    fn app_running(&self) -> BoxFuture<'_, bool>;
    /// Resolves once the app is no longer running.
    fn app_gone(&self) -> BoxFuture<'_, ()>;
    fn bind_hotkey(
        &self,
        events: mpsc::UnboundedSender<KeyEvent>,
        on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> BoxFuture<'_, HotkeyStatus>;
    fn prepare_insert(&self) -> BoxFuture<'_, InsertStatus>;
    fn pill(&self, state: PillState, label: Option<&str>);
    fn pill_level(&self, rms: f32);
}

/// Lets the platform report its engines' state into the snapshot.
#[derive(Clone)]
pub struct Reporter {
    daemon: Daemon,
}

impl Reporter {
    /// The speech engine; dictation is available exactly while it is ready.
    pub fn stt(&self, status: WorkerStatus) {
        match (&status.state, &status.error) {
            (WorkerState::Ready, _) => eprintln!(
                "delulud: speech model ready ({})",
                status.device.as_deref().unwrap_or("unknown device")
            ),
            (_, Some(error)) => eprintln!("delulud: speech model: {error}"),
            _ => {}
        }
        self.daemon.update(|s| {
            let d = &mut s.dictation;
            d.available = status.state == WorkerState::Ready;
            d.unavailable_reason = match status.state {
                WorkerState::Ready => None,
                WorkerState::Off | WorkerState::Starting | WorkerState::Loading => {
                    Some("The speech model is loading".into())
                }
                _ => Some(
                    status
                        .error
                        .clone()
                        .unwrap_or_else(|| "The speech model is not available".into()),
                ),
            };
            d.stt = status;
            vec![Event::Dictation { state: d.clone() }]
        });
    }

    pub fn cleanup(&self, status: WorkerStatus) {
        self.daemon.update(|s| {
            if s.dictation.cleanup == status {
                return Vec::new();
            }
            s.dictation.cleanup = status;
            vec![Event::Dictation {
                state: s.dictation.clone(),
            }]
        });
    }
}

/// What the current dictation has gathered so far.
#[derive(Default)]
struct Job {
    id: JobId,
    pill: bool,
    started: Option<Instant>,
    was_held: bool,
    /// Read once, after the recording stopped, as the app does.
    settings: Option<Settings>,
    transcript: Option<Transcript>,
    cleaned: Option<Cleaned>,
    /// The saved History entry, for the outcome and the History event.
    entry: Option<HistoryEntry>,
    history_error: Option<String>,
    /// The pill's word for a failure, when the failing step knows a better one.
    failure_word: Option<&'static str>,
}

pub struct Live {
    me: Weak<Live>,
    daemon: Daemon,
    store: Arc<Store>,
    platform: Arc<dyn Platform>,
    job: Mutex<Job>,
    /// When the hotkey went up after recording stopped, for `total_ms`.
    last_release: Mutex<Option<Instant>>,
    last_level: Mutex<Option<Instant>>,
    context: Context,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Live {
    /// Takes over dictation in `daemon`: fills the snapshot from the store, starts
    /// the engines and binds the shortcut. Call it inside the Tokio runtime.
    pub fn start(daemon: Daemon, store: Arc<Store>, platform: Arc<dyn Platform>) -> Arc<Live> {
        let live = Arc::new_cyclic(|me| Live {
            me: me.clone(),
            daemon: daemon.clone(),
            store,
            platform,
            job: Mutex::new(Job::default()),
            last_release: Mutex::new(None),
            last_level: Mutex::new(None),
            context: Context::default(),
        });
        live.fill_snapshot();
        daemon.set_effects(live.clone());
        live.platform.start_engines(Reporter {
            daemon: daemon.clone(),
        });
        tokio::spawn(Arc::clone(&live).portals());
        live
    }

    fn arc(&self) -> Arc<Live> {
        self.me.upgrade().expect("the runtime outlives its tasks")
    }

    fn fill_snapshot(&self) {
        let settings = wire::settings(&self.store.settings());
        let history = self.history_page(&HistoryListParams::default());
        self.daemon.update(|s| {
            s.settings = Some(settings.clone());
            s.history = Some(history.clone());
            let d = &mut s.dictation;
            d.available = false;
            d.unavailable_reason = Some("The speech model is loading".into());
            d.stt = WorkerStatus {
                state: WorkerState::Starting,
                model: Some(settings.models.stt.clone()),
                device: None,
                error: None,
            };
            vec![
                Event::Settings { settings },
                Event::History { page: history },
                Event::Dictation { state: d.clone() },
            ]
        });
    }

    /// Binds the shortcut and opens the typing session, as the app does after
    /// first run. Opens no permission dialog before first run is done, and never
    /// binds while the app is running: on KDE both would get every press and the
    /// text would be typed twice.
    async fn portals(self: Arc<Self>) {
        if !self.store.state().first_run_done {
            let error = "Finish the first run in the Delulu Talks window first; until then the daemon opens no permission dialog.";
            eprintln!("delulud: first run is not done; not binding the shortcut");
            self.set_hotkey(HotkeyState {
                bound: false,
                trigger: None,
                error: Some(error.into()),
                problem: Some(HotkeyProblem::FirstRunPending),
            });
            self.set_insert(InsertState {
                ready: false,
                error: Some(error.into()),
            });
            return;
        }
        if self.platform.app_running().await {
            eprintln!(
                "delulud: the Delulu Talks app is running and holds the shortcut; binding it once the app quits"
            );
            self.set_hotkey(HotkeyState {
                bound: false,
                trigger: None,
                error: Some(
                    "The Delulu Talks app is running and holds the shortcut. Quit it (tray → Quit) and the daemon takes over."
                        .into(),
                ),
                problem: Some(HotkeyProblem::AppRunning),
            });
            self.platform.app_gone().await;
            eprintln!("delulud: the app has quit; binding the shortcut");
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        let keys = Arc::clone(&self);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                keys.key(event);
            }
        });
        let me = self.me.clone();
        let status = self
            .platform
            .bind_hotkey(
                tx,
                Box::new(move |status| {
                    if let Some(me) = me.upgrade() {
                        me.set_hotkey(wire::hotkey(status));
                    }
                }),
            )
            .await;
        self.set_hotkey(wire::hotkey(status));
        let insert = self.platform.prepare_insert().await;
        self.set_insert(wire::insert(insert));
    }

    fn set_hotkey(&self, state: HotkeyState) {
        let mut changed = false;
        self.daemon.update(|s| {
            if s.hotkey == state {
                return Vec::new();
            }
            changed = true;
            s.hotkey = state.clone();
            vec![Event::Hotkey {
                state: state.clone(),
            }]
        });
        if changed {
            match (&state.trigger, &state.error) {
                (Some(trigger), _) if state.bound => {
                    eprintln!("delulud: shortcut bound ({trigger})")
                }
                (_, Some(error)) => eprintln!("delulud: shortcut not bound: {error}"),
                _ => eprintln!("delulud: shortcut not bound"),
            }
        }
    }

    fn set_insert(&self, state: InsertState) {
        match &state.error {
            None if state.ready => eprintln!("delulud: typing allowed"),
            Some(error) => eprintln!("delulud: typing not ready: {error}"),
            None => {}
        }
        self.daemon.update(|s| {
            if s.insert == state {
                return Vec::new();
            }
            s.insert = state.clone();
            vec![Event::Insert { state }]
        });
    }

    fn key(&self, event: KeyEvent) {
        let now = Instant::now();
        if event == KeyEvent::Released && self.daemon.with_machine(|m| m.keys_down()) {
            *lock(&self.last_release) = Some(now);
        }
        let ready = self
            .daemon
            .read(|s| s.dictation.available || s.dictation.phase != DictationPhase::Idle);
        if !ready {
            if event != KeyEvent::Released {
                eprintln!("delulud: shortcut pressed, but dictation is not ready yet");
            }
            return;
        }
        let _ = self.daemon.input(Input::Key(event, now_ms()));
    }

    fn job(&self) -> MutexGuard<'_, Job> {
        lock(&self.job)
    }

    /// Changes the job's record only while `id` is still the current job.
    fn with_job<R>(&self, id: JobId, f: impl FnOnce(&mut Job) -> R) -> Option<R> {
        let mut job = self.job();
        (job.id == id).then(|| f(&mut job))
    }

    fn fail(&self, id: JobId, during: Phase, error: String, word: &'static str) {
        self.with_job(id, |j| j.failure_word = Some(word));
        let _ = self.daemon.input(Input::Failed {
            job: id,
            during,
            error,
        });
    }

    fn level(&self, id: JobId, rms: f32) {
        {
            let mut last = lock(&self.last_level);
            if last.is_some_and(|t| t.elapsed() < LEVEL_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        if self.job().pill {
            self.platform.pill_level(rms);
        }
        let level = delulu_overlay::audible_level(rms);
        self.daemon.update(|s| {
            if s.dictation.job != id || s.dictation.phase != DictationPhase::Recording {
                return Vec::new();
            }
            vec![Event::Level { level }]
        });
    }

    fn history_page(&self, params: &HistoryListParams) -> HistoryPage {
        let query = params.query.as_deref().filter(|q| !q.trim().is_empty());
        let limit = match params.limit {
            0 => HISTORY_PAGE,
            n => n.min(1000),
        } as usize;
        let offset = params.offset as usize;
        let all = self.store.history(query, usize::MAX);
        HistoryPage {
            query: query.map(str::to_owned),
            offset: params.offset,
            total: all.len() as u32,
            entries: all
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(wire::history_entry)
                .collect(),
        }
    }

    fn start_capture(&self, id: JobId) {
        let settings = self.store.settings();
        *self.job() = Job {
            id,
            pill: settings.overlay,
            ..Job::default()
        };
        self.daemon.with_machine(|m| {
            m.set_config(Config {
                cleanup: settings.cleanup,
            })
        });
        *lock(&self.last_level) = None;
        if settings.overlay {
            // Before the stream opens, so the first levels are not dropped.
            self.platform.pill(PillState::Listening, None);
        }
        let me = self.me.clone();
        let level = Box::new(move |rms| {
            if let Some(me) = me.upgrade() {
                me.level(id, rms);
            }
        });
        if let Err(error) = self
            .platform
            .start_capture(settings.microphone.as_deref(), level)
        {
            let word = if error.starts_with("microphone not found") {
                "No microphone"
            } else {
                "Mic error"
            };
            self.fail(id, Phase::Recording, error, word);
        }
    }

    fn transcribe(&self, id: JobId) {
        let was_held = self.daemon.with_machine(|m| m.keys_down());
        *lock(&self.last_release) = None;
        let pill = self.with_job(id, |j| {
            j.started = Some(Instant::now());
            j.was_held = was_held;
            j.pill
        });
        if pill == Some(true) {
            self.platform.pill(PillState::Transcribing, None);
        }
        let me = self.arc();
        tokio::spawn(async move {
            let samples = match me.stop_recording().await {
                Ok(samples) => samples,
                Err((word, error)) => return me.fail(id, Phase::Transcribing, error, word),
            };
            let settings = me.store.settings();
            match stop::transcribe_clip(&*me, &settings, samples).await {
                Ok(transcript) => {
                    let (text, language) = (transcript.text.clone(), transcript.language.clone());
                    me.with_job(id, |j| {
                        j.settings = Some(settings);
                        j.transcript = Some(transcript);
                    });
                    let _ = me.daemon.input(Input::Transcribed {
                        job: id,
                        text,
                        language,
                    });
                }
                Err(error) => me.fail(id, Phase::Transcribing, error, "Not transcribed"),
            }
        });
    }

    /// The settings and transcript the later stages work on.
    fn gathered(&self, id: JobId) -> Option<(Settings, Transcript)> {
        self.with_job(id, |j| Some((j.settings.clone()?, j.transcript.clone()?)))
            .flatten()
    }

    fn cleanup(&self, id: JobId) {
        let me = self.arc();
        tokio::spawn(async move {
            let Some((settings, transcript)) = me.gathered(id) else {
                return;
            };
            let cleaned = stop::clean_transcript(&*me, &settings, &transcript).await;
            let text = cleaned.text.clone();
            me.with_job(id, |j| j.cleaned = Some(cleaned));
            let _ = me.daemon.input(Input::Cleaned { job: id, text });
        });
    }

    fn insert(&self, id: JobId) {
        let me = self.arc();
        tokio::spawn(async move {
            let Some((settings, transcript)) = me.gathered(id) else {
                return;
            };
            let Some((cleaned, started, was_held)) = me.with_job(id, |j| {
                (
                    j.cleaned.take(),
                    j.started.unwrap_or_else(Instant::now),
                    j.was_held,
                )
            }) else {
                return;
            };
            // With cleanup off the machine skips the cleaning phase; the stage
            // still runs, so it skips cleanup and remembers the context, as the
            // app's stop path does.
            let cleaned = match cleaned {
                Some(cleaned) => cleaned,
                None => stop::clean_transcript(&*me, &settings, &transcript).await,
            };
            let request = StopRequest {
                started,
                was_held,
                log_text: stop::log_text(),
            };
            let (insert, entry, history_error) = match stop::deliver_and_save(
                &*me,
                settings,
                &request,
                &transcript,
                cleaned,
            )
            .await
            {
                StopOutcome::Delivered(event) => (event.insert, Some(event.entry), None),
                StopOutcome::Unsaved { insert, message } => (insert, None, Some(message)),
                // deliver_and_save ends in one of the two above.
                StopOutcome::NothingHeard | StopOutcome::Failed { .. } => return,
            };
            if let Some(error) = &history_error {
                eprintln!("delulud: dictation {id}: {error}");
            }
            me.with_job(id, |j| {
                j.entry = entry.map(wire::history_entry);
                j.history_error = history_error;
            });
            let input = match insert {
                InsertResult::Pasted => Input::Inserted {
                    job: id,
                    delivery: delulu_core::dictation::Delivery::Typed,
                },
                InsertResult::Copied { reason } => Input::Inserted {
                    job: id,
                    delivery: delulu_core::dictation::Delivery::Copied { reason },
                },
                InsertResult::Failed { reason } => {
                    return me.fail(id, Phase::Inserting, reason, "Not typed");
                }
            };
            let _ = me.daemon.input(input);
        });
    }
}

impl Effects for Live {
    fn run(&self, _daemon: &Daemon, effect: Effect) {
        match effect {
            Effect::StartCapture { job } => self.start_capture(job),
            Effect::Transcribe { job } => self.transcribe(job),
            Effect::Cleanup { job, .. } => self.cleanup(job),
            Effect::Insert { job, .. } => self.insert(job),
            Effect::DiscardCapture { .. } => self.platform.discard_capture(),
            // Engine work cannot be interrupted; its result is stale and dropped.
            Effect::CancelJob { .. } => {}
        }
    }

    fn record(&self, outcome: Outcome, now: u64) -> (DictationOutcome, Option<HistoryEntry>) {
        let mut job = self.job();
        let current = job.id == outcome_job(&outcome);
        let (entry, history_error, word) = if current {
            (
                job.entry.take(),
                job.history_error.take(),
                job.failure_word.take(),
            )
        } else {
            (None, None, None)
        };
        let pill = current && job.pill;
        drop(job);
        match &outcome {
            Outcome::Done { job, delivery, .. } => {
                if pill {
                    let word = match delivery {
                        delulu_core::dictation::Delivery::Copied { .. } => "Copied",
                        _ => "Typed",
                    };
                    self.platform.pill(PillState::Success, Some(word));
                }
                if entry.is_none() && history_error.is_none() {
                    eprintln!("delulud: dictation {job} done");
                }
            }
            Outcome::NothingHeard { job } => {
                eprintln!("delulud: dictation {job}: nothing heard");
                if pill {
                    self.platform.pill(PillState::Error, Some("Nothing heard"));
                }
            }
            Outcome::Cancelled { job, during } => {
                eprintln!("delulud: dictation {job} cancelled while {during:?}");
                if pill {
                    self.platform.pill(PillState::Hidden, None);
                }
            }
            Outcome::Failed {
                job, during, error, ..
            } => {
                eprintln!("delulud: dictation {job} failed while {during:?}: {error}");
                if pill {
                    let word = word.unwrap_or(match during {
                        Phase::Recording => "Mic error",
                        Phase::Inserting => "Not typed",
                        _ => "Not transcribed",
                    });
                    self.platform.pill(PillState::Error, Some(word));
                }
            }
        }
        let history_id = entry.as_ref().map(|e| e.id.clone());
        (
            wire::outcome(outcome, now, history_id, history_error),
            entry,
        )
    }

    fn history(&self, params: &HistoryListParams) -> Option<HistoryPage> {
        Some(self.history_page(params))
    }
}

fn outcome_job(outcome: &Outcome) -> JobId {
    match outcome {
        Outcome::Done { job, .. }
        | Outcome::NothingHeard { job }
        | Outcome::Cancelled { job, .. }
        | Outcome::Failed { job, .. } => *job,
    }
}

/// The stop path's view of the daemon.
impl StopPorts for Live {
    async fn stop_recording(&self) -> Recorded {
        let platform = Arc::clone(&self.platform);
        tokio::task::spawn_blocking(move || platform.stop_capture())
            .await
            .unwrap_or_else(|e| Err(("Mic error", e.to_string())))
    }
    fn settings(&self) -> Settings {
        self.store.settings()
    }
    fn whisper_prompt(&self) -> Option<String> {
        self.context.whisper_prompt(&self.store.vocabulary())
    }
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: Language,
        prompt: Option<String>,
    ) -> Result<Transcript, String> {
        self.platform.transcribe(samples, language, prompt).await
    }
    async fn clean(&self, language: &str, raw: String) -> Cleaned {
        let enabled = self.store.settings().cleanup;
        let vocabulary = if enabled {
            self.store.vocabulary().active_terms()
        } else {
            Vec::new()
        };
        self.platform
            .clean(enabled, language.to_owned(), raw, vocabulary)
            .await
    }
    fn remember(&self, topic: Option<String>, text: &str) {
        let generation = self.context.remember(topic, text);
        let me = self.me.clone();
        tokio::spawn(async move {
            tokio::time::sleep(EXPIRE).await;
            if let Some(me) = me.upgrade() {
                me.context.clear_if(Some(generation));
            }
        });
    }
    fn add_history(&self, entry: NewEntry) -> Result<delulu_store::HistoryEntry, String> {
        self.store.add_history(entry).map_err(|e| e.to_string())
    }
    async fn wait_release(&self) -> bool {
        stop::wait_release(
            || self.daemon.with_machine(|m| m.keys_down()),
            RELEASE_TIMEOUT,
        )
        .await
    }
    async fn deliver(&self, text: &str, mode: InsertMode, held: bool) -> InsertResult {
        self.platform.deliver(text.to_owned(), mode, held).await
    }
    fn last_release(&self) -> Option<Instant> {
        *lock(&self.last_release)
    }
    fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<delulu_store::HistoryEntry, String> {
        self.store
            .set_total_ms(id, total_ms)
            .map_err(|e| e.to_string())
    }
    fn log(&self, line: String) {
        eprintln!("{line}");
    }
}
