//! The presenter speaks through Delulu's own `delulu speak` (Chatterbox Turbo), always
//! with the bundled speaker. Each call loads the model, writes a WAV and exits, so no
//! speech model stays in graphics memory between breaks.
use crate::RadioError;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Speech can wait up to ten minutes for another reply's lock; generation is quick.
const TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub struct Voice {
    pub bin: PathBuf,
}

/// The `delulu` CLI next to the app binary (packages install both), else the
/// per-user one, else PATH.
pub fn cli_path() -> PathBuf {
    if let Some(path) = std::env::var_os("DELULU_VOICE_CLI") {
        return PathBuf::from(path);
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("delulu")))
        .filter(|p| p.is_file());
    let local = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".local/bin/delulu"))
        .filter(|p| p.is_file());
    sibling.or(local).unwrap_or_else(|| PathBuf::from("delulu"))
}

impl Voice {
    pub fn new() -> Voice {
        Voice { bin: cli_path() }
    }

    /// A `delulu` older than Delulu FM reads unknown flags as words to say, so the
    /// presenter only uses one that lists `--bundled-voice`.
    pub fn supported(&self) -> bool {
        Command::new(&self.bin)
            .args(["speak", "--help"])
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|o| {
                o.status.success() && String::from_utf8_lossy(&o.stdout).contains("--bundled-voice")
            })
    }

    /// Supported, configured and the Turbo model installed. Starts no Python.
    pub fn ready(&self) -> bool {
        self.supported() && self.installed()
    }

    fn installed(&self) -> bool {
        Command::new(&self.bin)
            .arg("status")
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .and_then(|v| v.get("ready").and_then(|r| r.as_bool()))
            .unwrap_or(false)
    }

    /// Write `text` as speech to `out` (WAV), silently.
    pub fn speak(
        &self,
        text: &str,
        out: &Path,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(), RadioError> {
        if !self.supported() {
            return Err(RadioError::Unavailable(
                "Voice replies need the delulu command from this version of Delulu Talks".into(),
            ));
        }
        let mut child = Command::new(&self.bin)
            .args(["speak", "--output"])
            .arg(out)
            .args(["--bundled-voice", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| RadioError::Unavailable(format!("delulu speak: {e}")))?;
        {
            use std::io::Write;
            let mut stdin = child.stdin.take().expect("piped");
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| RadioError::Voice(e.to_string()))?;
        }
        let mut stderr = child.stderr.take().expect("piped");
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| RadioError::Voice(e.to_string()))?
            {
                break status;
            }
            if cancel() || started.elapsed() > TIMEOUT {
                // SIGTERM lets the CLI stop its Python child and clean up.
                unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
                let _ = child.wait();
                return Err(RadioError::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let detail = reader.join().unwrap_or_default();
        if !status.success() || !out.is_file() {
            let last = detail
                .lines()
                .last()
                .unwrap_or("speech failed")
                .trim()
                .to_string();
            return Err(RadioError::Voice(last));
        }
        Ok(())
    }
}

impl Default for Voice {
    fn default() -> Self {
        Voice::new()
    }
}
