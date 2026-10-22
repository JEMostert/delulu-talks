//! Interpreter discovery and package installation (`installer.ts`); model
//! loading is separate.
//!
//! Setup never modifies the active environment. Each attempt builds a fresh
//! generation under `<venv>/generations/<uuid>`, validates it (pip check,
//! import/hardware readiness, inventory) and becomes a *candidate*. The
//! caller loads and warms the model on the candidate ([`RuntimeInstaller::python`]
//! points at it), then calls [`RuntimeInstaller::commit`] to switch
//! `active.json`, or [`RuntimeInstaller::discard`] to keep the previous
//! generation. Commands are always spawned with an argument vector, never a
//! shell string.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use delulu_core::{DomainError, DomainErrorCode, DomainResult};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::artifacts::resolve_runtime_artifacts;
use crate::environment::ChildEnv;
use crate::inventory::{
    create_runtime_inventory, inventory_backend, write_runtime_inventory, InstallConstraint, InstallStageName,
    InventoryContext, RequestedInstallStage, RuntimeKind, PYTHON_INVENTORY_PROBE,
};
use crate::location::{activate_runtime, runtime_directory, runtime_python};
use crate::manifest::*;
use crate::platform::{
    speech_runtime_profile, uses_metal, voice_runtime_profile, SpeechRuntimeProfile, TargetPlatform,
};
use crate::prerequisites::{
    parse_runtime_prerequisite_error, runtime_readiness_script, tail_utf16, validate_python_interpreter,
    RuntimePrerequisiteCode, RuntimePrerequisiteError, PYTHON_INTERPRETER_PROBE,
};
use crate::setup_log::{SetupEvent, SetupLog, SetupLogEntryType};
use crate::support::{self, split_command};
use crate::types::{SetupStage, SpeechTier, VoiceEngineId};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CANCELLED_MESSAGE: &str = "Runtime setup cancelled. The previous environment is unchanged.";

/// The bundled Linux x64 transitive constraints.
pub fn constraints_path(paths: &delulu_core::AppPaths) -> PathBuf {
    paths.resource("python/constraints-linux-x64.txt")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_stage: Option<SetupStage>,
    pub message: String,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The settings fields setup reads.
#[derive(Debug, Clone)]
pub struct InstallSettings {
    pub python_command: String,
    pub speech_engine: SpeechTier,
    pub voice_engine: VoiceEngineId,
}

#[derive(Debug, Clone)]
pub struct InstallerPaths {
    pub data_directory: PathBuf,
    pub venv_directory: PathBuf,
    /// The only runtime this installer may set up.
    pub kind: Option<RuntimeKind>,
}

pub type EnvironmentSource = Arc<dyn Fn() -> ChildEnv + Send + Sync>;
type Publish<'a> = &'a (dyn Fn(InstallProgress) + Send + Sync);

/// Run `pip check`, accepting only the documented voice runtime exceptions.
pub fn pip_check_script(exceptions: &[&str]) -> String {
    format!(
        r#"import subprocess, sys
result = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True, text=True)
allowed = {}
problems = [line for line in result.stdout.splitlines() if line.strip() and not any(line.startswith(prefix) for prefix in allowed)]
print(result.stdout)
if result.returncode != 0 and problems:
    print("\n".join(problems), file=sys.stderr)
    raise SystemExit(1)
"#,
        serde_json::to_string(exceptions).unwrap_or_else(|_| "[]".into())
    )
}

/// Appends requirements whose package is not already pinned in `base`.
fn with_packages(base: &[&str], extra: &[&str]) -> Vec<String> {
    let name = |requirement: &str| {
        requirement
            .split(['=', '<', '>', '!', '~', '['])
            .next()
            .unwrap_or_default()
            .to_lowercase()
            .replace('_', "-")
    };
    let present: Vec<String> = base.iter().map(|item| name(item)).collect();
    base.iter()
        .chain(extra.iter().filter(|item| !present.contains(&name(item))))
        .map(|item| (*item).to_owned())
        .collect()
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn millis(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 1000.0).round()
}

/// Internal failure; converted to a domain error at the public boundary.
#[derive(Debug)]
enum SetupError {
    Domain(DomainError),
    Prerequisite(RuntimePrerequisiteError),
    Message(String),
}

impl SetupError {
    fn message(&self) -> String {
        match self {
            Self::Domain(error) => error.message.clone(),
            Self::Prerequisite(error) => error.to_string(),
            Self::Message(message) => message.clone(),
        }
    }

    /// `domainError(reason, { operationId, operation })`.
    fn into_domain(self, operation_id: &str, operation: &str) -> DomainError {
        match self {
            Self::Domain(error) => error,
            Self::Prerequisite(error) => DomainError::failed(error.to_string())
                .with_operation(operation_id, operation)
                .with_cause("RuntimePrerequisiteError", None),
            Self::Message(message) => {
                DomainError::failed(message).with_operation(operation_id, operation).with_cause("Error", None)
            }
        }
    }
}

impl From<DomainError> for SetupError {
    fn from(error: DomainError) -> Self {
        Self::Domain(error)
    }
}

struct Candidate {
    generation: String,
    python: PathBuf,
}

struct State {
    setup_stage: String,
    stage_started: Option<(String, Instant)>,
    validated_python: Option<String>,
    candidate: Option<Candidate>,
    operation_id: String,
}

pub struct RuntimeInstaller {
    /// The current attempt's bounded log; services `begin`/`finish` it.
    pub setup_log: Arc<Mutex<SetupLog>>,
    paths: InstallerPaths,
    constraints_path: Option<PathBuf>,
    environment: EnvironmentSource,
    metal: bool,
    windows: bool,
    target: TargetPlatform,
    cancelled: AtomicBool,
    processes: Arc<Mutex<HashMap<u64, u32>>>,
    next_process: AtomicU64,
    state: Mutex<State>,
}

impl RuntimeInstaller {
    /// `constraints_path` is passed only for runtimes that use the Linux x64
    /// constraints (the rewrite runtime); see [`constraints_path`].
    pub fn new(
        paths: InstallerPaths,
        constraints_path: Option<PathBuf>,
        environment: impl Fn() -> ChildEnv + Send + Sync + 'static,
    ) -> Self {
        Self {
            setup_log: Arc::new(Mutex::new(SetupLog::new())),
            paths,
            constraints_path,
            environment: Arc::new(environment),
            metal: uses_metal(),
            windows: cfg!(windows),
            target: TargetPlatform::current(),
            cancelled: AtomicBool::new(false),
            processes: Arc::new(Mutex::new(HashMap::new())),
            next_process: AtomicU64::new(0),
            state: Mutex::new(State {
                setup_stage: "Runtime preflight".into(),
                stage_started: None,
                validated_python: None,
                candidate: None,
                operation_id: delulu_core::uuid(),
            }),
        }
    }

    /// Overrides platform detection (tests and cross-platform planning).
    pub fn with_platform(mut self, metal: bool, windows: bool, target: TargetPlatform) -> Self {
        self.metal = metal;
        self.windows = windows;
        self.target = target;
        self
    }

    fn log(&self, attempt: Option<&str>, event: SetupEvent) {
        self.setup_log.lock().record(attempt, event);
    }

    fn active_attempt(&self) -> Option<String> {
        self.setup_log.lock().active_id()
    }

    pub fn record_setup_stage(&self, message: &str) {
        let attempt = self.active_attempt();
        let now = Instant::now();
        let ended = {
            let mut state = self.state.lock();
            let ended = match (&attempt, &state.stage_started) {
                (Some(id), Some((started_id, at))) if id == started_id => Some((
                    state.setup_stage.clone(),
                    (now.duration_since(*at).as_secs_f64() * 1000.0).round(),
                )),
                _ => None,
            };
            state.setup_stage = message.to_owned();
            state.stage_started = attempt.clone().map(|id| (id, now));
            ended
        };
        if let Some((stage, duration)) = ended {
            self.log(attempt.as_deref(), SetupEvent::new(SetupLogEntryType::Stage, stage, "Stage ended").duration(duration));
        }
        self.log(attempt.as_deref(), SetupEvent::new(SetupLogEntryType::Stage, message, message));
    }

    pub fn record_setup_outcome(&self, message: &str) {
        let attempt = self.active_attempt();
        let (stage, duration) = {
            let state = self.state.lock();
            let duration = match (&attempt, &state.stage_started) {
                (Some(id), Some((started_id, at))) if id == started_id => Some(millis(*at)),
                _ => None,
            };
            (state.setup_stage.clone(), duration)
        };
        let mut event = SetupEvent::new(SetupLogEntryType::Stage, stage, message);
        event.duration_ms = duration;
        self.log(attempt.as_deref(), event);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn cancelled_error(&self) -> SetupError {
        let operation_id = self.state.lock().operation_id.clone();
        SetupError::Domain(DomainError::cancelled(CANCELLED_MESSAGE).with_operation(operation_id, "runtime:setup"))
    }

    /// The prepared candidate's interpreter, else the active generation's.
    pub fn python(&self) -> DomainResult<PathBuf> {
        if let Some(candidate) = &self.state.lock().candidate {
            return Ok(candidate.python.clone());
        }
        runtime_python(&self.paths.venv_directory)
    }

    fn assert_kind(&self, kind: RuntimeKind) -> Result<(), SetupError> {
        if let Some(owner) = self.paths.kind.filter(|owner| *owner != kind) {
            return Err(SetupError::Message(format!(
                "This installer owns the {} runtime, not {}",
                owner.as_str(),
                kind.as_str()
            )));
        }
        let marker = runtime_directory(&self.paths.venv_directory)?.join("runtime-role.json");
        // Preserve pre-marker generations and the legacy Writing environment.
        if !marker.exists() {
            return Ok(());
        }
        let text = std::fs::read_to_string(&marker).map_err(|error| SetupError::Message(error.to_string()))?;
        let role: Value = serde_json::from_str(&text).map_err(|error| SetupError::Message(error.to_string()))?;
        let owner = role.get("kind").and_then(Value::as_str).unwrap_or("undefined");
        if owner != kind.as_str() {
            return Err(SetupError::Message(format!(
                "The selected environment belongs to {owner}, not {}. Choose its dedicated runtime directory.",
                kind.as_str()
            )));
        }
        Ok(())
    }

    /// Call only after the candidate worker has completed real model warmup.
    pub fn commit(&self) -> DomainResult<()> {
        let generation = match &self.state.lock().candidate {
            None => return Err(DomainError::failed("No prepared runtime is available to activate")),
            Some(candidate) => candidate.generation.clone(),
        };
        if self.is_cancelled() {
            return Err(DomainError::failed(
                "Runtime setup cancelled before activation. Previous runtime remains selected.",
            ));
        }
        self.record_setup_stage("Activating runtime after model load and warmup");
        activate_runtime(&self.paths.venv_directory, &generation)?;
        self.state.lock().candidate = None;
        self.record_setup_stage("Validated runtime activation committed");
        Ok(())
    }

    pub fn discard(&self) {
        self.rollback();
    }

    pub fn reset_cancellation(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// Setup has not changed the durable pointer. Discard only this candidate;
    /// never roll back an unrelated, already-active generation.
    pub fn rollback(&self) {
        self.record_setup_stage("Discarding candidate; previous runtime remains selected");
        let mut state = self.state.lock();
        state.candidate = None;
        state.validated_python = None;
    }

    /// Cancels setup and terminates every running setup command's group.
    pub fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pids: Vec<u32> = self.processes.lock().values().copied().collect();
        for pid in pids {
            terminate(pid);
        }
    }

    /// [`stop`](Self::stop), then waits up to six seconds for those commands to close.
    pub async fn stop_and_wait(&self) {
        let running: Vec<u64> = self.processes.lock().keys().copied().collect();
        self.stop();
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            if !running.iter().any(|key| self.processes.lock().contains_key(key)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn run(
        &self,
        program: &str,
        args: &[String],
        mut on_output: Option<&mut (dyn FnMut(&str) + Send)>,
        timeout: Duration,
    ) -> Result<String, SetupError> {
        if self.is_cancelled() {
            return Err(self.cancelled_error());
        }
        let attempt = self.active_attempt();
        let (stage, operation_id) = {
            let state = self.state.lock();
            (state.setup_stage.clone(), state.operation_id.clone())
        };
        let started = Instant::now();
        self.log(
            attempt.as_deref(),
            SetupEvent::new(SetupLogEntryType::Command, &stage, "Starting runtime command").command(program, args.to_vec()),
        );
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .env_clear()
            .envs((self.environment)())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        support::isolate(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.log(
                    attempt.as_deref(),
                    SetupEvent::new(SetupLogEntryType::Error, &stage, error.to_string()).duration(millis(started)),
                );
                return Err(SetupError::Domain(
                    DomainError::new(
                        DomainErrorCode::WorkerUnavailable,
                        "Could not start the runtime setup command. Check Python and try Repair.",
                    )
                    .with_operation(operation_id, "runtime:setup")
                    .with_cause("IoError", delulu_core::error::io_error_code(&error)),
                ));
            }
        };
        let key = self.next_process.fetch_add(1, Ordering::SeqCst);
        let pid = child.id();
        if let Some(pid) = pid {
            self.processes.lock().insert(key, pid);
        }
        let (chunks_tx, mut chunks) = mpsc::unbounded_channel::<(bool, String)>();
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(forward(stdout, false, chunks_tx.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(forward(stderr, true, chunks_tx));
        }
        let (mut output, mut diagnostic) = (String::new(), String::new());
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let closed = loop {
            tokio::select! {
                chunk = chunks.recv() => match chunk {
                    Some((is_stderr, text)) => {
                        let (buffer, limit, kind) = if is_stderr {
                            (&mut diagnostic, 16_000, SetupLogEntryType::Stderr)
                        } else {
                            (&mut output, 256_000, SetupLogEntryType::Stdout)
                        };
                        buffer.push_str(&text);
                        if buffer.len() > limit {
                            *buffer = tail_utf16(buffer, limit).to_owned();
                        }
                        self.log(attempt.as_deref(), SetupEvent::new(kind, &stage, &text));
                        if !self.is_cancelled() {
                            if let Some(on_output) = on_output.as_mut() {
                                on_output(&text);
                            }
                        }
                    }
                    None => {
                        tokio::select! {
                            status = child.wait() => break Some(status),
                            _ = &mut deadline => break None,
                        }
                    }
                },
                _ = &mut deadline => break None,
            }
        };
        let Some(status) = closed else {
            self.log(
                attempt.as_deref(),
                SetupEvent::new(SetupLogEntryType::Error, &stage, "Runtime command timed out; termination requested")
                    .duration(millis(started)),
            );
            if let Some(pid) = pid {
                terminate(pid);
            }
            // Keep the command registered until it closes, like the TypeScript 'close' handler.
            let (log, processes) = (self.setup_log.clone(), self.processes.clone());
            tokio::spawn(async move {
                let status = child.wait().await;
                log.lock().record(attempt.as_deref(), exit_event(&stage, started, status.ok()));
                processes.lock().remove(&key);
            });
            return Err(SetupError::Domain(
                DomainError::new(
                    DomainErrorCode::RuntimeSetupTimeout,
                    "Runtime operation timed out. Check your connection and try Repair.",
                )
                .with_operation(operation_id, "runtime:setup"),
            ));
        };
        let status = status.ok();
        self.log(attempt.as_deref(), exit_event(&stage, started, status));
        self.processes.lock().remove(&key);
        if self.is_cancelled() {
            return Err(self.cancelled_error());
        }
        let code = status.and_then(|status| status.code());
        if code == Some(0) {
            return Ok(output.trim().to_owned());
        }
        let cause = match diagnostic.trim() {
            "" => format!("Runtime command failed ({})", code.map_or("null".into(), |c| c.to_string())),
            text => text.to_owned(),
        };
        Err(parse_runtime_prerequisite_error(&diagnostic).map_or(SetupError::Message(cause), SetupError::Prerequisite))
    }

    /// Whether the active runtime can run `profile`; the magic runtime ignores it.
    /// Errors only when setup was cancelled meanwhile.
    pub async fn ready(&self, kind: RuntimeKind, profile: SpeechRuntimeProfile) -> DomainResult<bool> {
        let attempt = async {
            self.assert_kind(kind)?;
            let python = self.python()?;
            if !python.exists() {
                return Ok(false);
            }
            let key = format!("{}:{}:{}", kind.as_str(), profile.as_str(), python.display());
            if self.state.lock().validated_python.as_deref() == Some(key.as_str()) {
                return Ok(true);
            }
            let script = self.readiness(kind, profile);
            self.run(&lossy(&python), &["-c".into(), script], None, Duration::from_secs(60)).await?;
            self.state.lock().validated_python = Some(key);
            Ok::<bool, SetupError>(true)
        };
        match attempt.await {
            Ok(ready) => Ok(ready),
            Err(error) if self.is_cancelled() => {
                let operation_id = self.state.lock().operation_id.clone();
                Err(error.into_domain(&operation_id, "runtime:setup"))
            }
            Err(_) => Ok(false),
        }
    }

    fn readiness(&self, kind: RuntimeKind, profile: SpeechRuntimeProfile) -> String {
        runtime_readiness_script(kind, &self.target, kind == RuntimeKind::Speech && self.metal, profile)
    }

    async fn base_python(&self, command: &str, metal: bool) -> Result<Vec<String>, SetupError> {
        let configured = split_command(command);
        let fallbacks: Vec<Vec<String>> = if metal {
            let home = dirs::home_dir().unwrap_or_default();
            vec![
                vec!["python3.12".into()],
                vec!["/opt/homebrew/bin/python3.12".into()],
                vec![lossy(&home.join(".local/bin/python3.12"))],
            ]
        } else if self.windows {
            vec![vec!["py".into(), "-3.12".into()], vec!["python3.12".into()]]
        } else {
            vec![vec!["python3.13".into()], vec!["python3.12".into()], vec!["python3.11".into()]]
        };
        let automatic = configured.is_empty()
            || (configured.len() == 1 && matches!(configured[0].as_str(), "python" | "python3"));
        let candidates = if automatic { fallbacks.into_iter().chain([configured]).collect() } else { vec![configured] };
        let mut failures: Vec<RuntimePrerequisiteError> = Vec::new();
        for candidate in candidates.into_iter().filter(|candidate| !candidate.is_empty()) {
            let mut args = candidate[1..].to_vec();
            args.extend(["-c".into(), PYTHON_INTERPRETER_PROBE.into()]);
            let probed = match self.run(&candidate[0], &args, None, Duration::from_secs(5)).await {
                Ok(probe) => validate_python_interpreter(&probe, &self.target, metal).map_err(SetupError::Prerequisite),
                Err(error) => Err(error),
            };
            let cause = match probed {
                Ok(_) => return Ok(candidate),
                Err(cause) if self.is_cancelled() => return Err(cause),
                Err(cause) => cause,
            };
            let (code, details) = match &cause {
                SetupError::Prerequisite(error) => (error.code, error.details.clone()),
                other => (RuntimePrerequisiteCode::PythonVersion, other.message()),
            };
            let failure = RuntimePrerequisiteError::new(code, &format!("{}: {details}", candidate.join(" ")));
            if !automatic {
                return Err(SetupError::Prerequisite(failure));
            }
            failures.push(failure);
        }
        let summary: Vec<String> =
            failures.iter().map(|failure| format!("[{}] {}", failure.code.as_str(), failure.details)).collect();
        Err(SetupError::Prerequisite(RuntimePrerequisiteError::new(
            failures.last().map_or(RuntimePrerequisiteCode::PythonVersion, |failure| failure.code),
            &format!("No supported interpreter was found. {}", summary.join("; ")),
        )))
    }

    /// Builds and validates a candidate generation; the active runtime is
    /// untouched until [`commit`](Self::commit). Cancelling `cancel` (or
    /// calling [`stop`](Self::stop)) terminates the running command.
    pub async fn install(
        &self,
        kind: RuntimeKind,
        settings: &InstallSettings,
        publish: impl Fn(InstallProgress) + Send + Sync,
        cancel: Option<CancellationToken>,
    ) -> DomainResult<()> {
        let operation_id = delulu_core::uuid();
        let operation = format!("runtime:setup:{}", kind.as_str());
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(DomainError::cancelled(CANCELLED_MESSAGE).with_operation(operation_id, operation));
        }
        self.state.lock().operation_id = operation_id.clone();
        let work = self.install_candidate(kind, settings, &publish);
        tokio::pin!(work);
        let result = match cancel {
            None => work.await,
            Some(token) => {
                let mut stopped = false;
                loop {
                    tokio::select! {
                        result = &mut work => break result,
                        _ = token.cancelled(), if !stopped => {
                            stopped = true;
                            self.stop();
                        }
                    }
                }
            }
        };
        result.map_err(|error| error.into_domain(&operation_id, &operation))
    }

    async fn stage(
        &self,
        program: &str,
        args: &[String],
        message: &str,
        progress: f64,
        setup_stage: SetupStage,
        publish: Publish<'_>,
    ) -> Result<String, SetupError> {
        self.record_setup_stage(message);
        publish(InstallProgress { setup_stage: Some(setup_stage), message: message.into(), progress, detail: None });
        let mut current = setup_stage;
        let mut on_output = |output: &str| {
            let trimmed = output.trim();
            let last = trimmed.rsplit('\n').next().unwrap_or_default().trim_end_matches('\r');
            let detail = tail_utf16(last, 350);
            if matches!(
                current,
                SetupStage::RuntimePackages | SetupStage::RuntimeDownload | SetupStage::RuntimeInstall | SetupStage::RuntimeBuild
            ) {
                for line in output.split('\n').map(str::trim) {
                    if line.starts_with("Downloading ") || line.starts_with("Using cached ") {
                        current = SetupStage::RuntimeDownload;
                    } else if line.starts_with("Installing collected packages:") {
                        current = SetupStage::RuntimeInstall;
                    } else if line.starts_with("Building wheel") || line.starts_with("Preparing metadata") {
                        current = SetupStage::RuntimeBuild;
                    }
                }
            }
            if !detail.is_empty() {
                publish(InstallProgress {
                    setup_stage: Some(current),
                    message: message.into(),
                    progress,
                    detail: Some(detail.into()),
                });
            }
        };
        self.run(program, args, Some(&mut on_output), COMMAND_TIMEOUT).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn install_packages(
        &self,
        target: &PackageTarget<'_>,
        name: InstallStageName,
        requirements: Vec<String>,
        options: Vec<String>,
        message: &str,
        progress: f64,
        constraint: Option<InstallConstraint>,
        requested: &mut Vec<RequestedInstallStage>,
    ) -> Result<(), SetupError> {
        let base = format!("runtime-{}-{}-artifacts", target.kind.as_str(), name.as_str());
        let report_path = target.directory.join(format!("{base}.json"));
        let requirements_path = target.directory.join(format!("{base}.txt"));
        let mut resolver_arguments: Vec<String> =
            owned(&["install", "--disable-pip-version-check", "--dry-run", "--report"]);
        resolver_arguments.push(lossy(&report_path));
        resolver_arguments.extend(options.iter().cloned());
        resolver_arguments.extend(requirements.iter().cloned());
        let mut args = owned(&["-m", "pip"]);
        args.extend(resolver_arguments.iter().cloned());
        self.stage(
            &target.python,
            &args,
            &format!("Resolving artifacts: {}", message.to_lowercase()),
            progress,
            SetupStage::RuntimePrepare,
            target.publish,
        )
        .await?;
        let report = std::fs::read_to_string(&report_path).map_err(|error| SetupError::Message(error.to_string()))?;
        let resolved = resolve_runtime_artifacts(&report).map_err(SetupError::Message)?;
        delulu_core::util::write_private_atomic(&requirements_path, resolved.requirements.as_bytes())
            .map_err(|error| SetupError::Message(error.to_string()))?;
        let mut pip_arguments = owned(&["install", "--disable-pip-version-check", "--no-deps"]);
        // Retain stage policy for installation/build hooks as well as resolution
        // (indexes, constraints, and any future build-isolation/binary options).
        pip_arguments.extend(options);
        pip_arguments.extend(["--requirement".into(), lossy(&requirements_path)]);
        let empty = resolved.artifacts.is_empty();
        requested.push(RequestedInstallStage {
            name,
            requirements,
            pip_arguments: pip_arguments.clone(),
            constraint,
            artifacts: Some(resolved.artifacts),
            resolver_arguments: Some(resolver_arguments),
            artifact_requirements: Some(resolved.requirements),
        });
        // An empty resolver report means the requested packages are already present.
        if empty {
            return Ok(());
        }
        let mut args = owned(&["-m", "pip"]);
        args.extend(pip_arguments);
        self.stage(&target.python, &args, message, progress, SetupStage::RuntimePackages, target.publish).await?;
        Ok(())
    }

    async fn install_candidate(
        &self,
        kind: RuntimeKind,
        settings: &InstallSettings,
        publish: Publish<'_>,
    ) -> Result<(), SetupError> {
        if let Some(owner) = self.paths.kind.filter(|owner| *owner != kind) {
            return Err(SetupError::Message(format!(
                "This installer owns the {} runtime, not {}",
                owner.as_str(),
                kind.as_str()
            )));
        }
        self.cancelled.store(false, Ordering::SeqCst);
        // Install what the selected size needs; the full runtime also runs Small and Medium.
        let profile = match kind {
            RuntimeKind::Speech => speech_runtime_profile(settings.speech_engine),
            RuntimeKind::Voice => voice_runtime_profile(settings.voice_engine),
            RuntimeKind::Magic => SpeechRuntimeProfile::Full,
        };
        let cpu = kind != RuntimeKind::Magic && profile == SpeechRuntimeProfile::Cpu;
        {
            let mut state = self.state.lock();
            state.candidate = None;
            state.validated_python = None;
        }
        let metal = kind == RuntimeKind::Speech && self.metal && !cpu;
        if metal {
            if let Some(release) = darwin_release().filter(|release| {
                release.split('.').next().and_then(|major| major.parse::<u32>().ok()).is_some_and(|major| major < 24)
            }) {
                return Err(SetupError::Prerequisite(RuntimePrerequisiteError::new(
                    RuntimePrerequisiteCode::MetalUnavailable,
                    &format!("Found Darwin {release}; R2T2 MLX requires macOS 15 or later (Darwin 24+)."),
                )));
            }
        }
        self.record_setup_stage("Checking your Python environment");
        publish(InstallProgress {
            setup_stage: Some(SetupStage::RuntimeCheck),
            message: "Checking your Python environment".into(),
            progress: 0.05,
            detail: None,
        });
        let io = |error: std::io::Error| SetupError::Message(error.to_string());
        std::fs::create_dir_all(&self.paths.data_directory).map_err(io)?;
        let generation = delulu_core::uuid();
        let candidate = self.paths.venv_directory.join("generations").join(&generation);
        std::fs::create_dir_all(&candidate).map_err(io)?;
        let candidate_python = candidate.join(if self.windows { "Scripts/python.exe" } else { "bin/python" });
        // Never modify the active environment. Interrupted candidates are ignored,
        // and the previous generation stays on disk for recovery.
        let python = self.base_python(&settings.python_command, metal).await?;
        let mut args = python[1..].to_vec();
        args.extend(["-m".into(), "venv".into(), lossy(&candidate)]);
        self.stage(&python[0], &args, "Creating your local runtime", 0.12, SetupStage::RuntimePrepare, publish).await?;

        let target = PackageTarget { kind, directory: &candidate, python: lossy(&candidate_python), publish };
        let mut requested = Vec::new();
        self.install_packages(
            &target,
            InstallStageName::Installer,
            owned(INSTALLER_PACKAGES),
            Vec::new(),
            "Preparing the package installer",
            0.22,
            None,
            &mut requested,
        )
        .await?;
        let constraints_file = self
            .constraints_path
            .as_ref()
            .filter(|_| !self.windows && self.target.platform == "linux" && self.target.arch == "x64");
        let constraints: Vec<String> =
            constraints_file.map(|path| vec!["--constraint".into(), lossy(path)]).unwrap_or_default();
        let cuda_index = owned(&["--index-url", "https://download.pytorch.org/whl/cu130"]);
        if kind == RuntimeKind::Voice {
            if !cpu {
                self.install_packages(
                    &target,
                    InstallStageName::VoiceTorch,
                    owned(if self.windows { VOICE_WINDOWS_TORCH_PACKAGES } else { VOICE_TORCH_PACKAGES }),
                    if self.windows { cuda_index.clone() } else { Vec::new() },
                    "Installing PyTorch for expressive voice",
                    0.3,
                    None,
                    &mut requested,
                )
                .await?;
            }
            self.install_packages(
                &target,
                InstallStageName::Runtime,
                if cpu { owned(VOICE_CPU_PACKAGES) } else { with_packages(VOICE_GPU_PACKAGES, VOICE_CPU_PACKAGES) },
                Vec::new(),
                "Installing the voice runtime",
                0.45,
                None,
                &mut requested,
            )
            .await?;
            if !cpu {
                self.install_packages(
                    &target,
                    InstallStageName::VoiceUnpinned,
                    owned(VOICE_UNPINNED_PACKAGES),
                    owned(&["--no-deps"]),
                    "Installing Chatterbox Turbo",
                    0.6,
                    None,
                    &mut requested,
                )
                .await?;
            }
        } else if self.windows && !cpu {
            self.install_packages(
                &target,
                InstallStageName::WindowsCuda,
                owned(WINDOWS_CUDA_PACKAGES),
                cuda_index,
                "Installing the native Windows CUDA runtime",
                0.32,
                None,
                &mut requested,
            )
            .await?;
        } else if kind == RuntimeKind::Speech && !metal && !cpu {
            self.install_packages(
                &target,
                InstallStageName::LinuxCuda,
                owned(LINUX_CUDA_PACKAGES),
                constraints.clone(),
                "Installing the CUDA runtime",
                0.32,
                None,
                &mut requested,
            )
            .await?;
        }
        if kind != RuntimeKind::Voice {
            let packages = match kind {
                RuntimeKind::Speech if cpu => owned(CPU_SPEECH_PACKAGES),
                RuntimeKind::Speech => {
                    with_packages(if metal { METAL_PACKAGES } else { SPEECH_PACKAGES }, CPU_SPEECH_PACKAGES)
                }
                _ => owned(MAGIC_PACKAGES),
            };
            let constraint = match constraints_file {
                Some(path) => Some(InstallConstraint {
                    path: lossy(path),
                    contents: std::fs::read_to_string(path).map_err(io)?,
                }),
                None => None,
            };
            self.install_packages(
                &target,
                InstallStageName::Runtime,
                packages,
                constraints,
                if kind == RuntimeKind::Speech { "Installing the speech runtime" } else { "Installing the rewrite runtime" },
                0.45,
                constraint,
                &mut requested,
            )
            .await?;
        }
        let check = if kind == RuntimeKind::Voice {
            vec!["-c".into(), pip_check_script(VOICE_PIP_CHECK_EXCEPTIONS)]
        } else {
            owned(&["-m", "pip", "check"])
        };
        self.stage(&target.python, &check, "Checking package compatibility", 0.72, SetupStage::RuntimeValidate, publish)
            .await?;
        self.stage(
            &target.python,
            &["-c".into(), self.readiness(kind, profile)],
            "Validating the new runtime before switching",
            0.76,
            SetupStage::RuntimeValidate,
            publish,
        )
        .await?;
        self.record_setup_stage("Recording installed package versions");
        let versions = self.run(&target.python, &owned(&["-m", "pip", "freeze"]), None, Duration::from_secs(15)).await?;
        delulu_core::util::write_private_atomic(
            &candidate.join(format!("runtime-{}-installed.txt", kind.as_str())),
            format!("# Delulu runtime {RUNTIME_REVISION}\n{versions}\n").as_bytes(),
        )
        .map_err(io)?;
        self.record_setup_stage("Recording the runtime dependency inventory");
        publish(InstallProgress {
            setup_stage: Some(SetupStage::RuntimeValidate),
            message: "Recording the runtime dependency inventory".into(),
            progress: 0.78,
            detail: None,
        });
        let probe = ["-B".into(), "-c".into(), PYTHON_INVENTORY_PROBE.into()];
        let observation = match self.run(&target.python, &probe, None, Duration::from_secs(15)).await {
            Ok(observation) => observation,
            Err(error) if self.is_cancelled() => return Err(error),
            Err(error) => {
                return Err(SetupError::Message(format!(
                    "Could not inspect runtime dependencies: {}. The previous environment is unchanged.",
                    error.message()
                )))
            }
        };
        let inventory = create_runtime_inventory(
            InventoryContext {
                revision: RUNTIME_REVISION,
                kind,
                generation: &generation,
                backend: inventory_backend(kind, metal, profile),
                target: self.target.clone(),
                python: &candidate_python,
                directory: &candidate,
                requested,
            },
            &observation,
        )
        .map_err(SetupError::Message)?;
        write_runtime_inventory(&candidate, &inventory).map_err(SetupError::Message)?;
        let role = if kind == RuntimeKind::Magic {
            json!({ "kind": kind.as_str(), "revision": RUNTIME_REVISION })
        } else {
            json!({ "kind": kind.as_str(), "revision": RUNTIME_REVISION, "profile": profile.as_str() })
        };
        delulu_core::util::write_private_atomic(&candidate.join("runtime-role.json"), role.to_string().as_bytes())
            .map_err(io)?;
        if self.is_cancelled() {
            return Err(self.cancelled_error());
        }
        self.record_setup_stage("Candidate imports validated; awaiting model load and warmup");
        self.state.lock().candidate = Some(Candidate { generation, python: candidate_python });
        publish(InstallProgress {
            setup_stage: Some(SetupStage::ModelPrepare),
            message: "Runtime candidate prepared. Previous runtime stays selected until model warmup succeeds…".into(),
            progress: 0.8,
            detail: None,
        });
        Ok(())
    }
}

struct PackageTarget<'a> {
    kind: RuntimeKind,
    directory: &'a Path,
    python: String,
    publish: Publish<'a>,
}

async fn forward(mut stream: impl AsyncReadExt + Unpin, is_stderr: bool, chunks: mpsc::UnboundedSender<(bool, String)>) {
    let mut buffer = vec![0u8; 16 * 1024];
    while let Ok(read) = stream.read(&mut buffer).await {
        if read == 0 || chunks.send((is_stderr, String::from_utf8_lossy(&buffer[..read]).into_owned())).is_err() {
            return;
        }
    }
}

fn exit_event(stage: &str, started: Instant, status: Option<std::process::ExitStatus>) -> SetupEvent {
    let mut event =
        SetupEvent::new(SetupLogEntryType::Exit, stage, "Runtime command closed").duration(millis(started));
    event.exit_code = Some(status.and_then(|status| status.code()));
    event.signal = Some(status.and_then(signal_name));
    event
}

#[cfg(unix)]
fn signal_name(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let signal = status.signal()?;
    Some(nix::sys::signal::Signal::try_from(signal).map_or_else(|_| signal.to_string(), |s| s.as_str().to_owned()))
}

#[cfg(not(unix))]
fn signal_name(_status: std::process::ExitStatus) -> Option<String> {
    None
}

/// `os.release()` on macOS (the Darwin kernel version).
fn darwin_release() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        nix::sys::utsname::uname().ok().map(|name| name.release().to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// SIGTERM to the command's group, SIGKILL five seconds later. A build or
/// download subprocess can outlive the installer parent, so escalation stays
/// attached to the group even after the command closes.
fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        if support::signal_group(pid, false) != support::SignalOutcome::Sent {
            support::signal_process(pid, false);
        }
        support::escalate_after(pid, Duration::from_secs(5), || {});
    }
    #[cfg(windows)]
    {
        support::taskkill(pid);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const ACTIVE: &str = "12345678-1234-1234-1234-123456789abc";

    fn installer(root: &Path, kind: RuntimeKind) -> RuntimeInstaller {
        RuntimeInstaller::new(
            InstallerPaths { data_directory: root.to_path_buf(), venv_directory: root.join("voice-venv"), kind: Some(kind) },
            None,
            || std::env::vars_os().collect(),
        )
        .with_platform(false, false, TargetPlatform::new("linux", "x64"))
    }

    fn settings(python_command: &str) -> InstallSettings {
        InstallSettings {
            python_command: python_command.into(),
            speech_engine: SpeechTier::Small,
            voice_engine: VoiceEngineId::Kokoro,
        }
    }

    fn compiles(source: &str) -> bool {
        std::process::Command::new("python3")
            .args(["-c", "import sys; compile(sys.argv[1], '<runtime>', 'exec')", source])
            .status()
            .map(|status| status.success())
            .unwrap_or(true) // No Python on this machine: nothing to check.
    }

    #[test]
    fn generated_voice_runtime_scripts_are_valid_python() {
        assert!(compiles(&pip_check_script(VOICE_PIP_CHECK_EXCEPTIONS)));
        let target = TargetPlatform::new("linux", "x64");
        for profile in [SpeechRuntimeProfile::Cpu, SpeechRuntimeProfile::Full] {
            assert!(compiles(&runtime_readiness_script(RuntimeKind::Voice, &target, true, profile)));
        }
        assert!(compiles(&runtime_readiness_script(RuntimeKind::Magic, &target, false, SpeechRuntimeProfile::Full)));
        assert_eq!(with_packages(&["torch==2.11.0", "Sound_File==1"], &["torch==1", "sound-file==2", "x==1"]).len(), 3);
    }

    #[tokio::test]
    async fn a_failed_setup_keeps_the_active_generation_and_logs_the_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let installer = installer(dir.path(), RuntimeKind::Voice);
        let venv = dir.path().join("voice-venv");
        std::fs::create_dir_all(&venv).unwrap();
        activate_runtime(&venv, ACTIVE).unwrap();
        let pointer = std::fs::read_to_string(venv.join("active.json")).unwrap();
        let attempt = installer.setup_log.lock().begin(crate::setup_log::RuntimeSetupKind::Voice);
        let error = installer
            .install(RuntimeKind::Voice, &settings("/nonexistent/python3.12"), |_| {}, None)
            .await
            .unwrap_err();
        // The configured interpreter could not start: a prerequisite failure.
        assert_eq!(error.code, DomainErrorCode::OperationFailed);
        assert!(error.message.starts_with("[PYTHON_VERSION]"), "{}", error.message);
        assert_eq!(error.cause.as_ref().unwrap().name, "RuntimePrerequisiteError");
        installer.discard();
        installer.setup_log.lock().finish(Some(&attempt), crate::setup_log::FinalOutcome::Error, None);
        assert_eq!(std::fs::read_to_string(venv.join("active.json")).unwrap(), pointer);
        assert_eq!(installer.python().unwrap(), venv.join("generations").join(ACTIVE).join("bin/python"));
        assert!(installer.commit().unwrap_err().message.contains("No prepared runtime"));
        let log = installer.setup_log.lock().snapshot(crate::setup_log::RuntimeSetupKind::Voice);
        assert!(log.entries.iter().any(|entry| entry.kind == SetupLogEntryType::Command));
        // An installer owns one runtime only.
        let wrong = installer.install(RuntimeKind::Magic, &settings("python3"), |_| {}, None).await.unwrap_err();
        assert!(wrong.message.contains("owns the voice runtime"));
        assert!(!installer.ready(RuntimeKind::Voice, SpeechRuntimeProfile::Cpu).await.unwrap());
    }

    #[tokio::test]
    async fn cancellation_terminates_the_running_command() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("slow-python");
        std::fs::write(&script, "sleep 30\n").unwrap();
        let installer = installer(dir.path(), RuntimeKind::Voice);
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        let error = installer
            .install(RuntimeKind::Voice, &settings(&format!("sh {}", script.display())), |_| {}, Some(token))
            .await
            .unwrap_err();
        assert_eq!(error.code, DomainErrorCode::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(installer.processes.lock().is_empty());
        installer.stop_and_wait().await;
    }
}
