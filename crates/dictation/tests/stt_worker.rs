//! The speech worker client (`delulu_dictation::stt`) against a fake `delulu-engine
//! stt`: this test's own binary, started again as `<binary> stt`. It has no test
//! harness (Cargo.toml), so nothing but the protocol reaches the client on stdout.
//! No GPU and no model needed.
//!
//! The fake answers like the real worker and misbehaves on cue: a clip of `CRASH`
//! samples kills it, `HANG` makes it stop answering, `SLOW` is answered only when
//! cancelled; a models folder named `broken` fails the load, `crash-on-load` kills
//! it while loading. It writes its pid to `<models folder>/pids` when it loads.
use delulu_dictation::stt::{engine_thread, EngineHost, EngineJob, NOT_INSTALLED};
use delulu_proto::worker::{
    AudioSource, FromWorker, JobPayload, JobResult, ToWorker, WorkerErrorKind,
    WORKER_PROTOCOL_VERSION,
};
use delulu_stt::{Language, Prompt, Transcript};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

const CRASH: usize = 13;
const HANG: usize = 17;
const SLOW: usize = 19;
const MODEL: &str = "large-v3-turbo-q5_0";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("stt") {
        fake_worker();
        return;
    }
    let tests: [(&str, fn()); 9] = [
        (
            "a_clip_reaches_the_worker_whole_with_its_language_and_prompt",
            a_clip_reaches_the_worker_whole_with_its_language_and_prompt,
        ),
        (
            "a_worker_killed_while_idle_is_back_within_3_s",
            a_worker_killed_while_idle_is_back_within_3_s,
        ),
        (
            "a_crash_during_a_dictation_fails_it_and_the_next_one_works",
            a_crash_during_a_dictation_fails_it_and_the_next_one_works,
        ),
        ("a_hung_worker_is_replaced", a_hung_worker_is_replaced),
        (
            "a_dictation_nobody_waits_for_is_cancelled",
            a_dictation_nobody_waits_for_is_cancelled,
        ),
        (
            "a_failed_recovery_is_tried_again",
            a_failed_recovery_is_tried_again,
        ),
        (
            "a_dictation_during_a_retry_is_answered_after_it",
            a_dictation_during_a_retry_is_answered_after_it,
        ),
        (
            "closing_during_a_retry_ends_the_thread",
            closing_during_a_retry_ends_the_thread,
        ),
        ("load_failures_are_reported", load_failures_are_reported),
    ];
    let filter = args.iter().skip(1).find(|a| !a.starts_with('-'));
    println!("\nrunning {} tests", tests.len());
    let mut failed = Vec::new();
    for (name, test) in tests {
        if filter.is_some_and(|f| !name.contains(f.as_str())) {
            continue;
        }
        let ok = std::panic::catch_unwind(test).is_ok();
        println!("test {name} ... {}", if ok { "ok" } else { "FAILED" });
        if !ok {
            failed.push(name);
        }
    }
    if !failed.is_empty() {
        println!("\nfailures: {failed:?}");
        std::process::exit(101);
    }
    println!("\ntest result: ok");
}

// ---- the client side ----

type Report = (&'static str, String, Result<String, String>);

struct Host {
    dir: PathBuf,
    reports: Sender<Report>,
    timeout: Duration,
    no_engine: bool,
}

impl EngineHost for Host {
    fn models_dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn before_load(&self) {}
    fn loaded(&self, id: String, result: Result<String, String>) {
        let _ = self.reports.send(("loaded", id, result));
    }
    fn recovered(&self, id: String, result: Result<String, String>) {
        let _ = self.reports.send(("recovered", id, result));
    }
    fn engine(&self) -> Option<PathBuf> {
        (!self.no_engine).then(|| std::env::current_exe().unwrap())
    }
    fn job_timeout(&self, _: Duration) -> Duration {
        self.timeout
    }
    fn recovery_retry(&self) -> Duration {
        Duration::from_millis(300)
    }
}

struct Session {
    jobs: Sender<EngineJob>,
    reports: Receiver<Report>,
    dir: PathBuf,
    _tmp: tempfile::TempDir,
}

fn session(folder: &str, timeout: Duration, no_engine: bool) -> Session {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    let (reports_tx, reports) = mpsc::channel();
    let (jobs, rx) = mpsc::channel();
    let host = Host {
        dir: dir.clone(),
        reports: reports_tx,
        timeout,
        no_engine,
    };
    std::thread::spawn(move || engine_thread(host, rx));
    Session {
        jobs,
        reports,
        dir,
        _tmp: tmp,
    }
}

impl Session {
    fn report(&self) -> Report {
        self.reports
            .recv_timeout(Duration::from_secs(10))
            .expect("a report from the engine thread")
    }

    fn load(&self) -> Result<String, String> {
        self.jobs.send(EngineJob::Load(MODEL.into())).unwrap();
        let (kind, id, result) = self.report();
        assert_eq!((kind, id.as_str()), ("loaded", MODEL));
        result
    }

    fn transcribe(
        &self,
        samples: usize,
        language: Language,
        prompt: Option<Prompt>,
    ) -> Result<Transcript, String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.jobs
            .send(EngineJob::Transcribe(
                vec![0.25; samples],
                language,
                prompt,
                reply,
            ))
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime
            .block_on(async { tokio::time::timeout(Duration::from_secs(10), answer).await })
            .expect("an answer within 10 s")
            .expect("the engine thread answers")
    }

    /// The fake worker's latest pid.
    fn worker_pid(&self) -> libc::pid_t {
        std::fs::read_to_string(self.dir.join("pids"))
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .parse()
            .unwrap()
    }
}

fn both() -> Language {
    Language::Auto(vec!["nl".into(), "en".into()])
}

fn a_clip_reaches_the_worker_whole_with_its_language_and_prompt() {
    let s = session("models", Duration::from_secs(10), false);
    assert_eq!(s.load().as_deref(), Ok("Fake GPU"));
    // More than one 1 MiB frame.
    let prompt = Prompt {
        terms: Some("T3 Code.".into()),
        sentence: Some("Fix it.".into()),
    };
    let t = s.transcribe(300_000, both(), Some(prompt)).unwrap();
    assert_eq!(
        t.text,
        "300000 samples of 0.25, auto nl+en, T3 Code.|Fix it."
    );
    assert_eq!(
        (t.language.as_str(), t.audio_ms, t.elapsed_ms),
        ("nl", 18_750, 7)
    );
    let t = s
        .transcribe(1_600, Language::Fixed("de".into()), None)
        .unwrap();
    assert_eq!(t.text, "1600 samples of 0.25, de, -");
}

fn a_worker_killed_while_idle_is_back_within_3_s() {
    let s = session("models", Duration::from_secs(10), false);
    s.load().unwrap();
    let pid = s.worker_pid();
    let killed = Instant::now();
    // SAFETY: plain syscall on the fake worker this test started.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let (kind, id, result) = s.report();
    assert_eq!(
        (kind, id.as_str(), result.as_deref()),
        ("recovered", MODEL, Ok("Fake GPU"))
    );
    assert!(
        killed.elapsed() < Duration::from_secs(3),
        "{:?}",
        killed.elapsed()
    );
    assert_ne!(s.worker_pid(), pid, "a new worker");
    assert!(s.transcribe(1_000, both(), None).is_ok());
}

fn a_crash_during_a_dictation_fails_it_and_the_next_one_works() {
    let s = session("models", Duration::from_secs(10), false);
    s.load().unwrap();
    let error = s.transcribe(CRASH, both(), None).unwrap_err();
    assert!(error.contains("stopped unexpectedly"), "{error}");
    let (kind, _, result) = s.report();
    assert_eq!((kind, result.is_ok()), ("recovered", true));
    assert!(s.transcribe(1_000, both(), None).is_ok());
}

fn a_hung_worker_is_replaced() {
    let s = session("models", Duration::from_millis(800), false);
    s.load().unwrap();
    let started = Instant::now();
    let error = s.transcribe(HANG, both(), None).unwrap_err();
    assert!(error.contains("stopped responding"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(3));
    let (kind, _, result) = s.report();
    assert_eq!((kind, result.is_ok()), ("recovered", true));
    assert!(s.transcribe(1_000, both(), None).is_ok());
}

fn a_dictation_nobody_waits_for_is_cancelled() {
    // Without the cancel, the next clip would wait for this timeout.
    let s = session("models", Duration::from_secs(30), false);
    s.load().unwrap();
    let (reply, answer) = tokio::sync::oneshot::channel();
    s.jobs
        .send(EngineJob::Transcribe(vec![0.25; SLOW], both(), None, reply))
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    drop(answer);
    let started = Instant::now();
    assert!(s.transcribe(1_000, both(), None).is_ok());
    assert!(started.elapsed() < Duration::from_secs(3));
}

fn a_failed_recovery_is_tried_again() {
    let s = session("models", Duration::from_secs(10), false);
    s.load().unwrap();
    // The new worker cannot load the model for a while (the GPU is full, say).
    std::fs::write(s.dir.join("fail-loads"), "").unwrap();
    // SAFETY: plain syscall on the fake worker this test started.
    unsafe { libc::kill(s.worker_pid(), libc::SIGKILL) };
    let (kind, _, result) = s.report();
    assert_eq!(
        (kind, result),
        ("recovered", Err("not a model file".into()))
    );
    std::fs::remove_file(s.dir.join("fail-loads")).unwrap();
    // Nobody asks: the engine thread tries again by itself.
    let (kind, id, result) = s.report();
    assert_eq!(
        (kind, id.as_str(), result.as_deref()),
        ("recovered", MODEL, Ok("Fake GPU"))
    );
    assert!(s.transcribe(1_000, both(), None).is_ok());
}

/// A session whose worker was killed and could not load the model again, now inside
/// the engine thread's own retry: the fake worker holds that load until `release`.
fn failed_recovery_with_a_slow_retry() -> Session {
    let s = session("models", Duration::from_secs(10), false);
    s.load().unwrap();
    std::fs::write(s.dir.join("fail-loads"), "").unwrap();
    // SAFETY: plain syscall on the fake worker this test started.
    unsafe { libc::kill(s.worker_pid(), libc::SIGKILL) };
    let (kind, _, result) = s.report();
    assert_eq!((kind, result.is_err()), ("recovered", true));
    std::fs::write(s.dir.join("hold-loads"), "").unwrap();
    std::fs::remove_file(s.dir.join("fail-loads")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !s.dir.join("loading").exists() {
        assert!(Instant::now() < deadline, "the retry did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    s
}

/// Lets the held load finish, once whatever the test just sent has had time to pass
/// the job thread and reach the engine thread's queue. Should that thread stall
/// longer, the test passes without covering the handoff; it never fails falsely.
fn release(s: &std::path::Path) {
    std::thread::sleep(Duration::from_millis(500));
    std::fs::write(s.join("release"), "").unwrap();
}

fn a_dictation_during_a_retry_is_answered_after_it() {
    let s = failed_recovery_with_a_slow_retry();
    let (reply, answer) = tokio::sync::oneshot::channel();
    s.jobs
        .send(EngineJob::Transcribe(
            vec![0.25; 1_000],
            both(),
            None,
            reply,
        ))
        .unwrap();
    release(&s.dir);
    let (kind, _, result) = s.report();
    assert_eq!((kind, result.is_ok()), ("recovered", true));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let answer = runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(5), answer).await })
        .expect("an answer after the retry");
    assert!(answer.unwrap().is_ok());
}

fn closing_during_a_retry_ends_the_thread() {
    let s = failed_recovery_with_a_slow_retry();
    let Session { jobs, reports, .. } = s;
    // The held load never ends: no answer from the worker wakes the thread, so only
    // its own check of the close can end it.
    drop(jobs);
    // The thread drops its host (and so the reports sender) when it ends.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match reports.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("the engine thread kept running"),
        }
    }
}

fn load_failures_are_reported() {
    let s = session("broken", Duration::from_secs(10), false);
    let error = s.load().unwrap_err();
    assert_eq!(error, "not a model file");
    assert_eq!(
        s.transcribe(1_000, both(), None).unwrap_err(),
        "Model is not loaded"
    );

    let s = session("crash-on-load", Duration::from_secs(10), false);
    let error = s.load().unwrap_err();
    assert!(error.contains("stopped each time"), "{error}");
    let tries = std::fs::read_to_string(s.dir.join("pids")).unwrap();
    assert_eq!(tries.lines().count(), 5, "started again up to the limit");

    let s = session("models", Duration::from_secs(10), true);
    assert_eq!(s.load().unwrap_err(), NOT_INSTALLED);
}

// ---- the fake worker ----

fn send(out: &mut impl Write, message: &FromWorker) {
    let line = serde_json::to_string(message).unwrap();
    writeln!(out, "{line}").unwrap();
    out.flush().unwrap();
}

struct Pending {
    language: Option<String>,
    languages: Vec<String>,
    prompt: String,
    samples: Vec<f32>,
}

fn fake_worker() {
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut out = std::io::stdout().lock();
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let mut slow = None;
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let message: ToWorker = serde_json::from_str(&line).unwrap();
        match message {
            ToWorker::Hello { .. } => send(
                &mut out,
                &FromWorker::Ready {
                    engine: "fake".into(),
                    protocol: WORKER_PROTOCOL_VERSION,
                    device: None,
                    vram_bytes: None,
                    caps: Vec::new(),
                },
            ),
            ToWorker::Load { model, .. } => {
                let dir = PathBuf::from(&model.path).parent().unwrap().to_path_buf();
                let mut pids = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("pids"))
                    .unwrap();
                writeln!(pids, "{}", std::process::id()).unwrap();
                if model.path.contains("crash-on-load") {
                    kill_self();
                }
                if dir.join("hold-loads").exists() {
                    // Tell the test the load began, and wait until it lets the load end.
                    std::fs::write(dir.join("loading"), "").unwrap();
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while !dir.join("release").exists() && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                send(
                    &mut out,
                    &if model.path.contains("broken") || dir.join("fail-loads").exists() {
                        FromWorker::Error {
                            id: None,
                            kind: WorkerErrorKind::LoadFailed,
                            message: "not a model file".into(),
                        }
                    } else {
                        FromWorker::Loaded {
                            model_id: model.id,
                            load_ms: 1,
                            vram_bytes: None,
                            device: Some("Fake GPU".into()),
                        }
                    },
                );
            }
            ToWorker::Job {
                id,
                payload:
                    JobPayload::Transcribe {
                        audio: AudioSource::Frames,
                        language,
                        languages,
                        prompt,
                        ..
                    },
                ..
            } => {
                let prompt = prompt.map_or("-".to_string(), |p| {
                    format!(
                        "{}|{}",
                        p.terms.unwrap_or_default(),
                        p.sentence.unwrap_or_default()
                    )
                });
                pending.insert(
                    id,
                    Pending {
                        language,
                        languages,
                        prompt,
                        samples: Vec::new(),
                    },
                );
            }
            ToWorker::Audio(header) => {
                let mut bytes = vec![0u8; header.bytes as usize];
                input.read_exact(&mut bytes).unwrap();
                let clip = pending.get_mut(&header.id).unwrap();
                clip.samples.extend(
                    bytes
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|b| f32::from_le_bytes(*b)),
                );
                if !header.last {
                    continue;
                }
                let clip = pending.remove(&header.id).unwrap();
                match clip.samples.len() {
                    CRASH => kill_self(),
                    HANG => loop {
                        std::thread::sleep(Duration::from_secs(60));
                    },
                    SLOW => slow = Some(header.id),
                    n => {
                        let all_same = clip.samples.iter().all(|s| *s == clip.samples[0]);
                        let heard = clip
                            .language
                            .clone()
                            .unwrap_or_else(|| format!("auto {}", clip.languages.join("+")));
                        send(
                            &mut out,
                            &FromWorker::Done {
                                id: header.id,
                                ms: 7,
                                result: JobResult::Transcript {
                                    text: format!(
                                        "{n} samples of {}, {heard}, {}",
                                        if all_same { clip.samples[0] } else { f32::NAN },
                                        clip.prompt
                                    ),
                                    language: clip.language.unwrap_or_else(|| "nl".into()),
                                    audio_ms: n as u64 / 16,
                                },
                            },
                        );
                    }
                }
            }
            ToWorker::Cancel { id } if slow == Some(id) => {
                slow = None;
                send(
                    &mut out,
                    &FromWorker::Error {
                        id: Some(id),
                        kind: WorkerErrorKind::Cancelled,
                        message: "cancelled".into(),
                    },
                );
            }
            ToWorker::Shutdown => {
                send(&mut out, &FromWorker::Bye);
                return;
            }
            _ => {}
        }
    }
}

fn kill_self() -> ! {
    // SAFETY: plain syscall on this process, like `kill -9`.
    unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
    unreachable!("killed")
}
