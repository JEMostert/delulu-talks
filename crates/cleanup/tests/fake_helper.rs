//! `Cleaner` against small `sh` scripts that stand in for the real helper.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use delulu_cleanup::{Cleaner, CleanupError};

const READY: &str = r#"echo '{"type":"ready","backend":"Fake: test","loadMs":1}'"#;

const SCRIPTS: [(&str, &str); 7] = [
    // Answers every request with its own id.
    (
        "normal",
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed 's/^{"id":\([0-9]*\).*/\1/')
  # printf, not echo: dash's echo would turn the JSON \n escape into a line break.
  printf '%s\n' "{\"type\":\"result\",\"id\":$id,\"text\":\" everyday\\nOutput: So hello there.\",\"truncated\":false,\"ms\":1}"
done"#,
    ),
    // Never reads stdin again.
    ("deaf", "exec sleep 30"),
    // Reads the request, then only sends replies for other ids.
    (
        "wrong_ids",
        r#"read -r line
while true; do
  echo '{"type":"result","id":999,"text":"nope","truncated":false,"ms":1}'
  sleep 0.1
done"#,
    ),
    // Reads the request and never answers.
    ("silent", "read -r line\nexec sleep 30"),
    // Answers too much text, which sanitize rejects.
    (
        "rambling",
        r#"read -r line
echo '{"type":"result","id":1,"text":"Sure! Here is a long and helpful answer that goes on and on and on for a while.","truncated":false,"ms":1}'
exec sleep 30"#,
    ),
    // Model load fails.
    (
        "load_error",
        r#"echo '{"type":"error","message":"no such model"}'
exit 1"#,
    ),
    // Still loading forever.
    ("loading", "exec sleep 30"),
];

/// Write every script once, before any test spawns a process, so no exec races an
/// open write fd ("Text file busy").
fn script(name: &str) -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("delulu-cleanup-fake");
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in SCRIPTS {
            let ready = if name == "load_error" || name == "loading" {
                ""
            } else {
                READY
            };
            let path = dir.join(format!("{name}.sh"));
            std::fs::write(&path, format!("#!/bin/sh\n{ready}\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    });
    dir.join(format!("{name}.sh"))
}

fn start(name: &str) -> Cleaner {
    Cleaner::start(
        &script(name),
        Path::new("model.gguf"),
        Duration::from_secs(10),
        |_| {},
    )
    .unwrap()
}

#[test]
fn normal_helper_cleans_text() {
    let mut cleaner = start("normal");
    assert_eq!(cleaner.backend(), "Fake: test");
    for _ in 0..2 {
        let clean = cleaner.clean("en", "so hello there", &[]).unwrap();
        let clean = clean.expect("cleaned");
        assert_eq!(clean.text, "So hello there.");
        assert_eq!(clean.topic.as_deref(), Some("everyday"));
    }
    // Unsupported language: no request, paste raw.
    assert_eq!(cleaner.clean("de", "hallo", &[]).unwrap(), None);
}

#[test]
fn rejected_output_keeps_raw() {
    let mut cleaner = start("rambling");
    assert_eq!(cleaner.clean("en", "so hello there", &[]).unwrap(), None);
}

#[test]
fn load_error_is_reported_and_reaped() {
    let err = Cleaner::start(
        &script("load_error"),
        Path::new("model.gguf"),
        Duration::from_secs(10),
        |_| {},
    )
    .unwrap_err();
    assert!(
        matches!(&err, CleanupError::Load(m) if m == "no such model"),
        "{err:?}"
    );
}

#[test]
fn missing_helper_is_a_spawn_error() {
    let err = Cleaner::start(
        Path::new("/nonexistent/delulu-cleanup"),
        Path::new("model.gguf"),
        Duration::from_secs(1),
        |_| {},
    )
    .unwrap_err();
    assert!(matches!(err, CleanupError::Spawn(_)), "{err:?}");
}

#[test]
fn start_times_out_and_kills() {
    let (tx, rx) = mpsc::channel();
    let started = Instant::now();
    let err = Cleaner::start(
        &script("loading"),
        Path::new("model.gguf"),
        Duration::from_millis(300),
        |kill| tx.send(kill).unwrap(),
    )
    .unwrap_err();
    assert!(matches!(err, CleanupError::Timeout), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    // The killer was handed out while loading.
    assert!(rx.try_recv().is_ok());
}

#[test]
fn helper_that_stops_reading_times_out() {
    let mut cleaner = start("deaf");
    let started = Instant::now();
    let err = cleaner.clean("en", "hi", &[]).unwrap_err();
    assert!(matches!(err, CleanupError::Timeout), "{err:?}");
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(2000), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(3000), "{elapsed:?}");
    // The helper is dead now; later calls fail at once.
    let started = Instant::now();
    assert!(cleaner.clean("en", "hi", &[]).is_err());
    assert!(started.elapsed() < Duration::from_millis(200));
}

#[test]
fn wrong_ids_never_extend_the_deadline() {
    let mut cleaner = start("wrong_ids");
    let started = Instant::now();
    let err = cleaner.clean("en", "hi", &[]).unwrap_err();
    assert!(matches!(err, CleanupError::Timeout), "{err:?}");
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(2000), "{elapsed:?}");
    assert!(elapsed < Duration::from_millis(3000), "{elapsed:?}");
}

#[test]
fn silent_helper_times_out_and_is_killed() {
    let mut cleaner = start("silent");
    let started = Instant::now();
    let err = cleaner.clean("en", "hi", &[]).unwrap_err();
    assert!(matches!(err, CleanupError::Timeout), "{err:?}");
    assert!(started.elapsed() < Duration::from_millis(3000));
}

#[test]
fn kill_during_clean_returns_quickly() {
    let mut cleaner = start("silent");
    let kill = cleaner.killer();
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        kill.kill();
    });
    let started = Instant::now();
    let err = cleaner.clean("en", "hi", &[]).unwrap_err();
    killer.join().unwrap();
    assert!(matches!(err, CleanupError::Helper(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_millis(1000));
    // A killed Cleaner stays unusable.
    assert!(cleaner.clean("en", "hi", &[]).is_err());
}

#[test]
fn kill_during_start_returns_quickly() {
    let (tx, rx) = mpsc::channel();
    let killer = std::thread::spawn(move || {
        let kill: delulu_cleanup::CleanerKill = rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        kill.kill();
    });
    let started = Instant::now();
    let err = Cleaner::start(
        &script("loading"),
        Path::new("model.gguf"),
        Duration::from_secs(10),
        move |kill| tx.send(kill).unwrap(),
    )
    .unwrap_err();
    killer.join().unwrap();
    assert!(matches!(err, CleanupError::Helper(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_millis(1000));
}

#[test]
fn drop_kills_and_reaps_the_helper() {
    let cleaner = start("deaf");
    let pid = cleaner.pid();
    assert!(Path::new(&format!("/proc/{pid}")).exists());
    let kill = cleaner.killer();
    drop(cleaner);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    // Killing after the child is reaped is a no-op.
    kill.kill();
}
