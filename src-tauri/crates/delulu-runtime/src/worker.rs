//! One persistent JSON-lines worker transport (`workerClient.ts`), with
//! bounded diagnostics and deterministic failure cleanup.
//!
//! The worker is `python -u <script>` in its own process group (Unix). Every
//! request gets a UUID; responses (`@delulu:`) and progress events
//! (`@delulu-progress:`) are matched by id. A crash, timeout, protocol
//! violation or failed write rejects every pending request and terminates
//! the whole group (SIGTERM, then SIGKILL after five seconds; `taskkill /T /F`
//! on Windows). Output from a stopped worker generation is ignored, even when
//! a failure handler has already started a replacement.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Weak};
use std::time::Duration;

use delulu_core::{CancellationEffect, DomainError, DomainErrorCode, DomainResult};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::environment::ChildEnv;
use crate::prerequisites::tail_utf16;
use crate::private_diagnostics::backend_failure;
use crate::protocol::{
    serialize_worker_request, validate_worker_progress, validate_worker_response, validate_worker_result,
    BoundedWorkerLines, WorkerDiagnosticTail, WorkerProgress, WorkerProtocolLimits, WorkerResponse, PROGRESS_PREFIX,
    RESPONSE_PREFIX,
};
use crate::support;

/// The bundled worker entry point.
pub fn worker_script(paths: &delulu_core::AppPaths) -> PathBuf {
    paths.resource("python/transcription_engine.py")
}

/// Default deadline per command.
pub fn operation_timeout(command: &str) -> Duration {
    Duration::from_millis(match command {
        "load" | "magicLoad" | "voiceLoad" | "coordinatorLoad" | "coordinatorSetup" => 30 * 60_000,
        "voiceSynthesize" | "transcribe" => 120_000,
        "magicRewrite" => 180_000,
        _ => 30_000,
    })
}

/// Transcription deadline: three times the audio, between 2 and 15 minutes.
pub fn transcription_timeout(duration_ms: Option<f64>) -> Duration {
    let ms = match duration_ms {
        Some(ms) if ms.is_finite() => (ms * 3.0).clamp(120_000.0, 15.0 * 60_000.0),
        _ => 15.0 * 60_000.0,
    };
    Duration::from_millis(ms as u64)
}

/// How to start the worker; read on every (re)start.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub python: PathBuf,
    pub script: PathBuf,
    /// The complete child environment.
    pub env: ChildEnv,
}

pub type ConfigSource = Arc<dyn Fn() -> DomainResult<WorkerConfig> + Send + Sync>;
pub type FailureHandler = Arc<dyn Fn(DomainError) + Send + Sync>;
/// `(detail, event)`: the detail is the last 350 characters of `event.detail`.
pub type ProgressHandler = Arc<dyn Fn(&str, &WorkerProgress) + Send + Sync>;

#[derive(Clone, Default)]
pub struct WorkerClientOptions {
    pub on_progress: Option<ProgressHandler>,
    pub limits: WorkerProtocolLimits,
}

const START_FAILED: &str = "Could not start the model worker. Check Python and repair the runtime before retrying.";

struct Outgoing {
    id: String,
    command: String,
    wire: String,
}

struct LiveWorker {
    generation: u64,
    pid: Option<u32>,
    stdin: mpsc::UnboundedSender<Outgoing>,
    exited: watch::Receiver<bool>,
    kill: Option<oneshot::Sender<()>>,
}

struct Pending {
    command: String,
    reply: oneshot::Sender<DomainResult<Value>>,
    timer: JoinHandle<()>,
}

struct State {
    generation: u64,
    child: Option<LiveWorker>,
    pending: HashMap<String, Pending>,
    diagnostics: WorkerDiagnosticTail,
}

struct Inner {
    config: ConfigSource,
    on_failure: FailureHandler,
    on_progress: Option<ProgressHandler>,
    limits: WorkerProtocolLimits,
    /// Serializes worker start-up; never held while calling `on_failure`.
    start: Mutex<()>,
    state: Mutex<State>,
}

/// Cheap to clone; clones share one worker.
#[derive(Clone)]
pub struct WorkerClient {
    inner: Arc<Inner>,
}

fn protocol_error(operation: &str, message: &str) -> DomainError {
    DomainError::new(DomainErrorCode::WorkerProtocol, message)
        .with_operation(delulu_core::uuid(), operation)
        .with_cause("Error", None)
}

/// The rejection one pending request receives when `error` stops its worker.
fn reject_for(error: &DomainError, id: &str, command: &str) -> DomainError {
    // Errors without an operation identity behave like plain JavaScript errors
    // wrapped by `domainError`: they take the request's own identity.
    let plain = error.operation_id.is_none() || error.operation.is_none();
    let failure_id = error.operation_id.as_deref().filter(|_| !plain).unwrap_or(id);
    let failure_operation = error.operation.as_deref().filter(|_| !plain).unwrap_or(command);
    let interrupted = failure_operation != "worker:stop"
        && failure_id != id
        && matches!(error.code, DomainErrorCode::Timeout | DomainErrorCode::Cancelled);
    let (code, message) = if interrupted {
        (
            DomainErrorCode::OperationInterrupted,
            "Model operation interrupted because another operation stopped its worker. Load the model before retrying."
                .to_owned(),
        )
    } else {
        (error.code, error.message.clone())
    };
    let mut rejection = DomainError::new(code, message).with_operation(id, command).with_cancellation_effect(
        if error.code == DomainErrorCode::Cancelled { CancellationEffect::WorkerStopped } else { error.cancellation_effect },
    );
    rejection.cause = error.cause.clone().or_else(|| {
        Some(delulu_core::error::FailureCause { name: if plain { "Error" } else { "DomainError" }.into(), code: None })
    });
    rejection
}

impl WorkerClient {
    pub fn new(
        config: impl Fn() -> DomainResult<WorkerConfig> + Send + Sync + 'static,
        on_failure: impl Fn(DomainError) + Send + Sync + 'static,
    ) -> Self {
        Self::with_options(config, on_failure, WorkerClientOptions::default()).expect("default limits are valid")
    }

    /// Fails only when a limit is not a positive integer.
    pub fn with_options(
        config: impl Fn() -> DomainResult<WorkerConfig> + Send + Sync + 'static,
        on_failure: impl Fn(DomainError) + Send + Sync + 'static,
        options: WorkerClientOptions,
    ) -> DomainResult<Self> {
        let limits = options.limits.validate().map_err(DomainError::invalid)?;
        Ok(Self {
            inner: Arc::new(Inner {
                config: Arc::new(config),
                on_failure: Arc::new(on_failure),
                on_progress: options.on_progress,
                limits,
                start: Mutex::new(()),
                state: Mutex::new(State {
                    generation: 0,
                    child: None,
                    pending: HashMap::new(),
                    diagnostics: WorkerDiagnosticTail::new(limits.stderr_bytes),
                }),
            }),
        })
    }

    pub fn running(&self) -> bool {
        self.inner.state.lock().child.is_some()
    }

    /// Bounded stderr tail of the current (or last) worker. Never show it
    /// verbatim: classify it with [`backend_failure`].
    pub fn stderr(&self) -> String {
        self.inner.state.lock().diagnostics.text()
    }

    pub fn busy(&self) -> bool {
        !self.inner.state.lock().pending.is_empty()
    }

    /// Sends `command` with `payload` (a JSON object) and resolves with the
    /// validated result. Dispatch happens immediately (the request is pending
    /// before the returned future is polled); `timeout` defaults to
    /// [`operation_timeout`]. Must be called inside a Tokio runtime.
    pub fn request(
        &self,
        command: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> impl Future<Output = DomainResult<Value>> + Send + 'static {
        let id = delulu_core::uuid();
        let dispatched = self.inner.dispatch(&id, command, &payload, timeout);
        let command = command.to_owned();
        async move {
            let reply = dispatched?;
            reply.await.unwrap_or_else(|_| {
                Err(DomainError::new(DomainErrorCode::WorkerExited, "Model worker closed").with_operation(id, command))
            })
        }
    }

    /// [`request`](Self::request), deserializing the result.
    pub fn request_as<T: DeserializeOwned>(
        &self,
        command: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> impl Future<Output = DomainResult<T>> + Send + 'static {
        let request = self.request(command, payload, timeout);
        async move {
            let value = request.await?;
            serde_json::from_value(value).map_err(|error| {
                DomainError::new(DomainErrorCode::WorkerProtocol, format!("Unexpected model worker result: {error}"))
            })
        }
    }

    /// Rejects every pending request and terminates the worker group.
    /// `None` is a cancellation (`CANCELLED`, `worker-stopped`).
    pub fn stop(&self, error: Option<DomainError>) {
        self.inner.stop(error);
    }

    /// [`stop`](Self::stop), then waits up to five seconds for the worker to
    /// exit and (Unix) up to five more for its process group to disappear,
    /// killing the group if it lingers. `None` rejects pending requests with
    /// `OPERATION_FAILED` "Model worker stopped".
    pub async fn stop_and_wait(&self, error: Option<DomainError>) {
        let (pid, mut exited) = {
            let state = self.inner.state.lock();
            match &state.child {
                Some(LiveWorker { pid: Some(pid), exited, .. }) => (*pid, exited.clone()),
                _ => return,
            }
        };
        self.inner.stop(Some(error.unwrap_or_else(|| DomainError::failed("Model worker stopped"))));
        let _ = tokio::time::timeout(Duration::from_secs(5), exited.wait_for(|done| *done)).await;
        #[cfg(unix)]
        {
            // Descendants may outlive their parent while releasing CUDA resources.
            for _ in 0..100 {
                if !support::group_alive(pid) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            support::signal_group(pid, true);
        }
        #[cfg(not(unix))]
        let _ = pid;
    }
}

impl Inner {
    fn current(&self, generation: u64) -> bool {
        self.state.lock().child.as_ref().is_some_and(|child| child.generation == generation)
    }

    fn dispatch(
        self: &Arc<Self>,
        id: &str,
        command: &str,
        payload: &Value,
        timeout: Option<Duration>,
    ) -> DomainResult<oneshot::Receiver<DomainResult<Value>>> {
        let invalid = |message: String| {
            DomainError::new(DomainErrorCode::InvalidRequest, message).with_operation(id, command).with_cause("Error", None)
        };
        let wire = serialize_worker_request(id, command, payload, self.limits.request_bytes).map_err(invalid)?;
        let timeout = timeout.unwrap_or_else(|| operation_timeout(command));
        if timeout.is_zero() {
            return Err(invalid("Model worker timeout must be a positive number".into()));
        }
        let started = {
            let _start = self.start.lock();
            if self.state.lock().pending.len() >= self.limits.pending_requests {
                return Err(DomainError::busy(format!(
                    "Model worker already has {} pending requests. Wait for an operation to finish and try again.",
                    self.limits.pending_requests
                ))
                .with_operation(id, command));
            }
            self.ensure_started(id, command)
        };
        let (generation, stdin) = match started {
            Ok(started) => started,
            Err(StartError::Config(error)) => return Err(error),
            Err(StartError::Spawn(error)) => {
                (self.on_failure)(error.clone());
                return Err(reject_for(&error, id, command));
            }
        };
        let (reply, receiver) = oneshot::channel();
        {
            let mut state = self.state.lock();
            if !state.child.as_ref().is_some_and(|child| child.generation == generation) {
                // The worker failed between start-up and registration.
                return Err(DomainError::new(
                    DomainErrorCode::WorkerExited,
                    "Could not send the model operation. Load the model to try again.",
                )
                .with_operation(id, command));
            }
            let weak = Arc::downgrade(self);
            let (timer_id, timer_command) = (id.to_owned(), command.to_owned());
            let timer = tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                if let Some(inner) = weak.upgrade() {
                    inner.on_timeout(&timer_id, &timer_command);
                }
            });
            state.pending.insert(id.to_owned(), Pending { command: command.to_owned(), reply, timer });
        }
        // A closed writer means the worker is exiting; its exit handler reports.
        let _ = stdin.send(Outgoing { id: id.to_owned(), command: command.to_owned(), wire });
        Ok(receiver)
    }

    fn ensure_started(
        self: &Arc<Self>,
        id: &str,
        command: &str,
    ) -> Result<(u64, mpsc::UnboundedSender<Outgoing>), StartError> {
        if let Some(child) = &self.state.lock().child {
            return Ok((child.generation, child.stdin.clone()));
        }
        let config = (self.config)().map_err(|error| {
            let mut wrapped = DomainError::new(DomainErrorCode::WorkerUnavailable, START_FAILED).with_operation(id, command);
            wrapped.cause = error.cause.or_else(|| Some(delulu_core::error::FailureCause { name: "Error".into(), code: None }));
            StartError::Config(wrapped)
        })?;
        let mut process = tokio::process::Command::new(&config.python);
        process
            .arg("-u")
            .arg(&config.script)
            .env_clear()
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Its own process group, so stopping it also releases GPU-owning descendants.
        support::isolate(&mut process);
        let mut child = process.spawn().map_err(|error| {
            StartError::Spawn(
                DomainError::new(DomainErrorCode::WorkerUnavailable, START_FAILED)
                    .with_operation(delulu_core::uuid(), "worker:start")
                    .with_cause("IoError", delulu_core::error::io_error_code(&error)),
            )
        })?;
        let pid = child.id();
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(false);
        let (kill_tx, kill_rx) = oneshot::channel();
        let generation = {
            let mut state = self.state.lock();
            state.generation += 1;
            state.diagnostics = WorkerDiagnosticTail::new(self.limits.stderr_bytes);
            state.child = Some(LiveWorker {
                generation: state.generation,
                pid,
                stdin: stdin_tx.clone(),
                exited: exit_rx,
                kill: Some(kill_tx),
            });
            state.generation
        };
        let weak = Arc::downgrade(self);
        if let Some(stdin) = stdin {
            tokio::spawn(write_requests(weak.clone(), generation, stdin, stdin_rx));
        }
        let readers = [
            stdout.map(|stdout| tokio::spawn(read_stdout(weak.clone(), generation, stdout, self.limits.stdout_line_bytes))),
            stderr.map(|stderr| tokio::spawn(read_stderr(weak.clone(), generation, stderr))),
        ];
        tokio::spawn(wait_for_exit(weak, generation, child, kill_rx, exit_tx, readers));
        Ok((generation, stdin_tx))
    }

    fn on_timeout(&self, id: &str, command: &str) {
        if !self.state.lock().pending.contains_key(id) {
            return;
        }
        self.fail(
            DomainError::timeout(format!("Model operation {command} timed out. Load the model to try again."))
                .with_operation(id, command),
        );
    }

    fn fail(&self, error: DomainError) {
        self.stop(Some(error.clone()));
        (self.on_failure)(error);
    }

    fn stop(&self, error: Option<DomainError>) {
        let error = error.unwrap_or_else(|| {
            DomainError::cancelled("Model worker stopped")
                .with_operation(delulu_core::uuid(), "worker:stop")
                .with_cancellation_effect(CancellationEffect::WorkerStopped)
        });
        let (child, pending) = {
            let mut state = self.state.lock();
            (state.child.take(), std::mem::take(&mut state.pending))
        };
        for (id, request) in pending {
            request.timer.abort();
            let _ = request.reply.send(Err(reject_for(&error, &id, &request.command)));
        }
        if let Some(child) = child {
            terminate(child);
        }
    }

    /// One stdout line. Errors are protocol violations raised while framing.
    fn receive(&self, generation: u64, line: String) -> Result<bool, String> {
        // A stopped generation can leave buffered lines; they are never routed.
        if !self.current(generation) {
            return Ok(false);
        }
        if let Some(json) = line.strip_prefix(PROGRESS_PREFIX) {
            let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
            let event = validate_worker_progress(&value)?;
            let owned = self.state.lock().pending.get(&event.id).is_some_and(|request| request.command == event.command);
            if owned {
                if let Some(on_progress) = &self.on_progress {
                    on_progress(tail_utf16(&event.detail, 350), &event);
                }
            }
            return Ok(self.current(generation));
        }
        let Some(json) = line.strip_prefix(RESPONSE_PREFIX) else { return Ok(true) };
        if self.respond(json).is_err() {
            self.fail(protocol_error(
                "worker:response",
                "Model worker returned an invalid response. Repair its runtime before retrying.",
            ));
        }
        Ok(self.current(generation))
    }

    fn respond(&self, json: &str) -> Result<(), String> {
        let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let response = validate_worker_response(&value)?;
        let request = {
            let mut state = self.state.lock();
            let Some(request) = state.pending.get(response.id()) else { return Ok(()) };
            if let WorkerResponse::Ok { result, .. } = &response {
                validate_worker_result(&request.command, result)?;
            }
            state.pending.remove(response.id())
        };
        let Some(request) = request else { return Ok(()) };
        request.timer.abort();
        let outcome = match response {
            WorkerResponse::Ok { result, .. } => Ok(result),
            WorkerResponse::Err { id, error } => Err(DomainError::backend(backend_failure(&error).message)
                .with_operation(id, request.command.clone())
                .with_cause("Error", None)),
        };
        let _ = request.reply.send(outcome);
        Ok(())
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(child) = self.state.get_mut().child.take() {
            terminate(child);
        }
    }
}

enum StartError {
    /// The configuration could not be read; reported only to the caller.
    Config(DomainError),
    /// The process could not start; also reported to the failure handler.
    Spawn(DomainError),
}

/// Closes stdin and terminates the worker's process group. Escalation keeps
/// targeting this generation's group even after a replacement started.
fn terminate(child: LiveWorker) {
    let LiveWorker { pid, kill, stdin, .. } = child;
    drop(stdin);
    let Some(pid) = pid else { return };
    let fallback = move || {
        if let Some(kill) = kill {
            let _ = kill.send(());
        }
    };
    #[cfg(unix)]
    {
        if support::signal_group(pid, false) == support::SignalOutcome::Failed {
            fallback();
        }
        // Reject immediately, then give this generation five seconds to release
        // resources; timeout/failure paths never wait, so GPU descendants must
        // not survive forever.
        support::escalate_after(pid, Duration::from_secs(5), || {});
    }
    #[cfg(windows)]
    {
        if !support::taskkill(pid) {
            fallback();
        }
    }
}

async fn write_requests(
    weak: Weak<Inner>,
    generation: u64,
    mut stdin: tokio::process::ChildStdin,
    mut requests: mpsc::UnboundedReceiver<Outgoing>,
) {
    while let Some(request) = requests.recv().await {
        let written = async {
            stdin.write_all(request.wire.as_bytes()).await?;
            stdin.flush().await
        };
        // EPIPE from a worker that exited mid-write is reported here once; the
        // exit handler covers everything else.
        if let Err(error) = written.await {
            if let Some(inner) = weak.upgrade().filter(|inner| inner.current(generation)) {
                inner.fail(
                    DomainError::new(
                        DomainErrorCode::WorkerExited,
                        "Could not send the model operation. Load the model to try again.",
                    )
                    .with_operation(request.id, request.command)
                    .with_cause("IoError", delulu_core::error::io_error_code(&error)),
                );
            }
            return;
        }
    }
}

async fn read_stdout(weak: Weak<Inner>, generation: u64, mut stdout: tokio::process::ChildStdout, max_line: usize) {
    let mut lines = BoundedWorkerLines::new(max_line);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        // Keep draining a stopped generation so its 'close' can complete.
        let Some(inner) = weak.upgrade().filter(|inner| inner.current(generation)) else { continue };
        if lines.push(&chunk[..read], &mut |line| inner.receive(generation, line)).is_err() && inner.current(generation) {
            inner.fail(protocol_error(
                "worker:stdout",
                "Model worker output exceeded its protocol limits. Repair its runtime before retrying.",
            ));
        }
    }
    if let Some(inner) = weak.upgrade().filter(|inner| inner.current(generation)) {
        if lines.end(&mut |line| inner.receive(generation, line)).is_err() {
            inner.fail(protocol_error(
                "worker:stdout",
                "Model worker returned incomplete output. Repair its runtime before retrying.",
            ));
        }
    }
}

async fn read_stderr(weak: Weak<Inner>, generation: u64, mut stderr: tokio::process::ChildStderr) {
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let Some(inner) = weak.upgrade() else { continue };
        let mut state = inner.state.lock();
        if state.child.as_ref().is_some_and(|child| child.generation == generation) {
            state.diagnostics.push(&chunk[..read]);
        }
    }
}

async fn wait_for_exit(
    weak: Weak<Inner>,
    generation: u64,
    mut child: tokio::process::Child,
    mut kill: oneshot::Receiver<()>,
    exited: watch::Sender<bool>,
    readers: [Option<JoinHandle<()>>; 2],
) {
    let status = tokio::select! {
        status = child.wait() => status,
        Ok(()) = &mut kill => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // 'exit': stop_and_wait only needs the worker itself to be gone.
    let _ = exited.send(true);
    // 'close': descendants holding stdio delay it, exactly like Node.
    for reader in readers.into_iter().flatten() {
        let _ = reader.await;
    }
    let Some(inner) = weak.upgrade().filter(|inner| inner.current(generation)) else { return };
    let code = status.ok().and_then(|status| status.code());
    let message = match code {
        Some(0) => "Model worker closed".to_owned(),
        Some(code) => format!("Model worker exited ({code}). Load the model to try again."),
        None => "Model worker exited (null). Load the model to try again.".to_owned(),
    };
    inner.fail(
        DomainError::new(DomainErrorCode::WorkerExited, message)
            .with_operation(delulu_core::uuid(), "worker:exit")
            .with_cause("Error", None),
    );
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    use serde_json::json;

    /// A fake worker: answers `status`, streams progress for `load`, crashes on
    /// `crash`, prints an oversized line on `flood`, ignores `hang`.
    const FAKE_WORKER: &str = r#"
import json, sys
for raw in sys.stdin:
    request = json.loads(raw)
    rid, command = request["id"], request["command"]
    def reply(body):
        print("@delulu:" + json.dumps(dict(protocolVersion=1, id=rid, **body)), flush=True)
    if command == "status":
        print("ordinary log line", flush=True)
        reply({"ok": True, "result": {"loaded": False, "model": None, "device": None}})
    elif command == "load" and request.get("model") == "r2t2":
        print("@delulu-progress:" + json.dumps({"protocolVersion": 1, "type": "progress", "id": rid,
              "command": "load", "stage": "download", "detail": "x" * 500}), flush=True)
        reply({"ok": True, "result": {"loaded": True, "model": "r2t2", "device": "cuda", "residency": "resident"}})
    elif command == "unload":
        reply({"ok": False, "error": "torch.cuda.OutOfMemoryError: secret transcript"})
    elif command == "magicStatus":
        reply({"ok": True, "result": {"loaded": "yes"}})
    elif request.get("model") == "parakeet-v3":
        print("x" * 5000, flush=True)
    elif request.get("model") == "canary-180m":
        sys.stderr.write("fatal: worker crashed\n"); sys.stderr.flush()
        sys.exit(3)
"#;

    struct Fixture {
        _dir: tempfile::TempDir,
        client: WorkerClient,
        failures: Arc<Mutex<Vec<DomainError>>>,
        progress: Arc<AtomicUsize>,
    }

    fn fixture(program: &str, script: &str, limits: WorkerProtocolLimits) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker");
        std::fs::write(&path, script).unwrap();
        let failures = Arc::new(Mutex::new(Vec::new()));
        let progress = Arc::new(AtomicUsize::new(0));
        let (seen, count) = (failures.clone(), progress.clone());
        let program = PathBuf::from(program);
        let client = WorkerClient::with_options(
            move || Ok(WorkerConfig { python: program.clone(), script: path.clone(), env: std::env::vars_os().collect() }),
            move |error| seen.lock().push(error),
            WorkerClientOptions {
                on_progress: Some(Arc::new(move |detail, event| {
                    assert_eq!((detail.len(), event.stage.as_str()), (350, "download"));
                    count.fetch_add(1, Ordering::SeqCst);
                })),
                limits,
            },
        )
        .unwrap();
        Fixture { _dir: dir, client, failures, progress }
    }

    fn python_worker(limits: WorkerProtocolLimits) -> Fixture {
        fixture("python3", FAKE_WORKER, limits)
    }

    #[tokio::test]
    async fn requests_resolve_with_validated_results_and_owned_progress() {
        let f = python_worker(WorkerProtocolLimits::default());
        let status = f.client.request("status", json!({}), None).await.unwrap();
        assert_eq!(status["loaded"], false);
        let loaded = f.client.request("load", json!({ "model": "r2t2" }), None).await.unwrap();
        assert_eq!(loaded["residency"], "resident");
        assert_eq!(f.progress.load(Ordering::SeqCst), 1);
        let failure = f.client.request("unload", json!({}), None).await.unwrap_err();
        assert_eq!(failure.code, DomainErrorCode::BackendFailure);
        assert!(failure.message.starts_with("The model ran out of memory") && !failure.message.contains("secret"));
        assert!(f.client.running() && !f.client.busy());
        // A result that breaks its schema is a protocol failure that stops the worker.
        let invalid = f.client.request("magicStatus", json!({}), None).await.unwrap_err();
        assert_eq!(invalid.code, DomainErrorCode::WorkerProtocol);
        assert!(!f.client.running());
        assert_eq!(f.failures.lock().len(), 1);
        f.client.stop_and_wait(None).await;
    }

    #[tokio::test]
    async fn timeouts_reject_every_pending_request_and_stop_the_group() {
        let f = python_worker(WorkerProtocolLimits::default());
        let other = f.client.request("transcribe", json!({ "audioPath": "/a.wav" }), None);
        let timed = f.client.request("capabilities", json!({ "engine": "speech" }), Some(Duration::from_millis(300)));
        let (timed, other) = tokio::join!(timed, other);
        let (timed, other) = (timed.unwrap_err(), other.unwrap_err());
        assert_eq!(timed.code, DomainErrorCode::Timeout);
        assert_eq!(timed.message, "Model operation capabilities timed out. Load the model to try again.");
        assert_eq!(other.code, DomainErrorCode::OperationInterrupted);
        assert!(!f.client.running());
        assert_eq!(f.failures.lock()[0].code, DomainErrorCode::Timeout);
        // The next request starts a fresh generation.
        assert!(f.client.request("status", json!({}), None).await.is_ok());
        f.client.stop_and_wait(None).await;
    }

    #[tokio::test]
    async fn crashes_reject_pending_requests_and_keep_a_bounded_stderr_tail() {
        let f = python_worker(WorkerProtocolLimits { stderr_bytes: 12, ..WorkerProtocolLimits::default() });
        let error = f.client.request("load", json!({ "model": "canary-180m" }), None).await.unwrap_err();
        assert_eq!(error.code, DomainErrorCode::WorkerExited);
        assert_eq!(error.message, "Model worker exited (3). Load the model to try again.");
        assert_eq!(f.client.stderr(), "ker crashed\n");
        assert!(!f.client.running());
    }

    #[tokio::test]
    async fn protocol_bounds_are_enforced() {
        let limits = WorkerProtocolLimits { pending_requests: 1, stdout_line_bytes: 1024, request_bytes: 256, ..Default::default() };
        let f = python_worker(limits);
        let oversized = f.client.request("status", json!({ "text": "x".repeat(300) }), None).await.unwrap_err();
        assert_eq!(oversized.code, DomainErrorCode::InvalidRequest);
        assert!(oversized.message.contains("exceeds 256 UTF-8 bytes"));
        let first = f.client.request("load", json!({ "model": "parakeet-v3" }), None);
        let busy = f.client.request("status", json!({}), None).await.unwrap_err();
        assert_eq!(busy.code, DomainErrorCode::Busy);
        let flood = first.await.unwrap_err();
        assert_eq!(flood.code, DomainErrorCode::WorkerProtocol);
        assert!(flood.message.contains("exceeded its protocol limits"));
        let missing = fixture("/nonexistent/python", "", WorkerProtocolLimits::default());
        let error = missing.client.request("status", json!({}), None).await.unwrap_err();
        assert_eq!(error.code, DomainErrorCode::WorkerUnavailable);
        assert_eq!(missing.failures.lock().len(), 1);
    }

    #[tokio::test]
    async fn stop_and_wait_does_not_wait_out_its_fallback_when_the_worker_already_exited() {
        // The background sleep inherits stdout, so 'close' waits for it while 'exit' fires at once.
        let f = fixture("/bin/sh", "sleep 30 &\nexit 0\n", WorkerProtocolLimits::default());
        let pending = f.client.request("status", json!({}), Some(Duration::from_secs(20)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        f.client.stop_and_wait(None).await;
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
        assert!(pending.await.is_err());
    }

    #[tokio::test]
    async fn stop_cancels_pending_requests() {
        let f = python_worker(WorkerProtocolLimits::default());
        let pending = f.client.request("transcribe", json!({ "audioPath": "/a.wav" }), None);
        f.client.stop(None);
        let error = pending.await.unwrap_err();
        assert_eq!(error.code, DomainErrorCode::Cancelled);
        assert_eq!(error.cancellation_effect, CancellationEffect::WorkerStopped);
        assert!(f.failures.lock().is_empty());
    }
}
