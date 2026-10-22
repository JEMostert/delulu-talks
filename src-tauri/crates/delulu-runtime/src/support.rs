//! Crate-internal helpers: timestamps, lexical paths, command-line splitting,
//! process-group termination and bounded command capture.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use tokio::io::AsyncReadExt;

/// `new Date(ms).toISOString()`.
pub fn iso_timestamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// Node's `path.resolve`: absolute against the working directory, `.`/`..`
/// collapsed lexically, symlinks untouched.
pub fn resolve_lexical(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Splits a configured interpreter command like the TypeScript regex
/// `(?:[^\s"']+|"[^"]*"|'[^']*')+`, then strips matching outer quotes.
pub fn split_command(command: &str) -> Vec<String> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let token = TOKEN.get_or_init(|| Regex::new(r#"(?:[^\s"']+|"[^"]*"|'[^']*')+"#).unwrap());
    token
        .find_iter(command)
        .map(|m| {
            let part = m.as_str();
            let bytes = part.as_bytes();
            if part.len() >= 2 && (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[part.len() - 1] == bytes[0] {
                part[1..part.len() - 1].to_owned()
            } else {
                part.to_owned()
            }
        })
        .collect()
}

/// Detaches a child into its own process group (Unix) or hides its console
/// window (Windows).
pub fn isolate(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Hides the console window of a short probe on Windows.
pub fn hide_window(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command;
}

/// Outcome of signalling a process group.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
pub enum SignalOutcome {
    Sent,
    /// The group no longer exists (`ESRCH`).
    Gone,
    /// Any other failure; callers fall back to signalling the child alone.
    Failed,
}

#[cfg(unix)]
pub fn signal_group(pid: u32, kill: bool) -> SignalOutcome {
    use nix::errno::Errno;
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let signal = if kill { Signal::SIGKILL } else { Signal::SIGTERM };
    match killpg(Pid::from_raw(pid as i32), signal) {
        Ok(()) => SignalOutcome::Sent,
        Err(Errno::ESRCH) => SignalOutcome::Gone,
        Err(_) => SignalOutcome::Failed,
    }
}

/// Signals only the child itself.
#[cfg(unix)]
pub fn signal_process(pid: u32, kill: bool) {
    use nix::sys::signal::{kill as send, Signal};
    use nix::unistd::Pid;
    let _ = send(Pid::from_raw(pid as i32), if kill { Signal::SIGKILL } else { Signal::SIGTERM });
}

/// Whether any member of the process group is still alive.
#[cfg(unix)]
pub fn group_alive(pid: u32) -> bool {
    use nix::sys::signal::killpg;
    use nix::unistd::Pid;
    killpg(Pid::from_raw(pid as i32), None).is_ok()
}

/// `taskkill /pid N /T /F`; returns false when taskkill could not start.
#[cfg(windows)]
pub fn taskkill(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
}

/// Sends SIGKILL to the group after `delay`, from a detached thread so the
/// escalation survives the caller (and the parent's exit), like an unref'd
/// Node timer.
#[cfg(unix)]
pub fn escalate_after(pid: u32, delay: Duration, fallback: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if signal_group(pid, true) == SignalOutcome::Failed {
            fallback();
        }
    });
}

#[derive(Debug)]
pub enum CaptureError {
    NotFound,
    Failed,
}

/// `execFile` with a timeout and stdout cap: stdout on exit code 0, else an
/// error. The child is killed when the timeout or the cap is exceeded.
pub async fn capture(program: &str, args: &[String], timeout: Duration, max_buffer: usize) -> Result<String, CaptureError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => CaptureError::NotFound,
        _ => CaptureError::Failed,
    })?;
    let mut stdout = child.stdout.take().ok_or(CaptureError::Failed)?;
    let mut stderr = child.stderr.take().ok_or(CaptureError::Failed)?;
    let work = async {
        let read_stdout = async {
            let mut out = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let read = stdout.read(&mut chunk).await.map_err(|_| CaptureError::Failed)?;
                if read == 0 {
                    return Ok(out);
                }
                out.extend_from_slice(&chunk[..read]);
                if out.len() > max_buffer {
                    return Err(CaptureError::Failed);
                }
            }
        };
        // Drain stderr concurrently so a chatty child cannot block on a full pipe.
        let drain_stderr = async {
            let mut chunk = [0u8; 8192];
            while matches!(stderr.read(&mut chunk).await, Ok(read) if read > 0) {}
        };
        let (out, ()) = tokio::join!(read_stdout, drain_stderr);
        let out = out?;
        let status = child.wait().await.map_err(|_| CaptureError::Failed)?;
        if status.success() {
            Ok(String::from_utf8_lossy(&out).into_owned())
        } else {
            Err(CaptureError::Failed)
        }
    };
    tokio::time::timeout(timeout, work).await.unwrap_or(Err(CaptureError::Failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps_match_javascript() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(1_792_675_398_123), "2026-10-22T13:23:18.123Z");
    }

    #[test]
    fn commands_split_like_typescript() {
        assert_eq!(split_command(r#""C:\Program Files\py.exe" -3.12"#), vec![r"C:\Program Files\py.exe", "-3.12"]);
        assert_eq!(split_command("  python3 "), vec!["python3"]);
        assert!(split_command("").is_empty());
    }
}
