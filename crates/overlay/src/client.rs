use crate::helper::UNAVAILABLE;
use crate::{audible_level, Message, PillState};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LEVEL_INTERVAL: Duration = Duration::from_millis(33);
/// Crashes in a row before the pill gives up for this session.
const MAX_FAILURES: u32 = 3;

/// Drives the `--pill` helper process. Every call returns at once: a writer
/// thread owns the helper, so the audio thread never blocks on a pipe.
pub struct Pill {
    tx: OnceLock<mpsc::Sender<Message>>,
    gate: Mutex<Gate>,
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
    /// Cheap: nothing starts until the first message.
    pub fn new() -> Self {
        Self {
            tx: OnceLock::new(),
            gate: Mutex::new(Gate::default()),
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
            if let Err(e) = std::thread::Builder::new()
                .name("pill".into())
                .spawn(move || writer(rx))
            {
                eprintln!("pill: writer thread: {e}");
            }
            tx
        });
        let _ = tx.send(m);
    }
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    started: Instant,
}

fn writer(rx: mpsc::Receiver<Message>) {
    let mut helper: Option<Helper> = None;
    let mut failures = 0;
    let mut disabled = false;
    while let Ok(mut m) = rx.recv() {
        // Each message is the whole state, so only the newest one matters.
        while let Ok(next) = rx.try_recv() {
            m = next;
        }
        if disabled || (m.state == PillState::Hidden && helper.is_none()) {
            continue;
        }
        let Ok(mut line) = serde_json::to_vec(&m) else {
            continue;
        };
        line.push(b'\n');
        // A dead helper gets one fresh replacement per message.
        for _attempt in 0..2 {
            if helper.is_none() {
                match spawn() {
                    Ok(h) => helper = Some(h),
                    Err(e) => {
                        eprintln!("pill: could not start the helper: {e}; recording pill disabled");
                        disabled = true;
                        break;
                    }
                }
            }
            let h = helper.as_mut().expect("helper");
            if matches!(h.child.try_wait(), Ok(None)) && h.stdin.write_all(&line).is_ok() {
                break;
            }
            if exited(helper.take().expect("helper"), &mut failures) {
                disabled = true;
                break;
            }
        }
    }
}

/// Reap a dead helper; true when the pill should stop trying.
fn exited(mut h: Helper, failures: &mut u32) -> bool {
    drop(h.stdin);
    let status = h.child.wait().ok();
    if status.and_then(|s| s.code()) == Some(UNAVAILABLE) {
        eprintln!("pill: no X display (XWayland); recording pill disabled");
        return true;
    }
    if h.started.elapsed() > Duration::from_secs(60) {
        *failures = 0;
    }
    *failures += 1;
    eprintln!(
        "pill: helper exited ({}), restarting",
        status.map_or("unknown".into(), |s| s.to_string())
    );
    if *failures >= MAX_FAILURES {
        eprintln!("pill: helper keeps exiting; recording pill disabled");
        return true;
    }
    false
}

fn spawn() -> std::io::Result<Helper> {
    let mut child = Command::new(exe()?)
        .arg("--pill")
        // Override-redirect windows need X11; on Wayland this means XWayland.
        .env("GDK_BACKEND", "x11")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    Ok(Helper {
        child,
        stdin,
        started: Instant::now(),
    })
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
        assert!((rx.try_recv().unwrap().level.unwrap() - 0.42).abs() < 1e-6);
        pill.level(0.2);
        assert!(rx.try_recv().is_err(), "too soon after the last level");
        pill.show(PillState::Transcribing, None);
        assert_eq!(rx.try_recv().unwrap().state, PillState::Transcribing);
        pill.gate.lock().unwrap().last_level = None;
        pill.level(0.3);
        assert!(rx.try_recv().is_err(), "late audio after stop");
    }
}
