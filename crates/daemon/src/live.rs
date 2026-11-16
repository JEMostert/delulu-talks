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
use delulu_proto::api::{
    Acknowledged, ApiError, ErrorCode, Event, HistoryListParams, Permissions, Request,
    VocabularyChangeParams,
};
use delulu_proto::state::*;
use delulu_proto::APP_CLIENT;
use delulu_store::{InsertMode, NewEntry, Settings, Store};
use delulu_stt::{Language, Prompt, Transcript};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub use crate::server::BoxFuture;

/// How often a level event goes out while recording, at most.
const LEVEL_INTERVAL: Duration = Duration::from_millis(33);
/// How long delivery waits for the hotkey to come up before copying instead.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often the daemon checks whether the app still holds the shortcut.
const APP_CHECK_INTERVAL: Duration = Duration::from_secs(1);

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
        prompt: Option<Prompt>,
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
    /// The Delulu Talks app is running (its single-instance name is taken).
    /// It holds the shortcut itself unless it is connected as a client.
    fn app_running(&self) -> BoxFuture<'_, bool>;
    fn bind_hotkey(
        &self,
        events: mpsc::UnboundedSender<KeyEvent>,
        on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> BoxFuture<'_, HotkeyStatus>;
    fn prepare_insert(&self) -> BoxFuture<'_, InsertStatus>;
    /// Opens the desktop's shortcut settings. `None`: no shortcut is bound (an
    /// unbound session is closed), so the caller binds again instead.
    fn configure_hotkey(&self) -> BoxFuture<'_, Option<Result<(), String>>>;
    /// The settings changed: reload the speech model, start or stop cleanup,
    /// hide the pill, as needed.
    fn settings_changed(&self, old: &Settings, new: &Settings);
    /// Model files changed on disk: load what is there now.
    fn refresh_models(&self);
    /// `cleanup.start` (the user agreed to the download) and its cancel.
    fn start_cleanup(&self);
    fn cancel_cleanup(&self);
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
    /// One binding or permission request at a time.
    portals: tokio::sync::Mutex<()>,
    /// The microphone is open for the level meter (`mic.test`).
    mic_test: std::sync::atomic::AtomicBool,
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
            portals: tokio::sync::Mutex::new(()),
            mic_test: std::sync::atomic::AtomicBool::new(false),
        });
        live.fill_snapshot();
        daemon.set_effects(live.clone());
        live.platform.start_engines(Reporter {
            daemon: daemon.clone(),
        });
        let portals = Arc::clone(&live);
        tokio::spawn(async move {
            portals.bind_portals(false).await;
        });
        live
    }

    fn arc(&self) -> Arc<Live> {
        self.me.upgrade().expect("the runtime outlives its tasks")
    }

    fn fill_snapshot(&self) {
        let settings = wire::settings(&self.store.settings());
        let history = self.history_page(&HistoryListParams::default());
        let vocabulary = wire::vocabulary(&self.store.vocabulary());
        let setup = self.setup();
        self.daemon.update(|s| {
            s.settings = Some(settings.clone());
            s.history = Some(history.clone());
            s.vocabulary = Some(vocabulary.clone());
            s.setup = Some(setup);
            let d = &mut s.dictation;
            d.available = false;
            d.unavailable_reason = Some("The speech model is loading".into());
            d.stt = WorkerStatus {
                state: WorkerState::Starting,
                model: Some(settings.models.stt.clone()),
                device: None,
                error: None,
                progress: None,
            };
            vec![
                Event::Settings { settings },
                Event::History { page: history },
                Event::Vocabulary { vocabulary },
                Event::Dictation { state: d.clone() },
            ]
        });
    }

    /// Binds the shortcut and opens the typing session, as the app does after
    /// first run, unless already done. Opens no permission dialog before first
    /// run is done unless `asked` (the window's first-run step asks), and never
    /// binds while the app runs dictation itself: on KDE both would get every
    /// press and the text would be typed twice. A window connected as a client
    /// holds no shortcut.
    async fn bind_portals(self: &Arc<Self>, asked: bool) -> Permissions {
        let _one = self.portals.lock().await;
        let current = || self.daemon.read(|s| (s.hotkey.clone(), s.insert.clone()));
        if !asked && !self.store.state().first_run_done {
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
            let (hotkey, insert) = current();
            return Permissions { hotkey, insert };
        }
        let mut told = false;
        while self.platform.app_running().await && !self.daemon.has_client(APP_CLIENT) {
            if !told {
                told = true;
                eprintln!(
                    "delulud: the Delulu Talks app is running; binding the shortcut once it quits or connects as a client"
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
            }
            tokio::time::sleep(APP_CHECK_INTERVAL).await;
        }
        if told {
            eprintln!("delulud: the app quit or connected as a client; binding the shortcut");
        }
        if !self.daemon.read(|s| s.hotkey.bound) {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let keys = Arc::clone(self);
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
        }
        if !self.daemon.read(|s| s.insert.ready) {
            let insert = self.platform.prepare_insert().await;
            self.set_insert(wire::insert(insert));
        }
        let (hotkey, insert) = current();
        Permissions { hotkey, insert }
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

    /// The stop path's ports for one job.
    fn ports(&self, id: JobId) -> JobPorts<'_> {
        JobPorts {
            live: self,
            id,
            delivering: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Feeds a failure from a task. Effects call this through a spawned task,
    /// never directly: `Daemon::input` is not re-entrant.
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

    fn setup(&self) -> Setup {
        Setup {
            first_run_done: self.store.state().first_run_done,
            cleanup_model_ok: self.store.settings().cleanup_model_ok,
        }
    }

    fn publish_history(&self) {
        let page = self.history_page(&HistoryListParams::default());
        self.daemon.update(|s| {
            s.history = Some(page.clone());
            vec![Event::History { page }]
        });
    }

    fn publish_settings(&self, settings: &delulu_store::Settings) -> delulu_proto::state::Settings {
        let wire = wire::settings(settings);
        let setup = self.setup();
        self.daemon.update(|s| {
            s.settings = Some(wire.clone());
            s.setup = Some(setup);
            vec![Event::Settings {
                settings: wire.clone(),
            }]
        });
        wire
    }

    /// The methods beyond dictation, for the window.
    async fn serve(self: Arc<Self>, request: Request) -> Result<Value, ApiError> {
        let failed = |e: String| ApiError::new(ErrorCode::Internal, e);
        let busy = || ApiError::new(ErrorCode::Busy, "Wait for the dictation to finish");
        let idle = || {
            self.daemon
                .read(|s| s.dictation.phase == DictationPhase::Idle)
        };
        match request {
            Request::HistoryDelete(params) => {
                self.store
                    .delete_history(&params.id)
                    .map_err(|e| failed(e.to_string()))?;
                self.publish_history();
                to_value(Acknowledged {})
            }
            Request::HistoryClear(_) => {
                self.store
                    .clear_history()
                    .map_err(|e| failed(e.to_string()))?;
                self.publish_history();
                to_value(Acknowledged {})
            }
            Request::HistoryReinsert(params) => {
                let entry = self.store.history_entry(&params.id).ok_or_else(|| {
                    ApiError::new(ErrorCode::InvalidParams, "Transcript not found")
                })?;
                let text = match (params.raw, entry.raw) {
                    (true, Some(raw)) => raw,
                    _ => entry.text,
                };
                let mode = self.store.settings().insert;
                match self.platform.deliver(text, mode, false).await {
                    InsertResult::Pasted => to_value(Delivery::Typed),
                    InsertResult::Copied { reason } => to_value(Delivery::Copied { reason }),
                    InsertResult::Failed { reason } => Err(failed(reason)),
                }
            }
            Request::SettingsSet(params) => {
                let old = self.store.settings();
                let mut new = old.clone();
                wire::apply_settings(&params.settings, &mut new);
                if old.model != new.model && !idle() {
                    return Err(busy());
                }
                self.store
                    .save_settings(&new)
                    .map_err(|e| failed(e.to_string()))?;
                if !new.smart_context {
                    self.context.clear_if(None);
                }
                self.platform.settings_changed(&old, &new);
                to_value(self.publish_settings(&new))
            }
            Request::SetupFinish(_) => {
                let mut state = self.store.state();
                state.first_run_done = true;
                self.store
                    .save_state(&state)
                    .map_err(|e| failed(e.to_string()))?;
                // The first-run model step disclosed the cleanup download.
                let old = self.store.settings();
                let mut new = old.clone();
                new.cleanup_model_ok = true;
                self.store
                    .save_settings(&new)
                    .map_err(|e| failed(e.to_string()))?;
                self.publish_settings(&new);
                self.platform.settings_changed(&old, &new);
                let me = Arc::clone(&self);
                tokio::spawn(async move {
                    me.bind_portals(false).await;
                });
                to_value(self.setup())
            }
            Request::VocabularyGet(_) => to_value(wire::vocabulary(&self.store.vocabulary())),
            Request::VocabularyChange(change) => {
                let (_, vocabulary) = self
                    .store
                    .update_vocabulary(|v| match change {
                        VocabularyChangeParams::AddShelf { name } => v.add_shelf(&name).map(|_| ()),
                        VocabularyChangeParams::AddPreset { key } => v.add_preset(&key).map(|_| ()),
                        VocabularyChangeParams::RenameShelf { id, name } => {
                            v.rename_shelf(&id, &name)
                        }
                        VocabularyChangeParams::DeleteShelf { id } => {
                            v.delete_shelf(&id);
                            Ok(())
                        }
                        VocabularyChangeParams::SetEnabled { id, enabled } => {
                            v.set_enabled(&id, enabled)
                        }
                        VocabularyChangeParams::AddTerms { id, text } => {
                            v.add_terms(&id, &text).map(|_| ())
                        }
                        VocabularyChangeParams::RemoveTerm { id, term } => {
                            v.remove_term(&id, &term)
                        }
                    })
                    .map_err(|e| ApiError::new(ErrorCode::InvalidParams, e.to_string()))?;
                let vocabulary = wire::vocabulary(&vocabulary);
                self.daemon.update(|s| {
                    s.vocabulary = Some(vocabulary.clone());
                    vec![Event::Vocabulary {
                        vocabulary: vocabulary.clone(),
                    }]
                });
                to_value(vocabulary)
            }
            Request::CleanupStart(_) => {
                let mut settings = self.store.settings();
                if !settings.cleanup_model_ok {
                    settings.cleanup_model_ok = true;
                    self.store
                        .save_settings(&settings)
                        .map_err(|e| failed(e.to_string()))?;
                    self.publish_settings(&settings);
                }
                self.platform.start_cleanup();
                to_value(Acknowledged {})
            }
            Request::CleanupCancel(_) => {
                self.platform.cancel_cleanup();
                to_value(Acknowledged {})
            }
            Request::MicTest(params) => {
                use std::sync::atomic::Ordering;
                if !params.on {
                    if self.mic_test.swap(false, Ordering::SeqCst) {
                        self.platform.discard_capture();
                    }
                    return to_value(Acknowledged {});
                }
                if !idle() {
                    return Err(ApiError::new(ErrorCode::Busy, "Dictation is in progress"));
                }
                if self.mic_test.swap(true, Ordering::SeqCst) {
                    return to_value(Acknowledged {});
                }
                let me = self.me.clone();
                let level = Box::new(move |rms| {
                    if let Some(me) = me.upgrade() {
                        me.test_level(rms);
                    }
                });
                let device = self.store.settings().microphone;
                if let Err(e) = self.platform.start_capture(device.as_deref(), level) {
                    self.mic_test.store(false, Ordering::SeqCst);
                    return Err(failed(e));
                }
                to_value(Acknowledged {})
            }
            Request::PermissionsRequest(_) => to_value(self.bind_portals(true).await),
            Request::HotkeyConfigure(_) => match self.platform.configure_hotkey().await {
                Some(result) => result
                    .map_err(failed)
                    .and_then(|()| to_value(Acknowledged {})),
                None => {
                    // Skipped or declined before: bind again.
                    self.set_hotkey(HotkeyState {
                        bound: false,
                        trigger: None,
                        error: None,
                        problem: Some(HotkeyProblem::NotSet),
                    });
                    self.bind_portals(true).await;
                    to_value(Acknowledged {})
                }
            },
            Request::ModelsRefresh(_) => {
                self.platform.refresh_models();
                to_value(Acknowledged {})
            }
            other => Err(ApiError::new(
                ErrorCode::NotAvailable,
                format!("{} is not served by the dictation runtime", other.method()),
            )),
        }
    }

    /// The level meter outside dictation (first run, Settings).
    fn test_level(&self, rms: f32) {
        {
            let mut last = lock(&self.last_level);
            if last.is_some_and(|t| t.elapsed() < LEVEL_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        let level = delulu_overlay::audible_level(rms);
        self.daemon.update(|s| {
            if s.dictation.phase != DictationPhase::Idle {
                return Vec::new();
            }
            vec![Event::Level { level }]
        });
    }

    fn start_capture(&self, id: JobId) {
        // Dictation takes the microphone from the level meter.
        if self
            .mic_test
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            self.platform.discard_capture();
        }
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
            let me = self.arc();
            tokio::spawn(async move { me.fail(id, Phase::Recording, error, word) });
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
        // Here, not in the task: effects run in order, so no later start can
        // meet this recording still open, and no stale stop can end a newer one.
        let recorded = self.platform.stop_capture();
        let me = self.arc();
        tokio::spawn(async move {
            let samples = match recorded {
                Ok(samples) => samples,
                Err((word, error)) => return me.fail(id, Phase::Transcribing, error, word),
            };
            let settings = me.store.settings();
            match stop::transcribe_clip(&me.ports(id), &settings, samples).await {
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
            let cleaned = stop::clean_transcript(&me.ports(id), &settings, &transcript).await;
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
                None => stop::clean_transcript(&me.ports(id), &settings, &transcript).await,
            };
            let request = StopRequest {
                started,
                was_held,
                log_text: stop::log_text(),
            };
            let ports = me.ports(id);
            let outcome =
                stop::deliver_and_save(&ports, settings, &request, &transcript, cleaned).await;
            if !ports.inserting() {
                if ports.delivering.load(std::sync::atomic::Ordering::SeqCst) {
                    // Too late to stop: the text was being typed when the cancel
                    // came, so it stays in History.
                    eprintln!("delulud: dictation {id} was cancelled while it was being delivered; it is kept in History");
                } else {
                    // Cancelled while waiting for the hotkey to come up: nothing
                    // was typed, and the entry saved just before goes too.
                    if let StopOutcome::Delivered(event) = &outcome {
                        if let Err(e) = me.store.delete_history(&event.entry.id) {
                            eprintln!("delulud: remove the cancelled dictation from History: {e}");
                        }
                    }
                    eprintln!("delulud: dictation {id} was cancelled before it was delivered");
                }
                return;
            }
            let (insert, entry, history_error) = match outcome {
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

    fn call(&self, request: Request) -> Option<BoxFuture<'static, Result<Value, ApiError>>> {
        Some(Box::pin(self.arc().serve(request)))
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

/// The stop path's view of the daemon, for one job.
struct JobPorts<'a> {
    live: &'a Live,
    id: JobId,
    /// Delivery got past the cancel check. Typing cannot be taken back, so from
    /// then on a cancel no longer undoes the History entry.
    delivering: std::sync::atomic::AtomicBool,
}

impl JobPorts<'_> {
    /// The job is still the one being delivered: not cancelled, not replaced.
    /// Checked before each step that leaves a trace (History, typing).
    fn inserting(&self) -> bool {
        self.live
            .daemon
            .with_machine(|m| m.job() == self.id && m.phase() == Phase::Inserting)
    }
}

const CANCELLED: &str = "the dictation was cancelled";

impl StopPorts for JobPorts<'_> {
    // The daemon stops the recorder in the Transcribe effect; the stages never
    // call this. It is here for the trait.
    async fn stop_recording(&self) -> Recorded {
        let platform = Arc::clone(&self.live.platform);
        tokio::task::spawn_blocking(move || platform.stop_capture())
            .await
            .unwrap_or_else(|e| Err(("Mic error", e.to_string())))
    }
    fn settings(&self) -> Settings {
        self.live.store.settings()
    }
    fn whisper_prompt(&self) -> Option<Prompt> {
        self.live
            .context
            .whisper_prompt(&self.live.store.vocabulary())
    }
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: Language,
        prompt: Option<Prompt>,
    ) -> Result<Transcript, String> {
        self.live
            .platform
            .transcribe(samples, language, prompt)
            .await
    }
    async fn clean(&self, language: &str, raw: String) -> Cleaned {
        let enabled = self.live.store.settings().cleanup;
        let vocabulary = if enabled {
            self.live.store.vocabulary().active_terms()
        } else {
            Vec::new()
        };
        self.live
            .platform
            .clean(enabled, language.to_owned(), raw, vocabulary)
            .await
    }
    fn remember(&self, topic: Option<String>, text: &str) {
        let generation = self.live.context.remember(topic, text);
        let me = self.live.me.clone();
        tokio::spawn(async move {
            tokio::time::sleep(EXPIRE).await;
            if let Some(me) = me.upgrade() {
                me.context.clear_if(Some(generation));
            }
        });
    }
    fn add_history(&self, entry: NewEntry) -> Result<delulu_store::HistoryEntry, String> {
        if !self.inserting() {
            return Err(CANCELLED.into());
        }
        self.live
            .store
            .add_history(entry)
            .map_err(|e| e.to_string())
    }
    async fn wait_release(&self) -> bool {
        stop::wait_release(
            || self.live.daemon.with_machine(|m| m.keys_down()),
            RELEASE_TIMEOUT,
        )
        .await
    }
    async fn deliver(&self, text: &str, mode: InsertMode, held: bool) -> InsertResult {
        if !self.inserting() {
            return InsertResult::Failed {
                reason: CANCELLED.into(),
            };
        }
        self.delivering
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.live
            .platform
            .deliver(text.to_owned(), mode, held)
            .await
    }
    fn last_release(&self) -> Option<Instant> {
        *lock(&self.live.last_release)
    }
    fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<delulu_store::HistoryEntry, String> {
        self.live
            .store
            .set_total_ms(id, total_ms)
            .map_err(|e| e.to_string())
    }
    fn log(&self, line: String) {
        eprintln!("{line}");
    }
}

fn to_value(value: impl serde::Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}
