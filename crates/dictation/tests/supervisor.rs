//! The cleanup supervisor against `sh` scripts that stand in for `delulu-engine`:
//! a helper that is killed or crashes comes back by itself.

use delulu_dictation::cleanup::{CleanupStatus, Supervisor, Want};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Writes its pid next to itself, reports ready, then answers every request.
/// With `die_once`, the first process to get a request exits instead.
fn helper(dir: &Path, die_once: bool) -> PathBuf {
    let die = if die_once {
        r#"if [ ! -e "$here/died" ]; then : > "$here/died"; exit 9; fi"#
    } else {
        ""
    };
    let script = format!(
        r#"#!/bin/sh
here=$(dirname "$0")
[ "$1" = llm ] || exit 2
echo $$ > "$here/pid"
echo '{{"type":"ready","backend":"Fake: test","loadMs":1}}'
while IFS= read -r line; do
  {die}
  id=$(printf '%s' "$line" | sed 's/^{{"id":\([0-9]*\).*/\1/')
  printf '%s\n' "{{\"type\":\"result\",\"id\":$id,\"text\":\" everyday\\nOutput: The plan is ready.\",\"truncated\":false,\"ms\":1}}"
done
"#
    );
    let path = dir.join("helper.sh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

const WANT: Want = Want {
    enabled: true,
    first_run_done: true,
    model_ok: true,
    file_ready: true,
};

fn start(dir: &Path, die_once: bool) -> (Arc<Supervisor>, mpsc::Receiver<CleanupStatus>) {
    let (tx, rx) = mpsc::channel();
    let supervisor = Supervisor::new(
        true,
        true,
        dir.to_owned(),
        Box::new(move |status| {
            let _ = tx.send(status);
        }),
    );
    supervisor.set_helper(helper(dir, die_once));
    supervisor.watch();
    supervisor.whisper_settled(WANT);
    (supervisor, rx)
}

/// Waits for the next "ready" status and returns the helper's pid then.
fn ready(rx: &mpsc::Receiver<CleanupStatus>, dir: &Path, within: Duration) -> u32 {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let status = rx
            .recv_timeout(left)
            .expect("the helper became ready in time");
        if status.state == "ready" {
            return std::fs::read_to_string(dir.join("pid"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        }
        assert_ne!(status.state, "error", "{status:?}");
    }
}

fn kill(pid: u32) {
    // SAFETY: plain syscall on a helper this test started.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
}

#[test]
fn a_killed_idle_helper_comes_back_until_it_keeps_dying() {
    let dir = tempfile::tempdir().unwrap();
    let (supervisor, rx) = start(dir.path(), false);
    let mut pid = ready(&rx, dir.path(), Duration::from_secs(10));
    // Two kills in a row, each right after the helper became ready.
    for _ in 0..2 {
        let killed = Instant::now();
        kill(pid);
        let next = ready(&rx, dir.path(), Duration::from_secs(3));
        assert_ne!(pid, next);
        assert!(killed.elapsed() < Duration::from_secs(3));
        pid = next;
    }
    assert_eq!(supervisor.status().state, "ready");
    // A third quick death in a row: it keeps crashing, so stop restarting it.
    kill(pid);
    let deadline = Instant::now() + Duration::from_secs(3);
    while supervisor.status().state != "error" {
        assert!(Instant::now() < deadline, "{:?}", supervisor.status());
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test]
async fn a_helper_that_dies_mid_clean_leaves_the_raw_text_and_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let (supervisor, rx) = start(dir.path(), true);
    let first = ready(&rx, dir.path(), Duration::from_secs(10));
    let raw = "eh the plan is ready".to_string();
    let cleaned = supervisor.clean(true, "en", raw.clone(), Vec::new).await;
    assert_eq!((cleaned.text, cleaned.raw), (raw, None));
    let second = ready(&rx, dir.path(), Duration::from_secs(3));
    assert_ne!(first, second);
    let cleaned = supervisor
        .clean(true, "en", "eh the plan is ready".into(), Vec::new)
        .await;
    assert_eq!(cleaned.text, "The plan is ready.");
}
