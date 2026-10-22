//! Speech and rewriting runtimes (`electron/services/asr.ts`): setup through
//! [`RuntimeInstaller`] (serialized across both runtimes), load/unload,
//! residency and idle unloading, transcription, manual and automatic
//! rewriting, error generations and the status objects the renderer shows.
//!
//! Ownership rules (docs/ARCHITECTURE.md, "Runtime lifecycle"): idle
//! unloading checks capture ownership, maintenance and pending requests and
//! otherwise defers a full interval; an errored engine stays failed until an
//! explicit Load/Repair or retry; automatic loads carry the failure
//! generation so a stale result cannot overwrite a newer failure.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use delulu_core::{AppPaths, DomainError, DomainResult, SharedSink};
use delulu_domain::text::{
    normalize_rewrite_context, recognition_hints, split_for_rewrite, split_technical_blocks,
    TextPart,
};
use delulu_domain::word_packs::active_rules;
use delulu_domain::{
    js, magic_model_by_id, model_by_id, pipeline_timings::normalize_timings,
    speech_models::normalize_speech_execution, AppSettings, BackendCapabilities, DictationPhase,
    DictationStatus, EnginePhase, MagicPreset, MagicRewriteRequest, MagicRewriteResult,
    MagicStatus, MemoryPolicy, RetryAudioState, RuntimeSetupKind, RuntimeSetupLog, SpeechModelId,
    SpeechTier, WarmupState, CANARY_MODEL, PARAKEET_MODEL,
};
use delulu_runtime::installer::constraints_path;
use delulu_runtime::platform::{large_speech_supported, speech_model_for_platform};
use delulu_runtime::private_diagnostics::private_failure_log;
use delulu_runtime::protocol::WorkerProgress;
use delulu_runtime::setup_log::FinalOutcome;
use delulu_runtime::worker::worker_script;
use delulu_runtime::{
    runtime_environment, transcription_timeout, InstallSettings, InstallerPaths, RuntimeInstaller,
    RuntimeKind, SerialQueue, SpeechRuntimeProfile, TargetPlatform, WorkerClient, WorkerConfig,
};
use futures::future::{BoxFuture, FutureExt};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Map, Value};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::channels;
use crate::ports::SpeechEngine;
use crate::profile::Profile;
use crate::status::{failed_lifecycle, unloaded_lifecycle, Listener, StatusCell};
use crate::support::{convert, eager, elapsed_ms, plain, Finally, SharedTask};

/// Checkpoints the speech worker loads; Medium picks Parakeet's English model for English.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechWorkerModel {
    Canary180m,
    ParakeetV2,
    ParakeetV3,
    R2t2,
}

impl SpeechWorkerModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Canary180m => "canary-180m",
            Self::ParakeetV2 => "parakeet-v2",
            Self::ParakeetV3 => "parakeet-v3",
            Self::R2t2 => "r2t2",
        }
    }
}

/// The checkpoint for the selected size. Large falls back to Medium where R2T2 cannot run.
pub fn speech_engine_id(settings: &AppSettings) -> SpeechWorkerModel {
    if settings.speech_engine == SpeechTier::Small {
        return SpeechWorkerModel::Canary180m;
    }
    if settings.speech_engine == SpeechTier::Large
        && large_speech_supported(&TargetPlatform::current())
    {
        return SpeechWorkerModel::R2t2;
    }
    if settings.language == "en" {
        SpeechWorkerModel::ParakeetV2
    } else {
        SpeechWorkerModel::ParakeetV3
    }
}

pub fn speech_model_name(settings: &AppSettings) -> String {
    match speech_engine_id(settings) {
        SpeechWorkerModel::R2t2 => model_by_id(settings.model).model.name.clone(),
        SpeechWorkerModel::Canary180m => CANARY_MODEL.name.clone(),
        SpeechWorkerModel::ParakeetV2 => format!("{} v2", PARAKEET_MODEL.name),
        SpeechWorkerModel::ParakeetV3 => format!("{} v3", PARAKEET_MODEL.name),
    }
}

fn speech_profile(settings: &AppSettings) -> SpeechRuntimeProfile {
    if speech_engine_id(settings) == SpeechWorkerModel::R2t2 {
        SpeechRuntimeProfile::Full
    } else {
        SpeechRuntimeProfile::Cpu
    }
}

/// The speech model this platform's Large size runs (`speechModelForPlatform()`).
fn platform_speech_model() -> SpeechModelId {
    convert(&speech_model_for_platform(&TargetPlatform::current())).unwrap_or(SpeechModelId::R2t2)
}

fn model_setup_stage(stage: &str) -> Option<&'static str> {
    Some(match stage {
        "download" => "model-download",
        "load" => "model-load",
        "conversion" => "model-conversion",
        "warmup" => "warmup",
        _ => return None,
    })
}

/// `reportedLifecycle(runtime)`.
fn reported_lifecycle(runtime: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(
        "residency".into(),
        runtime
            .get("residency")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
    );
    map.insert(
        "warmup".into(),
        runtime
            .get("warmup")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
    );
    map.insert(
        "device".into(),
        runtime.get("device").cloned().unwrap_or(Value::Null),
    );
    map
}

fn loaded(runtime: &Value) -> bool {
    runtime.get("loaded").and_then(Value::as_bool) == Some(true)
}

/// The last useful line of a worker failure, at most 800 characters.
pub(crate) fn concise_error(value: &str) -> String {
    let lines: Vec<&str> = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let progress_bar = |line: &str| {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        digits > 0 && line[digits..].starts_with("%|")
    };
    let useful = lines.iter().rev().find(|line| {
        !line.contains("unauthenticated requests")
            && !line.contains("Loading weights")
            && !progress_bar(line)
    });
    let chosen = useful
        .or(lines.last())
        .copied()
        .unwrap_or("The model worker stopped unexpectedly");
    crate::support::chars(chosen, 800)
}

fn merge(mut base: Map<String, Value>, patch: Value) -> Value {
    if let Value::Object(patch) = patch {
        base.extend(patch);
    }
    Value::Object(base)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Speech,
    Magic,
}

type Eligible = Arc<dyn Fn() -> bool + Send + Sync>;

fn always() -> Eligible {
    Arc::new(|| true)
}

fn rewrite_cancelled() -> DomainError {
    DomainError::cancelled("Rewrite cancelled").with_cause("RewriteCancelledError", None)
}

fn is_rewrite_cancelled(error: &DomainError) -> bool {
    error
        .cause
        .as_ref()
        .is_some_and(|cause| cause.name == "RewriteCancelledError")
}

struct SetupOperation {
    token: CancellationToken,
    started: AtomicBool,
    previous_engine: EnginePhase,
    promise: Mutex<Option<SharedTask>>,
    termination: Mutex<Option<SharedTask>>,
}

struct ManualRewrite {
    id: String,
    cancelled: AtomicBool,
    settled: AtomicBool,
    cancel_promise: Mutex<Option<SharedTask>>,
}

impl ManualRewrite {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn throw_if_cancelled(operation: &Option<Arc<ManualRewrite>>) -> DomainResult<()> {
    match operation {
        Some(operation) if operation.cancelled() => Err(rewrite_cancelled()),
        _ => Ok(()),
    }
}

#[derive(Default)]
struct State {
    initializing: bool,
    setup_promise: Option<SharedTask>,
    magic_setup_promise: Option<SharedTask>,
    speech_setup: Option<Arc<SetupOperation>>,
    magic_setup: Option<Arc<SetupOperation>>,
    load: Option<SharedTask>,
    magic_load: Option<SharedTask>,
    speech_unload: Option<SharedTask>,
    magic_release: Option<SharedTask>,
    speech_operations: usize,
    magic_operations: usize,
    manual_rewrite: Option<Arc<ManualRewrite>>,
    shutting_down: bool,
    residency_pending: bool,
    speech_failure_generation: u64,
    magic_failure_generation: u64,
    speech_idle: Option<(u64, JoinHandle<()>)>,
    magic_idle: Option<(u64, JoinHandle<()>)>,
    timer_sequence: u64,
    loaded_engine: Option<SpeechWorkerModel>,
}

impl State {
    fn setup(&self, kind: Kind) -> Option<Arc<SetupOperation>> {
        match kind {
            Kind::Speech => self.speech_setup.clone(),
            Kind::Magic => self.magic_setup.clone(),
        }
    }
}

struct Inner {
    paths: AppPaths,
    profile: Arc<dyn Profile>,
    runtime: Handle,
    speech_worker: WorkerClient,
    magic_worker: WorkerClient,
    speech_installer: Arc<RuntimeInstaller>,
    magic_installer: Arc<RuntimeInstaller>,
    maintenance: SerialQueue,
    model_operations: SerialQueue,
    status: StatusCell<DictationStatus>,
    magic: StatusCell<MagicStatus>,
    state: Mutex<State>,
    can_idle_unload: RwLock<Eligible>,
}

/// Cheap to clone; clones share one service. Must be created inside a Tokio runtime.
#[derive(Clone)]
pub struct AsrService {
    inner: Arc<Inner>,
}

fn initial_status() -> DictationStatus {
    serde_json::from_value(json!({
        "residency": "unloaded", "warmup": "not-started",
        "speechModel": platform_speech_model(),
        "phase": "idle", "engine": "missing",
        "message": "Speech runtime setup required",
        "retryAvailable": false,
        "retryAudio": {"phase": "empty", "byteLength": 0, "durationMs": null, "discarded": false, "sessionOnly": true},
    }))
    .expect("valid initial status")
}

fn initial_magic_status() -> MagicStatus {
    serde_json::from_value(json!({
        "residency": "unloaded", "warmup": "not-started",
        "phase": "idle", "engine": "missing",
        "message": "Rewrite runtime setup required",
    }))
    .expect("valid initial magic status")
}

impl AsrService {
    pub fn new(paths: AppPaths, profile: Arc<dyn Profile>, sink: SharedSink) -> Self {
        let runtime = Handle::current();
        let inner = Arc::new_cyclic(|weak: &Weak<Inner>| {
            let environment = |kind: Kind| {
                let weak = weak.clone();
                move || {
                    weak.upgrade()
                        .map(|inner| AsrService { inner }.worker_environment(kind))
                        .unwrap_or_default()
                }
            };
            let speech_installer = Arc::new(RuntimeInstaller::new(
                InstallerPaths {
                    data_directory: paths.data.clone(),
                    venv_directory: paths.speech_venv(),
                    kind: Some(RuntimeKind::Speech),
                },
                None,
                environment(Kind::Speech),
            ));
            let magic_installer = Arc::new(RuntimeInstaller::new(
                InstallerPaths {
                    data_directory: paths.data.clone(),
                    venv_directory: paths.magic_venv(),
                    kind: Some(RuntimeKind::Magic),
                },
                Some(constraints_path(&paths)),
                environment(Kind::Magic),
            ));
            AsrService::build_inner(
                weak,
                paths,
                profile,
                sink,
                runtime,
                speech_installer,
                magic_installer,
            )
        });
        Self { inner }
    }

    fn build_inner(
        weak: &Weak<Inner>,
        paths: AppPaths,
        profile: Arc<dyn Profile>,
        sink: SharedSink,
        runtime: Handle,
        speech_installer: Arc<RuntimeInstaller>,
        magic_installer: Arc<RuntimeInstaller>,
    ) -> Inner {
        let config = |kind: Kind| {
            let weak = weak.clone();
            move || {
                let inner = weak
                    .upgrade()
                    .ok_or_else(|| plain("The model engines are shutting down"))?;
                let installer = match kind {
                    Kind::Speech => &inner.speech_installer,
                    Kind::Magic => &inner.magic_installer,
                };
                Ok(WorkerConfig {
                    python: installer.python()?,
                    script: worker_script(&inner.paths),
                    env: AsrService {
                        inner: inner.clone(),
                    }
                    .worker_environment(kind),
                })
            }
        };
        let service = |weak: &Weak<Inner>| weak.upgrade().map(|inner| AsrService { inner });
        let speech_failure = {
            let weak = weak.clone();
            move |error: DomainError| {
                if let Some(this) = service(&weak) {
                    if !this.setup_aborted(Kind::Speech) {
                        this.fail(&error);
                    }
                }
            }
        };
        let speech_progress = {
            let weak = weak.clone();
            move |detail: &str, event: &WorkerProgress| {
                let Some(this) = service(&weak) else { return };
                if this.setup_aborted(Kind::Speech) {
                    return;
                }
                let mut patch = json!({"detail": detail});
                if event.command == "load" {
                    if let Some(stage) = model_setup_stage(&event.stage) {
                        patch["setupStage"] = stage.into();
                        patch["progress"] = Value::Null;
                    }
                    if event.stage == "warmup" {
                        patch["residency"] = "resident".into();
                        patch["warmup"] = "warming".into();
                    }
                }
                patch["downloadBytes"] = if event.command == "load" {
                    event
                        .download_bytes
                        .as_ref()
                        .and_then(|bytes| serde_json::to_value(bytes).ok())
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                this.update_status(patch);
            }
        };
        let magic_failure = {
            let weak = weak.clone();
            move |error: DomainError| {
                if let Some(this) = service(&weak) {
                    if !this.setup_aborted(Kind::Magic) && !this.manual_cancelled() {
                        this.fail_magic(&error);
                    }
                }
            }
        };
        let magic_progress = {
            let weak = weak.clone();
            move |detail: &str, event: &WorkerProgress| {
                let Some(this) = service(&weak) else { return };
                if this.setup_aborted(Kind::Magic) || this.manual_cancelled() {
                    return;
                }
                let mut patch = json!({"detail": detail});
                if event.command == "magicLoad" {
                    if let Some(stage) = model_setup_stage(&event.stage) {
                        patch["setupStage"] = stage.into();
                        patch["progress"] = Value::Null;
                    }
                }
                if event.command == "magicRewrite" && event.stage == "warmup" {
                    patch["setupStage"] = "warmup".into();
                    patch["warmup"] = "warming".into();
                    patch["progress"] = Value::Null;
                }
                patch["downloadBytes"] = if event.command == "magicLoad" {
                    event
                        .download_bytes
                        .as_ref()
                        .and_then(|bytes| serde_json::to_value(bytes).ok())
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                this.update_magic_status(patch);
            }
        };
        let options = |progress: delulu_runtime::worker::ProgressHandler| {
            delulu_runtime::WorkerClientOptions {
                on_progress: Some(progress),
                ..Default::default()
            }
        };
        let speech_worker = WorkerClient::with_options(
            config(Kind::Speech),
            speech_failure,
            options(Arc::new(speech_progress)),
        )
        .expect("default limits are valid");
        let magic_worker = WorkerClient::with_options(
            config(Kind::Magic),
            magic_failure,
            options(Arc::new(magic_progress)),
        )
        .expect("default limits are valid");
        Inner {
            paths,
            profile,
            runtime,
            speech_worker,
            magic_worker,
            speech_installer,
            magic_installer,
            maintenance: SerialQueue::new(),
            model_operations: SerialQueue::new(),
            status: StatusCell::new(
                channels::RUNTIME_STATUS,
                true,
                initial_status(),
                sink.clone(),
            ),
            magic: StatusCell::new(channels::MAGIC_STATUS, false, initial_magic_status(), sink),
            state: Mutex::new(State::default()),
            can_idle_unload: RwLock::new(always()),
        }
    }

    /// Who else owns the speech model (`!dictation.isActive && !listening.active`).
    pub fn set_idle_guard(&self, can_idle_unload: impl Fn() -> bool + Send + Sync + 'static) {
        *self.inner.can_idle_unload.write() = Arc::new(can_idle_unload);
    }

    fn can_idle_unload(&self) -> bool {
        let guard = self.inner.can_idle_unload.read().clone();
        guard()
    }

    /// Listener for speech status changes (after `runtime:statusChanged` is emitted).
    pub fn on_status(&self, listener: impl Fn(&DictationStatus) + Send + Sync + 'static) {
        self.inner
            .status
            .on_change(Arc::new(listener) as Listener<DictationStatus>);
    }

    /// Listener for rewriting status changes (after `magic:statusChanged` is emitted).
    pub fn on_magic_status(&self, listener: impl Fn(&MagicStatus) + Send + Sync + 'static) {
        self.inner
            .magic
            .on_change(Arc::new(listener) as Listener<MagicStatus>);
    }

    fn setup_aborted(&self, kind: Kind) -> bool {
        self.inner
            .state
            .lock()
            .setup(kind)
            .is_some_and(|op| op.token.is_cancelled())
    }

    fn manual_cancelled(&self) -> bool {
        self.inner
            .state
            .lock()
            .manual_rewrite
            .as_ref()
            .is_some_and(|op| op.cancelled())
    }

    fn installer(&self, kind: Kind) -> &Arc<RuntimeInstaller> {
        match kind {
            Kind::Speech => &self.inner.speech_installer,
            Kind::Magic => &self.inner.magic_installer,
        }
    }

    fn worker(&self, kind: Kind) -> &WorkerClient {
        match kind {
            Kind::Speech => &self.inner.speech_worker,
            Kind::Magic => &self.inner.magic_worker,
        }
    }

    /// `runtime:busy`: any setup, load, unload, request or manual rewrite.
    pub fn is_busy(&self) -> bool {
        let state = self.inner.state.lock();
        state.initializing
            || state.setup_promise.is_some()
            || state.magic_setup_promise.is_some()
            || self.inner.maintenance.busy()
            || self.inner.model_operations.busy()
            || self.inner.speech_worker.busy()
            || self.inner.magic_worker.busy()
            || state.load.is_some()
            || state.magic_load.is_some()
            || state.speech_unload.is_some()
            || state.magic_release.is_some()
            || state.speech_operations > 0
            || state.magic_operations > 0
            || state.manual_rewrite.is_some()
    }

    /// `runtime:setupLog` for `speech` or `rewrite`.
    pub fn setup_log(&self, kind: RuntimeSetupKind) -> RuntimeSetupLog {
        let (installer, runtime_kind) = match kind {
            RuntimeSetupKind::Speech => (
                &self.inner.speech_installer,
                delulu_runtime::RuntimeSetupKind::Speech,
            ),
            _ => (
                &self.inner.magic_installer,
                delulu_runtime::RuntimeSetupKind::Rewrite,
            ),
        };
        let snapshot = installer.setup_log.lock().snapshot(runtime_kind);
        convert(&snapshot).expect("setup logs are wire-identical")
    }

    pub fn status(&self) -> DictationStatus {
        self.inner.status.get()
    }

    pub fn magic_status(&self) -> MagicStatus {
        self.inner.magic.get()
    }

    pub fn set_recovery(&self, available: bool, retry_audio: Option<RetryAudioState>) {
        let mut patch = json!({"retryAvailable": available});
        if let Some(audio) = retry_audio {
            patch["retryAudio"] = serde_json::to_value(audio).unwrap_or(Value::Null);
        }
        self.update_status(patch);
    }

    pub fn set_capture_input_notice(&self, message: Option<&str>) {
        self.update_status(json!({"captureInputNotice": message}));
    }

    pub fn set_silence_countdown(&self, remaining_seconds: Option<f64>) {
        self.update_status(json!({"silenceCountdownSeconds": remaining_seconds}));
    }

    pub fn set_activity(&self, phase: DictationPhase, message: &str, detail: Option<&str>) {
        self.update_status(json!({"phase": phase, "message": message, "detail": detail}));
    }

    fn update_status(&self, patch: Value) {
        self.inner.status.update(patch);
    }

    fn update_magic_status(&self, patch: Value) {
        self.inner.magic.update(patch);
    }

    fn update(&self, kind: Kind, patch: Value) {
        match kind {
            Kind::Speech => self.update_status(patch),
            Kind::Magic => self.update_magic_status(patch),
        }
    }

    fn shutting_down(&self) -> bool {
        self.inner.state.lock().shutting_down
    }

    fn venv_directory(&self, kind: Kind) -> PathBuf {
        match kind {
            Kind::Speech => self.inner.paths.speech_venv(),
            Kind::Magic => self.inner.paths.magic_venv(),
        }
    }

    fn python_exists(&self, kind: Kind) -> bool {
        self.installer(kind)
            .python()
            .is_ok_and(|python| python.exists())
    }

    pub async fn initialize(&self, settings: &AppSettings) {
        {
            let mut state = self.inner.state.lock();
            state.shutting_down = false;
            state.initializing = true;
        }
        self.update_status(json!({"phase": "loading", "engine": "unloaded", "message": "Checking your speech runtime…"}));
        self.update_magic_status(
            json!({"phase": "loading", "engine": "unloaded", "message": "Checking your rewrite runtime…"}),
        );
        let (ready, magic_ready) = tokio::join!(
            self.is_environment_ready(settings),
            self.is_magic_environment_ready()
        );
        let (ready, magic_ready) = (ready.unwrap_or(false), magic_ready.unwrap_or(false));
        let migration_required = !ready && self.runtime_needs_update();
        self.inner.state.lock().initializing = false;
        if self.inner.maintenance.busy() {
            return;
        }
        self.update_status(if ready {
            json!({
                "phase": "idle", "engine": "unloaded",
                "message": if settings.preload_model { "Preparing the speech model" } else { "Speech runtime installed — speech model loads on demand" },
                "migrationRequired": false,
            })
        } else {
            json!({
                "phase": "idle", "engine": "missing",
                "message": if migration_required { "Speech runtime update required" } else { "Speech runtime setup required" },
                "migrationRequired": migration_required,
            })
        });
        self.update_magic_status(if magic_ready {
            json!({
                "phase": "idle", "engine": "unloaded",
                "message": if settings.magic_enabled { "Rewrite runtime installed — rewrite model loads on demand" } else { "Rewrite runtime installed — rewriting available on demand" },
            })
        } else {
            json!({"phase": "idle", "engine": "missing", "message": "Rewrite runtime setup required"})
        });
        if ready && settings.preload_model {
            let this = self.clone();
            let settings = settings.clone();
            self.inner.runtime.spawn(async move {
                if let Err(error) = this.load_model(&settings).await {
                    this.fail(&error);
                }
            });
        }
        if magic_ready
            && settings.preload_magic_model
            && settings.memory_policy != MemoryPolicy::Balanced
        {
            let this = self.clone();
            let settings = settings.clone();
            self.inner.runtime.spawn(async move {
                if let Err(error) = this.load_magic(&settings).await {
                    this.fail_magic(&error);
                }
            });
        }
    }

    /// Whether the active speech runtime can run the selected model size.
    pub async fn is_environment_ready(&self, settings: &AppSettings) -> DomainResult<bool> {
        self.inner
            .speech_installer
            .ready(RuntimeKind::Speech, speech_profile(settings))
            .await
    }

    pub async fn is_magic_environment_ready(&self) -> DomainResult<bool> {
        self.inner
            .magic_installer
            .ready(RuntimeKind::Magic, SpeechRuntimeProfile::Cpu)
            .await
    }

    /// An installed runtime that lacks the selected size's packages needs an
    /// update, as does a legacy shared `asr-venv`.
    fn runtime_needs_update(&self) -> bool {
        match self.inner.speech_installer.python() {
            Ok(python) => python.exists() || self.inner.paths.legacy_venv().exists(),
            Err(_) => true,
        }
    }

    /// Re-check the runtime after the model size changes, so setup is offered when needed.
    pub async fn refresh_environment(&self, settings: &AppSettings) -> DomainResult<()> {
        let blocked = |this: &Self| {
            let state = this.inner.state.lock();
            state.setup_promise.is_some() || this.inner.maintenance.busy() || state.shutting_down
        };
        if blocked(self) {
            return Ok(());
        }
        let ready = self.is_environment_ready(settings).await?;
        if blocked(self) {
            return Ok(());
        }
        if !ready {
            let update = self.runtime_needs_update();
            self.update_status(json!({
                "phase": "idle", "engine": "missing",
                "message": if update { "Speech runtime update required for this model size" } else { "Speech runtime setup required" },
                "migrationRequired": update, "model": null, "progress": null,
            }));
        } else if self.status().engine == EnginePhase::Missing {
            self.update_status(json!({
                "phase": "idle", "engine": "unloaded",
                "message": "Speech runtime installed — speech model loads on demand",
                "migrationRequired": false,
            }));
        }
        Ok(())
    }

    /// `runtime:setup`. A running setup is joined, not restarted.
    pub async fn setup(&self, settings: &AppSettings) -> DomainResult<()> {
        self.start_setup(Kind::Speech, settings).await
    }

    /// `magic:setup`.
    pub async fn setup_magic(&self, settings: &AppSettings) -> DomainResult<()> {
        self.start_setup(Kind::Magic, settings).await
    }

    fn start_setup(&self, kind: Kind, settings: &AppSettings) -> SharedTask {
        let mut state = self.inner.state.lock();
        let existing = match kind {
            Kind::Speech => state.setup_promise.clone(),
            Kind::Magic => state.magic_setup_promise.clone(),
        };
        if let Some(existing) = existing {
            return existing;
        }
        let previous_engine = match kind {
            Kind::Speech => self.status().engine,
            Kind::Magic => self.magic_status().engine,
        };
        let operation = Arc::new(SetupOperation {
            token: CancellationToken::new(),
            started: AtomicBool::new(false),
            previous_engine,
            promise: Mutex::new(None),
            termination: Mutex::new(None),
        });
        match kind {
            Kind::Speech => state.speech_setup = Some(operation.clone()),
            Kind::Magic => state.magic_setup = Some(operation.clone()),
        }
        let this = self.clone();
        let settings = settings.clone();
        let op = operation.clone();
        let promise = eager(&self.inner.runtime, async move {
            let result = this.setup_runtime(kind, &settings, op.clone()).await;
            {
                let mut state = this.inner.state.lock();
                match kind {
                    Kind::Speech => {
                        state.setup_promise = None;
                        if state
                            .speech_setup
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &op))
                        {
                            state.speech_setup = None;
                        }
                    }
                    Kind::Magic => {
                        state.magic_setup_promise = None;
                        if state
                            .magic_setup
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &op))
                        {
                            state.magic_setup = None;
                        }
                    }
                }
            }
            if !op.token.is_cancelled() {
                this.apply_deferred_residency();
            }
            result
        });
        match kind {
            Kind::Speech => state.setup_promise = Some(promise.clone()),
            Kind::Magic => state.magic_setup_promise = Some(promise.clone()),
        }
        *operation.promise.lock() = Some(promise.clone());
        promise
    }

    /// `runtime:cancelSetup` / `magic:cancelSetup`.
    pub async fn cancel_setup(&self, rewrite: bool) -> DomainResult<()> {
        let kind = if rewrite { Kind::Magic } else { Kind::Speech };
        let Some(operation) = self.inner.state.lock().setup(kind) else {
            return Ok(());
        };
        operation.token.cancel();
        match kind {
            Kind::Speech => {
                self.clear_speech_idle();
                self.update_status(json!({
                    "setupState": "cancelling",
                    "message": "Cancelling setup — releasing runtime resources…",
                    "progress": null,
                }));
            }
            Kind::Magic => {
                self.clear_magic_idle();
                self.update_magic_status(json!({
                    "setupState": "cancelling",
                    "message": "Cancelling rewriting setup — releasing runtime resources…",
                    "progress": null,
                }));
            }
        }
        if operation.started.load(Ordering::SeqCst) {
            let _ = self.terminate_setup(kind, &operation).await;
        }
        // The original operation owns candidate disposal and the terminal status.
        let promise = operation.promise.lock().clone();
        match promise {
            Some(promise) => promise.await,
            None => Ok(()),
        }
    }

    fn terminate_setup(&self, kind: Kind, operation: &SetupOperation) -> SharedTask {
        let mut termination = operation.termination.lock();
        if let Some(existing) = termination.as_ref() {
            return existing.clone();
        }
        let installer = self.installer(kind).clone();
        let worker = self.worker(kind).clone();
        let task = eager(&self.inner.runtime, async move {
            tokio::join!(installer.stop_and_wait(), worker.stop_and_wait(None));
            Ok(())
        });
        *termination = Some(task.clone());
        task
    }

    async fn setup_runtime(
        &self,
        kind: Kind,
        settings: &AppSettings,
        operation: Arc<SetupOperation>,
    ) -> DomainResult<()> {
        self.inner.state.lock().shutting_down = false;
        let installer = self.installer(kind).clone();
        installer.setup_log.lock().begin(match kind {
            Kind::Speech => delulu_runtime::RuntimeSetupKind::Speech,
            Kind::Magic => delulu_runtime::RuntimeSetupKind::Rewrite,
        });
        installer.record_setup_stage("Preparing owned runtime candidate");
        self.update(
            kind,
            json!({
                "setupState": "running", "phase": "preparing", "engine": "settingUp",
                "message": if kind == Kind::Speech { "Preparing speech setup" } else { "Preparing rewriting setup" },
                "progress": null,
            }),
        );
        let this = self.clone();
        let settings_owned = settings.clone();
        let op = operation.clone();
        let result = self
            .inner
            .maintenance
            .run(move || async move {
                let result = this.setup_transaction(kind, &settings_owned, &op).await;
                if result.is_err() && op.started.load(Ordering::SeqCst) {
                    // Keep the maintenance reservation until children are released and
                    // the staged candidate is no longer visible to worker configuration.
                    let _ = this.terminate_setup(kind, &op).await;
                    let installer = this.installer(kind);
                    installer.discard();
                    installer.reset_cancellation();
                }
                result
            })
            .await;
        let Err(error) = result else { return Ok(()) };
        let aborted = operation.token.is_cancelled();
        let active = installer.setup_log.lock().active_id();
        installer.setup_log.lock().finish(
            active.as_deref(),
            if aborted {
                FinalOutcome::Cancelled
            } else {
                FinalOutcome::Error
            },
            Some(if aborted {
                "Setup cancelled; previous runtime preserved"
            } else {
                "Setup failed; previous runtime preserved"
            }),
        );
        if aborted {
            let installed = self.python_exists(kind);
            let started = operation.started.load(Ordering::SeqCst);
            let engine = if started {
                if installed {
                    EnginePhase::Unloaded
                } else {
                    EnginePhase::Missing
                }
            } else {
                operation.previous_engine
            };
            let mut patch = json!({
                "phase": "idle", "engine": engine, "setupState": "cancelled",
                "message": if installed || (!started && engine != EnginePhase::Missing) {
                    "Setup cancelled. Your previous runtime is preserved."
                } else {
                    "Setup cancelled. No new runtime was activated; setup is still required."
                },
                "detail": null, "progress": null,
            });
            if started {
                patch["model"] = Value::Null;
                if kind == Kind::Magic {
                    patch["device"] = Value::Null;
                }
            }
            self.update(kind, patch);
            return Ok(());
        }
        match kind {
            Kind::Speech => {
                self.fail(&error);
                self.update_status(json!({"setupState": "failed"}));
                if self.is_environment_ready(settings).await.unwrap_or(false) {
                    self.update_status(json!({
                        "phase": "idle", "engine": "unloaded",
                        "message": "Setup failed; your existing runtime is preserved. Load it to continue, or retry Repair.",
                        "progress": null,
                    }));
                }
            }
            Kind::Magic => {
                self.fail_magic(&error);
                self.update_magic_status(json!({"setupState": "failed"}));
                if self.is_magic_environment_ready().await.unwrap_or(false) {
                    self.update_magic_status(json!({
                        "phase": "idle", "engine": "unloaded",
                        "message": "Setup failed; your existing Writing runtime is preserved. Load it to continue, or retry Repair.",
                        "progress": null,
                    }));
                }
            }
        }
        Err(error)
    }

    /// Installs a candidate, loads and warms it, and only then activates it.
    async fn setup_transaction(
        &self,
        kind: Kind,
        settings: &AppSettings,
        operation: &Arc<SetupOperation>,
    ) -> DomainResult<()> {
        let token = operation.token.clone();
        let aborted = || {
            if token.is_cancelled() {
                Err(plain("Runtime setup cancelled"))
            } else {
                Ok(())
            }
        };
        let current: Eligible = {
            let this = self.clone();
            let operation = operation.clone();
            Arc::new(move || {
                let state = this.inner.state.lock();
                !operation.token.is_cancelled()
                    && !state.shutting_down
                    && operation.termination.lock().is_none()
                    && state
                        .setup(kind)
                        .is_some_and(|current| Arc::ptr_eq(&current, &operation))
            })
        };
        aborted()?;
        operation.started.store(true, Ordering::SeqCst);
        self.worker(kind).stop_and_wait(None).await;
        self.update(kind, Value::Object(unloaded_lifecycle()));
        aborted()?;
        let install_settings = InstallSettings {
            python_command: settings.python_command.clone(),
            speech_engine: convert(&settings.speech_engine)
                .expect("speech tiers are wire-identical"),
            voice_engine: convert(&settings.voice_engine)
                .expect("voice engines are wire-identical"),
        };
        let runtime_kind = if kind == Kind::Speech {
            RuntimeKind::Speech
        } else {
            RuntimeKind::Magic
        };
        let publish = {
            let this = self.clone();
            let current = current.clone();
            move |progress: delulu_runtime::InstallProgress| {
                if !current() {
                    return;
                }
                let patch = merge(
                    serde_json::from_value(json!({"phase": "preparing", "engine": "settingUp"}))
                        .unwrap_or_default(),
                    serde_json::to_value(progress).unwrap_or(Value::Null),
                );
                this.update(kind, patch);
            }
        };
        self.installer(kind)
            .install(
                runtime_kind,
                &install_settings,
                publish,
                Some(token.clone()),
            )
            .await?;
        aborted()?;
        // Only this setup worker sees the prepared candidate. The saved active
        // pointer remains unchanged throughout model download/load/warmup.
        match kind {
            Kind::Speech => {
                self.run_model_operation(
                    settings,
                    self.perform_load_model(settings, true, current.clone()),
                )
                .await?
            }
            Kind::Magic => {
                self.run_model_operation(
                    settings,
                    self.perform_load_magic(settings, true, current.clone()),
                )
                .await?
            }
        }
        aborted()?;
        if self.shutting_down() {
            return Err(plain("Runtime setup interrupted by shutdown"));
        }
        if kind == Kind::Magic {
            // Exercise writing inference before publishing the candidate pointer.
            // This fixed local warmup is never stored or delivered.
            self.request(
                kind,
                "magicRewrite",
                json!({"text": "Warmup.", "preset": "polish", "instructions": "", "allowInferences": false, "warmup": true}),
                None,
            )
            .await?;
        }
        aborted()?;
        let runtime = self
            .request(
                kind,
                if kind == Kind::Speech {
                    "status"
                } else {
                    "magicStatus"
                },
                json!({}),
                None,
            )
            .await?;
        if !loaded(&runtime) || runtime.get("warmup").and_then(Value::as_str) != Some("complete") {
            return Err(plain(
                "Candidate inference warmup did not complete; previous runtime remains selected",
            ));
        }
        aborted()?;
        if !current() {
            return Err(plain("Runtime candidate no longer owns setup"));
        }
        let installer = self.installer(kind);
        installer.commit()?;
        let active = installer.setup_log.lock().active_id();
        installer.setup_log.lock().finish(
            active.as_deref(),
            FinalOutcome::Success,
            Some("Runtime activated after inference warmup"),
        );
        let mut completed = reported_lifecycle(&runtime);
        completed.extend(
            serde_json::from_value::<Map<String, Value>>(json!({
                "phase": "idle", "engine": "ready", "setupStage": "ready", "setupState": "complete",
                "message": "Runtime activated after inference warmup", "detail": null, "progress": 1,
            }))
            .unwrap_or_default(),
        );
        if kind == Kind::Speech {
            completed.insert(
                "speechExecution".into(),
                serde_json::to_value(normalize_speech_execution(
                    runtime.get("speechExecution").unwrap_or(&Value::Null),
                ))
                .unwrap_or(Value::Null),
            );
            completed.insert("migrationRequired".into(), false.into());
        }
        self.update(kind, Value::Object(completed));
        // Apply configured preloads after this transaction releases its
        // reservation, without making the other runtime part of cancellation.
        self.inner.state.lock().residency_pending = true;
        Ok(())
    }

    fn worker_environment(&self, kind: Kind) -> delulu_runtime::ChildEnv {
        let fallback =
            self.venv_directory(kind)
                .join(if cfg!(windows) { "Scripts" } else { "bin" });
        // Repair must still run when the old activation record is damaged.
        let bin = self
            .installer(kind)
            .python()
            .ok()
            .and_then(|python| python.parent().map(Path::to_path_buf))
            .unwrap_or(fallback);
        runtime_environment(
            if kind == Kind::Speech {
                RuntimeKind::Speech
            } else {
                RuntimeKind::Magic
            },
            &self.inner.paths.data,
            &self.inner.paths.models(),
            &bin,
            delulu_core::host_vars(),
        )
    }

    fn request(
        &self,
        kind: Kind,
        command: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'static, DomainResult<Value>> {
        if self.shutting_down() {
            return futures::future::ready(Err(plain("The model engines are shutting down")))
                .boxed();
        }
        let allowed: &[&str] = match kind {
            Kind::Speech => &[
                "capabilities",
                "load",
                "unload",
                "status",
                "transcribe",
                "shutdown",
            ],
            Kind::Magic => &[
                "capabilities",
                "magicLoad",
                "magicStatus",
                "magicRewrite",
                "shutdown",
            ],
        };
        if !allowed.contains(&command) {
            let runtime = if kind == Kind::Speech {
                "speech"
            } else {
                "magic"
            };
            return futures::future::ready(Err(plain(format!(
                "{command} is not allowed in the {runtime} runtime"
            ))))
            .boxed();
        }
        self.worker(kind).request(command, payload, timeout).boxed()
    }

    async fn negotiate_capabilities(
        &self,
        kind: Kind,
        model: Option<SpeechWorkerModel>,
    ) -> DomainResult<BackendCapabilities> {
        let engine = if kind == Kind::Speech {
            "speech"
        } else {
            "writing"
        };
        let mut payload = json!({"engine": engine});
        if let Some(model) = model {
            payload["model"] = model.as_str().into();
        }
        let value = self.request(kind, "capabilities", payload, None).await?;
        let capabilities: BackendCapabilities = serde_json::from_value(value).map_err(|error| {
            plain(format!(
                "The {engine} runtime reported invalid capabilities: {error}"
            ))
        })?;
        let cpu =
            kind == Kind::Speech && model.is_some_and(|model| model != SpeechWorkerModel::R2t2);
        let backend = if kind == Kind::Magic {
            "transformers"
        } else if cpu {
            "onnx-cpu"
        } else if platform_speech_model() == SpeechModelId::R2t2Mlx {
            "mlx"
        } else {
            "cuda-transformers"
        };
        let family = if kind == Kind::Magic {
            "qwen3.5"
        } else if model == Some(SpeechWorkerModel::Canary180m) {
            "canary"
        } else if cpu {
            "parakeet"
        } else {
            "r2t2"
        };
        if capabilities.engine.as_str() != engine
            || capabilities.model_family.as_str() != family
            || capabilities.backend.as_str() != backend
        {
            return Err(plain(format!(
                "The {engine} runtime reported an incompatible adapter. Expected {backend} for {family}; repair the local runtime before loading a model."
            )));
        }
        Ok(capabilities)
    }

    async fn run_model_operation<T: Send + 'static>(
        &self,
        settings: &AppSettings,
        operation: impl std::future::Future<Output = DomainResult<T>> + Send + 'static,
    ) -> DomainResult<T> {
        if settings.memory_policy != MemoryPolicy::Balanced {
            return operation.await;
        }
        let result = self.inner.model_operations.run(move || operation).await;
        self.apply_deferred_residency();
        result
    }

    async fn release_magic_for_speech(&self, settings: &AppSettings) -> DomainResult<()> {
        if settings.memory_policy != MemoryPolicy::Balanced {
            return Ok(());
        }
        let release = self.inner.state.lock().magic_release.clone();
        if let Some(release) = release {
            release.await?;
        }
        if matches!(
            self.magic_status().engine,
            EnginePhase::Missing | EnginePhase::Unloaded
        ) {
            return Ok(());
        }
        // Called inside the balanced operation queue: rewriting has finished and
        // its result is already returned. Stopping only the worker leaves raw
        // transcripts, buffered audio and settings in their owning services.
        self.perform_unload_magic(true).await?;
        self.update_magic_status(
            json!({"message": "Magic released for speech by balanced memory policy"}),
        );
        Ok(())
    }

    /// `runtime:load` and tray "Load model now".
    pub async fn load_model(&self, settings: &AppSettings) -> DomainResult<()> {
        self.run_model_operation(settings, self.perform_load_model(settings, false, always()))
            .await
    }

    fn perform_load_model(
        &self,
        settings: &AppSettings,
        from_setup: bool,
        eligible: Eligible,
    ) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        let settings = settings.clone();
        async move {
            if !eligible() {
                return Ok(());
            }
            if this.shutting_down() {
                return Err(plain("The speech model worker is shutting down"));
            }
            if !from_setup && this.inner.maintenance.busy() {
                return Err(plain("Wait for runtime setup to finish"));
            }
            let promise = {
                let state = this.inner.state.lock();
                if let Some(load) = state.load.clone() {
                    load
                } else {
                    drop(state);
                    this.clear_speech_idle();
                    let mut state = this.inner.state.lock();
                    let worker = this.clone();
                    let eligible = eligible.clone();
                    let settings = settings.clone();
                    let promise = eager(&this.inner.runtime, async move {
                        let result = worker
                            .load_speech_body(&settings, from_setup, &eligible)
                            .await;
                        let result = match result {
                            Err(error) if eligible() => {
                                worker.inner.speech_worker.stop_and_wait(None).await;
                                if eligible() {
                                    worker.fail(&error);
                                    Err(error)
                                } else {
                                    Ok(())
                                }
                            }
                            Err(_) => Ok(()),
                            ok => ok,
                        };
                        worker.inner.state.lock().load = None;
                        worker.apply_deferred_residency();
                        result
                    });
                    state.load = Some(promise.clone());
                    promise
                }
            };
            promise.await
        }
        .boxed()
    }

    async fn load_speech_body(
        &self,
        settings: &AppSettings,
        from_setup: bool,
        eligible: &Eligible,
    ) -> DomainResult<()> {
        let unload = self.inner.state.lock().speech_unload.clone();
        if let Some(unload) = unload {
            unload.await?;
        }
        self.release_magic_for_speech(settings).await?;
        if !eligible() {
            return Ok(());
        }
        let ready = from_setup || self.is_environment_ready(settings).await?;
        if !eligible() {
            return Ok(());
        }
        if !ready {
            return Err(plain(
                "Speech runtime setup is required before loading the speech model",
            ));
        }
        let name = speech_model_name(settings);
        self.update_status(json!({
            "phase": "loading", "engine": "loading", "setupStage": "model-prepare",
            "residency": "loading", "warmup": "unknown", "device": null, "detail": null, "capabilities": null,
            "message": format!("Loading and warming up speech model {name}. Ready means speech inference has been exercised, not just the weights loaded."),
            "model": settings.model, "progress": 0.85,
        }));
        let engine = speech_engine_id(settings);
        let capabilities = self
            .negotiate_capabilities(Kind::Speech, Some(engine))
            .await?;
        self.update_status(json!({"capabilities": capabilities}));
        if !eligible() {
            return Ok(());
        }
        let runtime = self
            .request(
                Kind::Speech,
                "load",
                json!({"cacheDir": self.inner.paths.models(), "model": engine.as_str(), "language": settings.language}),
                None,
            )
            .await?;
        self.inner.state.lock().loaded_engine = Some(engine);
        if !loaded(&runtime) {
            return Err(plain("Speech model load did not report loaded weights"));
        }
        if !eligible() {
            return Ok(());
        }
        let complete = runtime.get("warmup").and_then(Value::as_str) == Some("complete");
        let mut patch = reported_lifecycle(&runtime);
        patch.extend(
            serde_json::from_value::<Map<String, Value>>(json!({
                "phase": if from_setup { "preparing" } else { "idle" },
                "engine": if from_setup { "settingUp" } else { "ready" },
                "setupStage": if from_setup { "warmup" } else if complete { "ready" } else { "model-loaded" },
                "message": if from_setup {
                    "Candidate model loaded; completing setup warmup and activation".to_owned()
                } else if complete {
                    format!("{name} ready")
                } else {
                    format!("{name} loaded; warmup not reported complete")
                },
                "speechExecution": normalize_speech_execution(runtime.get("speechExecution").unwrap_or(&Value::Null)),
                "detail": null,
                "model": settings.model,
                "progress": if from_setup { Value::Null } else { 1.into() },
                "migrationRequired": false,
            }))
            .unwrap_or_default(),
        );
        self.update_status(Value::Object(patch));
        if !from_setup {
            self.schedule_speech_idle();
        }
        Ok(())
    }

    /// Loads the selected speech model unless it is already ready.
    pub async fn ensure_loaded(&self, settings: &AppSettings) -> DomainResult<()> {
        self.ensure_loaded_if(settings, always()).await
    }

    fn ensure_loaded_if(
        &self,
        settings: &AppSettings,
        eligible: Eligible,
    ) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        let settings = settings.clone();
        async move {
            if !eligible() {
                return Ok(());
            }
            if this.shutting_down() {
                return Err(plain("The speech model worker is shutting down"));
            }
            let unload = this.inner.state.lock().speech_unload.clone();
            if let Some(unload) = unload {
                unload.await?;
            }
            if !eligible() {
                return Ok(());
            }
            if this.shutting_down() {
                return Err(plain("The speech model worker is shutting down"));
            }
            let status = this.status();
            if status.engine == EnginePhase::Ready
                && status.model == Some(settings.model)
                && this.inner.state.lock().loaded_engine == Some(speech_engine_id(&settings))
            {
                return Ok(());
            }
            this.perform_load_model(&settings, false, eligible).await
        }
        .boxed()
    }

    /// Transcribes `{ audioPath, durationMs? }` with the given settings.
    pub async fn transcribe(&self, payload: Value, settings: &AppSettings) -> DomainResult<Value> {
        let this = self.clone();
        let captured = settings.clone();
        self.run_model_operation(settings, async move {
            this.perform_transcription(payload, &captured).await
        })
        .await
    }

    async fn perform_transcription(
        &self,
        payload: Value,
        settings: &AppSettings,
    ) -> DomainResult<Value> {
        let started = Instant::now();
        self.inner.state.lock().speech_operations += 1;
        self.clear_speech_idle();
        let _finally = Finally(|| {
            self.inner.state.lock().speech_operations -= 1;
            self.schedule_speech_idle();
            self.apply_deferred_residency();
        });
        let load_started = Instant::now();
        self.release_magic_for_speech(settings).await?;
        self.ensure_loaded(settings).await?;
        let speech_load_ms = elapsed_ms(load_started);
        self.clear_speech_idle();
        // A cold load reports "ready"; the dictation is still being transcribed.
        if self.status().phase != DictationPhase::Transcribing {
            self.update_status(json!({"phase": "transcribing", "message": "Transcribing locally"}));
        }
        let status = self.status();
        let Some(capabilities) = status.lifecycle.capabilities.clone() else {
            return Err(plain("Speech capabilities are unavailable. Reload the speech model before recording again."));
        };
        if capabilities.language_hints.supported
            && !capabilities
                .language_hints
                .languages
                .contains(&settings.language)
        {
            let choices = capabilities.language_hints.languages.join(", ");
            return Err(plain(format!(
                "The speech adapter does not support language {}. {}",
                settings.language,
                if choices.is_empty() {
                    "This adapter advertises no language hints; repair the local speech runtime."
                        .to_owned()
                } else {
                    format!("Choose a supported language in Settings: {choices}.")
                }
            )));
        }
        let request_started = Instant::now();
        // Capture this execution before the asynchronous request; future loads must
        // never relabel the transcript produced by the current worker.
        let execution = status.speech_execution.clone();
        let mut request = match payload {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let duration = request.get("durationMs").and_then(Value::as_f64);
        request.insert("language".into(), settings.language.clone().into());
        request.insert("model".into(), speech_engine_id(settings).as_str().into());
        if capabilities.vocabulary_biasing && settings.vocabulary_hints {
            let rules = active_rules(&settings.custom_words, &settings.word_packs);
            request.insert(
                "hotwords".into(),
                recognition_hints(&rules, &settings.language).into(),
            );
        }
        let result = self
            .request(
                Kind::Speech,
                "transcribe",
                Value::Object(request),
                Some(transcription_timeout(duration)),
            )
            .await?;
        let speech_request_ms = elapsed_ms(request_started);
        let mut output = match result {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let mut timings = normalize_timings(output.get("timings").unwrap_or(&Value::Null))
            .and_then(|timings| match serde_json::to_value(timings) {
                Ok(Value::Object(map)) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        timings.insert("speechLoadMs".into(), json!(speech_load_ms));
        timings.insert("speechRequestMs".into(), json!(speech_request_ms));
        match normalize_timings(&Value::Object(timings)) {
            Some(timings) => output.insert(
                "timings".into(),
                serde_json::to_value(timings).unwrap_or(Value::Null),
            ),
            None => output.remove("timings"),
        };
        match execution {
            Some(execution) => output.insert(
                "speechExecution".into(),
                serde_json::to_value(execution).unwrap_or(Value::Null),
            ),
            None => output.remove("speechExecution"),
        };
        output.insert(
            "processingTime".into(),
            json!(started.elapsed().as_secs_f64()),
        );
        Ok(Value::Object(output))
    }

    /// `runtime:unload` and tray "Unload model".
    pub fn unload(&self) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        async move {
            if this.inner.model_operations.busy() {
                return Err(plain("Wait for the current model operation before unloading"));
            }
            let promise = {
                let state = this.inner.state.lock();
                if let Some(unload) = state.speech_unload.clone() {
                    unload
                } else {
                    let busy = this.inner.speech_worker.busy() || state.load.is_some() || state.speech_operations > 0;
                    drop(state);
                    if busy || !this.can_idle_unload() {
                        return Err(plain("Wait for speech to finish before unloading"));
                    }
                    this.clear_speech_idle();
                    let mut state = this.inner.state.lock();
                    let worker = this.clone();
                    let promise = eager(&this.inner.runtime, async move {
                        worker.update_status(json!({"residency": "unloading", "idleUnloadAt": null}));
                        worker.inner.speech_worker.stop_and_wait(None).await;
                        worker.inner.state.lock().loaded_engine = None;
                        worker.update_status(json!({
                            "phase": "idle",
                            "engine": if worker.python_exists(Kind::Speech) { "unloaded" } else { "missing" },
                            "message": "Speech model unloaded", "model": null, "progress": null,
                        }));
                        worker.inner.state.lock().speech_unload = None;
                        worker.apply_deferred_residency();
                        Ok(())
                    });
                    state.speech_unload = Some(promise.clone());
                    promise
                }
            };
            promise.await
        }
        .boxed()
    }

    /// `magic:load` and tray "Load model now".
    pub async fn load_magic(&self, settings: &AppSettings) -> DomainResult<()> {
        self.run_model_operation(settings, self.perform_load_magic(settings, false, always()))
            .await
    }

    fn perform_load_magic(
        &self,
        settings: &AppSettings,
        from_setup: bool,
        eligible: Eligible,
    ) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        let settings = settings.clone();
        async move {
            if !eligible() {
                return Ok(());
            }
            // A manual rewrite may join a load already awaiting runtime readiness.
            let operation = Arc::new(Mutex::new(this.inner.state.lock().manual_rewrite.clone()));
            let guard = {
                let this = this.clone();
                let operation = operation.clone();
                move || {
                    let mut operation = operation.lock();
                    if operation.is_none() {
                        *operation = this.inner.state.lock().manual_rewrite.clone();
                    }
                    throw_if_cancelled(&operation)
                }
            };
            guard()?;
            if this.shutting_down() {
                return Err(plain("The rewrite model worker is shutting down"));
            }
            if !from_setup && this.inner.maintenance.busy() {
                return Err(plain("Wait for runtime setup to finish"));
            }
            let promise = {
                let state = this.inner.state.lock();
                if let Some(load) = state.magic_load.clone() {
                    load
                } else {
                    drop(state);
                    this.clear_magic_idle();
                    let mut state = this.inner.state.lock();
                    let worker = this.clone();
                    let promise = eager(&this.inner.runtime, async move {
                        let result = worker
                            .load_magic_body(&settings, from_setup, &eligible, &guard)
                            .await;
                        let result = match result {
                            Err(error) => {
                                let mut current = operation.lock().clone();
                                if current.is_none() {
                                    current = worker.inner.state.lock().manual_rewrite.clone();
                                }
                                match current {
                                    Some(op) if op.cancelled() => {
                                        let cleanup = op.cancel_promise.lock().clone();
                                        if let Some(cleanup) = cleanup {
                                            let _ = cleanup.await;
                                        }
                                        Err(rewrite_cancelled())
                                    }
                                    _ if !eligible() => Ok(()),
                                    _ => {
                                        worker.fail_magic(&error);
                                        Err(error)
                                    }
                                }
                            }
                            ok => ok,
                        };
                        worker.inner.state.lock().magic_load = None;
                        worker.apply_deferred_residency();
                        result
                    });
                    state.magic_load = Some(promise.clone());
                    promise
                }
            };
            promise.await
        }
        .boxed()
    }

    async fn load_magic_body(
        &self,
        settings: &AppSettings,
        from_setup: bool,
        eligible: &Eligible,
        guard: &(dyn Fn() -> DomainResult<()> + Send + Sync),
    ) -> DomainResult<()> {
        let release = self.inner.state.lock().magic_release.clone();
        if let Some(release) = release {
            release.await?;
        }
        if !eligible() {
            return Ok(());
        }
        let ready = from_setup || self.is_magic_environment_ready().await?;
        if !eligible() {
            return Ok(());
        }
        if !ready {
            return Err(plain("Install the rewrite runtime before loading a model"));
        }
        guard()?;
        let name = magic_model_by_id(settings.magic_model).name.clone();
        self.update_magic_status(json!({
            "phase": "loading", "engine": "loading", "setupStage": "model-prepare",
            "residency": "loading", "warmup": "unknown", "device": null, "detail": null, "capabilities": null,
            "message": format!("Loading rewrite model {name}"),
            "model": settings.magic_model, "progress": 0.86,
        }));
        let capabilities = self.negotiate_capabilities(Kind::Magic, None).await?;
        guard()?;
        self.update_magic_status(json!({"capabilities": capabilities}));
        if !eligible() {
            return Ok(());
        }
        guard()?;
        let runtime = self
            .request(
                Kind::Magic,
                "magicLoad",
                json!({"model": settings.magic_model, "cacheDir": self.inner.paths.models()}),
                None,
            )
            .await?;
        guard()?;
        if !loaded(&runtime) {
            return Err(plain("Writing model load did not report loaded weights"));
        }
        if !eligible() {
            return Ok(());
        }
        let complete = runtime.get("warmup").and_then(Value::as_str) == Some("complete");
        let mut patch = reported_lifecycle(&runtime);
        patch.extend(
            serde_json::from_value::<Map<String, Value>>(json!({
                "phase": if from_setup { "preparing" } else { "idle" },
                "engine": if from_setup { "settingUp" } else { "ready" },
                "setupStage": if from_setup { "warmup" } else if complete { "ready" } else { "model-loaded" },
                "message": if from_setup {
                    "Candidate model loaded; completing setup warmup and activation".to_owned()
                } else if complete {
                    format!("{name} ready")
                } else {
                    format!("{name} loaded; warmup not reported complete")
                },
                "model": settings.magic_model,
                "progress": if from_setup { Value::Null } else { 1.into() },
            }))
            .unwrap_or_default(),
        );
        self.update_magic_status(Value::Object(patch));
        guard()?;
        if !from_setup {
            self.schedule_magic_idle();
        }
        Ok(())
    }

    fn ensure_magic_loaded(
        &self,
        settings: &AppSettings,
        eligible: Eligible,
        operation: Option<Arc<ManualRewrite>>,
    ) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        let settings = settings.clone();
        async move {
            if !eligible() {
                return Ok(());
            }
            throw_if_cancelled(&operation)?;
            if this.shutting_down() {
                return Err(plain("The rewrite model worker is shutting down"));
            }
            let release = this.inner.state.lock().magic_release.clone();
            if let Some(release) = release {
                release.await?;
            }
            if !eligible() {
                return Ok(());
            }
            throw_if_cancelled(&operation)?;
            if this.shutting_down() {
                return Err(plain("The rewrite model worker is shutting down"));
            }
            let status = this.magic_status();
            if status.engine == EnginePhase::Ready && status.model == Some(settings.magic_model) {
                return Ok(());
            }
            this.perform_load_magic(&settings, false, eligible).await?;
            throw_if_cancelled(&operation)
        }
        .boxed()
    }

    fn release_manual_rewrite(&self, operation: &Arc<ManualRewrite>) {
        let mut state = self.inner.state.lock();
        if operation.settled.load(Ordering::SeqCst)
            && (!operation.cancelled() || operation.cancel_promise.lock().is_none())
            && state
                .manual_rewrite
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            state.manual_rewrite = None;
        }
    }

    /// `magic:cancelRewrite`. Stops the worker of the matching manual rewrite.
    pub async fn cancel_rewrite(&self, operation_id: &str) -> bool {
        let operation = self.inner.state.lock().manual_rewrite.clone();
        let Some(operation) = operation else {
            return false;
        };
        if operation.id != operation_id || operation.settled.load(Ordering::SeqCst) {
            return false;
        }
        if !operation.cancelled.swap(true, Ordering::SeqCst) {
            self.clear_magic_idle();
            let this = self.clone();
            let task = eager(&self.inner.runtime, async move {
                this.inner
                    .magic_worker
                    .stop_and_wait(Some(rewrite_cancelled()))
                    .await;
                let mut patch = unloaded_lifecycle();
                patch.extend(
                    serde_json::from_value::<Map<String, Value>>(json!({
                        "phase": "idle", "engine": "unloaded", "message": "Rewrite cancelled",
                        "model": null, "detail": null, "progress": null,
                    }))
                    .unwrap_or_default(),
                );
                this.update_magic_status(Value::Object(patch));
                Ok(())
            });
            *operation.cancel_promise.lock() = Some(task);
        }
        let cleanup = operation.cancel_promise.lock().clone();
        if let Some(cleanup) = cleanup {
            let _ = cleanup.await;
        }
        *operation.cancel_promise.lock() = None;
        self.release_manual_rewrite(&operation);
        self.apply_deferred_residency();
        true
    }

    /// `magic:rewrite` (manual, with an operation ID) and the dictation pipeline.
    pub async fn rewrite_magic(
        &self,
        request: MagicRewriteRequest,
        settings: &AppSettings,
    ) -> DomainResult<MagicRewriteResult> {
        let this = self.clone();
        let captured = settings.clone();
        self.run_model_operation(settings, async move {
            this.perform_rewrite(request, &captured).await
        })
        .await
    }

    async fn perform_rewrite(
        &self,
        mut request: MagicRewriteRequest,
        settings: &AppSettings,
    ) -> DomainResult<MagicRewriteResult> {
        let context = match &request.context {
            Some(context) => normalize_rewrite_context(Some(&serde_json::to_value(context)?))?,
            None => None,
        };
        {
            let state = self.inner.state.lock();
            if state.manual_rewrite.is_some()
                || (request.operation_id.is_some() && state.magic_operations > 0)
            {
                return Err(plain("Wait for the active rewrite to finish"));
            }
        }
        if request
            .operation_id
            .as_deref()
            .is_some_and(|id| js::trim(id).is_empty())
        {
            return Err(plain("Manual rewrite requires a nonempty operation ID"));
        }
        let cleanup = request.preset == MagicPreset::SpokenCorrections;
        if cleanup {
            request.allow_inferences = false;
            request.instructions = None;
            request.context = None;
        }
        let context = if cleanup { None } else { context };
        let parts: Vec<TextPart> = if cleanup {
            vec![TextPart::new(request.text.clone(), false)]
        } else {
            let rules = active_rules(&settings.custom_words, &settings.word_packs);
            let language = request
                .source_language
                .clone()
                .unwrap_or_else(|| settings.language.clone());
            split_technical_blocks(&request.text)
                .into_iter()
                .flat_map(|part| {
                    if part.protected {
                        vec![part]
                    } else {
                        split_for_rewrite(&part.text, &rules, Some(&language))
                    }
                })
                .collect()
        };
        if parts
            .iter()
            .filter(|part| !part.protected && !js::trim(&part.text).is_empty())
            .count()
            > 16
        {
            return Err(plain(
                "This text contains too many separate protected blocks or identifiers to rewrite at once. Rewrite a shorter selection.",
            ));
        }
        let operation = request.operation_id.clone().map(|id| {
            Arc::new(ManualRewrite {
                id,
                cancelled: AtomicBool::new(false),
                settled: AtomicBool::new(false),
                cancel_promise: Mutex::new(None),
            })
        });
        {
            let mut state = self.inner.state.lock();
            if let Some(operation) = &operation {
                state.manual_rewrite = Some(operation.clone());
            }
            state.magic_operations += 1;
        }
        self.clear_magic_idle();
        let _finally = Finally(|| {
            self.inner.state.lock().magic_operations -= 1;
            if let Some(operation) = &operation {
                operation.settled.store(true, Ordering::SeqCst);
                self.release_manual_rewrite(operation);
            }
            self.schedule_magic_idle();
            self.apply_deferred_residency();
        });
        let result = self
            .rewrite_parts(&request, context, &parts, cleanup, settings, &operation)
            .await;
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                if let Some(operation) =
                    operation.as_ref().filter(|operation| operation.cancelled())
                {
                    let cleanup = operation.cancel_promise.lock().clone();
                    if let Some(cleanup) = cleanup {
                        let _ = cleanup.await;
                    }
                    return Err(rewrite_cancelled());
                }
                self.fail_magic(&error);
                Err(error)
            }
        }
    }

    async fn rewrite_parts(
        &self,
        request: &MagicRewriteRequest,
        context: Option<delulu_domain::MagicRewriteContext>,
        parts: &[TextPart],
        cleanup: bool,
        settings: &AppSettings,
        operation: &Option<Arc<ManualRewrite>>,
    ) -> DomainResult<MagicRewriteResult> {
        throw_if_cancelled(operation)?;
        let load_started = Instant::now();
        self.ensure_magic_loaded(settings, always(), operation.clone())
            .await?;
        let rewrite_load_ms = elapsed_ms(load_started);
        throw_if_cancelled(operation)?;
        self.clear_magic_idle();
        let name = magic_model_by_id(settings.magic_model).name.clone();
        self.update_magic_status(json!({
            "phase": "rewriting", "engine": "ready", "message": format!("{name} is rewriting"), "progress": null,
        }));
        throw_if_cancelled(operation)?;
        let mut output = String::new();
        let mut processing_time_ms = 0.0;
        let mut rewriting_ms = 0.0;
        let mut base = match serde_json::to_value(request)? {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        match &context {
            Some(context) => base.insert("context".into(), serde_json::to_value(context)?),
            None => base.remove("context"),
        };
        for part in parts {
            throw_if_cancelled(operation)?;
            let trimmed = js::trim(&part.text);
            if part.protected || trimmed.is_empty() {
                output.push_str(&part.text);
                continue;
            }
            let mut payload = base.clone();
            payload.insert("text".into(), trimmed.into());
            let request_started = Instant::now();
            let result = self
                .request(Kind::Magic, "magicRewrite", Value::Object(payload), None)
                .await?;
            rewriting_ms += elapsed_ms(request_started);
            throw_if_cancelled(operation)?;
            let mut lifecycle = Map::new();
            for key in ["residency", "warmup", "device"] {
                if let Some(value) = result.get(key) {
                    lifecycle.insert(key.into(), value.clone());
                }
            }
            if !lifecycle.is_empty() {
                self.update_magic_status(Value::Object(lifecycle));
            }
            processing_time_ms += result
                .get("processingTimeMs")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let text = result
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Preserve separators around immutable blocks; they never enter the model.
            let leading = &part.text[..part.text.len() - js::trim_start(&part.text).len()];
            let trailing = &part.text[js::trim_end(&part.text).len()..];
            output.push_str(leading);
            output.push_str(js::trim(text));
            output.push_str(trailing);
        }
        if cleanup
            && split_technical_blocks(&request.text)
                .iter()
                .any(|part| part.protected && !output.contains(js::trim(&part.text)))
        {
            return Err(plain(
                "Cleanup changed a protected code block. Review the original; nothing sent.",
            ));
        }
        throw_if_cancelled(operation)?;
        let warm = self.magic_status().lifecycle.warmup == Some(WarmupState::Complete);
        self.update_magic_status(json!({
            "phase": "idle", "engine": "ready",
            "setupStage": if warm { "ready" } else { "model-loaded" },
            "message": if warm { format!("{name} ready") } else { format!("{name} loaded; warmup not reported complete") },
            "progress": 1,
        }));
        throw_if_cancelled(operation)?;
        Ok(MagicRewriteResult {
            lifecycle: Default::default(),
            timings: normalize_timings(
                &json!({"rewriteLoadMs": rewrite_load_ms, "rewritingMs": rewriting_ms}),
            ),
            preset: Some(request.preset),
            input_characters: js::utf16_len(&request.text) as u64,
            output_characters: js::utf16_len(&output) as u64,
            text: output,
            model: settings.magic_model,
            processing_time_ms,
            included_inferences: request.allow_inferences,
        })
    }

    /// `magic:unload` and tray "Unload model".
    pub async fn unload_magic(&self) -> DomainResult<()> {
        if self.inner.model_operations.busy() {
            return Err(plain(
                "Wait for the current model operation before unloading",
            ));
        }
        self.perform_unload_magic(false).await
    }

    fn perform_unload_magic(&self, for_speech: bool) -> BoxFuture<'static, DomainResult<()>> {
        let this = self.clone();
        async move {
            let promise = {
                let state = this.inner.state.lock();
                if let Some(release) = state.magic_release.clone() {
                    release
                } else {
                    let busy = this.inner.magic_worker.busy() || state.magic_load.is_some() || state.magic_operations > 0;
                    drop(state);
                    if busy || (!for_speech && !this.can_idle_unload()) {
                        return Err(plain("Wait for rewriting to finish before unloading the rewrite model"));
                    }
                    this.clear_magic_idle();
                    let mut state = this.inner.state.lock();
                    let worker = this.clone();
                    let promise = eager(&this.inner.runtime, async move {
                        worker.update_magic_status(json!({"residency": "unloading", "idleUnloadAt": null}));
                        worker.inner.magic_worker.stop_and_wait(None).await;
                        worker.update_magic_status(json!({
                            "phase": "idle",
                            "engine": if worker.python_exists(Kind::Magic) { "unloaded" } else { "missing" },
                            "message": "Rewrite model unloaded", "model": null, "device": null, "progress": null,
                        }));
                        worker.inner.state.lock().magic_release = None;
                        worker.apply_deferred_residency();
                        Ok(())
                    });
                    state.magic_release = Some(promise.clone());
                    promise
                }
            };
            promise.await
        }
        .boxed()
    }

    /// Applies the saved residency policy (keep loaded, idle timers). Called
    /// after settings changes; deferred while anything is busy.
    pub fn configure_residency(&self, settings: &AppSettings) {
        if self.shutting_down() {
            return;
        }
        // Apply saved timer policy even when a request is still pending. Completion
        // reads storage again rather than restoring the request's old snapshot.
        self.schedule_speech_idle();
        self.schedule_magic_idle();
        if self.is_busy() {
            self.inner.state.lock().residency_pending = true;
            return;
        }
        self.inner.state.lock().residency_pending = false;
        if settings.preload_model && self.status().engine != EnginePhase::Error {
            self.clear_speech_idle();
            let generation = self.inner.state.lock().speech_failure_generation;
            let eligible: Eligible = {
                let this = self.clone();
                Arc::new(move || {
                    let state = this.inner.state.lock();
                    !state.shutting_down
                        && generation == state.speech_failure_generation
                        && this.status().engine != EnginePhase::Error
                })
            };
            let this = self.clone();
            let settings = settings.clone();
            self.inner.runtime.spawn(async move {
                match this.is_environment_ready(&settings).await {
                    Ok(ready) => {
                        let current = this.inner.profile.settings();
                        if !ready || !current.preload_model || !eligible() {
                            return;
                        }
                        if this.is_busy() {
                            this.inner.state.lock().residency_pending = true;
                        } else if let Err(error) = this
                            .run_model_operation(
                                &current,
                                this.ensure_loaded_if(&current, eligible.clone()),
                            )
                            .await
                        {
                            if eligible() {
                                this.fail(&error);
                            }
                        }
                    }
                    Err(error) => {
                        if eligible() {
                            this.fail(&error);
                        }
                    }
                }
            });
        }
        if settings.preload_magic_model
            && settings.memory_policy != MemoryPolicy::Balanced
            && self.magic_status().engine != EnginePhase::Error
        {
            self.clear_magic_idle();
            let generation = self.inner.state.lock().magic_failure_generation;
            let eligible: Eligible = {
                let this = self.clone();
                Arc::new(move || {
                    let state = this.inner.state.lock();
                    !state.shutting_down
                        && generation == state.magic_failure_generation
                        && this.magic_status().engine != EnginePhase::Error
                })
            };
            let this = self.clone();
            self.inner.runtime.spawn(async move {
                match this.is_magic_environment_ready().await {
                    Ok(ready) => {
                        let current = this.inner.profile.settings();
                        if !ready
                            || !current.preload_magic_model
                            || current.memory_policy == MemoryPolicy::Balanced
                            || !eligible()
                        {
                            return;
                        }
                        if this.is_busy() {
                            this.inner.state.lock().residency_pending = true;
                        } else if let Err(error) = this
                            .run_model_operation(
                                &current,
                                this.ensure_magic_loaded(&current, eligible.clone(), None),
                            )
                            .await
                        {
                            if eligible() {
                                this.fail_magic(&error);
                            }
                        }
                    }
                    Err(error) => {
                        if eligible() {
                            this.fail_magic(&error);
                        }
                    }
                }
            });
        }
    }

    fn apply_deferred_residency(&self) {
        if self.inner.state.lock().residency_pending && !self.is_busy() {
            self.configure_residency(&self.inner.profile.settings());
        }
    }

    fn clear_speech_idle(&self) {
        if let Some((_, timer)) = self.inner.state.lock().speech_idle.take() {
            timer.abort();
        }
        if self.status().lifecycle.idle_unload_at.is_some() {
            self.update_status(json!({"idleUnloadAt": null}));
        }
    }

    fn clear_magic_idle(&self) {
        if let Some((_, timer)) = self.inner.state.lock().magic_idle.take() {
            timer.abort();
        }
        if self.magic_status().lifecycle.idle_unload_at.is_some() {
            self.update_magic_status(json!({"idleUnloadAt": null}));
        }
    }

    fn idle_delay(settings: &AppSettings) -> Duration {
        Duration::from_secs_f64((settings.model_idle_minutes * 60.0).max(0.0))
    }

    fn schedule_speech_idle(&self) {
        self.clear_speech_idle();
        let settings = self.inner.profile.settings();
        if self.shutting_down()
            || settings.preload_model
            || self.status().engine != EnginePhase::Ready
        {
            return;
        }
        let delay = Self::idle_delay(&settings);
        let this = self.clone();
        let mut state = self.inner.state.lock();
        state.timer_sequence += 1;
        let id = state.timer_sequence;
        let timer = self.inner.runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut state = this.inner.state.lock();
                if state
                    .speech_idle
                    .as_ref()
                    .is_none_or(|(current, _)| *current != id)
                {
                    return;
                }
                state.speech_idle = None;
            }
            this.update_status(json!({"idleUnloadAt": null}));
            if this.shutting_down()
                || this.inner.profile.settings().preload_model
                || this.status().engine != EnginePhase::Ready
            {
                return;
            }
            if this.is_busy() || !this.can_idle_unload() {
                this.schedule_speech_idle();
            } else if let Err(error) = this.unload().await {
                this.fail(&error);
            }
        });
        state.speech_idle = Some((id, timer));
        drop(state);
        self.update_status(
            json!({"idleUnloadAt": delulu_core::now_ms() + delay.as_millis() as u64}),
        );
    }

    fn schedule_magic_idle(&self) {
        self.clear_magic_idle();
        let settings = self.inner.profile.settings();
        let pinned = |settings: &AppSettings| {
            settings.preload_magic_model && settings.memory_policy != MemoryPolicy::Balanced
        };
        if self.shutting_down()
            || pinned(&settings)
            || self.magic_status().engine != EnginePhase::Ready
        {
            return;
        }
        let delay = Self::idle_delay(&settings);
        let this = self.clone();
        let mut state = self.inner.state.lock();
        state.timer_sequence += 1;
        let id = state.timer_sequence;
        let timer = self.inner.runtime.spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut state = this.inner.state.lock();
                if state
                    .magic_idle
                    .as_ref()
                    .is_none_or(|(current, _)| *current != id)
                {
                    return;
                }
                state.magic_idle = None;
            }
            this.update_magic_status(json!({"idleUnloadAt": null}));
            if this.shutting_down()
                || pinned(&this.inner.profile.settings())
                || this.magic_status().engine != EnginePhase::Ready
            {
                return;
            }
            if this.is_busy() || !this.can_idle_unload() {
                this.schedule_magic_idle();
            } else if let Err(error) = this.unload_magic().await {
                this.fail_magic(&error);
            }
        });
        state.magic_idle = Some((id, timer));
        drop(state);
        self.update_magic_status(
            json!({"idleUnloadAt": delulu_core::now_ms() + delay.as_millis() as u64}),
        );
    }

    /// `runtime:reset`: stops both runtimes and removes their environments.
    /// Model caches, history and settings stay.
    pub async fn reset(&self) -> DomainResult<()> {
        self.shutdown().await;
        for directory in [
            self.inner.paths.speech_venv(),
            self.inner.paths.magic_venv(),
        ] {
            if directory.exists() {
                std::fs::remove_dir_all(&directory)?;
            }
        }
        self.update_status(json!({
            "phase": "idle", "engine": "missing", "message": "Speech and rewrite runtimes removed",
            "model": null, "progress": null, "migrationRequired": false,
        }));
        self.update_magic_status(json!({
            "phase": "idle", "engine": "missing", "message": "Rewrite runtime setup required",
            "model": null, "device": null, "progress": null,
        }));
        Ok(())
    }

    /// Stops setup, timers and both workers (and their GPU children).
    pub async fn shutdown(&self) {
        let (setup, magic_setup) = {
            let mut state = self.inner.state.lock();
            state.shutting_down = true;
            for operation in [&state.speech_setup, &state.magic_setup]
                .into_iter()
                .flatten()
            {
                operation.token.cancel();
            }
            state.residency_pending = false;
            (
                state.setup_promise.clone(),
                state.magic_setup_promise.clone(),
            )
        };
        self.inner.speech_installer.stop();
        self.inner.magic_installer.stop();
        self.clear_speech_idle();
        self.clear_magic_idle();
        tokio::join!(
            self.inner.speech_worker.stop_and_wait(None),
            self.inner.magic_worker.stop_and_wait(None),
            self.inner.speech_installer.stop_and_wait(),
            self.inner.magic_installer.stop_and_wait(),
        );
        self.update_status(Value::Object(unloaded_lifecycle()));
        self.update_magic_status(Value::Object(unloaded_lifecycle()));
        for promise in [setup, magic_setup].into_iter().flatten() {
            let _ = promise.await;
        }
    }

    fn write_failure_log(&self, file: &str, runtime: &str, error: &DomainError, stderr: String) {
        if !self.inner.profile.settings().keep_history {
            return;
        }
        let log = private_failure_log(runtime, &error.message, &stderr);
        // Diagnostics are best-effort.
        let _ = delulu_core::util::write_private_atomic(
            &self.inner.paths.data.join(file),
            log.as_bytes(),
        );
    }

    /// Marks the speech engine failed (tray actions, worker crashes). Stays
    /// failed until an explicit load, repair or retry.
    pub fn fail(&self, error: &DomainError) {
        if error.is_cancelled() {
            return;
        }
        self.clear_speech_idle();
        self.inner.state.lock().speech_failure_generation += 1;
        let failure = error.to_failure(&delulu_core::uuid(), "runtime:speech");
        self.write_failure_log(
            "last-asr-error.log",
            "speech",
            error,
            self.inner.speech_worker.stderr(),
        );
        let mut patch = failed_lifecycle(self.inner.speech_worker.running());
        patch.extend(
            serde_json::from_value::<Map<String, Value>>(json!({
                "phase": "error", "engine": "error",
                "message": concise_error(&failure.message), "detail": failure.message,
                "progress": null, "failure": failure,
            }))
            .unwrap_or_default(),
        );
        self.update_status(Value::Object(patch));
    }

    /// Marks the rewriting engine failed; cancelled rewrites are not failures.
    pub fn fail_magic(&self, error: &DomainError) {
        if is_rewrite_cancelled(error) || self.manual_cancelled() || error.is_cancelled() {
            return;
        }
        self.clear_magic_idle();
        self.inner.state.lock().magic_failure_generation += 1;
        let failure = error.to_failure(&delulu_core::uuid(), "runtime:magic");
        self.write_failure_log(
            "last-magic-error.log",
            "magic",
            error,
            self.inner.magic_worker.stderr(),
        );
        let mut patch = failed_lifecycle(self.inner.magic_worker.running());
        patch.extend(
            serde_json::from_value::<Map<String, Value>>(json!({
                "phase": "error", "engine": "error",
                "message": concise_error(&failure.message), "detail": failure.message,
                "progress": null, "failure": failure,
            }))
            .unwrap_or_default(),
        );
        self.update_magic_status(Value::Object(patch));
    }
}

#[async_trait]
impl SpeechEngine for AsrService {
    fn status(&self) -> DictationStatus {
        AsrService::status(self)
    }
    fn is_busy(&self) -> bool {
        AsrService::is_busy(self)
    }
    fn set_activity(&self, phase: DictationPhase, message: &str, detail: Option<&str>) {
        AsrService::set_activity(self, phase, message, detail)
    }
    fn set_recovery(&self, available: bool, retry_audio: RetryAudioState) {
        AsrService::set_recovery(self, available, Some(retry_audio))
    }
    fn set_capture_input_notice(&self, message: Option<&str>) {
        AsrService::set_capture_input_notice(self, message)
    }
    fn set_silence_countdown(&self, remaining_seconds: Option<f64>) {
        AsrService::set_silence_countdown(self, remaining_seconds)
    }
    async fn transcribe(&self, payload: Value, settings: &AppSettings) -> DomainResult<Value> {
        AsrService::transcribe(self, payload, settings).await
    }
    async fn rewrite(
        &self,
        request: MagicRewriteRequest,
        settings: &AppSettings,
    ) -> DomainResult<MagicRewriteResult> {
        AsrService::rewrite_magic(self, request, settings).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concise_errors_skip_download_noise() {
        assert_eq!(
            concise_error("Traceback\n  RuntimeError: boom\n 45%|████\nLoading weights 3/4\n"),
            "RuntimeError: boom"
        );
        assert_eq!(
            concise_error("\n\n"),
            "The model worker stopped unexpectedly"
        );
    }

    #[test]
    fn medium_follows_the_language() {
        let mut settings = AppSettings {
            speech_engine: SpeechTier::Medium,
            ..AppSettings::default()
        };
        assert_eq!(speech_engine_id(&settings), SpeechWorkerModel::ParakeetV2);
        settings.language = "auto".into();
        assert_eq!(speech_engine_id(&settings), SpeechWorkerModel::ParakeetV3);
        settings.speech_engine = SpeechTier::Small;
        assert_eq!(speech_engine_id(&settings), SpeechWorkerModel::Canary180m);
    }
}
