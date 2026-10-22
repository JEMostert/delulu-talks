//! The system clipboard, owned by one long-lived thread.
//!
//! A background process that owns a selection has to keep serving it, so
//! the `arboard::Clipboard` lives on a dedicated thread for the lifetime of
//! the app instead of being created per write:
//!
//! - KDE Plasma and wlroots compositors offer data-control
//!   (`ext-data-control-v1` / `zwlr-data-control`), which arboard uses
//!   without needing keyboard focus.
//! - GNOME/Mutter has no data-control. arboard falls back to X11 through
//!   Xwayland; Mutter bridges the X11 CLIPBOARD selection into the Wayland
//!   clipboard regardless of focus and acts as the X11 clipboard manager,
//!   so the text survives even if the owner exits.
//! - `wl-copy`/`wl-paste` are a last resort when neither works (no
//!   data-control and no Xwayland); without data-control they need focus,
//!   so every call is bounded by a timeout.

use delulu_core::HostEnv;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Contents relevant to restoring and to change detection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClipboardSnapshot {
    /// Plain text, if the clipboard offers it.
    pub text: Option<String>,
    /// HTML, file lists or other non-text formats were offered (a rich
    /// clipboard must not be replaced by a plain-text backup).
    pub rich: bool,
    /// Bytes of the rich representations seen, for change detection.
    pub rich_fingerprint: Vec<u8>,
}

pub trait ClipboardBackend: Send + Sync {
    fn write_text(&self, text: &str) -> Result<(), String>;
    fn read(&self) -> Result<ClipboardSnapshot, String>;
}

type Job = Box<dyn FnOnce(&mut Option<arboard::Clipboard>) + Send>;

const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// The production clipboard. Cheap to clone; all clones share one thread.
#[derive(Clone)]
pub struct SystemClipboard {
    inner: Backend,
}

#[derive(Clone)]
enum Backend {
    Arboard(mpsc::Sender<Job>),
    WlClipboard,
}

impl SystemClipboard {
    /// Starts the clipboard thread. On Linux, falls back to `wl-copy` when
    /// arboard cannot open any clipboard and `wl-copy` is installed.
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        let spawned = thread::Builder::new().name("delulu-clipboard".into()).spawn(move || {
            let mut clipboard = arboard::Clipboard::new().ok();
            let _ = ready_tx.send(clipboard.is_some());
            for job in receiver {
                job(&mut clipboard);
            }
        });
        let opened = spawned.is_ok() && ready_rx.recv_timeout(CALL_TIMEOUT).unwrap_or(false);
        if !opened && cfg!(target_os = "linux") && which::which("wl-copy").is_ok() {
            return Self { inner: Backend::WlClipboard };
        }
        Self { inner: Backend::Arboard(sender) }
    }

    /// `"arboard"` or `"wl-clipboard"`, for diagnostics.
    pub fn backend_name(&self) -> &'static str {
        match self.inner {
            Backend::Arboard(_) => "arboard",
            Backend::WlClipboard => "wl-clipboard",
        }
    }

    fn call<T: Send + 'static>(
        &self,
        sender: &mpsc::Sender<Job>,
        work: impl FnOnce(&mut arboard::Clipboard) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let job: Job = Box::new(move |slot| {
            if slot.is_none() {
                *slot = arboard::Clipboard::new().ok();
            }
            let result = match slot.as_mut() {
                Some(clipboard) => work(clipboard),
                None => Err("The system clipboard is unavailable".to_owned()),
            };
            let _ = reply_tx.send(result);
        });
        sender.send(job).map_err(|_| "The clipboard service stopped".to_owned())?;
        reply_rx.recv_timeout(CALL_TIMEOUT).map_err(|_| "The system clipboard did not respond".to_owned())?
    }
}

impl Default for SystemClipboard {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipboardBackend for SystemClipboard {
    fn write_text(&self, text: &str) -> Result<(), String> {
        match &self.inner {
            Backend::Arboard(sender) => {
                let text = text.to_owned();
                self.call(sender, move |clipboard| clipboard.set_text(text).map_err(|e| e.to_string()))
            }
            Backend::WlClipboard => wl::copy(text),
        }
    }

    fn read(&self) -> Result<ClipboardSnapshot, String> {
        match &self.inner {
            Backend::Arboard(sender) => self.call(sender, |clipboard| {
                let text = optional(clipboard.get_text())?;
                let html = optional(clipboard.get().html())?;
                let files = optional(clipboard.get().file_list())?.unwrap_or_default();
                let mut fingerprint = Vec::new();
                if let Some(html) = &html {
                    fingerprint.extend_from_slice(html.as_bytes());
                }
                for file in &files {
                    fingerprint.push(0);
                    fingerprint.extend_from_slice(file.to_string_lossy().as_bytes());
                }
                Ok(ClipboardSnapshot { text, rich: html.is_some() || !files.is_empty(), rich_fingerprint: fingerprint })
            }),
            Backend::WlClipboard => wl::read(),
        }
    }
}

fn optional<T>(result: Result<T, arboard::Error>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(arboard::Error::ContentNotAvailable | arboard::Error::ConversionFailure) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// `wl-copy`/`wl-paste` with hard timeouts.
mod wl {
    use super::*;

    const TEXT_TYPES: [&str; 5] = ["text/plain", "text/plain;charset=utf-8", "UTF8_STRING", "STRING", "TEXT"];

    pub fn copy(text: &str) -> Result<(), String> {
        let mut child = Command::new("wl-copy")
            .host_env()
            .args(["--type", "text/plain;charset=utf-8"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("wl-copy: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).map_err(|e| format!("wl-copy: {e}"))?;
        }
        match wait(&mut child, Duration::from_secs(2))? {
            Some(0) => Ok(()),
            Some(code) => Err(format!("wl-copy exited with code {code}")),
            None => Err("wl-copy did not respond".to_owned()),
        }
    }

    pub fn read() -> Result<ClipboardSnapshot, String> {
        let types = output(&["--list-types"])?.unwrap_or_default();
        let types: Vec<&str> = types.lines().map(str::trim).filter(|t| !t.is_empty()).collect();
        let rich = types.iter().any(|t| !TEXT_TYPES.contains(t));
        let text = if types.iter().any(|t| TEXT_TYPES.contains(t)) {
            output(&["--no-newline", "--type", "text/plain"])?
        } else {
            None
        };
        Ok(ClipboardSnapshot { text, rich, rich_fingerprint: types.join("\n").into_bytes() })
    }

    fn output(args: &[&str]) -> Result<Option<String>, String> {
        let mut child = Command::new("wl-paste")
            .host_env()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("wl-paste: {e}"))?;
        let mut stdout = child.stdout.take();
        let reader = thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(pipe) = stdout.as_mut() {
                use std::io::Read;
                let _ = pipe.take(4 * 1024 * 1024).read_to_end(&mut buffer);
            }
            buffer
        });
        match wait(&mut child, Duration::from_secs(1))? {
            Some(0) => Ok(Some(String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned())),
            // wl-paste exits non-zero for an empty clipboard / missing type.
            Some(_) => Ok(None),
            None => Err("wl-paste did not respond".to_owned()),
        }
    }

    fn wait(child: &mut std::process::Child, timeout: Duration) -> Result<Option<i32>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return Ok(Some(status.code().unwrap_or(-1)));
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use parking_lot::Mutex;

    /// In-memory clipboard with failure injection.
    #[derive(Default)]
    pub struct FakeClipboard {
        pub current: Mutex<ClipboardSnapshot>,
        pub writes: Mutex<Vec<String>>,
        pub fail_writes: Mutex<bool>,
    }

    impl FakeClipboard {
        pub fn with_text(text: &str) -> Self {
            let clipboard = Self::default();
            clipboard.current.lock().text = Some(text.to_owned());
            clipboard
        }
        pub fn text(&self) -> Option<String> {
            self.current.lock().text.clone()
        }
        /// A write by another application.
        pub fn external_write(&self, text: &str) {
            *self.current.lock() = ClipboardSnapshot { text: Some(text.to_owned()), ..Default::default() };
        }
    }

    impl ClipboardBackend for FakeClipboard {
        fn write_text(&self, text: &str) -> Result<(), String> {
            if *self.fail_writes.lock() {
                return Err("Clipboard rejected".to_owned());
            }
            self.writes.lock().push(text.to_owned());
            self.external_write(text);
            Ok(())
        }
        fn read(&self) -> Result<ClipboardSnapshot, String> {
            Ok(self.current.lock().clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual check against the real clipboard (restores the previous text):
    /// `cargo test -p delulu-desktop -- --ignored system_clipboard --nocapture`.
    /// `DELULU_CLIPBOARD_HOLD_MS` keeps the owner alive for cross-process reads.
    #[test]
    #[ignore = "writes the user's clipboard"]
    fn system_clipboard_round_trip() {
        let clipboard = SystemClipboard::new();
        let before = clipboard.read().unwrap();
        println!("backend: {}, previous text present: {}, rich: {}", clipboard.backend_name(), before.text.is_some(), before.rich);
        let marker = "delulu-desktop clipboard check héllo 👋";
        clipboard.write_text(marker).unwrap();
        assert_eq!(clipboard.read().unwrap().text.as_deref(), Some(marker));
        let hold = std::env::var("DELULU_CLIPBOARD_HOLD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        thread::sleep(Duration::from_millis(hold));
        match before.text {
            Some(text) if !before.rich => clipboard.write_text(&text).unwrap(),
            _ => {}
        }
    }
}
