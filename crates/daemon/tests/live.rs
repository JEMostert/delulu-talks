//! Dictation in the daemon (`live`) against a fake platform and a real store in a
//! temporary folder: no desktop, GPU or model needed.

use delulu_core::dictation::Input;
use delulu_core::gesture::KeyEvent;
use delulu_daemon::live::{BoxFuture, Live, Platform, Reporter};
use delulu_daemon::server::{Daemon, Options};
use delulu_desktop::hotkey::HotkeyStatus;
use delulu_desktop::insert::InsertStatus;
use delulu_dictation::cleanup::{choose, CleanResult, Cleaned};
use delulu_dictation::stop::{InsertResult, Recorded};
use delulu_overlay::PillState;
use delulu_proto::state::*;
use delulu_store::{InsertMode, Store};
use delulu_stt::{Language, Transcript};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Notify};

const HEARD: &str = "the secret plan is ready";

/// A scripted machine: answers from its fields and records what the daemon did.
struct Fake {
    transcripts: Mutex<VecDeque<Result<String, String>>>,
    /// While set, transcription waits until `release` is notified.
    hold_transcription: AtomicBool,
    release: Notify,
    transcribing: Notify,
    bind: Mutex<HotkeyStatus>,
    binds: AtomicUsize,
    app_running: AtomicBool,
    /// What each clean was asked: cleanup on, and the vocabulary terms.
    cleaned_with: Mutex<Vec<(bool, Vec<String>)>>,
    keys: Mutex<Option<mpsc::UnboundedSender<KeyEvent>>>,
    delivered: Mutex<Vec<String>>,
    /// The microphone is open.
    open: AtomicBool,
    /// Opening and stopping the microphone take this long, to widen races.
    slow_start: AtomicBool,
    slow_stop: AtomicBool,
    starting: Notify,
    /// While set, delivery waits for `release_delivery` after it has begun.
    hold_delivery: AtomicBool,
    delivering: Notify,
    release_delivery: Notify,
}

impl Fake {
    fn new() -> Self {
        Self {
            transcripts: Mutex::new(VecDeque::new()),
            hold_transcription: AtomicBool::new(false),
            release: Notify::new(),
            transcribing: Notify::new(),
            bind: Mutex::new(HotkeyStatus {
                bound: true,
                trigger: Some("Meta+Z".into()),
                error: None,
            }),
            binds: AtomicUsize::new(0),
            app_running: AtomicBool::new(false),
            cleaned_with: Mutex::new(Vec::new()),
            keys: Mutex::new(None),
            delivered: Mutex::new(Vec::new()),
            open: AtomicBool::new(false),
            slow_start: AtomicBool::new(false),
            slow_stop: AtomicBool::new(false),
            starting: Notify::new(),
            hold_delivery: AtomicBool::new(false),
            delivering: Notify::new(),
            release_delivery: Notify::new(),
        }
    }
    fn hears(&self, result: Result<&str, &str>) {
        self.transcripts
            .lock()
            .unwrap()
            .push_back(result.map(str::to_owned).map_err(str::to_owned));
    }
    fn delivered(&self) -> Vec<String> {
        self.delivered.lock().unwrap().clone()
    }
}

impl Platform for Fake {
    fn start_engines(&self, report: Reporter) {
        report.stt(WorkerStatus {
            state: WorkerState::Ready,
            model: Some("fake".into()),
            device: Some("Fake".into()),
            error: None,
            progress: None,
        });
    }
    fn start_capture(&self, _: Option<&str>, _: Box<dyn Fn(f32) + Send>) -> Result<(), String> {
        if self.slow_start.load(Ordering::SeqCst) {
            self.starting.notify_one();
            std::thread::sleep(Duration::from_millis(150));
        }
        if self.open.swap(true, Ordering::SeqCst) {
            return Err("audio stream failed: already recording".into());
        }
        Ok(())
    }
    fn stop_capture(&self) -> Recorded {
        if self.slow_stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(150));
        }
        self.open.store(false, Ordering::SeqCst);
        Ok(vec![0.0; 1600])
    }
    fn discard_capture(&self) {
        self.open.store(false, Ordering::SeqCst);
    }
    fn transcribe(
        &self,
        _: Vec<f32>,
        _: Language,
        _: Option<String>,
    ) -> BoxFuture<'_, Result<Transcript, String>> {
        Box::pin(async move {
            self.transcribing.notify_one();
            if self.hold_transcription.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            let next = self.transcripts.lock().unwrap().pop_front();
            next.unwrap_or_else(|| Ok(HEARD.into()))
                .map(|text| Transcript {
                    text,
                    language: "en".into(),
                    audio_ms: 2400,
                    elapsed_ms: 180,
                })
        })
    }
    fn clean(
        &self,
        enabled: bool,
        _: String,
        raw: String,
        vocabulary: Vec<String>,
    ) -> BoxFuture<'_, Cleaned> {
        self.cleaned_with
            .lock()
            .unwrap()
            .push((enabled, vocabulary));
        Box::pin(async move { choose(raw, CleanResult::Skipped, 0) })
    }
    fn deliver(&self, text: String, _: InsertMode, _: bool) -> BoxFuture<'_, InsertResult> {
        Box::pin(async move {
            if self.hold_delivery.load(Ordering::SeqCst) {
                self.delivering.notify_one();
                self.release_delivery.notified().await;
            }
            self.delivered.lock().unwrap().push(text);
            InsertResult::Pasted
        })
    }
    fn app_running(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { self.app_running.load(Ordering::SeqCst) })
    }
    fn bind_hotkey(
        &self,
        events: mpsc::UnboundedSender<KeyEvent>,
        _: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> BoxFuture<'_, HotkeyStatus> {
        self.binds.fetch_add(1, Ordering::SeqCst);
        *self.keys.lock().unwrap() = Some(events);
        let status = self.bind.lock().unwrap().clone();
        Box::pin(async move { status })
    }
    fn configure_hotkey(&self) -> BoxFuture<'_, Option<Result<(), String>>> {
        Box::pin(async { Some(Ok(())) })
    }
    fn settings_changed(&self, _: &delulu_store::Settings, _: &delulu_store::Settings) {}
    fn refresh_models(&self) {}
    fn start_cleanup(&self) {}
    fn cancel_cleanup(&self) {}
    fn prepare_insert(&self) -> BoxFuture<'_, InsertStatus> {
        Box::pin(async {
            InsertStatus {
                ready: true,
                error: None,
            }
        })
    }
    fn pill(&self, _: PillState, _: Option<&str>) {}
    fn pill_level(&self, _: f32) {}
}

struct Setup {
    daemon: Daemon,
    fake: Arc<Fake>,
    socket: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

/// A daemon in dictation mode over `fake`, with first run done and a store in a
/// temporary folder; `prepare` may change the data folder before the store opens.
fn start(fake: Fake, prepare: impl FnOnce(&Path)) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let (config, data) = (dir.path().join("config"), dir.path().join("data"));
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(config.join("state.json"), r#"{"firstRunDone":true}"#).unwrap();
    // Cleanup off keeps the fake simple; the cleanup phase has its own tests.
    std::fs::write(
        config.join("settings.json"),
        r#"{"version":2,"cleanup":false}"#,
    )
    .unwrap();
    prepare(&data);
    let store = Arc::new(Store::open(&config, &data).unwrap());
    let socket = dir.path().join("d.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let daemon = Daemon::new(Options::default());
    let fake = Arc::new(fake);
    Live::start(daemon.clone(), store, fake.clone());
    let serving = daemon.clone();
    tokio::spawn(async move { serving.serve(listener, std::future::pending()).await });
    Setup {
        daemon,
        fake,
        socket,
        _dir: dir,
    }
}

/// Waits until the snapshot satisfies `ready`, then returns it.
async fn until(daemon: &Daemon, what: &str, ready: impl Fn(&AppState) -> bool) -> AppState {
    for _ in 0..500 {
        let state = daemon.snapshot();
        if ready(&state) {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "timed out waiting for {what}: {:#?}",
        daemon.snapshot().dictation
    );
}

fn idle_after(job: u64) -> impl Fn(&AppState) -> bool {
    move |s| s.dictation.phase == DictationPhase::Idle && s.dictation.job == job
}

struct Client {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    next: u64,
}

impl Client {
    async fn open(path: &Path) -> Self {
        Self::open_as(path, "test").await
    }
    async fn open_as(path: &Path, name: &str) -> Self {
        let (reader, writer) = UnixStream::connect(path).await.unwrap().into_split();
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            next: 0,
        };
        client
            .call("hello", json!({"protocol": 1, "client": name}))
            .await;
        client
    }
    /// Sends a request and returns its reply line, skipping events.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let mut line = json!({"id": id, "method": method, "params": params}).to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).await.unwrap();
        loop {
            let mut reply = String::new();
            tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut reply))
                .await
                .expect("a reply within 5 s")
                .unwrap();
            let reply: Value = serde_json::from_str(&reply).unwrap();
            if reply["id"] == id {
                return reply;
            }
        }
    }
}

#[tokio::test]
async fn a_dictation_is_typed_saved_and_listed() {
    let s = start(Fake::new(), |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let mut c = Client::open(&s.socket).await;
    assert_eq!(
        c.call("dictation.toggle", json!({})).await["result"]["phase"],
        "recording"
    );
    c.call("dictation.toggle", json!({})).await;
    let state = until(&s.daemon, "the dictation to finish", idle_after(1)).await;

    assert_eq!(s.fake.delivered(), [HEARD]);
    let Some(DictationOutcome::Done {
        text,
        delivery: Delivery::Typed,
        history_id: Some(id),
        history_error: None,
        ..
    }) = state.dictation.last
    else {
        panic!("expected a typed dictation: {:?}", state.dictation.last);
    };
    assert_eq!(text, HEARD);
    let page = state.history.unwrap();
    assert_eq!((page.total, page.entries[0].id.as_str()), (1, id.as_str()));
    let listed = c.call("history.list", json!({"query": "secret"})).await;
    assert_eq!(listed["result"]["entries"][0]["text"], HEARD, "{listed}");
    let none = c
        .call("history.list", json!({"query": "nothing like it"}))
        .await;
    assert_eq!(none["result"]["total"], 0, "{none}");
}

#[tokio::test]
async fn a_failed_history_save_still_types_and_says_it_was_not_saved() {
    // A database path that cannot be opened: the session runs without History.
    let s = start(Fake::new(), |data| {
        std::fs::create_dir_all(data.join("delulu.db")).unwrap()
    });
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    let state = until(&s.daemon, "the dictation to finish", idle_after(1)).await;

    assert_eq!(s.fake.delivered(), [HEARD]);
    match state.dictation.last {
        Some(DictationOutcome::Done {
            delivery: Delivery::Typed,
            history_id: None,
            history_error: Some(error),
            ..
        }) => assert!(error.starts_with("Not saved to History"), "{error}"),
        other => panic!("expected typed but unsaved: {other:?}"),
    }
}

#[tokio::test]
async fn a_failed_transcription_returns_to_idle_with_the_error() {
    let fake = Fake::new();
    fake.hears(Err("speech engine: out of memory"));
    let s = start(fake, |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    let state = until(&s.daemon, "the dictation to fail", idle_after(1)).await;

    assert!(s.fake.delivered().is_empty());
    assert!(matches!(
        state.dictation.last,
        Some(DictationOutcome::Failed { during: DictationPhase::Transcribing, ref error, .. })
            if error == "speech engine: out of memory"
    ));
    // The engine is still there for the next dictation.
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    until(&s.daemon, "the second dictation", idle_after(2)).await;
    assert_eq!(s.fake.delivered(), [HEARD]);
}

#[tokio::test]
async fn a_client_that_disconnects_mid_dictation_does_not_stop_it() {
    let fake = Fake::new();
    fake.hold_transcription.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let mut c = Client::open(&s.socket).await;
    c.call("dictation.toggle", json!({})).await;
    c.call("dictation.toggle", json!({})).await;
    s.fake.transcribing.notified().await;
    drop(c);
    s.fake.release.notify_one();

    let state = until(&s.daemon, "the dictation to finish", idle_after(1)).await;
    assert_eq!(s.fake.delivered(), [HEARD]);
    assert!(matches!(
        state.dictation.last,
        Some(DictationOutcome::Done { .. })
    ));
}

#[tokio::test]
async fn a_shortcut_that_could_not_be_bound_is_reported_and_toggle_still_works() {
    let fake = Fake::new();
    *fake.bind.lock().unwrap() = HotkeyStatus {
        bound: false,
        trigger: None,
        error: Some("GlobalShortcuts portal not available".into()),
    };
    let s = start(fake, |_| {});
    let state = until(&s.daemon, "the shortcut state", |s| {
        s.hotkey.error.is_some()
    })
    .await;
    assert!(!state.hotkey.bound);
    assert_eq!(state.hotkey.problem, Some(HotkeyProblem::Unavailable));

    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let mut c = Client::open(&s.socket).await;
    c.call("dictation.toggle", json!({})).await;
    c.call("dictation.toggle", json!({})).await;
    until(&s.daemon, "the dictation to finish", idle_after(1)).await;
    assert_eq!(s.fake.delivered(), [HEARD]);
}

#[tokio::test]
async fn the_shortcut_is_not_bound_while_the_app_runs_and_is_bound_once_it_quits() {
    let fake = Fake::new();
    fake.app_running.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    let state = until(&s.daemon, "the app-running state", |s| {
        s.hotkey.problem == Some(HotkeyProblem::AppRunning)
    })
    .await;
    assert!(!state.hotkey.bound);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        s.fake.binds.load(Ordering::SeqCst),
        0,
        "bound while the app runs"
    );

    s.fake.app_running.store(false, Ordering::SeqCst);
    let state = until(&s.daemon, "the shortcut to be bound", |s| s.hotkey.bound).await;
    assert_eq!(state.hotkey.trigger.as_deref(), Some("Meta+Z"));
    assert_eq!(s.fake.binds.load(Ordering::SeqCst), 1);

    // Presses of the shortcut now dictate.
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let keys = s.fake.keys.lock().unwrap().clone().unwrap();
    keys.send(KeyEvent::Activated).unwrap();
    until(&s.daemon, "recording", |s| {
        s.dictation.phase == DictationPhase::Recording
    })
    .await;
    keys.send(KeyEvent::Activated).unwrap();
    until(&s.daemon, "the dictation to finish", idle_after(1)).await;
    assert_eq!(s.fake.delivered(), [HEARD]);
}

#[tokio::test]
async fn a_dictation_cancelled_before_delivery_is_neither_typed_nor_kept() {
    let fake = Fake::new();
    fake.hold_transcription.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "ready and bound", |s| {
        s.dictation.available && s.hotkey.bound
    })
    .await;
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    s.fake.transcribing.notified().await;
    // The hotkey goes down and stays down, so delivery waits for its release.
    let keys = s.fake.keys.lock().unwrap().clone().unwrap();
    keys.send(KeyEvent::Pressed).unwrap();
    until(&s.daemon, "the key to be tracked", |_| true).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    s.fake.release.notify_one();
    until(&s.daemon, "delivery", |s| {
        s.dictation.phase == DictationPhase::Inserting
    })
    .await;
    s.daemon.input(Input::Cancel).unwrap();

    tokio::time::sleep(Duration::from_millis(300)).await;
    let state = s.daemon.snapshot();
    assert!(s.fake.delivered().is_empty(), "typed after cancel");
    assert!(matches!(
        state.dictation.last,
        Some(DictationOutcome::Cancelled {
            during: DictationPhase::Inserting,
            ..
        })
    ));
    let mut c = Client::open(&s.socket).await;
    assert_eq!(
        c.call("history.list", json!({})).await["result"]["total"],
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_racing_a_start_leaves_the_microphone_closed() {
    let fake = Fake::new();
    fake.slow_start.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let daemon = s.daemon.clone();
    let start = tokio::task::spawn_blocking(move || daemon.input(Input::Toggle));
    // The machine is recording and the microphone is still opening.
    s.fake.starting.notified().await;
    let daemon = s.daemon.clone();
    let cancel = tokio::task::spawn_blocking(move || daemon.input(Input::Cancel));
    start.await.unwrap().unwrap();
    cancel.await.unwrap().unwrap();

    assert_eq!(s.daemon.snapshot().dictation.phase, DictationPhase::Idle);
    assert!(
        !s.fake.open.load(Ordering::SeqCst),
        "microphone left open while idle"
    );
}

#[tokio::test]
async fn a_new_dictation_right_after_a_cancelled_one_records() {
    let fake = Fake::new();
    fake.slow_stop.store(true, Ordering::SeqCst);
    fake.hold_transcription.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Cancel).unwrap();
    s.daemon.input(Input::Toggle).unwrap();

    tokio::time::sleep(Duration::from_millis(300)).await;
    let state = s.daemon.snapshot();
    assert_eq!(
        (state.dictation.phase, state.dictation.job),
        (DictationPhase::Recording, 2),
        "{:?}",
        state.dictation.last
    );
    assert!(
        s.fake.open.load(Ordering::SeqCst),
        "the new recording has no microphone"
    );
}

#[tokio::test]
async fn a_cancel_during_typing_keeps_the_typed_text_in_history() {
    let fake = Fake::new();
    fake.hold_delivery.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    s.daemon.input(Input::Toggle).unwrap();
    s.daemon.input(Input::Toggle).unwrap();
    // Typing has begun (the portal is slow) when the cancel comes.
    s.fake.delivering.notified().await;
    s.daemon.input(Input::Cancel).unwrap();
    s.fake.release_delivery.notify_one();

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.fake.delivered(), [HEARD]);
    let mut c = Client::open(&s.socket).await;
    let listed = c.call("history.list", json!({})).await;
    assert_eq!(listed["result"]["entries"][0]["text"], HEARD, "{listed}");
}

#[tokio::test]
async fn a_window_connected_as_a_client_does_not_keep_the_shortcut_from_the_daemon() {
    let fake = Fake::new();
    // The app's single-instance name is taken, but by a window that is a client.
    fake.app_running.store(true, Ordering::SeqCst);
    let s = start(fake, |_| {});
    until(&s.daemon, "the app-running state", |s| {
        s.hotkey.problem == Some(HotkeyProblem::AppRunning)
    })
    .await;
    let mut window = Client::open_as(&s.socket, delulu_proto::APP_CLIENT).await;
    until(&s.daemon, "the shortcut to be bound", |s| s.hotkey.bound).await;
    assert_eq!(s.fake.binds.load(Ordering::SeqCst), 1);
    let state = window.call("state.get", json!({})).await;
    assert_eq!(state["result"]["hotkey"]["bound"], true);
}

#[tokio::test]
async fn settings_and_vocabulary_changed_in_the_window_apply_to_the_next_dictation() {
    let s = start(Fake::new(), |_| {});
    until(&s.daemon, "dictation available", |s| s.dictation.available).await;
    let mut c = Client::open(&s.socket).await;
    let shelf = c
        .call(
            "vocabulary.change",
            json!({"op": "addShelf", "name": "Work"}),
        )
        .await;
    let id = shelf["result"]["shelves"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let terms = c
        .call(
            "vocabulary.change",
            json!({"op": "addTerms", "id": id, "text": "Tauri, T3 Code"}),
        )
        .await;
    assert_eq!(terms["result"]["activeTerms"], 2, "{terms}");
    let mut settings = s.daemon.snapshot().settings.unwrap();
    settings.cleanup = true;
    let saved = c.call("settings.set", json!({"settings": settings})).await;
    assert_eq!(saved["result"]["cleanup"], true, "{saved}");

    c.call("dictation.toggle", json!({})).await;
    c.call("dictation.toggle", json!({})).await;
    until(&s.daemon, "the dictation to finish", idle_after(1)).await;
    let asked = s.fake.cleaned_with.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].0, "cleanup was still off");
    assert_eq!(asked[0].1, ["Tauri", "T3 Code"]);
}
