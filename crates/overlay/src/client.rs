use crate::{audible_level, Message, PillState, UNAVAILABLE};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LEVEL_INTERVAL: Duration = Duration::from_millis(33);
/// Crashes in a row before a pill program is given up for this session.
const MAX_FAILURES: u32 = 3;
/// A pill that ran this long before it crashed starts a fresh count.
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// The native pill's binary name, next to the caller or in [`HELPER_DIR`].
const NATIVE: &str = "delulu-pill";
/// Where the packages install helper binaries.
const HELPER_DIR: &str = "/usr/lib/delulu-talks";

/// Drives the recording pill process. Every call returns at once: a writer
/// thread owns the process, so the audio thread never blocks on a pipe.
///
/// The writer starts the native `delulu-pill` when it is installed (see
/// [`native_pill`]) and falls back to a GTK `--pill` helper when it is
/// missing, exits "unavailable" (no layer-shell and no X display it can use)
/// or keeps crashing. Each program gets at most one "unavailable" exit and
/// [`MAX_FAILURES`] crashes a minute, so a broken pill never loops.
pub struct Pill {
    tx: OnceLock<mpsc::Sender<Message>>,
    gate: Mutex<Gate>,
    fallback: Fallback,
}

/// The GTK helper to fall back on.
#[derive(Clone)]
enum Fallback {
    /// This process's own binary, `--pill` (the app).
    OwnBinary,
    /// Another binary's `--pill` mode (the daemon uses the app's).
    Program(PathBuf),
    /// None: only the native pill.
    None,
}

#[derive(Default)]
struct Gate {
    listening: bool,
    last_level: Option<Instant>,
}

impl Default for Pill {
    fn default() -> Self {
        Self::new()
    }
}

impl Pill {
    /// The native pill, else this binary's `--pill` helper. Cheap: nothing
    /// starts until the first message.
    pub fn new() -> Self {
        Self::with_fallback(Fallback::OwnBinary)
    }

    /// The native pill, else `program --pill`.
    pub fn with_program(program: PathBuf) -> Self {
        Self::with_fallback(Fallback::Program(program))
    }

    /// The native pill alone; None when it is not installed.
    pub fn native() -> Option<Self> {
        native_pill().map(|_| Self::with_fallback(Fallback::None))
    }

    fn with_fallback(fallback: Fallback) -> Self {
        Self {
            tx: OnceLock::new(),
            gate: Mutex::new(Gate::default()),
            fallback,
        }
    }

    pub fn show(&self, state: PillState, label: Option<&str>) {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        gate.listening = state == PillState::Listening;
        gate.last_level = None;
        self.send(Message {
            state,
            level: None,
            label: label.map(Into::into),
        });
    }

    /// Feed a raw RMS level. Ignored unless the pill is listening, so a late
    /// audio callback can't pull it back from transcribing; about 30 Hz at most.
    pub fn level(&self, rms: f32) {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        if !gate.listening
            || gate
                .last_level
                .is_some_and(|t| t.elapsed() < LEVEL_INTERVAL)
        {
            return;
        }
        gate.last_level = Some(Instant::now());
        self.send(Message {
            state: PillState::Listening,
            level: Some(audible_level(rms)),
            label: None,
        });
    }

    pub fn hide(&self) {
        self.show(PillState::Hidden, None);
    }

    fn send(&self, m: Message) {
        let tx = self.tx.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            let fallback = self.fallback.clone();
            if let Err(e) = std::thread::Builder::new()
                .name("pill".into())
                .spawn(move || writer(rx, programs(native_pill(), fallback)))
            {
                eprintln!("pill: writer thread: {e}");
            }
            tx
        });
        let _ = tx.send(m);
    }
}

/// The native pill: `$DELULU_PILL` (a path; anything else, such as `gtk`,
/// skips the native pill), else `delulu-pill` next to this binary, else the
/// packaged one in `/usr/lib/delulu-talks`.
pub fn native_pill() -> Option<PathBuf> {
    let exe_dir = exe().ok().and_then(|e| e.parent().map(Path::to_owned));
    find_native(
        std::env::var_os("DELULU_PILL"),
        exe_dir.as_deref(),
        Path::new(HELPER_DIR),
    )
}

fn find_native(
    env: Option<OsString>,
    exe_dir: Option<&Path>,
    helper_dir: &Path,
) -> Option<PathBuf> {
    if let Some(value) = env.filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        return path.is_file().then_some(path);
    }
    [
        exe_dir.map(|d| d.join(NATIVE)),
        Some(helper_dir.join(NATIVE)),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_file())
}

/// A program that can draw the pill.
#[derive(Debug, Clone, PartialEq)]
enum Program {
    Native(PathBuf),
    /// A binary's GTK `--pill` mode; None = this process's own binary.
    Helper(Option<PathBuf>),
}

fn programs(native: Option<PathBuf>, fallback: Fallback) -> Programs {
    let mut queue = VecDeque::new();
    queue.extend(native.map(Program::Native));
    match fallback {
        Fallback::OwnBinary => queue.push_back(Program::Helper(None)),
        Fallback::Program(path) => queue.push_back(Program::Helper(Some(path))),
        Fallback::None => {}
    }
    Programs { queue, failures: 0 }
}

/// The programs left to try, best first, and the current one's crash count.
#[derive(Debug)]
struct Programs {
    queue: VecDeque<Program>,
    failures: u32,
}

impl Programs {
    fn current(&self) -> Option<&Program> {
        self.queue.front()
    }

    /// The current program cannot run here: try the next one.
    fn give_up(&mut self, why: &str) {
        if let Some(gone) = self.queue.pop_front() {
            match self.queue.front() {
                Some(next) => {
                    eprintln!("pill: {} {why}; using {} instead", gone.name(), next.name())
                }
                None => eprintln!("pill: {} {why}; recording pill disabled", gone.name()),
            }
        }
        self.failures = 0;
    }

    /// The current program exited after `ran` with `code`.
    fn exited(&mut self, code: Option<i32>, ran: Duration) {
        if code == Some(UNAVAILABLE) {
            self.give_up("cannot draw here (no layer-shell and no X display it can use)");
            return;
        }
        if ran > FAILURE_WINDOW {
            self.failures = 0;
        }
        self.failures += 1;
        if self.failures >= MAX_FAILURES {
            self.give_up("keeps exiting");
        } else if let Some(p) = self.current() {
            let code = code.map_or("a signal".into(), |c| format!("code {c}"));
            eprintln!("pill: {} exited ({code}), restarting", p.name());
        }
    }
}

impl Program {
    fn name(&self) -> String {
        match self {
            Program::Native(path) => path.display().to_string(),
            Program::Helper(Some(path)) => format!("{} --pill", path.display()),
            Program::Helper(None) => "the GTK pill helper".into(),
        }
    }

    fn spawn(&self) -> std::io::Result<Running> {
        let mut command = match self {
            Program::Native(path) => Command::new(path),
            Program::Helper(program) => {
                let mut c = Command::new(match program {
                    Some(path) => path.clone(),
                    None => exe()?,
                });
                // Override-redirect windows need X11; on Wayland this means XWayland.
                c.arg("--pill").env("GDK_BACKEND", "x11");
                c
            }
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        Ok(Running {
            child,
            stdin,
            started: Instant::now(),
        })
    }
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    started: Instant,
}

impl Running {
    /// Reap the process; its exit code (None after a signal) and run time.
    fn reap(self) -> (Option<i32>, Duration) {
        let Running {
            mut child,
            stdin,
            started,
        } = self;
        drop(stdin);
        let code = child.wait().ok().and_then(|s| s.code());
        (code, started.elapsed())
    }
}

fn writer(rx: mpsc::Receiver<Message>, mut programs: Programs) {
    let mut running: Option<Running> = None;
    while let Ok(mut m) = rx.recv() {
        // Each message is the whole state, so only the newest one matters.
        while let Ok(next) = rx.try_recv() {
            m = next;
        }
        if m.state == PillState::Hidden && running.is_none() {
            continue;
        }
        let Ok(mut line) = serde_json::to_vec(&m) else {
            continue;
        };
        line.push(b'\n');
        // A dead pill gets one replacement per message; a program that cannot
        // start at all hands over to the next one at once.
        let mut restarts = 0;
        while restarts < 2 {
            if running.is_none() {
                let Some(program) = programs.current() else {
                    break;
                };
                match program.spawn() {
                    Ok(r) => running = Some(r),
                    Err(e) => {
                        programs.give_up(&format!("could not start ({e})"));
                        continue;
                    }
                }
            }
            let r = running.as_mut().expect("running");
            if matches!(r.child.try_wait(), Ok(None)) && r.stdin.write_all(&line).is_ok() {
                break;
            }
            let (code, ran) = running.take().expect("running").reap();
            programs.exited(code, ran);
            restarts += 1;
        }
    }
}

/// The running binary; after a package upgrade Linux reports the old inode as
/// "… (deleted)", and the new binary at the same path speaks the same protocol.
fn exe() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(
        match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
            Some(path) => PathBuf::from(path),
            None => exe,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn captured() -> (Pill, mpsc::Receiver<Message>) {
        let pill = Pill::new();
        let (tx, rx) = mpsc::channel();
        pill.tx.set(tx).unwrap();
        (pill, rx)
    }

    #[test]
    fn levels_only_while_listening_and_rate_limited() {
        let (pill, rx) = captured();
        pill.level(0.1);
        assert!(rx.try_recv().is_err(), "not listening yet");
        pill.show(PillState::Listening, None);
        assert_eq!(rx.try_recv().unwrap().state, PillState::Listening);
        pill.level(0.1);
        assert_eq!(rx.try_recv().unwrap().level, Some(audible_level(0.1)));
        pill.level(0.2);
        assert!(rx.try_recv().is_err(), "too soon after the last level");
        pill.show(PillState::Transcribing, None);
        assert_eq!(rx.try_recv().unwrap().state, PillState::Transcribing);
        pill.gate.lock().unwrap().last_level = None;
        pill.level(0.3);
        assert!(rx.try_recv().is_err(), "late audio after stop");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("delulu-pill-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(path: &Path, body: &str) {
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn finds_the_native_pill_next_to_the_caller_or_packaged() {
        let dir = temp_dir("find");
        let (bin, lib) = (dir.join("bin"), dir.join("lib"));
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        assert_eq!(find_native(None, Some(&bin), &lib), None, "not installed");
        script(&lib.join(NATIVE), "true");
        assert_eq!(find_native(None, Some(&bin), &lib), Some(lib.join(NATIVE)));
        script(&bin.join(NATIVE), "true");
        assert_eq!(
            find_native(None, Some(&bin), &lib),
            Some(bin.join(NATIVE)),
            "a dev build wins"
        );
        let custom = dir.join("custom");
        script(&custom, "true");
        assert_eq!(
            find_native(Some(custom.clone().into()), Some(&bin), &lib),
            Some(custom)
        );
        assert_eq!(
            find_native(Some("gtk".into()), Some(&bin), &lib),
            None,
            "forced off"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unavailable_or_crashing_programs_hand_over_once() {
        let native = Program::Native("/x/delulu-pill".into());
        let helper = Program::Helper(None);
        let mut p = programs(Some("/x/delulu-pill".into()), Fallback::OwnBinary);
        assert_eq!(p.current(), Some(&native));
        p.exited(Some(UNAVAILABLE), Duration::from_millis(5));
        assert_eq!(
            p.current(),
            Some(&helper),
            "no layer-shell or X: the GTK helper"
        );
        p.exited(Some(UNAVAILABLE), Duration::from_millis(5));
        assert_eq!(p.current(), None, "neither can draw: off for the session");

        let mut p = programs(Some("/x/delulu-pill".into()), Fallback::None);
        for _ in 0..MAX_FAILURES - 1 {
            p.exited(Some(101), Duration::from_secs(1));
            assert_eq!(p.current(), Some(&native), "a crash restarts it");
        }
        p.exited(None, Duration::from_secs(1));
        assert_eq!(p.current(), None, "three quick crashes: given up");

        let mut p = programs(None, Fallback::Program("/usr/bin/delulu-talks".into()));
        for _ in 0..MAX_FAILURES * 2 {
            p.exited(Some(1), FAILURE_WINDOW * 2);
        }
        assert!(p.current().is_some(), "rare crashes never add up");
    }

    /// Messages read by the program at `path`, polled until the last is `want`.
    fn lines(path: &Path, want: PillState) -> Vec<Message> {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let got: Vec<Message> = std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            if got.last().is_some_and(|m| m.state == want) || Instant::now() > until {
                return got;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn falls_back_to_the_helper_when_the_native_pill_is_unavailable() {
        let dir = temp_dir("fallback");
        let (native, helper) = (dir.join("delulu-pill"), dir.join("delulu-talks"));
        let (starts, out) = (dir.join("native-starts"), dir.join("helper-lines"));
        script(&native, &format!("echo >> {}; exit 3", starts.display()));
        script(&helper, &format!("cat >> {}", out.display()));
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn({
            let native = native.clone();
            move || writer(rx, programs(Some(native), Fallback::Program(helper)))
        });
        let msg = |state, level| Message {
            state,
            level,
            label: None,
        };
        tx.send(msg(PillState::Listening, None)).unwrap();
        // Give the native pill time to exit, as a real one does at once.
        std::thread::sleep(Duration::from_millis(300));
        for i in 0..20 {
            tx.send(msg(PillState::Listening, Some(i as f32 / 20.0)))
                .unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        tx.send(msg(PillState::Transcribing, None)).unwrap();
        let got = lines(&out, PillState::Transcribing);
        assert_eq!(got.last().map(|m| m.state), Some(PillState::Transcribing));
        drop(tx);
        thread.join().unwrap();
        let native_starts = std::fs::read_to_string(&starts).unwrap().lines().count();
        assert_eq!(
            native_starts, 1,
            "an unavailable native pill is not retried"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
