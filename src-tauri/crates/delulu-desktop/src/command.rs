//! Short-lived helper commands (qdbus, xdotool, osascript, PowerShell) with a
//! kill timeout. Injected so tests can replace every subprocess.

use delulu_core::HostEnv;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;

/// Signal sent when a command overruns its timeout. Windows always terminates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub timeout: Duration,
    pub kill: KillSignal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutcome {
    /// `code` is `None` when a signal ended the process.
    Exited { code: Option<i32>, stderr: String },
    TimedOut,
    /// The process could not be started.
    SpawnFailed(String),
}

#[async_trait]
pub trait CommandRunner: Send + Sync {
    /// Whether `program` is on `PATH` (`which`/`where`).
    fn exists(&self, program: &str) -> bool;
    async fn run(&self, spec: CommandSpec) -> CommandOutcome;
}

/// Runs real processes with stdin and stdout closed and stderr captured.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemCommandRunner;

const MAX_STDERR: usize = 64 * 1024;

#[async_trait]
impl CommandRunner for SystemCommandRunner {
    fn exists(&self, program: &str) -> bool {
        which::which(program).is_ok()
    }

    async fn run(&self, spec: CommandSpec) -> CommandOutcome {
        let mut command = tokio::process::Command::new(&spec.program);
        command.host_env().args(&spec.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, like windowsHide
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return CommandOutcome::SpawnFailed(spawn_message(&spec.program, &error)),
        };
        let mut stderr_pipe = child.stderr.take();
        let collect = async move {
            let mut buffer = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.take(MAX_STDERR as u64).read_to_end(&mut buffer).await;
            }
            buffer
        };
        let waited = tokio::time::timeout(spec.timeout, async {
            let (status, stderr) = tokio::join!(child.wait(), collect);
            (status, stderr)
        })
        .await;
        match waited {
            Ok((Ok(status), stderr)) => CommandOutcome::Exited {
                code: status.code(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            },
            Ok((Err(error), _)) => CommandOutcome::SpawnFailed(error.to_string()),
            Err(_) => {
                terminate(&mut child, spec.kill);
                CommandOutcome::TimedOut
            }
        }
    }
}

fn spawn_message(program: &str, error: &std::io::Error) -> String {
    match delulu_core::error::io_error_code(error) {
        Some(code) => format!("spawn {program} {code}"),
        None => format!("spawn {program}: {error}"),
    }
}

fn terminate(child: &mut tokio::process::Child, signal: KillSignal) {
    #[cfg(unix)]
    if signal == KillSignal::Term {
        if let Some(pid) = child.id() {
            // SAFETY: plain signal delivery to our own, not yet reaped child.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            return;
        }
    }
    let _ = signal;
    let _ = child.start_kill();
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use parking_lot::Mutex;
    use std::collections::VecDeque;
    use std::sync::Arc;

    /// Records commands and answers them from a script (default: exit 0).
    #[derive(Default)]
    pub struct FakeRunner {
        pub installed: Mutex<Vec<String>>,
        pub commands: Mutex<Vec<CommandSpec>>,
        pub outcomes: Mutex<VecDeque<CommandOutcome>>,
        /// When set, `run` waits for a notification before answering.
        pub gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    }

    impl FakeRunner {
        pub fn with(installed: &[&str]) -> Arc<Self> {
            let runner = Self::default();
            *runner.installed.lock() = installed.iter().map(|s| s.to_string()).collect();
            Arc::new(runner)
        }
        pub fn push(&self, outcome: CommandOutcome) {
            self.outcomes.lock().push_back(outcome);
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        fn exists(&self, program: &str) -> bool {
            self.installed.lock().iter().any(|p| p == program)
        }
        async fn run(&self, spec: CommandSpec) -> CommandOutcome {
            self.commands.lock().push(spec);
            let gate = self.gate.lock().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.outcomes
                .lock()
                .pop_front()
                .unwrap_or(CommandOutcome::Exited { code: Some(0), stderr: String::new() })
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_runner_reports_exit_stderr_timeout_and_missing_programs() {
        let runner = SystemCommandRunner;
        let spec = |program: &str, args: &[&str], ms| CommandSpec {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            timeout: Duration::from_millis(ms),
            kill: KillSignal::Term,
        };
        assert_eq!(
            runner.run(spec("sh", &["-c", "echo denied >&2; exit 3"], 5000)).await,
            CommandOutcome::Exited { code: Some(3), stderr: "denied\n".into() }
        );
        assert_eq!(runner.run(spec("sleep", &["5"], 50)).await, CommandOutcome::TimedOut);
        assert_eq!(
            runner.run(spec("delulu-no-such-program", &[], 1000)).await,
            CommandOutcome::SpawnFailed("spawn delulu-no-such-program ENOENT".into())
        );
        assert!(runner.exists("sh"));
    }
}
