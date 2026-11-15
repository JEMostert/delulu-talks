//! The real `delulud` binary: single instance, crash recovery, SIGTERM, CLI.

use delulu_daemon::client::Client;
use delulu_proto::api::{Event, GetStateParams, SubscribeParams, Topic};
use delulu_proto::state::{DaemonMode, DictationOutcome, DictationPhase};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_delulud");

struct Daemon {
    child: Option<Child>,
}

impl Daemon {
    fn start(socket: &Path, args: &[&str]) -> Self {
        let child = Command::new(BIN)
            .arg("daemon")
            .args(args)
            .arg("--socket")
            .arg(socket)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Client::connect(socket, "test").is_err() {
            assert!(Instant::now() < deadline, "daemon did not come up");
            std::thread::sleep(Duration::from_millis(20));
        }
        Self { child: Some(child) }
    }
    fn signal(&self, signal: i32) {
        // SAFETY: plain kill(2) on our own child.
        assert_eq!(
            unsafe { libc::kill(self.child.as_ref().unwrap().id() as i32, signal) },
            0
        );
    }
    fn wait(mut self) -> Output {
        let mut child = self.child.take().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "daemon did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
        child.wait_with_output().unwrap()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// A short socket path: Unix socket paths must stay under 108 bytes.
fn socket_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("delulud-")
        .tempdir_in("/tmp")
        .unwrap();
    let socket = dir.path().join("run/daemon.sock");
    (dir, socket)
}

fn cli(socket: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .arg("--socket")
        .arg(socket)
        .output()
        .unwrap()
}

#[test]
fn a_second_client_sees_the_events_of_a_cli_toggle() {
    let (_dir, socket) = socket_dir();
    let _daemon = Daemon::start(&socket, &["--demo", "--still"]);
    let mut watcher = Client::connect(&socket, "test").unwrap();
    watcher
        .call(SubscribeParams {
            topics: vec![Topic::Dictation],
        })
        .unwrap();

    let out = cli(&socket, &["toggle"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        r#"{"phase":"recording","job":1}"#
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(cli(&socket, &["toggle"]).status.success());

    let mut phases = Vec::new();
    let last = loop {
        let Event::Dictation { state } = watcher.next_event().unwrap().event else {
            panic!("only dictation events were asked for");
        };
        phases.push(state.phase);
        if state.phase == DictationPhase::Idle {
            break state.last;
        }
    };
    use DictationPhase::*;
    assert_eq!(phases, [Recording, Transcribing, Cleaning, Inserting, Idle]);
    assert!(matches!(last, Some(DictationOutcome::Done { job: 1, .. })));

    let state = cli(&socket, &["state"]);
    assert!(state.status.success());
    let state: serde_json::Value = serde_json::from_slice(&state.stdout).unwrap();
    assert_eq!(state["dictation"]["last"]["kind"], "done");
}

#[test]
fn two_daemons_cannot_share_a_socket() {
    let (_dir, socket) = socket_dir();
    let _first = Daemon::start(&socket, &[]);
    let second = Command::new(BIN)
        .args(["daemon", "--socket"])
        .arg(&socket)
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&second.stderr).contains("already running"));
    // The first one is untouched.
    let mut client = Client::connect(&socket, "test").unwrap();
    assert_eq!(
        client.call(GetStateParams {}).unwrap().daemon.mode,
        DaemonMode::Normal
    );
}

#[test]
fn a_crashed_daemons_socket_is_recovered() {
    let (_dir, socket) = socket_dir();
    let crashed = Daemon::start(&socket, &[]);
    crashed.signal(libc::SIGKILL);
    crashed.wait();
    assert!(socket.exists(), "a killed daemon leaves its socket behind");
    assert!(Client::connect(&socket, "test").is_err());

    let _daemon = Daemon::start(&socket, &["--demo"]);
    let mut client = Client::connect(&socket, "test").unwrap();
    assert_eq!(
        client.call(GetStateParams {}).unwrap().daemon.mode,
        DaemonMode::Demo
    );
}

#[test]
fn sigterm_says_goodbye_and_removes_the_socket() {
    let (_dir, socket) = socket_dir();
    let daemon = Daemon::start(&socket, &[]);
    let mut watcher = Client::connect(&socket, "test").unwrap();
    watcher
        .call(SubscribeParams {
            topics: vec![Topic::Dictation],
        })
        .unwrap();
    daemon.signal(libc::SIGTERM);
    assert_eq!(watcher.next_event().unwrap().event, Event::ShuttingDown);
    let out = daemon.wait();
    assert!(out.status.success(), "{out:?}");
    assert!(!socket.exists());
}

#[test]
fn cli_reports_a_missing_daemon_and_unavailable_dictation() {
    let (_dir, socket) = socket_dir();
    let out = cli(&socket, &["state"]);
    assert_eq!(out.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not running"));

    let _daemon = Daemon::start(&socket, &[]);
    let out = cli(&socket, &["toggle"]);
    assert_eq!(out.status.code(), Some(4));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not_available"));
}
