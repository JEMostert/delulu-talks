//! The `delulu` binary against a fake voice engine (a shell script speaking the
//! worker protocol), in private XDG folders.
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const FAKE_ENGINE: &str = r#"#!/bin/bash
echo $$ > "$FAKE_DIR/engine.pid"
read -r hello
echo '{"type":"ready","engine":"fake","protocol":1,"device":"CPU","vramBytes":null,"caps":[]}'
read -r load
echo '{"type":"loaded","modelId":"supertonic-3","loadMs":0,"vramBytes":null}'
read -r job
echo "$job" > "$FAKE_DIR/job.json"
if [ -e "$FAKE_DIR/hang" ]; then exec sleep 600; fi
echo '{"type":"audio","id":1,"seq":0,"rate":44100,"bytes":8,"last":false}'
printf '\x00\x00\x80\x3e\x00\x00\x80\xbe'
echo '{"type":"audio","id":1,"seq":1,"rate":44100,"bytes":0,"last":true}'
echo '{"type":"done","id":1,"ms":1,"result":{"kind":"spoken","audioMs":0}}'
read -r shutdown
echo '{"type":"bye"}'
"#;

struct Env {
    dir: tempfile::TempDir,
}

impl Env {
    /// Private XDG folders, a fake engine, no resident engine.
    fn new() -> Env {
        let env = Env {
            dir: tempfile::tempdir().unwrap(),
        };
        let engine = env.path("delulu-engine");
        fs::write(&engine, FAKE_ENGINE).unwrap();
        fs::set_permissions(&engine, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(env.voice()).unwrap();
        fs::write(
            env.voice().join("settings.json"),
            r#"{"keepWarmSeconds":0}"#,
        )
        .unwrap();
        env
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn voice(&self) -> PathBuf {
        self.path("data/delulu-talks/voice")
    }

    /// Files of the right size count as installed (the downloader only renames a
    /// file into place after its hash checked out). Sparse, so nothing is written.
    fn install_model(&self) {
        let models = self.path("data/delulu-talks/models");
        for f in delulu_models::SUPERTONIC_3.files {
            let path = models.join(f.file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            File::create(&path).unwrap().set_len(f.bytes).unwrap();
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_delulu"));
        c.args(args)
            .env("XDG_DATA_HOME", self.path("data"))
            .env("XDG_CONFIG_HOME", self.path("config"))
            .env("XDG_RUNTIME_DIR", self.path("run"))
            .env("HOME", self.path("home"))
            .env("DELULU_ENGINE", self.path("delulu-engine"))
            .env("FAKE_DIR", self.dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    /// Holds the per-user speech lock, as a running reply does.
    fn hold_lock(&self) -> File {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.voice().join("job.lock"))
            .unwrap();
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        file
    }
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn wait(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let started = Instant::now();
    while started.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

fn alive(pid_file: &Path) -> bool {
    let pid = fs::read_to_string(pid_file).unwrap();
    Path::new(&format!("/proc/{}", pid.trim())).exists()
}

#[test]
fn a_missing_model_gives_installation_guidance_and_exit_code_1() {
    let env = Env::new();
    let out = env.run(&["speak", "Hello."]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("delulu install-model"),
        "{}",
        stderr(&out)
    );
    assert!(stderr(&out).contains("Settings → Voice replies"));
    let status: serde_json::Value = serde_json::from_slice(&env.run(&["status"]).stdout).unwrap();
    assert_eq!(
        (status["ready"].as_bool(), status["model"].as_bool()),
        (Some(false), Some(false))
    );
}

#[test]
fn speak_sends_voice_and_language_and_writes_the_engines_audio() {
    let env = Env::new();
    env.install_model();
    let wav = env.path("out.wav");
    let out = env.run(&[
        "speak",
        "--voice",
        "m2",
        "--lang",
        "nl",
        "--output",
        wav.to_str().unwrap(),
        "Klaar.",
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    let job: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(env.path("job.json")).unwrap()).unwrap();
    assert_eq!(job["payload"]["kind"], "speak");
    assert_eq!(job["payload"]["voice"], "M2");
    assert_eq!(job["payload"]["language"], "nl");
    assert_eq!(job["payload"]["text"], "Klaar.");
    let bytes = fs::read(&wav).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        44_100
    );
    // Two samples, 0.25 and -0.25, as 16-bit PCM.
    assert_eq!(&bytes[44..], &[0xff, 0x1f, 0x01, 0xe0]);
    // The one-shot engine was told to shut down and is gone.
    assert!(!alive(&env.path("engine.pid")));
    let status: serde_json::Value = serde_json::from_slice(&env.run(&["status"]).stdout).unwrap();
    assert_eq!(status["ready"], true);
}

#[test]
fn bad_input_fails_before_any_engine_starts() {
    let env = Env::new();
    env.install_model();
    let out = env.run(&["speak", "--voice", "Z9", "Hi."]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("Unknown voice Z9"));
    let out = env.run(&["speak", "--lang", "fr", "Salut."]);
    assert_eq!(out.status.code(), Some(1));
    // Over the 16,000-byte cap, from stdin.
    let mut child = env
        .command(&["speak", "-"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(&vec![b'a'; 16_001]);
    }
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("exceeds 16000 bytes"),
        "{}",
        stderr(&out)
    );
    assert!(!env.path("engine.pid").exists());
}

#[test]
fn a_second_reply_queues_behind_the_lock_and_runs_when_it_is_free() {
    let env = Env::new();
    env.install_model();
    let lock = env.hold_lock();
    let wav = env.path("queued.wav");
    let mut child = env
        .command(&["speak", "--output", wav.to_str().unwrap(), "Queued."])
        .spawn()
        .unwrap();
    assert!(
        wait(&mut child, Duration::from_millis(700)).is_none(),
        "speak must wait for the lock"
    );
    assert!(!env.path("engine.pid").exists(), "no engine while queued");
    drop(lock);
    let status =
        wait(&mut child, Duration::from_secs(10)).expect("finishes after the lock is free");
    assert!(status.success());
    assert!(wav.is_file());
}

#[test]
fn signals_while_queued_exit_with_130_and_143() {
    let env = Env::new();
    env.install_model();
    let _lock = env.hold_lock();
    for (signal, code) in [(libc::SIGINT, 130), (libc::SIGTERM, 143)] {
        let mut child = env.command(&["speak", "Waiting."]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        unsafe { libc::kill(child.id() as i32, signal) };
        let status = wait(&mut child, Duration::from_secs(5)).expect("exits after the signal");
        assert_eq!(status.code(), Some(code));
    }
}

#[test]
fn cancelling_during_synthesis_stops_the_engine_too() {
    let env = Env::new();
    env.install_model();
    fs::write(env.path("hang"), "").unwrap();
    let mut child = env
        .command(&[
            "speak",
            "--output",
            env.path("x.wav").to_str().unwrap(),
            "Long.",
        ])
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !env.path("job.json").exists() && started.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(alive(&env.path("engine.pid")));
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let status = wait(&mut child, Duration::from_secs(5)).expect("exits after the signal");
    assert_eq!(status.code(), Some(143));
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !alive(&env.path("engine.pid")),
        "the engine must not outlive a cancelled reply"
    );
    assert!(!env.path("x.wav").exists());
}

#[test]
fn chatterbox_is_opt_in_and_explains_itself_when_not_configured() {
    let env = Env::new();
    let out = env.run(&["speak", "--engine", "chatterbox", "Hello."]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        stderr(&out).contains("delulu setup --python"),
        "{}",
        stderr(&out)
    );
}
