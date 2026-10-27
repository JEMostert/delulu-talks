//! The voice runtime, its worker and the speech queue (`electron/services/voice.ts`).
//!
//! Utterances are spoken one at a time; each is split into chunks so the
//! first sentence plays while the next is synthesized. Playback is native
//! ([`delulu_audio::Player`]) instead of the renderer's Web Audio, so the
//! `voice:play` / `voice:playback` IPC round trip is gone: the player reports
//! per-chunk events straight back to [`VoiceService::playback_event`].

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use base64::Engine as _;
use delulu_audio::{PlaybackChunk, PlaybackEvent, PlaybackEventKind, Player};
use delulu_core::util::{truncate_utf16, utf16_len};
use delulu_core::{now_ms, uuid, AppPaths, DomainError, DomainErrorCode, DomainResult};
use delulu_domain::js;
use delulu_domain::voice::chunks::{plan_voice_chunks, ChunkOptions, VoiceChunk};
use delulu_domain::voice::markup::parse_voice_markup;
use delulu_domain::voice::speakable::speakable_text;
use delulu_domain::voice::{
    voice_engine_info, VoiceBridgeStatus, VoiceCurrentUtterance, VoiceEngineId, VoicePhase, VoiceQueued, VoiceSource,
    VoiceSpeakRequest, VoiceSpeakResult, VoiceStatus, VoiceSynthesizeRequest, VoiceSynthesizeResult, VoiceTimestamp,
    VoiceUtteranceOutcome, VoiceUtteranceSummary, VOICE_LIMITS,
};
use delulu_domain::{AppSettings, EnginePhase, ModelResidency, RuntimeLifecycle, SetupStage, SetupState, WarmupState};
use delulu_runtime::installer::InstallProgress;
use delulu_runtime::protocol::WorkerProgress;
use delulu_runtime::setup_log::FinalOutcome;
use delulu_runtime::worker::worker_script;
use delulu_runtime::{
    runtime_environment, ChildEnv, InstallSettings, InstallerPaths, RuntimeInstaller, RuntimeKind, RuntimeSetupKind,
    RuntimeSetupLog, WorkerClient, WorkerClientOptions, WorkerConfig,
};
use futures::future::{FutureExt, Shared};
use parking_lot::{Mutex, ReentrantMutex};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::host::{BoxFuture, VoiceProfile};

/* ------------------------------------------------------------------ */
/* Seams                                                               */
/* ------------------------------------------------------------------ */

/// The worker surface the service uses; tests substitute a fake.
pub trait VoiceWorker: Send + Sync {
    fn request(&self, command: &str, payload: Value, timeout: Option<Duration>) -> BoxFuture<'static, DomainResult<Value>>;
    fn stop_and_wait(&self) -> BoxFuture<'static, ()>;
    fn running(&self) -> bool;
    fn busy(&self) -> bool;
}

impl VoiceWorker for WorkerClient {
    fn request(&self, command: &str, payload: Value, timeout: Option<Duration>) -> BoxFuture<'static, DomainResult<Value>> {
        Box::pin(WorkerClient::request(self, command, payload, timeout))
    }
    fn stop_and_wait(&self) -> BoxFuture<'static, ()> {
        let client = self.clone();
        Box::pin(async move { client.stop_and_wait(None).await })
    }
    fn running(&self) -> bool {
        WorkerClient::running(self)
    }
    fn busy(&self) -> bool {
        WorkerClient::busy(self)
    }
}

/// Where synthesized chunks go (the TypeScript `VoicePlayback`).
pub trait VoicePlayback: Send + Sync {
    /// Returns false when nothing can play audio right now.
    fn play(&self, chunk: PlaybackChunk) -> bool;
    fn stop(&self, utterance_id: Option<&str>);
}

impl VoicePlayback for Player {
    fn play(&self, chunk: PlaybackChunk) -> bool {
        Player::play(self, chunk);
        true
    }
    fn stop(&self, utterance_id: Option<&str>) {
        Player::stop(self, utterance_id);
    }
}

pub type ReadyCheck = Arc<dyn Fn(&AppSettings) -> bool + Send + Sync>;

/// Test seams (the TypeScript constructor `overrides`).
#[derive(Default, Clone)]
pub struct VoiceOptions {
    pub worker: Option<Arc<dyn VoiceWorker>>,
    pub ready: Option<ReadyCheck>,
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const RECENT_LIMIT: usize = 20;
/// Synthesize at most this many chunks ahead of the one being heard.
const LOOKAHEAD: usize = 2;
/// Fallback when playback never reports a chunk's end.
const PLAYBACK_GRACE_MS: f64 = 4_000.0;
const NO_PLAYBACK: &str = "Open Delulu Talks once so it can play audio, then try again.";
/// The first sentence is its own chunk, so audio starts as soon as it is
/// synthesized; later chunks stay short enough to be ready before the one
/// playing ends.
const CHUNKS: ChunkOptions = ChunkOptions { first_chunk_characters: Some(1), chunk_characters: Some(140) };

type SharedTask<T> = Shared<BoxFuture<'static, T>>;

struct PendingChunk {
    resolve: oneshot::Sender<()>,
    timer: Option<JoinHandle<()>>,
}

impl PendingChunk {
    fn settle(self) {
        if let Some(timer) = self.timer {
            timer.abort();
        }
        let _ = self.resolve.send(());
    }
}

struct Utterance {
    id: String,
    at: u64,
    source: VoiceSource,
    agent: Option<String>,
    text: String,
    chunks: Vec<VoiceChunk>,
    warnings: Vec<String>,
    unsupported: Vec<String>,
    timestamps: Vec<VoiceTimestamp>,
    cursor_ms: f64,
    /// Chunks playback reported as started and not yet ended.
    playing: Vec<u32>,
    pending: HashMap<u32, PendingChunk>,
    /// Highest chunk index playback has started.
    heard: i64,
    /// When the audio sent so far should have finished playing (epoch ms).
    play_end_at: f64,
    outcome: VoiceUtteranceOutcome,
    response_id: String,
    cancelled: bool,
    /// Cut off by the user talking over it, rather than stopped.
    interrupted: bool,
    error: Option<String>,
    finish: Option<oneshot::Sender<VoiceSpeakResult>>,
}

impl Utterance {
    fn settle_pending(&mut self) {
        for (_, pending) in self.pending.drain() {
            pending.settle();
        }
        self.playing.clear();
    }
}

/// A set that forgets its oldest entries.
struct BoundedSet {
    items: VecDeque<String>,
    limit: usize,
}

impl BoundedSet {
    fn add(&mut self, value: &str) {
        self.items.retain(|item| item != value);
        self.items.push_back(value.to_owned());
        if self.items.len() > self.limit {
            self.items.pop_front();
        }
    }
    fn has(&self, value: &str) -> bool {
        self.items.iter().any(|item| item == value)
    }
}

struct SetupOperation {
    id: u64,
    token: CancellationToken,
    started: Arc<AtomicBool>,
    done: SharedTask<DomainResult<()>>,
}

struct State {
    status: VoiceStatus,
    queue: VecDeque<Utterance>,
    current: Option<Utterance>,
    draining: bool,
    recent: Vec<VoiceUtteranceSummary>,
    spoken_text: Vec<(String, u64)>,
    /// Utterances stopped or interrupted; late audio for them is dropped.
    rejected: BoundedSet,
    setup: Option<SetupOperation>,
    loading: Option<(u64, SharedTask<DomainResult<()>>)>,
    unloading: Option<SharedTask<()>>,
    loaded_engine: Option<VoiceEngineId>,
    idle_timer: Option<JoinHandle<()>>,
    shutting_down: bool,
    bridge: VoiceBridgeStatus,
}

type Listener = Arc<dyn Fn(&VoiceStatus) + Send + Sync>;

struct Inner {
    profile: Arc<dyn VoiceProfile>,
    paths: AppPaths,
    playback: Arc<dyn VoicePlayback>,
    installer: Arc<RuntimeInstaller>,
    worker: Arc<dyn VoiceWorker>,
    ready: Option<ReadyCheck>,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    publishing: ReentrantMutex<()>,
    listeners: Mutex<Vec<Listener>>,
    ids: AtomicU64,
}

/// Forwards native player events to the service that owns the player.
#[derive(Clone)]
pub struct PlaybackEvents {
    inner: Weak<Inner>,
}

impl PlaybackEvents {
    pub fn deliver(&self, event: PlaybackEvent) {
        if let Some(inner) = self.inner.upgrade() {
            VoiceService { inner }.playback_event(event);
        }
    }
}

/// A queued utterance; `done` resolves when it is spoken, stopped or failed.
pub struct SpeakHandle {
    pub queued: VoiceQueued,
    done: oneshot::Receiver<VoiceSpeakResult>,
    id: String,
    response_id: String,
}

impl SpeakHandle {
    pub async fn done(self) -> VoiceSpeakResult {
        let (id, response_id) = (self.id, self.response_id);
        self.done.await.unwrap_or_else(|_| VoiceSpeakResult {
            id,
            response_id,
            outcome: VoiceUtteranceOutcome::Stopped,
            duration_ms: 0.0,
            timestamps: Vec::new(),
            warnings: Vec::new(),
            unsupported: Vec::new(),
            error: None,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStatus {
    #[serde(default)]
    loaded: bool,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    residency: Option<ModelResidency>,
    #[serde(default)]
    warmup: Option<WarmupState>,
}

fn voice_error(code: DomainErrorCode, message: impl Into<String>, operation: &str) -> DomainError {
    DomainError::new(code, message).with_operation(uuid(), operation)
}

fn plain(message: impl Into<String>) -> DomainError {
    DomainError::failed(message).with_cause("Error", None)
}

fn model_setup_stage(stage: &str) -> Option<SetupStage> {
    match stage {
        "download" => Some(SetupStage::ModelDownload),
        "load" => Some(SetupStage::ModelLoad),
        "warmup" => Some(SetupStage::Warmup),
        _ => None,
    }
}

/// Collapse whitespace and truncate for display (`summary`).
pub(crate) fn summary(text: &str, limit: usize) -> String {
    let clean = text.split(js::is_whitespace).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    if utf16_len(&clean) > limit {
        format!("{}…", truncate_utf16(&clean, limit - 1))
    } else {
        clean
    }
}

/// Converts between the identical wire shapes of two crates.
fn convert<T: serde::Serialize, U: DeserializeOwned>(value: &T) -> Option<U> {
    serde_json::to_value(value).ok().and_then(|value| serde_json::from_value(value).ok())
}

fn runtime_engine(engine: VoiceEngineId) -> delulu_runtime::types::VoiceEngineId {
    match engine {
        VoiceEngineId::Kokoro => delulu_runtime::types::VoiceEngineId::Kokoro,
        VoiceEngineId::ChatterboxTurbo => delulu_runtime::types::VoiceEngineId::ChatterboxTurbo,
    }
}

fn engine_name(engine: VoiceEngineId) -> &'static str {
    voice_engine_info(engine).name
}

fn unsupported_runtime(settings: &AppSettings) -> String {
    format!("{} needs a runtime update", engine_name(settings.voice_engine))
}

fn initial_status() -> VoiceStatus {
    VoiceStatus {
        lifecycle: RuntimeLifecycle {
            residency: Some(ModelResidency::Unloaded),
            warmup: Some(WarmupState::NotStarted),
            ..RuntimeLifecycle::default()
        },
        engine: EnginePhase::Missing,
        phase: VoicePhase::Idle,
        message: "Siren setup required".into(),
        detail: None,
        progress: None,
        setup_stage: None,
        setup_state: None,
        download_bytes: None,
        failure: None,
        migration_required: None,
        model: None,
        current: None,
        queued: 0,
        recent: Vec::new(),
        bridge: VoiceBridgeStatus { enabled: false, listening: false, clients: 0, endpoint: None, error: None },
    }
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

/// Owns the voice runtime, its worker and the speech queue. Cheap to clone.
/// Construct inside a Tokio runtime; work is spawned on it.
#[derive(Clone)]
pub struct VoiceService {
    inner: Arc<Inner>,
}

impl VoiceService {
    /// A service that plays through `playback`; feed its events to
    /// [`playback_event`](Self::playback_event).
    pub fn new(profile: Arc<dyn VoiceProfile>, playback: Arc<dyn VoicePlayback>, options: VoiceOptions) -> Self {
        Self::build(profile, |_| playback, options)
    }

    /// A service that plays through a native [`Player`]; the player is also
    /// returned so listening sessions can use it as their echo reference.
    pub fn with_player(profile: Arc<dyn VoiceProfile>, options: VoiceOptions) -> (Self, Player) {
        let mut created = None;
        let service = Self::build(
            profile,
            |events| {
                let player = Player::new(move |event| events.deliver(event));
                created = Some(player.clone());
                Arc::new(player)
            },
            options,
        );
        (service, created.expect("player is created during construction"))
    }

    fn build(
        profile: Arc<dyn VoiceProfile>,
        playback: impl FnOnce(PlaybackEvents) -> Arc<dyn VoicePlayback>,
        options: VoiceOptions,
    ) -> Self {
        let paths = profile.paths().clone();
        let runtime = tokio::runtime::Handle::current();
        let inner = Arc::new_cyclic(|weak: &Weak<Inner>| {
            let installer_slot: Arc<OnceLock<Weak<RuntimeInstaller>>> = Arc::new(OnceLock::new());
            let env_paths = paths.clone();
            let env_slot = installer_slot.clone();
            let installer = Arc::new(RuntimeInstaller::new(
                InstallerPaths {
                    data_directory: paths.data.clone(),
                    venv_directory: paths.voice_venv(),
                    kind: Some(RuntimeKind::Voice),
                },
                None,
                move || environment(&env_paths, env_slot.get().and_then(Weak::upgrade).as_deref()),
            ));
            let _ = installer_slot.set(Arc::downgrade(&installer));
            let worker = options.worker.clone().unwrap_or_else(|| {
                let config_installer = installer.clone();
                let config_paths = paths.clone();
                let failed = weak.clone();
                let progressed = weak.clone();
                let client = WorkerClient::with_options(
                    move || {
                        Ok(WorkerConfig {
                            python: config_installer.python()?,
                            script: worker_script(&config_paths),
                            env: environment(&config_paths, Some(&config_installer)),
                        })
                    },
                    move |error| {
                        if let Some(inner) = failed.upgrade() {
                            let service = VoiceService { inner };
                            if !service.setup_aborted() {
                                service.fail(&error);
                            }
                        }
                    },
                    WorkerClientOptions {
                        on_progress: Some(Arc::new(move |detail: &str, event: &WorkerProgress| {
                            if let Some(inner) = progressed.upgrade() {
                                VoiceService { inner }.worker_progress(detail, event);
                            }
                        })),
                        ..WorkerClientOptions::default()
                    },
                )
                .expect("default worker limits are valid");
                Arc::new(client)
            });
            Inner {
                profile,
                paths: paths.clone(),
                playback: playback(PlaybackEvents { inner: weak.clone() }),
                installer,
                worker,
                ready: options.ready,
                runtime,
                state: Mutex::new(State {
                    status: initial_status(),
                    queue: VecDeque::new(),
                    current: None,
                    draining: false,
                    recent: Vec::new(),
                    spoken_text: Vec::new(),
                    rejected: BoundedSet { items: VecDeque::new(), limit: 200 },
                    setup: None,
                    loading: None,
                    unloading: None,
                    loaded_engine: None,
                    idle_timer: None,
                    shutting_down: false,
                    bridge: initial_status().bridge,
                }),
                publishing: ReentrantMutex::new(()),
                listeners: Mutex::new(Vec::new()),
                ids: AtomicU64::new(1),
            }
        });
        Self { inner }
    }

    fn settings(&self) -> AppSettings {
        self.inner.profile.settings()
    }

    fn next_id(&self) -> u64 {
        self.inner.ids.fetch_add(1, Ordering::Relaxed)
    }

    fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(&self, future: F) {
        self.inner.runtime.spawn(future);
    }

    /* -------------------------------------------------------------- */
    /* Status                                                          */
    /* -------------------------------------------------------------- */

    /// Called with every status change (`voice:statusChanged`).
    pub fn on_status(&self, listener: impl Fn(&VoiceStatus) + Send + Sync + 'static) {
        self.inner.listeners.lock().push(Arc::new(listener));
    }

    pub fn get_status(&self) -> VoiceStatus {
        self.inner.state.lock().status.clone()
    }

    pub fn get_setup_log(&self) -> RuntimeSetupLog {
        self.inner.installer.setup_log.lock().snapshot(RuntimeSetupKind::Voice)
    }

    pub fn is_speaking(&self) -> bool {
        let state = self.inner.state.lock();
        state.current.is_some() || !state.queue.is_empty()
    }

    pub fn is_busy(&self) -> bool {
        {
            let state = self.inner.state.lock();
            if state.setup.is_some() || state.loading.is_some() {
                return true;
            }
        }
        self.inner.worker.busy() || self.is_speaking()
    }

    pub fn set_bridge_status(&self, bridge: VoiceBridgeStatus) {
        self.inner.state.lock().bridge = bridge;
        self.update(None, |_| {});
    }

    fn setup_aborted(&self) -> bool {
        self.inner.state.lock().setup.as_ref().is_some_and(|setup| setup.token.is_cancelled())
    }

    /// Applies a patch and publishes. `engine` mirrors `patch.engine`: when
    /// set (and not `error`) it clears the failure, and `unloaded`/`missing`
    /// reset residency, warmup, device, model and setup stage first.
    fn update(&self, engine: Option<EnginePhase>, patch: impl FnOnce(&mut VoiceStatus)) {
        let _order = self.inner.publishing.lock();
        let snapshot = {
            let mut state = self.inner.state.lock();
            apply(&mut state, engine, patch);
            state.status.clone()
        };
        let listeners: Vec<Listener> = self.inner.listeners.lock().clone();
        for listener in listeners {
            listener(&snapshot);
        }
    }

    /* -------------------------------------------------------------- */
    /* Runtime                                                         */
    /* -------------------------------------------------------------- */

    fn worker_progress(&self, detail: &str, event: &WorkerProgress) {
        if self.setup_aborted() || event.command != "voiceLoad" {
            return;
        }
        let stage = model_setup_stage(&event.stage);
        let warmup = event.stage == "warmup";
        let bytes = event.download_bytes.as_ref().and_then(convert);
        let detail = detail.to_owned();
        self.update(None, move |status| {
            status.detail = Some(detail);
            if let Some(stage) = stage {
                status.setup_stage = Some(stage);
                status.progress = None;
            }
            if warmup {
                status.lifecycle.residency = Some(ModelResidency::Resident);
                status.lifecycle.warmup = Some(WarmupState::Warming);
            }
            status.download_bytes = bytes;
        });
    }

    pub async fn is_environment_ready(&self, settings: &AppSettings) -> bool {
        if let Some(ready) = &self.inner.ready {
            return ready(settings);
        }
        let profile = delulu_runtime::platform::voice_runtime_profile(runtime_engine(settings.voice_engine));
        self.inner.installer.ready(RuntimeKind::Voice, profile).await.unwrap_or(false)
    }

    fn runtime_installed(&self) -> bool {
        self.inner.installer.python().map(|python| python.exists()).unwrap_or(false)
    }

    pub async fn initialize(&self, settings: &AppSettings) {
        self.inner.state.lock().shutting_down = false;
        self.update(Some(EnginePhase::Unloaded), |status| {
            status.message = "Checking Siren…".into();
        });
        let ready = self.is_environment_ready(settings).await;
        if self.inner.state.lock().setup.is_some() {
            return;
        }
        let installed = self.runtime_installed();
        if ready {
            self.update(Some(EnginePhase::Unloaded), |status| {
                status.message = "Siren ready — the engine loads when something is said".into();
                status.migration_required = Some(false);
            });
        } else {
            let message = if installed { unsupported_runtime(settings) } else { "Siren setup required".into() };
            self.update(Some(EnginePhase::Missing), |status| {
                status.message = message;
                status.migration_required = Some(installed);
            });
        }
        if ready && settings.voice_enabled && settings.voice_keep_loaded {
            let this = self.clone();
            let settings = settings.clone();
            self.spawn(async move {
                if let Err(error) = this.load(&settings).await {
                    this.fail(&error);
                }
            });
        }
    }

    /// Re-check the runtime after the engine changes, so setup is offered when needed.
    pub async fn refresh_environment(&self, settings: &AppSettings) {
        let blocked = |this: &Self| {
            let state = this.inner.state.lock();
            state.setup.is_some() || state.shutting_down
        };
        if blocked(self) {
            return;
        }
        let ready = self.is_environment_ready(settings).await;
        if blocked(self) {
            return;
        }
        if !ready {
            let installed = self.runtime_installed();
            let message = if installed { unsupported_runtime(settings) } else { "Siren setup required".into() };
            self.update(Some(EnginePhase::Missing), |status| {
                status.message = message;
                status.migration_required = Some(installed);
                status.progress = None;
            });
        } else if self.get_status().engine == EnginePhase::Missing {
            self.update(Some(EnginePhase::Unloaded), |status| {
                status.message = "Siren ready — the engine loads when something is said".into();
                status.migration_required = Some(false);
            });
        }
    }

    pub async fn setup(&self, settings: &AppSettings) -> DomainResult<()> {
        let existing = self.inner.state.lock().setup.as_ref().map(|setup| setup.done.clone());
        if let Some(done) = existing {
            return done.await;
        }
        let id = self.next_id();
        let token = CancellationToken::new();
        let started = Arc::new(AtomicBool::new(false));
        let this = self.clone();
        let settings = settings.clone();
        let (run_token, run_started) = (token.clone(), started.clone());
        let task: BoxFuture<'static, DomainResult<()>> = Box::pin(async move {
            let result = this.setup_runtime(&settings, &run_token, &run_started).await;
            {
                let mut state = this.inner.state.lock();
                if state.setup.as_ref().is_some_and(|setup| setup.id == id) {
                    state.setup = None;
                }
            }
            this.schedule_idle();
            result
        });
        let done = task.shared();
        let existing = {
            let mut state = self.inner.state.lock();
            match &state.setup {
                Some(setup) => Some(setup.done.clone()),
                None => {
                    state.setup = Some(SetupOperation { id, token, started, done: done.clone() });
                    None
                }
            }
        };
        if let Some(existing) = existing {
            return existing.await;
        }
        let driver = done.clone();
        self.spawn(async move {
            let _ = driver.await;
        });
        done.await
    }

    pub async fn cancel_setup(&self) {
        let Some((token, started, done)) = self
            .inner
            .state
            .lock()
            .setup
            .as_ref()
            .map(|setup| (setup.token.clone(), setup.started.clone(), setup.done.clone()))
        else {
            return;
        };
        token.cancel();
        self.update(None, |status| {
            status.setup_state = Some(SetupState::Cancelling);
            status.message = "Cancelling Siren setup…".into();
            status.progress = None;
        });
        if started.load(Ordering::SeqCst) {
            tokio::join!(self.inner.installer.stop_and_wait(), self.inner.worker.stop_and_wait());
        }
        let _ = done.await;
    }

    async fn setup_runtime(
        &self,
        settings: &AppSettings,
        token: &CancellationToken,
        started: &AtomicBool,
    ) -> DomainResult<()> {
        let installer = self.inner.installer.clone();
        self.inner.state.lock().shutting_down = false;
        self.stop("setup");
        installer.setup_log.lock().begin(RuntimeSetupKind::Voice);
        installer.record_setup_stage("Preparing owned voice runtime candidate");
        self.update(Some(EnginePhase::SettingUp), |status| {
            status.setup_state = Some(SetupState::Running);
            status.message = "Preparing Siren setup".into();
            status.progress = None;
        });
        let aborted = || {
            if token.is_cancelled() {
                Err(DomainError::cancelled("Siren setup cancelled"))
            } else {
                Ok(())
            }
        };
        let attempt = async {
            aborted()?;
            started.store(true, Ordering::SeqCst);
            self.inner.worker.stop_and_wait().await;
            self.inner.state.lock().loaded_engine = None;
            self.update(None, |status| {
                status.lifecycle.residency = Some(ModelResidency::Unloaded);
                status.lifecycle.warmup = Some(WarmupState::NotStarted);
                status.lifecycle.device = None;
            });
            aborted()?;
            let install = InstallSettings {
                python_command: settings.python_command.clone(),
                speech_engine: convert(&settings.speech_engine).unwrap_or(delulu_runtime::types::SpeechTier::Small),
                voice_engine: runtime_engine(settings.voice_engine),
            };
            let publisher = self.clone();
            let progress_token = token.clone();
            installer
                .install(
                    RuntimeKind::Voice,
                    &install,
                    move |progress: InstallProgress| {
                        if progress_token.is_cancelled() {
                            return;
                        }
                        let stage: Option<SetupStage> = progress.setup_stage.as_ref().and_then(convert);
                        publisher.update(Some(EnginePhase::SettingUp), move |status| {
                            if let Some(stage) = stage {
                                status.setup_stage = Some(stage);
                            }
                            status.message = progress.message;
                            status.progress = Some(progress.progress);
                            if let Some(detail) = progress.detail {
                                status.detail = Some(detail);
                            }
                        });
                    },
                    Some(token.clone()),
                )
                .await?;
            aborted()?;
            // The candidate stays private to this worker until real warmup succeeds.
            let runtime = self.load_worker(settings).await?;
            aborted()?;
            if !runtime.loaded || runtime.warmup.unwrap_or(WarmupState::Complete) != WarmupState::Complete {
                return Err(plain("Siren warmup did not complete; the previous runtime stays in use"));
            }
            installer.commit()?;
            let attempt = installer.setup_log.lock().active_id();
            installer.setup_log.lock().finish(
                attempt.as_deref(),
                FinalOutcome::Success,
                Some("Voice runtime activated after a test sentence"),
            );
            let name = engine_name(settings.voice_engine);
            self.update(Some(EnginePhase::Ready), |status| {
                status.setup_stage = Some(SetupStage::Ready);
                status.setup_state = Some(SetupState::Complete);
                status.message = format!("{name} is ready");
                status.detail = None;
                status.progress = Some(1.0);
                status.migration_required = Some(false);
            });
            Ok::<(), DomainError>(())
        };
        let Err(error) = attempt.await else { return Ok(()) };
        if started.load(Ordering::SeqCst) {
            tokio::join!(installer.stop_and_wait(), self.inner.worker.stop_and_wait());
            installer.discard();
            installer.reset_cancellation();
            self.inner.state.lock().loaded_engine = None;
        }
        let cancelled = token.is_cancelled();
        let attempt = installer.setup_log.lock().active_id();
        installer.setup_log.lock().finish(
            attempt.as_deref(),
            if cancelled { FinalOutcome::Cancelled } else { FinalOutcome::Error },
            Some(if cancelled {
                "Setup cancelled; previous runtime preserved"
            } else {
                "Setup failed; previous runtime preserved"
            }),
        );
        if cancelled {
            let installed = self.runtime_installed();
            self.update(Some(if installed { EnginePhase::Unloaded } else { EnginePhase::Missing }), |status| {
                status.setup_state = Some(SetupState::Cancelled);
                status.message = if installed {
                    "Setup cancelled. Your previous Siren runtime is kept.".into()
                } else {
                    "Setup cancelled. Siren still needs setup.".into()
                };
                status.detail = None;
                status.progress = None;
            });
            return Ok(());
        }
        self.fail(&error);
        self.update(None, |status| status.setup_state = Some(SetupState::Failed));
        Err(error)
    }

    /// Load the engine in the worker and wait for its warmup.
    async fn load_worker(&self, settings: &AppSettings) -> DomainResult<WorkerStatus> {
        let engine = settings.voice_engine;
        let name = engine_name(engine);
        self.update(Some(EnginePhase::Loading), |status| {
            status.message = format!("Loading {name}…");
            status.setup_stage = Some(SetupStage::ModelPrepare);
            status.progress = None;
        });
        let payload = json!({ "engine": engine, "cacheDir": self.inner.paths.models() });
        let value = self.inner.worker.request("voiceLoad", payload, None).await?;
        let status: WorkerStatus = serde_json::from_value(value).map_err(|error| {
            DomainError::new(DomainErrorCode::WorkerProtocol, format!("Unexpected model worker result: {error}"))
        })?;
        self.inner.state.lock().loaded_engine = Some(engine);
        let loaded = status.clone();
        self.update(Some(EnginePhase::Ready), move |current| {
            current.model = Some(engine);
            current.lifecycle.residency = Some(loaded.residency.unwrap_or(ModelResidency::Resident));
            current.lifecycle.warmup = Some(loaded.warmup.unwrap_or(WarmupState::Complete));
            current.message = match &loaded.device {
                Some(device) if !device.is_empty() => format!("{name} is ready on the {}", device.to_uppercase()),
                _ => format!("{name} is ready"),
            };
            current.lifecycle.device = loaded.device;
            current.setup_stage = Some(SetupStage::ModelLoaded);
            current.detail = None;
            current.progress = None;
        });
        Ok(status)
    }

    pub async fn load(&self, settings: &AppSettings) -> DomainResult<()> {
        if self.inner.state.lock().setup.is_some() {
            return Err(voice_error(DomainErrorCode::Busy, "Siren setup is still running", "voice:load"));
        }
        // Speech arriving during an unload waits for it, then loads again.
        let unloading = self.inner.state.lock().unloading.clone();
        if let Some(unloading) = unloading {
            unloading.await;
        }
        let engine = settings.voice_engine;
        let loaded = || {
            let state = self.inner.state.lock();
            state.loaded_engine == Some(engine) && state.status.engine == EnginePhase::Ready
        };
        if loaded() && self.inner.worker.running() {
            return Ok(());
        }
        let loading = self.inner.state.lock().loading.as_ref().map(|(_, task)| task.clone());
        if let Some(loading) = loading {
            loading.await?;
            if self.inner.state.lock().loaded_engine == Some(engine) {
                return Ok(());
            }
        }
        let id = self.next_id();
        let this = self.clone();
        let task_settings = settings.clone();
        let task: BoxFuture<'static, DomainResult<()>> = Box::pin(async move {
            if !this.is_environment_ready(&task_settings).await {
                this.refresh_environment(&task_settings).await;
                return Err(voice_error(
                    DomainErrorCode::WorkerUnavailable,
                    format!("Set up {} on the Siren page first.", engine_name(task_settings.voice_engine)),
                    "voice:load",
                ));
            }
            let previous = this.inner.state.lock().loaded_engine;
            if previous.is_some_and(|previous| previous != task_settings.voice_engine) {
                this.inner.worker.request("voiceUnload", json!({}), None).await?;
            }
            this.load_worker(&task_settings).await.map(|_| ())
        });
        let task = task.shared();
        self.inner.state.lock().loading = Some((id, task.clone()));
        let driver = task.clone();
        self.spawn(async move {
            let _ = driver.await;
        });
        let result = task.await;
        match &result {
            Ok(()) => {
                if !self.is_speaking() {
                    self.schedule_idle();
                }
            }
            Err(error) if error.code != DomainErrorCode::WorkerUnavailable => self.fail(error),
            Err(_) => {}
        }
        let mut state = self.inner.state.lock();
        if state.loading.as_ref().is_some_and(|(current, _)| *current == id) {
            state.loading = None;
        }
        result
    }

    pub async fn unload(&self) {
        let existing = self.inner.state.lock().unloading.clone();
        if let Some(unloading) = existing {
            return unloading.await;
        }
        self.clear_idle();
        self.stop("unload");
        // Mark it unloaded before the first await so load() cannot take the fast path.
        self.inner.state.lock().loaded_engine = None;
        let this = self.clone();
        let task: BoxFuture<'static, ()> = Box::pin(async move {
            let loading = this.inner.state.lock().loading.as_ref().map(|(_, task)| task.clone());
            if let Some(loading) = loading {
                let _ = loading.await;
            }
            this.inner.state.lock().loaded_engine = None;
            if this.inner.worker.running() {
                let _ = this.inner.worker.request("voiceUnload", json!({}), None).await;
                this.inner.worker.stop_and_wait().await;
            }
            if this.get_status().engine != EnginePhase::Missing {
                this.update(Some(EnginePhase::Unloaded), |status| {
                    status.message = "Siren engine unloaded — it loads when something is said".into();
                });
            }
        });
        let task = task.shared();
        self.inner.state.lock().unloading = Some(task.clone());
        let driver = task.clone();
        self.spawn(driver);
        task.await;
        self.inner.state.lock().unloading = None;
    }

    /// Apply saved settings: engine switches, residency and turning voice off.
    pub async fn settings_changed(&self, previous: &AppSettings, next: &AppSettings) {
        if !next.voice_enabled && previous.voice_enabled {
            self.stop("disabled");
        }
        if next.voice_engine != previous.voice_engine {
            self.unload().await;
            self.refresh_environment(next).await;
        }
        if next.voice_engine != previous.voice_engine
            || next.voice_keep_loaded != previous.voice_keep_loaded
            || next.voice_enabled != previous.voice_enabled
            || next.model_idle_minutes != previous.model_idle_minutes
        {
            if next.voice_enabled && next.voice_keep_loaded && self.get_status().engine == EnginePhase::Unloaded {
                let this = self.clone();
                let next = next.clone();
                self.spawn(async move {
                    let _ = this.load(&next).await;
                });
            } else {
                self.schedule_idle();
            }
        }
    }

    fn clear_idle(&self) {
        let had = {
            let mut state = self.inner.state.lock();
            if let Some(timer) = state.idle_timer.take() {
                timer.abort();
            }
            state.status.lifecycle.idle_unload_at.is_some()
        };
        if had {
            self.update(None, |status| status.lifecycle.idle_unload_at = None);
        }
    }

    fn schedule_idle(&self) {
        let settings = self.settings();
        let delay = {
            let mut state = self.inner.state.lock();
            if let Some(timer) = state.idle_timer.take() {
                timer.abort();
            }
            if state.shutting_down
                || state.status.engine != EnginePhase::Ready
                || (settings.voice_enabled && settings.voice_keep_loaded)
            {
                return;
            }
            let delay = (settings.model_idle_minutes * 60_000.0).max(0.0) as u64;
            let this = self.clone();
            state.idle_timer = Some(self.inner.runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                this.inner.state.lock().idle_timer = None;
                if this.is_busy() {
                    return this.schedule_idle();
                }
                this.unload().await;
            }));
            delay
        };
        self.update(None, |status| status.lifecycle.idle_unload_at = Some(now_ms() + delay));
    }

    pub fn fail(&self, error: &DomainError) {
        if error.is_cancelled() {
            return;
        }
        self.clear_idle();
        self.inner.state.lock().loaded_engine = None;
        let failure = error.to_failure(&uuid(), "runtime:voice");
        let running = self.inner.worker.running();
        let message = failure.message.clone();
        self.update(Some(EnginePhase::Error), move |status| {
            status.lifecycle.residency = Some(if running { ModelResidency::Unknown } else { ModelResidency::Unloaded });
            status.lifecycle.warmup = Some(if running { WarmupState::Unknown } else { WarmupState::NotStarted });
            status.lifecycle.device = None;
            let first = message.split('\n').next().unwrap_or_default().trim_end_matches('\r');
            status.message = truncate_utf16(first, 400).to_owned();
            status.detail = Some(message.clone());
            status.progress = None;
            status.failure = Some(failure);
        });
    }

    pub async fn shutdown(&self) {
        self.inner.state.lock().shutting_down = true;
        self.clear_idle();
        self.stop("shutdown");
        if let Some(setup) = &self.inner.state.lock().setup {
            setup.token.cancel();
        }
        let worker = self.inner.worker.clone();
        tokio::join!(self.inner.installer.stop_and_wait(), async {
            // Never start a worker just to shut it down.
            if worker.running() {
                let _ = worker.request("shutdown", json!({}), Some(Duration::from_secs(5))).await;
                worker.stop_and_wait().await;
            }
        });
    }

    /* -------------------------------------------------------------- */
    /* Reference clips (electron/ipc/voice.ts)                         */
    /* -------------------------------------------------------------- */

    fn references(&self) -> PathBuf {
        self.inner.paths.voice_dir().join("references")
    }

    /// `voice:chooseReference` once the app's file dialog returned `path`:
    /// keeps a private copy under `voice/references` and selects it.
    pub async fn choose_reference(&self, path: &std::path::Path) -> DomainResult<AppSettings> {
        const EXTENSIONS: [&str; 4] = ["wav", "flac", "mp3", "ogg"];
        const MAX_BYTES: u64 = 50 * 1024 * 1024;
        let extension = path.extension().map(|value| value.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !EXTENSIONS.contains(&extension.as_str()) {
            return Err(plain("Choose a WAV, FLAC, MP3 or Ogg audio file"));
        }
        let size = std::fs::metadata(path)?.len();
        if size == 0 {
            return Err(plain("That audio file is empty"));
        }
        if size > MAX_BYTES {
            return Err(plain("Choose a clip smaller than 50 MB; 5–20 seconds is enough"));
        }
        // Keep a private copy so the clip still works if the original moves.
        let references = self.references();
        create_private_dir(&references)?;
        let name = format!("{}.{extension}", uuid());
        std::fs::copy(path, references.join(&name))?;
        let previous = self.settings().voice_clone;
        match self.inner.profile.persist_settings(json!({ "voiceClone": name })).await {
            Ok(saved) => {
                if !previous.is_empty() && previous != name {
                    self.remove_clip(&previous);
                }
                Ok(saved)
            }
            Err(error) => {
                self.remove_clip(&name);
                Err(error)
            }
        }
    }

    /// `voice:removeReference`.
    pub async fn remove_reference(&self) -> DomainResult<AppSettings> {
        let previous = self.settings().voice_clone;
        let saved = self.inner.profile.persist_settings(json!({ "voiceClone": "" })).await?;
        self.remove_clip(&previous);
        Ok(saved)
    }

    fn remove_clip(&self, name: &str) {
        // Only a bare file name inside the references directory.
        if !name.is_empty() && !name.contains(['/', '\\']) && name != ".." {
            let _ = std::fs::remove_file(self.references().join(name));
        }
    }

    /* -------------------------------------------------------------- */
    /* Speaking                                                        */
    /* -------------------------------------------------------------- */

    /// Queue an utterance; the handle's `done` resolves when it is spoken,
    /// stopped or failed.
    pub fn enqueue(&self, request: VoiceSpeakRequest) -> DomainResult<SpeakHandle> {
        let settings = self.settings();
        let source = request.source.unwrap_or(VoiceSource::App);
        let operation = format!("voice:speak:{}", source.as_str());
        let unavailable = |message: String| voice_error(DomainErrorCode::WorkerUnavailable, message, &operation);
        {
            let state = self.inner.state.lock();
            if state.shutting_down {
                return Err(unavailable("Delulu is quitting".into()));
            }
            if source != VoiceSource::App && !settings.voice_enabled {
                return Err(unavailable(
                    "Siren is turned off in Delulu Talks. Switch on Speak replies aloud on the Siren page.".into(),
                ));
            }
            if state.status.engine == EnginePhase::Missing || state.setup.is_some() {
                return Err(unavailable(format!(
                    "Set up {} on the Siren page first.",
                    engine_name(settings.voice_engine)
                )));
            }
        }
        if utf16_len(&request.text) > VOICE_LIMITS.request_characters {
            return Err(voice_error(
                DomainErrorCode::InvalidRequest,
                format!("Text is limited to {} characters", group_thousands(VOICE_LIMITS.request_characters)),
                &operation,
            ));
        }
        let normalize = request.normalize.unwrap_or(settings.voice_normalize_text);
        let markup = parse_voice_markup(&if normalize { speakable_text(&request.text) } else { request.text.clone() });
        let chunks = plan_voice_chunks(&markup.segments, CHUNKS);
        if chunks.is_empty() {
            return Err(voice_error(DomainErrorCode::InvalidRequest, "There is nothing to say", &operation));
        }
        if request.interrupt == Some(true) {
            self.stop("interrupted");
        }
        let (finish, done) = oneshot::channel();
        let id = uuid();
        let response_id = request
            .response_id
            .as_deref()
            .map(|value| truncate_utf16(js::trim(value), 128).to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("rsp_{}", uuid()));
        let agent = request
            .agent
            .as_deref()
            .map(|value| truncate_utf16(js::trim(value), 64).to_owned())
            .filter(|value| !value.is_empty());
        let position = {
            let mut state = self.inner.state.lock();
            if state.queue.len() >= VOICE_LIMITS.queue {
                return Err(voice_error(
                    DomainErrorCode::Busy,
                    format!("{} messages are already waiting to be spoken", VOICE_LIMITS.queue),
                    &operation,
                ));
            }
            state.queue.push_back(Utterance {
                id: id.clone(),
                at: now_ms(),
                source,
                agent,
                text: markup.plain_text.clone(),
                chunks,
                warnings: markup.warnings.iter().take(20).cloned().collect(),
                unsupported: Vec::new(),
                timestamps: Vec::new(),
                cursor_ms: 0.0,
                playing: Vec::new(),
                pending: HashMap::new(),
                heard: -1,
                play_end_at: 0.0,
                outcome: VoiceUtteranceOutcome::Queued,
                response_id: response_id.clone(),
                cancelled: false,
                interrupted: false,
                error: None,
                finish: Some(finish),
            });
            // 0 means it starts right away; otherwise how many are ahead of it.
            (state.queue.len() - 1 + usize::from(state.current.is_some())) as u64
        };
        self.clear_idle();
        self.update(None, |_| {});
        self.drain();
        self.inner.state.lock().spoken_text.push((markup.plain_text, now_ms()));
        Ok(SpeakHandle {
            queued: VoiceQueued { id: id.clone(), response_id: response_id.clone(), position },
            done,
            id,
            response_id,
        })
    }

    pub async fn speak(&self, request: VoiceSpeakRequest) -> DomainResult<VoiceSpeakResult> {
        Ok(self.enqueue(request)?.done().await)
    }

    /// Text spoken recently, so a listening session can recognize its own voice.
    pub fn recently_spoken(&self, within_ms: u64) -> Vec<String> {
        let since = now_ms().saturating_sub(within_ms);
        let mut state = self.inner.state.lock();
        state.spoken_text.retain(|(_, at)| *at >= since);
        state.spoken_text.iter().map(|(text, _)| text.clone()).collect()
    }

    /// The user talked over Delulu: stop at once, drop what was queued and
    /// refuse any audio still being synthesized for these responses. Returns
    /// the response ids that were cut off, the one being heard first.
    pub fn interrupt(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        {
            let mut state = self.inner.state.lock();
            let State { current, queue, .. } = &mut *state;
            for utterance in current.iter_mut().chain(queue.iter_mut()) {
                utterance.interrupted = true;
                if !ids.contains(&utterance.response_id) {
                    ids.push(utterance.response_id.clone());
                }
            }
        }
        self.stop("barge-in");
        ids
    }

    /// Stop speaking and clear everything waiting.
    pub fn stop(&self, _reason: &str) {
        {
            let mut state = self.inner.state.lock();
            let State { current, queue, rejected, recent, .. } = &mut *state;
            let waiting: Vec<Utterance> = queue.drain(..).collect();
            if current.is_none() && waiting.is_empty() {
                return;
            }
            if let Some(utterance) = current.as_mut() {
                utterance.cancelled = true;
                rejected.add(&utterance.id);
                utterance.settle_pending();
            }
            for mut utterance in waiting {
                utterance.cancelled = true;
                rejected.add(&utterance.id);
                utterance.settle_pending();
                let outcome =
                    if utterance.interrupted { VoiceUtteranceOutcome::Interrupted } else { VoiceUtteranceOutcome::Stopped };
                complete(recent, &mut utterance, outcome);
            }
        }
        self.inner.playback.stop(None);
        self.update(None, |_| {});
    }

    /// Dictation started: stop talking so the user can answer.
    pub fn interrupt_for_dictation(&self) {
        if self.settings().voice_interrupt_on_dictation && self.is_speaking() {
            self.stop("dictation");
        }
    }

    /// Playback went away; nothing it was playing will finish.
    pub fn playback_lost(&self) {
        if let Some(utterance) = self.inner.state.lock().current.as_mut() {
            utterance.settle_pending();
        }
        self.update(None, |_| {});
    }

    pub fn playback_event(&self, event: PlaybackEvent) {
        {
            let mut state = self.inner.state.lock();
            let Some(utterance) = state.current.as_mut().filter(|current| current.id == event.utterance_id) else {
                return;
            };
            if event.event == PlaybackEventKind::Started {
                if !utterance.playing.contains(&event.chunk) {
                    utterance.playing.push(event.chunk);
                }
                utterance.heard = utterance.heard.max(event.chunk as i64);
            } else {
                utterance.playing.retain(|chunk| *chunk != event.chunk);
                if event.event == PlaybackEventKind::Failed && utterance.error.is_none() {
                    utterance.error = Some(
                        event
                            .message
                            .as_deref()
                            .map(|message| truncate_utf16(message, 400).to_owned())
                            .filter(|message| !message.is_empty())
                            .unwrap_or_else(|| "Playback failed".into()),
                    );
                }
                if let Some(pending) = utterance.pending.remove(&event.chunk) {
                    pending.settle();
                }
            }
        }
        self.update(None, |_| {});
    }

    /// Moves the next queued utterance into `current`.
    fn take_next(state: &mut State) -> Option<String> {
        if state.shutting_down {
            return None;
        }
        let mut utterance = state.queue.pop_front()?;
        utterance.outcome = VoiceUtteranceOutcome::Speaking;
        let id = utterance.id.clone();
        state.current = Some(utterance);
        Some(id)
    }

    /// Speaks the queue one utterance at a time. Like the TypeScript, the
    /// first utterance becomes current before this returns.
    fn drain(&self) {
        let first = {
            let mut state = self.inner.state.lock();
            if state.draining {
                return;
            }
            let Some(first) = Self::take_next(&mut state) else { return };
            state.draining = true;
            first
        };
        self.update(None, |_| {});
        let this = self.clone();
        self.spawn(async move {
            let mut next = Some(first);
            while let Some(id) = next {
                this.perform(&id).await;
                next = {
                    let mut state = this.inner.state.lock();
                    state.current = None;
                    let next = Self::take_next(&mut state);
                    if next.is_none() {
                        state.draining = false;
                    }
                    next
                };
                this.update(None, |_| {});
            }
            this.schedule_idle();
        });
    }

    /// Reads from the current utterance if it is still `id`.
    fn with_current<T>(&self, id: &str, read: impl FnOnce(&mut Utterance) -> T) -> Option<T> {
        self.inner.state.lock().current.as_mut().filter(|current| current.id == id).map(read)
    }

    fn cancelled(&self, id: &str) -> bool {
        self.with_current(id, |utterance| utterance.cancelled).unwrap_or(true)
    }

    async fn perform(&self, id: &str) {
        let mut playbacks: Vec<Option<oneshot::Receiver<()>>> = Vec::new();
        let result = async {
            self.load(&self.settings()).await?;
            let count = self.with_current(id, |utterance| utterance.chunks.len()).unwrap_or(0);
            for index in 0..count {
                if self.cancelled(id) {
                    break;
                }
                // Stay a short way ahead of what is being heard.
                if index >= LOOKAHEAD {
                    if let Some(playback) = playbacks[index - LOOKAHEAD].take() {
                        let _ = playback.await;
                    }
                }
                if self.cancelled(id) {
                    break;
                }
                let Some(chunk) = self.with_current(id, |utterance| utterance.chunks[index].clone()) else { break };
                let live = self.settings();
                let reference = (live.voice_engine == VoiceEngineId::ChatterboxTurbo && !live.voice_clone.is_empty())
                    .then(|| self.references().join(&live.voice_clone).to_string_lossy().into_owned());
                let request = VoiceSynthesizeRequest {
                    engine: live.voice_engine,
                    voice: live.voice_name.clone(),
                    reference,
                    speed: live.voice_speed,
                    styles: chunk.styles.clone(),
                    parts: chunk.parts.clone(),
                };
                let payload = serde_json::to_value(&request)?;
                let value = self.inner.worker.request("voiceSynthesize", payload, None).await?;
                let result: VoiceSynthesizeResult = serde_json::from_value(value).map_err(|error| {
                    DomainError::new(DomainErrorCode::WorkerProtocol, format!("Unexpected model worker result: {error}"))
                })?;
                if self.cancelled(id) {
                    break;
                }
                self.with_current(id, |utterance| {
                    for tag in &result.unsupported {
                        if !utterance.unsupported.contains(tag) {
                            utterance.unsupported.push(tag.clone());
                        }
                    }
                    utterance.timestamps.push(VoiceTimestamp {
                        text: chunk.text.clone(),
                        start_ms: utterance.cursor_ms.round(),
                        end_ms: (utterance.cursor_ms + result.duration_ms).round(),
                    });
                    utterance.cursor_ms += result.duration_ms;
                });
                playbacks.push(Some(self.play(id, index, count, &result)));
                self.update(None, |_| {});
            }
            for playback in playbacks.iter_mut().filter_map(Option::take) {
                let _ = playback.await;
            }
            Ok::<(), DomainError>(())
        }
        .await;
        let failed = result.is_err();
        let stop_playback = {
            let mut state = self.inner.state.lock();
            let State { current, recent, .. } = &mut *state;
            let Some(utterance) = current.as_mut().filter(|current| current.id == id) else { return };
            let mut stop = false;
            if let Err(error) = &result {
                if !utterance.cancelled {
                    utterance.error = Some(error.message.clone());
                    stop = true;
                }
            }
            let outcome = if utterance.interrupted {
                VoiceUtteranceOutcome::Interrupted
            } else if utterance.cancelled {
                VoiceUtteranceOutcome::Stopped
            } else if failed || utterance.error.is_some() {
                VoiceUtteranceOutcome::Failed
            } else {
                VoiceUtteranceOutcome::Spoken
            };
            complete(recent, utterance, outcome);
            stop
        };
        if stop_playback {
            self.inner.playback.stop(Some(id));
        }
        self.update(None, |_| {});
    }

    fn play(&self, id: &str, index: usize, count: usize, result: &VoiceSynthesizeResult) -> oneshot::Receiver<()> {
        let settings = self.settings();
        let (resolve, receiver) = oneshot::channel();
        let chunk = index as u32;
        {
            let mut state = self.inner.state.lock();
            let State { current, rejected, .. } = &mut *state;
            let Some(utterance) = current.as_mut().filter(|current| current.id == id) else {
                let _ = resolve.send(());
                return receiver;
            };
            // Chunks play back to back, so this one ends after everything sent before it.
            let now = now_ms() as f64;
            utterance.play_end_at = now.max(utterance.play_end_at) + result.duration_ms;
            // Audio synthesized after a stop or interruption never reaches playback.
            if utterance.cancelled || rejected.has(id) {
                let _ = resolve.send(());
                return receiver;
            }
            let delay = (utterance.play_end_at - now + PLAYBACK_GRACE_MS).max(0.0) as u64;
            let this = self.clone();
            let timer_id = id.to_owned();
            let timer = self.inner.runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let pending = this.with_current(&timer_id, |utterance| {
                    utterance.playing.retain(|playing| *playing != chunk);
                    utterance.pending.remove(&chunk)
                });
                if let Some(Some(pending)) = pending {
                    let _ = pending.resolve.send(());
                }
            });
            utterance.pending.insert(chunk, PendingChunk { resolve, timer: Some(timer) });
        }
        let pcm = base64::engine::general_purpose::STANDARD.decode(&result.audio).unwrap_or_default();
        let delivered = self.inner.playback.play(PlaybackChunk {
            utterance_id: id.to_owned(),
            chunk,
            last: index + 1 == count,
            sample_rate: result.sample_rate,
            pcm,
            volume: settings.voice_volume as f32,
            output_device_id: settings.voice_output_device_id.clone(),
        });
        if !delivered {
            let pending = self.with_current(id, |utterance| {
                utterance.error = Some(NO_PLAYBACK.into());
                utterance.pending.remove(&chunk)
            });
            if let Some(Some(pending)) = pending {
                pending.settle();
            }
        }
        receiver
    }
}

fn complete(recent: &mut Vec<VoiceUtteranceSummary>, utterance: &mut Utterance, outcome: VoiceUtteranceOutcome) {
    if matches!(
        utterance.outcome,
        VoiceUtteranceOutcome::Spoken
            | VoiceUtteranceOutcome::Stopped
            | VoiceUtteranceOutcome::Interrupted
            | VoiceUtteranceOutcome::Failed
    ) {
        return;
    }
    utterance.outcome = outcome;
    let duration_ms = utterance.cursor_ms.round();
    recent.insert(
        0,
        VoiceUtteranceSummary {
            id: utterance.id.clone(),
            at: utterance.at,
            source: utterance.source,
            agent: utterance.agent.clone(),
            text: summary(&utterance.text, 400),
            outcome,
            duration_ms,
        },
    );
    recent.truncate(RECENT_LIMIT);
    if let Some(finish) = utterance.finish.take() {
        let _ = finish.send(VoiceSpeakResult {
            id: utterance.id.clone(),
            response_id: utterance.response_id.clone(),
            outcome,
            duration_ms,
            timestamps: utterance.timestamps.clone(),
            warnings: utterance.warnings.clone(),
            unsupported: utterance.unsupported.clone(),
            error: utterance.error.clone().filter(|_| outcome == VoiceUtteranceOutcome::Failed),
        });
    }
}

fn apply(state: &mut State, engine: Option<EnginePhase>, patch: impl FnOnce(&mut VoiceStatus)) {
    let status = &mut state.status;
    if let Some(engine) = engine {
        if engine != EnginePhase::Error {
            status.failure = None;
        }
        if matches!(engine, EnginePhase::Unloaded | EnginePhase::Missing) {
            status.lifecycle.residency = Some(ModelResidency::Unloaded);
            status.lifecycle.warmup = Some(WarmupState::NotStarted);
            status.lifecycle.device = None;
            status.model = None;
            status.setup_stage = None;
        }
        status.engine = engine;
    }
    patch(status);
    status.phase = match &state.current {
        Some(current) if !current.playing.is_empty() => VoicePhase::Speaking,
        Some(_) => VoicePhase::Synthesizing,
        None => VoicePhase::Idle,
    };
    status.current = state.current.as_ref().map(|current| {
        let chunks = current.chunks.len() as i64;
        VoiceCurrentUtterance {
            id: current.id.clone(),
            text: summary(&current.text, 280),
            source: current.source,
            agent: current.agent.clone(),
            chunk: chunks.min((current.heard + 1).max(1)) as u64,
            chunks: chunks as u64,
        }
    });
    status.queued = state.queue.len() as u64;
    status.recent = state.recent.clone();
    status.bridge = state.bridge.clone();
    if !matches!(status.engine, EnginePhase::SettingUp | EnginePhase::Loading) {
        status.download_bytes = None;
    }
}

/// `n.toLocaleString("en")` for the integer limits used in messages.
pub(crate) fn group_thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

pub(crate) fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// The voice worker's environment (`environment()`).
fn environment(paths: &AppPaths, installer: Option<&RuntimeInstaller>) -> ChildEnv {
    let fallback = paths.voice_venv().join(if cfg!(windows) { "Scripts" } else { "bin" });
    // Repair must still run when the old activation record is damaged.
    let bin = installer
        .and_then(|installer| installer.python().ok())
        .and_then(|python| python.parent().map(PathBuf::from))
        .unwrap_or(fallback);
    let mut env = runtime_environment(RuntimeKind::Voice, &paths.data, &paths.models(), &bin, delulu_core::host_vars());
    env.insert("TQDM_DISABLE".into(), "1".into());
    env
}
