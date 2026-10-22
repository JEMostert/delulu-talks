//! The recording indicator (`pill.ts`): supervises `python3
//! overlay/pill.py`, a click-through gtk4-layer-shell pill driven by JSON
//! lines on stdin, on Linux Wayland. macOS uses an app-provided panel
//! window ([`MacPillFactory`], see [`crate::mac_pill`]).

use delulu_core::HostEnv;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use delulu_core::AppPaths;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::command::KillSignal;
use crate::env::DesktopEnv;
use crate::types::{OverlayMethod, Platform};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PillState {
    Hidden,
    Listening,
    Transcribing,
    Magic,
    Delivering,
    Success,
    Error,
}

/// One stdin line of the helper protocol.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PillCommand {
    pub state: PillState,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub level: Option<f64>,
}

impl PillCommand {
    pub fn hidden() -> Self {
        Self { state: PillState::Hidden, title: None, detail: None, level: None }
    }
    pub fn new(state: PillState) -> Self {
        Self { state, ..Self::hidden() }
    }
}

// ---------------------------------------------------------------------------
// App-level macOS panel

/// Creates the macOS recording panel (a nonactivating, click-through,
/// always-on-top transparent window; see [`crate::mac_pill`]).
pub trait MacPillFactory: Send + Sync {
    /// Called on the first visible command. Report failures through
    /// `on_error`; the pill then shows as unavailable until the next
    /// visible command creates a new panel.
    fn create(&self, on_error: Arc<dyn Fn(String) + Send + Sync>) -> Box<dyn MacPillWindow>;
}

pub trait MacPillWindow: Send {
    fn send(&mut self, command: &PillCommand);
    fn shutdown(&mut self);
}

// ---------------------------------------------------------------------------
// Helper process boundary

pub trait HelperProcess: Send + Sync {
    fn signal(&self, signal: KillSignal);
}

pub struct SpawnedHelper {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub stderr: Box<dyn Read + Send>,
    pub process: Arc<dyn HelperProcess>,
    /// Blocks until the process exits; `None` when a signal ended it.
    pub wait: Box<dyn FnOnce() -> Option<i32> + Send>,
}

pub trait HelperSpawner: Send + Sync {
    fn spawn(&self, python: &Path, script: &Path, env: &HashMap<String, String>) -> std::io::Result<SpawnedHelper>;
}

pub struct SystemSpawner;

struct SystemProcess {
    pid: u32,
    exited: Arc<AtomicBool>,
}

impl HelperProcess for SystemProcess {
    fn signal(&self, signal: KillSignal) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            let signal = if signal == KillSignal::Kill { libc::SIGKILL } else { libc::SIGTERM };
            // SAFETY: signal delivery to our own child, not yet reaped.
            unsafe { libc::kill(self.pid as libc::pid_t, signal) };
        }
        #[cfg(not(unix))]
        let _ = (signal, self.pid);
    }
}

impl HelperSpawner for SystemSpawner {
    fn spawn(&self, python: &Path, script: &Path, env: &HashMap<String, String>) -> std::io::Result<SpawnedHelper> {
        let mut child = Command::new(python)
            .arg(script)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let exited = Arc::new(AtomicBool::new(false));
        let process = Arc::new(SystemProcess { pid: child.id(), exited: exited.clone() });
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        Ok(SpawnedHelper {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            process,
            wait: Box::new(move || {
                let status = child.wait().ok();
                exited.store(true, Ordering::SeqCst);
                status.and_then(|status| status.code())
            }),
        })
    }
}

// ---------------------------------------------------------------------------
// Discovery

/// The Electron list plus the runtime sonames: Fedora's `gtk4-layer-shell`
/// ships only `/usr/lib64/libgtk4-layer-shell.so.0` (the unversioned link
/// and the pkg-config file come with `-devel`).
const LAYER_SHELL_CANDIDATES: [&str; 5] = [
    "/usr/lib/libgtk4-layer-shell.so",
    "/usr/lib64/libgtk4-layer-shell.so",
    "/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so.0",
    "/usr/lib64/libgtk4-layer-shell.so.0",
    "/usr/lib/libgtk4-layer-shell.so.0",
];

pub fn layer_shell_candidates(pkg_config_directory: Option<&str>) -> Vec<PathBuf> {
    pkg_config_directory
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join("libgtk4-layer-shell.so"))
        .into_iter()
        .chain(LAYER_SHELL_CANDIDATES.iter().map(PathBuf::from))
        .collect()
}

/// `python3` on PATH, then the usual absolute locations.
pub fn resolve_system_python(which: &dyn Fn(&str) -> Option<PathBuf>, exists: &dyn Fn(&Path) -> bool) -> PathBuf {
    if let Some(located) = which("python3").filter(|path| exists(path)) {
        return located;
    }
    ["/usr/bin/python3", "/usr/local/bin/python3"]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| exists(candidate))
        .unwrap_or_else(|| PathBuf::from("python3"))
}

fn pkg_config_libdir() -> Option<String> {
    let output = Command::new("pkg-config")
        .host_env()
        .args(["--variable=libdir", "gtk4-layer-shell-0"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// A compositor without layer-shell (GNOME/Mutter) never gains it while
/// running, and a missing Python module stays missing.
fn permanent_failure(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.to_lowercase();
        line.contains("unsupported")
            || line.contains("no module named")
            || line.find("namespace ").is_some_and(|at| line[at + "namespace ".len()..].contains(" not available"))
    })
}

// ---------------------------------------------------------------------------
// Service

type Which = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

pub struct PillIo {
    pub env: DesktopEnv,
    pub script: PathBuf,
    pub spawner: Arc<dyn HelperSpawner>,
    pub exists: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
    pub which: Which,
    pub pkg_config_libdir: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub kill_delay: Duration,
    pub mac: Option<Arc<dyn MacPillFactory>>,
}

impl PillIo {
    pub fn system(paths: &AppPaths, mac: Option<Arc<dyn MacPillFactory>>) -> Self {
        Self {
            env: DesktopEnv::current(),
            script: paths.resource("overlay/pill.py"),
            spawner: Arc::new(SystemSpawner),
            exists: Arc::new(|path: &Path| path.exists()),
            which: Arc::new(|program: &str| which::which(program).ok()),
            pkg_config_libdir: Arc::new(pkg_config_libdir),
            kill_delay: Duration::from_secs(5),
            mac,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retry {
    Now,
    After(Instant),
    Never,
}

struct ChildHandle {
    id: u64,
    stdin: Option<Box<dyn Write + Send>>,
    process: Arc<dyn HelperProcess>,
}

struct State {
    child: Option<ChildHandle>,
    next_child: u64,
    ready: bool,
    desired: PillCommand,
    unavailable_reason: Option<String>,
    retry: Retry,
    resolved_library: Option<Option<PathBuf>>,
    resolved_python: Option<PathBuf>,
    use_preload: bool,
    preload_attempted: bool,
    mac: Option<Box<dyn MacPillWindow>>,
}

struct Inner {
    io: PillIo,
    state: Mutex<State>,
    /// Set by the mac panel's `on_error`, applied on the next call (never
    /// re-enters the state lock from inside a panel call).
    mac_error: Arc<Mutex<Option<String>>>,
}

#[derive(Clone)]
pub struct PillService {
    inner: Arc<Inner>,
}

impl PillService {
    pub fn new(io: PillIo) -> Self {
        Self {
            inner: Arc::new(Inner {
                io,
                state: Mutex::new(State {
                    child: None,
                    next_child: 0,
                    ready: false,
                    desired: PillCommand::hidden(),
                    unavailable_reason: None,
                    retry: Retry::Now,
                    resolved_library: None,
                    resolved_python: None,
                    use_preload: false,
                    preload_attempted: false,
                    mac: None,
                }),
                mac_error: Arc::new(Mutex::new(None)),
            }),
        }
    }

    fn supported(&self) -> bool {
        self.inner.io.env.is_linux_wayland()
    }

    fn lock(&self) -> parking_lot::MutexGuard<'_, State> {
        let mut state = self.inner.state.lock();
        if let Some(message) = self.inner.mac_error.lock().take() {
            state.unavailable_reason = Some(message);
            if let Some(mut mac) = state.mac.take() {
                mac.shutdown();
            }
        }
        state
    }

    pub fn method(&self) -> OverlayMethod {
        let mut state = self.lock();
        if self.inner.io.env.platform == Platform::Darwin {
            return if state.unavailable_reason.is_some() { OverlayMethod::Unavailable } else { OverlayMethod::MacPanel };
        }
        if self.supported() && self.inner.layer_shell_library(&mut state).is_some() && state.unavailable_reason.is_none() {
            OverlayMethod::LayerShell
        } else {
            OverlayMethod::Unavailable
        }
    }

    pub fn detail(&self) -> String {
        let mut state = self.lock();
        if self.inner.io.env.platform == Platform::Darwin {
            return state
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "Nonactivating click-through Mac recording panel".into());
        }
        if !self.supported() {
            return "Native pill requires a Wayland layer-shell compositor".into();
        }
        if self.inner.layer_shell_library(&mut state).is_none() {
            return "Install gtk4-layer-shell to enable the native pill".into();
        }
        state.unavailable_reason.clone().unwrap_or_else(|| "Native click-through layer-shell pill".into())
    }

    /// Starts the helper ahead of the first recording (overlay enabled).
    pub fn prepare(&self) {
        let mut state = self.lock();
        if !self.supported() || state.child.is_some() {
            return;
        }
        // Turning the overlay back on is an explicit request to try again.
        state.retry = Retry::Now;
        state.preload_attempted = false;
        state.desired = PillCommand::hidden();
        Inner::start(&self.inner, &mut state);
    }

    /// Shows a visible state (`command.state` must not be `Hidden`).
    pub fn show(&self, command: PillCommand) {
        self.send(command);
    }

    pub fn hide(&self) {
        self.send(PillCommand::hidden());
    }

    /// Audio level (0–1, ~20 Hz) while listening.
    pub fn level(&self, value: f64) {
        let desired = self.lock().desired.clone();
        if desired.state != PillState::Listening {
            return;
        }
        let level = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
        self.send(PillCommand { level: Some(level), ..desired });
    }

    fn send(&self, command: PillCommand) {
        let mut state = self.lock();
        state.desired = if command.state == PillState::Listening {
            command.clone()
        } else {
            PillCommand { level: None, ..command.clone() }
        };
        if self.inner.io.env.platform == Platform::Darwin {
            if state.mac.is_none() && command.state != PillState::Hidden {
                if let Some(factory) = &self.inner.io.mac {
                    state.unavailable_reason = None;
                    let slot = self.inner.mac_error.clone();
                    state.mac = Some(factory.create(Arc::new(move |message| *slot.lock() = Some(message))));
                }
            }
            if let Some(mac) = state.mac.as_mut() {
                mac.send(&command);
            }
            return;
        }
        if !self.supported() {
            return;
        }
        if state.child.is_none() && command.state != PillState::Hidden {
            Inner::start(&self.inner, &mut state);
        }
        if state.ready {
            Inner::write(&mut state, &command);
        }
    }

    /// Closes stdin and sends SIGTERM, escalating to SIGKILL after the kill
    /// delay if the helper ignores it.
    pub fn shutdown(&self) {
        let mut state = self.lock();
        if let Some(mut mac) = state.mac.take() {
            mac.shutdown();
        }
        state.ready = false;
        let Some(mut child) = state.child.take() else { return };
        drop(state);
        drop(child.stdin.take());
        child.process.signal(KillSignal::Term);
        let process = child.process.clone();
        let delay = self.inner.io.kill_delay;
        thread::spawn(move || {
            thread::sleep(delay);
            process.signal(KillSignal::Kill);
        });
    }
}

impl Inner {
    fn layer_shell_library(&self, state: &mut State) -> Option<PathBuf> {
        if let Some(resolved) = &state.resolved_library {
            return resolved.clone();
        }
        let directory = (self.io.pkg_config_libdir)();
        let found = layer_shell_candidates(directory.as_deref()).into_iter().find(|candidate| self.exists(candidate));
        state.resolved_library = Some(found.clone());
        found
    }

    fn exists(&self, path: &Path) -> bool {
        (self.io.exists)(path)
    }

    fn python(&self, state: &mut State) -> PathBuf {
        if state.resolved_python.is_none() {
            let exists = |path: &Path| self.exists(path);
            state.resolved_python = Some(resolve_system_python(&*self.io.which, &exists));
        }
        state.resolved_python.clone().unwrap_or_else(|| PathBuf::from("python3"))
    }

    fn start(this: &Arc<Self>, state: &mut State) {
        match state.retry {
            Retry::Never => return,
            Retry::After(at) if Instant::now() < at => return,
            _ => {}
        }
        if !this.exists(&this.io.script) {
            state.unavailable_reason = Some("Native pill helper is missing".into());
            return;
        }
        state.ready = false;
        state.unavailable_reason = None;
        let Some(library) = this.layer_shell_library(state) else {
            state.unavailable_reason = Some("Install gtk4-layer-shell to enable the native pill".into());
            return;
        };
        let mut env = this.io.env.vars.clone();
        env.insert("GDK_BACKEND".into(), "wayland".into());
        env.insert("PYTHONUNBUFFERED".into(), "1".into());
        if state.use_preload {
            // Some hosts need the Wayland shim on the linker path before GTK is imported.
            let library = library.to_string_lossy().into_owned();
            let preload = match this.io.env.var("LD_PRELOAD").filter(|v| !v.is_empty()) {
                Some(existing) => format!("{library}:{existing}"),
                None => library,
            };
            env.insert("LD_PRELOAD".into(), preload);
        }
        state.next_child += 1;
        let id = state.next_child;
        let python = this.python(state);
        let helper = match this.io.spawner.spawn(&python, &this.io.script, &env) {
            Ok(helper) => helper,
            Err(error) => {
                state.child = Some(ChildHandle { id, stdin: None, process: Arc::new(NoProcess) });
                Self::finish(this, state, id, None, Some(error.to_string()), String::new());
                return;
            }
        };
        state.child = Some(ChildHandle { id, stdin: Some(helper.stdin), process: helper.process });
        let weak = Arc::downgrade(this);
        let stdout = helper.stdout;
        let stdout_reader = {
            let weak = weak.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if let Some(inner) = weak.upgrade() {
                        inner.message(id, &line);
                    }
                }
            })
        };
        let mut stderr_pipe = helper.stderr;
        let stderr_reader = thread::spawn(move || {
            let mut tail = String::new();
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stderr_pipe.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                tail.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if tail.len() > 2000 {
                    let mut cut = tail.len() - 2000;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
            tail
        });
        let wait = helper.wait;
        thread::spawn(move || {
            let _ = stdout_reader.join();
            let stderr = stderr_reader.join().unwrap_or_default();
            let code = wait();
            if let Some(inner) = weak.upgrade() {
                let mut state = inner.state.lock();
                Self::finish(&inner, &mut state, id, code, None, stderr);
            }
        });
    }

    fn message(&self, id: u64, line: &str) {
        #[derive(Deserialize)]
        struct Message {
            #[serde(rename = "type")]
            kind: Option<String>,
            message: Option<String>,
        }
        // Helper diagnostics that are not protocol messages are ignored.
        let Ok(message) = serde_json::from_str::<Message>(line) else { return };
        let mut state = self.state.lock();
        if state.child.as_ref().map(|c| c.id) != Some(id) {
            return;
        }
        match message.kind.as_deref() {
            Some("ready") => {
                state.ready = true;
                state.unavailable_reason = None;
                let desired = state.desired.clone();
                Self::write(&mut state, &desired);
            }
            Some("error") => {
                state.unavailable_reason = Some(message.message.unwrap_or_else(|| "Native pill could not start".into()));
            }
            _ => {}
        }
    }

    fn write(state: &mut State, command: &PillCommand) {
        if !state.ready {
            return;
        }
        let Some(stdin) = state.child.as_mut().and_then(|child| child.stdin.as_mut()) else { return };
        let Ok(mut line) = serde_json::to_vec(command) else { return };
        line.push(b'\n');
        // A helper that just exited must not take the app down.
        let _ = stdin.write_all(&line).and_then(|_| stdin.flush());
    }

    fn finish(this: &Arc<Self>, state: &mut State, id: u64, code: Option<i32>, error: Option<String>, stderr: String) {
        if state.child.as_ref().map(|c| c.id) != Some(id) {
            return;
        }
        if let Some(error) = error {
            state.unavailable_reason = Some(format!("Native pill unavailable: {error}"));
        }
        let started = state.ready;
        state.child = None;
        state.ready = false;
        let nonzero = code.is_some_and(|code| code != 0);
        let failed = !started || nonzero || state.unavailable_reason.is_some();
        let library = this.layer_shell_library(state);
        if failed && !state.preload_attempted && library.is_some() {
            state.preload_attempted = true;
            state.use_preload = true;
            state.retry = Retry::Now;
            Self::start(this, state);
            return;
        }
        let combined = format!("{}\n{stderr}", state.unavailable_reason.as_deref().unwrap_or(""));
        state.retry = if permanent_failure(&combined) {
            Retry::Never
        } else {
            Retry::After(Instant::now() + Duration::from_secs(10))
        };
        if !started || nonzero {
            let last = stderr.trim().lines().last().filter(|line| !line.is_empty()).map(str::to_owned);
            let reason = last
                .or_else(|| state.unavailable_reason.clone())
                .unwrap_or_else(|| format!("Native pill exited with code {}", code.unwrap_or(0)));
            state.unavailable_reason = Some(reason.chars().take(240).collect());
        }
    }
}

struct NoProcess;

impl HelperProcess for NoProcess {
    fn signal(&self, _signal: KillSignal) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc;

    #[derive(Default)]
    struct FakeProcess {
        signals: Mutex<Vec<KillSignal>>,
    }
    impl HelperProcess for FakeProcess {
        fn signal(&self, signal: KillSignal) {
            self.signals.lock().push(signal);
        }
    }

    /// Children that print `stdout`/`stderr` and exit with `code`, or block
    /// until the test releases them.
    struct FakeSpawner {
        script: Mutex<Vec<(String, String, Option<i32>)>>,
        spawned: Mutex<Vec<HashMap<String, String>>>,
        processes: Mutex<Vec<Arc<FakeProcess>>>,
        hold: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl HelperSpawner for FakeSpawner {
        fn spawn(&self, _python: &Path, _script: &Path, env: &HashMap<String, String>) -> std::io::Result<SpawnedHelper> {
            self.spawned.lock().push(env.clone());
            let (stdout, stderr, code) =
                self.script.lock().pop().unwrap_or_else(|| ("{\"type\":\"ready\"}\n".into(), String::new(), Some(0)));
            let process = Arc::new(FakeProcess::default());
            self.processes.lock().push(process.clone());
            let hold = self.hold.lock().take();
            Ok(SpawnedHelper {
                stdin: Box::new(std::io::sink()),
                stdout: Box::new(Cursor::new(stdout.into_bytes())),
                stderr: Box::new(Cursor::new(stderr.into_bytes())),
                process,
                wait: Box::new(move || {
                    if let Some(hold) = hold {
                        let _ = hold.recv();
                    }
                    code
                }),
            })
        }
    }

    fn service(spawner: Arc<FakeSpawner>) -> PillService {
        PillService::new(PillIo {
            env: DesktopEnv::new(Platform::Linux, [("XDG_SESSION_TYPE", "wayland")]),
            script: PathBuf::from("/app/overlay/pill.py"),
            spawner,
            exists: Arc::new(|path: &Path| {
                path == Path::new("/app/overlay/pill.py") || path == Path::new("/usr/lib64/libgtk4-layer-shell.so")
            }),
            which: Arc::new(|_| Some(PathBuf::from("/usr/bin/python3"))),
            pkg_config_libdir: Arc::new(|| Some("/usr/lib64".into())),
            kill_delay: Duration::from_millis(10),
            mac: None,
        })
    }

    fn spawner() -> Arc<FakeSpawner> {
        Arc::new(FakeSpawner {
            script: Mutex::new(vec![]),
            spawned: Mutex::new(vec![]),
            processes: Mutex::new(vec![]),
            hold: Mutex::new(None),
        })
    }

    fn eventually(condition: impl Fn() -> bool) {
        for _ in 0..200 {
            if condition() {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("condition not reached");
    }

    #[test]
    fn shutdown_escalates_to_sigkill_when_the_helper_ignores_sigterm() {
        let spawner = spawner();
        let (_release, hold) = mpsc::channel();
        *spawner.hold.lock() = Some(hold);
        let pill = service(spawner.clone());
        pill.prepare();
        assert_eq!(pill.method(), OverlayMethod::LayerShell);
        pill.shutdown();
        let process = spawner.processes.lock()[0].clone();
        assert_eq!(*process.signals.lock(), [KillSignal::Term]);
        eventually(|| process.signals.lock().len() == 2);
        assert_eq!(*process.signals.lock(), [KillSignal::Term, KillSignal::Kill]);
    }

    #[test]
    fn missing_python_modules_retry_once_with_ld_preload_then_never_respawn() {
        let spawner = spawner();
        let failure = (String::new(), "Traceback\nModuleNotFoundError: No module named 'gi'\n".to_owned(), Some(1));
        *spawner.script.lock() = vec![failure.clone(), failure];
        let pill = service(spawner.clone());
        pill.show(PillCommand::new(PillState::Listening));
        eventually(|| spawner.spawned.lock().len() == 2 && pill.method() == OverlayMethod::Unavailable);
        let spawned = spawner.spawned.lock().clone();
        assert!(!spawned[0].contains_key("LD_PRELOAD"));
        assert_eq!(spawned[1]["LD_PRELOAD"], "/usr/lib64/libgtk4-layer-shell.so");
        assert_eq!(spawned[1]["GDK_BACKEND"], "wayland");
        assert_eq!(pill.detail(), "ModuleNotFoundError: No module named 'gi'");
        pill.level(0.5);
        pill.show(PillCommand::new(PillState::Transcribing));
        thread::sleep(Duration::from_millis(20));
        assert_eq!(spawner.spawned.lock().len(), 2);
    }

    #[test]
    fn non_wayland_sessions_and_missing_layer_shell_are_reported() {
        let pill = PillService::new(PillIo {
            env: DesktopEnv::new(Platform::Linux, [("XDG_SESSION_TYPE", "x11")]),
            ..service_io_without_library()
        });
        assert_eq!(pill.detail(), "Native pill requires a Wayland layer-shell compositor");
        let pill = PillService::new(service_io_without_library());
        assert_eq!(pill.method(), OverlayMethod::Unavailable);
        assert_eq!(pill.detail(), "Install gtk4-layer-shell to enable the native pill");
        assert_eq!(
            layer_shell_candidates(Some("/opt/lib"))[0],
            PathBuf::from("/opt/lib/libgtk4-layer-shell.so")
        );
        assert!(permanent_failure("x\nNamespace GtkLayerShell not available\n"));
        assert!(!permanent_failure("Gtk-WARNING: cannot open display"));
    }

    fn service_io_without_library() -> PillIo {
        PillIo {
            env: DesktopEnv::new(Platform::Linux, [("XDG_SESSION_TYPE", "wayland")]),
            script: PathBuf::from("/app/overlay/pill.py"),
            spawner: spawner(),
            exists: Arc::new(|_| false),
            which: Arc::new(|_| None),
            pkg_config_libdir: Arc::new(|| None),
            kill_delay: Duration::from_millis(10),
            mac: None,
        }
    }

    /// Manual check with the real helper on this desktop (GNOME has no
    /// layer-shell, so the helper exits before opening a window):
    /// `cargo test -p delulu-desktop -- --ignored real_helper --nocapture`.
    #[test]
    #[ignore = "starts backend/overlay/pill.py"]
    fn real_helper_reports_its_status() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let paths = AppPaths::at(std::env::temp_dir(), root);
        let pill = PillService::new(PillIo::system(&paths, None));
        pill.prepare();
        thread::sleep(Duration::from_secs(4));
        println!("method: {:?}, detail: {}", pill.method(), pill.detail());
        pill.shutdown();
    }

    #[test]
    fn commands_serialize_like_the_helper_protocol() {
        let command = PillCommand { level: Some(0.5), ..PillCommand::new(PillState::Listening) };
        assert_eq!(serde_json::to_string(&command).unwrap(), r#"{"state":"listening","level":0.5}"#);
    }
}
