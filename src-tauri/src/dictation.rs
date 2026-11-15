use super::*;

pub(crate) fn event(app: &tauri::AppHandle, ev: KeyEvent) {
    let received_at = Instant::now();
    let shell = app.state::<Shell>();
    let command = {
        let mut gesture = shell.gesture.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(ev, KeyEvent::Released) && gesture.keys_down() {
            *shell.last_release.lock().unwrap_or_else(|e| e.into_inner()) = Some(received_at);
        }
        if status_value(&shell).phase == "transcribing" {
            gesture.track(ev);
            return;
        }
        gesture.feed(
            ev,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        )
    };
    match command {
        Some(Command::Start) => start(app),
        Some(Command::Stop) => stop(app, received_at),
        None => {}
    }
}
pub(crate) fn start(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    let status = status_value(&s);
    if status.phase != "idle"
        && !(status.phase == "error" && status.model.is_some() && s.store.state().first_run_done)
    {
        s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
        return;
    }
    if s.mic.load(Ordering::SeqCst) {
        s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
        return;
    }
    let settings = s.store.settings();
    // Show the pill before the stream opens so the first levels aren't dropped.
    if settings.overlay {
        s.pill.show(PillState::Listening, None);
    }
    let app2 = app.clone();
    let overlay = settings.overlay;
    match s.recorder.start(
        settings.microphone.as_deref(),
        Box::new(move |level| {
            let _ = app2.emit("mic-level", level);
            if overlay {
                app2.state::<Shell>().pill.level(level);
            }
        }),
    ) {
        Ok(()) => phase(app, "recording", None),
        Err(e) => {
            s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
            pill(&s, PillState::Error, Some(audio_word(&e)));
            phase(app, "error", Some(e.to_string()));
        }
    }
}
/// Show the recording pill unless it's turned off in Settings › Appearance.
pub(crate) fn pill(s: &Shell, state: PillState, label: Option<&str>) {
    if s.store.settings().overlay {
        s.pill.show(state, label);
    }
}
/// The pill's one word for a recorder problem.
fn audio_word(e: &delulu_audio::AudioError) -> &'static str {
    match e {
        delulu_audio::AudioError::NoDevice(_) => "No microphone",
        _ => "Mic error",
    }
}
/// The pill's one word for how the text arrived.
pub(crate) fn insert_word(insert: &InsertResult) -> (PillState, &'static str) {
    match insert {
        InsertResult::Pasted => (PillState::Success, "Typed"),
        InsertResult::Copied { .. } => (PillState::Success, "Copied"),
        InsertResult::Failed { .. } => (PillState::Error, "Not typed"),
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum InsertResult {
    Pasted,
    Copied { reason: Option<String> },
    Failed { reason: String },
}
#[derive(Clone, Serialize)]
pub(crate) struct TranscriptEvent {
    pub(crate) entry: HistoryEntry,
    pub(crate) insert: InsertResult,
}
pub(crate) fn paste_key(mode: InsertMode) -> Option<PasteKey> {
    match mode {
        InsertMode::ShiftInsert => Some(PasteKey::ShiftInsert),
        InsertMode::CtrlV => Some(PasteKey::CtrlV),
        InsertMode::CtrlShiftV => Some(PasteKey::CtrlShiftV),
        InsertMode::Off => None,
    }
}
pub(crate) async fn deliver(
    inserter: &Inserter,
    text: &str,
    mode: InsertMode,
    held: bool,
    no_portals: bool,
) -> InsertResult {
    if held || no_portals || mode == InsertMode::Off {
        return match inserter.copy(text) {
            Ok(()) => InsertResult::Copied {
                reason: if no_portals {
                    Some("Portals disabled for unattended tests".into())
                } else {
                    held.then(|| "Hotkey still held".into())
                },
            },
            Err(e) => InsertResult::Failed {
                reason: e.to_string(),
            },
        };
    }
    match inserter
        .insert(text, paste_key(mode).expect("non-off mode"))
        .await
    {
        Ok(InsertOutcome::Pasted) => InsertResult::Pasted,
        Ok(InsertOutcome::CopiedOnly { reason }) => InsertResult::Copied {
            reason: Some(reason),
        },
        Err(e) => InsertResult::Failed {
            reason: e.to_string(),
        },
    }
}
pub(crate) async fn wait_release(mut down: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while down() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}
pub(crate) fn stop(app: &tauri::AppHandle, stopped_at: Instant) {
    let s = app.state::<Shell>();
    if status_value(&s).phase != "recording" {
        return;
    }
    let was_held = s
        .gesture
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys_down();
    *s.last_release.lock().unwrap_or_else(|e| e.into_inner()) = None;
    phase(app, "transcribing", None);
    pill(&s, PillState::Transcribing, None);
    let request = StopRequest {
        started: stopped_at,
        was_held,
        log_text: log_text(),
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run_stop(&AppStop { app: app.clone() }, request).await;
        let s = app.state::<Shell>();
        match outcome {
            StopOutcome::Failed { word, message } => {
                pill(&s, PillState::Error, Some(word));
                phase(&app, "error", Some(message));
                return;
            }
            StopOutcome::NothingHeard => pill(&s, PillState::Error, Some("Nothing heard")),
            StopOutcome::Delivered(event) => {
                let (state, word) = insert_word(&event.insert);
                pill(&s, state, Some(word));
                let _ = app.emit("transcript", event);
            }
            StopOutcome::Unsaved { insert, message } => {
                let (state, word) = insert_word(&insert);
                pill(&s, state, Some(word));
                phase(&app, "error", Some(message));
                return;
            }
        }
        s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
        phase(&app, ready_phase(&s), None);
    });
}

/// `DELULU_LOG_TEXT=1` puts dictated text in the log, for debugging only. By default
/// the log (which ends up in the journal) never holds what the user said.
pub(crate) fn log_text() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| text_logging(std::env::var("DELULU_LOG_TEXT").ok().as_deref()))
}
fn text_logging(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Everything the stop path decides with, captured when the hotkey stopped recording.
pub(crate) struct StopRequest {
    pub(crate) started: Instant,
    /// The hotkey was still down when recording stopped (toggle press).
    pub(crate) was_held: bool,
    pub(crate) log_text: bool,
}

/// How a dictation ended. The caller turns it into the pill, the phase and the event.
pub(crate) enum StopOutcome {
    /// The pill word and the status message; the phase becomes "error".
    Failed {
        word: &'static str,
        message: String,
    },
    NothingHeard,
    Delivered(TranscriptEvent),
    /// The text was delivered, but History could not save it; the phase becomes "error".
    Unsaved {
        insert: InsertResult,
        message: String,
    },
}

/// The recorded samples, or the pill word and message for a recorder failure.
pub(crate) type Recorded = Result<Vec<f32>, (&'static str, String)>;

/// What the stop path needs from the app. The app implements it over its Tauri state;
/// tests use a fake, so the path runs without audio, a GPU or a desktop.
pub(crate) trait StopPorts {
    async fn stop_recording(&self) -> Recorded;
    /// Read after the recorder stopped, so a change saved meanwhile applies.
    fn settings(&self) -> Settings;
    fn whisper_prompt(&self) -> Option<String>;
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: delulu_stt::Language,
        prompt: Option<String>,
    ) -> Result<delulu_stt::Transcript, String>;
    async fn clean(&self, language: &str, raw: String) -> cleanup::Cleaned;
    fn remember(&self, topic: Option<String>, text: &str);
    fn add_history(&self, entry: NewEntry) -> Result<HistoryEntry, String>;
    /// True once the hotkey is up, false if it stayed down too long.
    async fn wait_release(&self) -> bool;
    async fn deliver(&self, text: &str, mode: InsertMode, held: bool) -> InsertResult;
    /// When the hotkey went up after recording stopped, if it did.
    fn last_release(&self) -> Option<Instant>;
    fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, String>;
    fn log(&self, line: String);
}

pub(crate) async fn run_stop(ports: &impl StopPorts, req: StopRequest) -> StopOutcome {
    let start = req.started;
    let samples = match ports.stop_recording().await {
        Ok(samples) => samples,
        Err((word, message)) => return StopOutcome::Failed { word, message },
    };
    let settings = ports.settings();
    let prompt = if settings.smart_context {
        ports.whisper_prompt()
    } else {
        None
    };
    let transcript = match ports
        .transcribe(
            samples,
            delulu_stt::Language::from_setting(&settings.language, &settings.allowed_languages),
            prompt,
        )
        .await
    {
        Ok(t) => t,
        Err(message) => {
            return StopOutcome::Failed {
                word: "Not transcribed",
                message,
            }
        }
    };
    if transcript.text.is_empty() {
        return StopOutcome::NothingHeard;
    }
    let cleaned = ports
        .clean(&transcript.language, transcript.text.clone())
        .await;
    if settings.smart_context {
        ports.remember(cleaned.topic.clone(), &cleaned.text);
    }
    let text = cleaned.text.clone();
    let entry = ports.add_history(NewEntry {
        text: cleaned.text,
        raw: cleaned.raw,
        cleanup_ms: cleaned.cleanup_ms,
        topic: cleaned.topic,
        language: transcript.language.clone(),
        model: settings.model,
        audio_ms: transcript.audio_ms,
        stt_ms: transcript.elapsed_ms,
        total_ms: start.elapsed().as_millis() as u64,
    });
    // Deliver even when History can't save it: the text must not be lost.
    let released = ports.wait_release().await;
    let delivery_start = Instant::now();
    let insert = ports.deliver(&text, settings.insert, !released).await;
    let entry = match entry {
        Ok(entry) => entry,
        Err(e) => {
            return StopOutcome::Unsaved {
                insert,
                message: format!("Not saved to History: {e}"),
            };
        }
    };
    let total = total_ms(start, req.was_held, ports.last_release(), Instant::now());
    let entry = match ports.set_total_ms(&entry.id, total) {
        Ok(updated) => updated,
        Err(e) => {
            ports.log(format!("save delivery timing: {e}"));
            entry
        }
    };
    let mut line = format!(
        "dictation audio={}ms stt={}ms cleanup={}ms insert={}ms total={}ms lang={} model={} topic={} delivery={} chars={} raw_chars={} history={}",
        transcript.audio_ms,
        transcript.elapsed_ms,
        entry.cleanup_ms.map_or("-".into(), |ms| ms.to_string()),
        delivery_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        transcript.language,
        entry.model,
        entry.topic.as_deref().unwrap_or("-"),
        insert_kind(&insert),
        entry.text.chars().count(),
        entry.raw.as_ref().map_or("-".into(), |r| r.chars().count().to_string()),
        entry.id
    );
    if req.log_text {
        line.push_str(&format!(" transcript={:?} raw={:?}", entry.text, entry.raw));
    }
    ports.log(line);
    StopOutcome::Delivered(TranscriptEvent { entry, insert })
}

fn insert_kind(insert: &InsertResult) -> &'static str {
    match insert {
        InsertResult::Pasted => "pasted",
        InsertResult::Copied { .. } => "copied",
        InsertResult::Failed { .. } => "failed",
    }
}

/// Milliseconds from the moment the user finished to `now`. After a toggle press the
/// user finishes when they let go of the key, not when recording stopped.
pub(crate) fn total_ms(
    start: Instant,
    was_held: bool,
    last_release: Option<Instant>,
    now: Instant,
) -> u64 {
    let from = if was_held {
        last_release.unwrap_or(start)
    } else {
        start
    };
    now.saturating_duration_since(from).as_millis() as u64
}

/// The stop path over the running app.
struct AppStop {
    app: tauri::AppHandle,
}
impl AppStop {
    fn shell(&self) -> State<'_, Shell> {
        self.app.state::<Shell>()
    }
}
impl StopPorts for AppStop {
    async fn stop_recording(&self) -> Recorded {
        let app = self.app.clone();
        match tokio::task::spawn_blocking(move || app.state::<Shell>().recorder.stop()).await {
            Ok(Ok(clip)) => Ok(clip.samples),
            Ok(Err(e)) => Err((audio_word(&e), e.to_string())),
            Err(e) => Err(("Mic error", e.to_string())),
        }
    }
    fn settings(&self) -> Settings {
        self.shell().store.settings()
    }
    fn whisper_prompt(&self) -> Option<String> {
        let s = self.shell();
        s.context.whisper_prompt(&s.store.vocabulary())
    }
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: delulu_stt::Language,
        prompt: Option<String>,
    ) -> Result<delulu_stt::Transcript, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.shell()
            .engine
            .send(EngineJob::Transcribe(samples, language, prompt, tx))
            .map_err(|_| "Engine thread stopped".to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    async fn clean(&self, language: &str, raw: String) -> cleanup::Cleaned {
        cleanup::clean(&self.app, language, raw).await
    }
    fn remember(&self, topic: Option<String>, text: &str) {
        context::remember(&self.app, topic, text);
    }
    fn add_history(&self, entry: NewEntry) -> Result<HistoryEntry, String> {
        self.shell()
            .store
            .add_history(entry)
            .map_err(|e| e.to_string())
    }
    async fn wait_release(&self) -> bool {
        let s = self.shell();
        wait_release(
            || {
                s.gesture
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .keys_down()
            },
            Duration::from_secs(3),
        )
        .await
    }
    async fn deliver(&self, text: &str, mode: InsertMode, held: bool) -> InsertResult {
        let s = self.shell();
        deliver(&s.inserter, text, mode, held, s.no_portals).await
    }
    fn last_release(&self) -> Option<Instant> {
        *self
            .shell()
            .last_release
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }
    fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, String> {
        self.shell()
            .store
            .set_total_ms(id, total_ms)
            .map_err(|e| e.to_string())
    }
    fn log(&self, line: String) {
        eprintln!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cleanup::{choose, CleanResult};
    use std::cell::{Cell, RefCell};

    const RAW: &str = "eh so the secret plan is ready";
    const CLEAN: &str = "So the secret plan is ready.";

    /// A scripted app: answers from the fields, records what the stop path did.
    struct Fake {
        recording: RefCell<Option<Recorded>>,
        transcript: RefCell<Option<Result<delulu_stt::Transcript, String>>>,
        cleanup: Cell<Option<CleanResult>>,
        history_error: Option<String>,
        released: bool,
        last_release: Option<Instant>,
        history: RefCell<Vec<HistoryEntry>>,
        delivered: RefCell<Vec<(String, bool)>>,
        remembered: RefCell<Vec<(Option<String>, String)>>,
        logs: RefCell<Vec<String>>,
    }

    fn fake(text: &str) -> Fake {
        Fake {
            recording: RefCell::new(Some(Ok(vec![0.0; 16]))),
            transcript: RefCell::new(Some(Ok(delulu_stt::Transcript {
                text: text.into(),
                language: "en".into(),
                audio_ms: 2400,
                elapsed_ms: 180,
            }))),
            cleanup: Cell::new(Some(CleanResult::Done(Some(delulu_cleanup::Cleaned {
                text: CLEAN.into(),
                topic: Some("work".into()),
            })))),
            history_error: None,
            released: true,
            last_release: None,
            history: RefCell::default(),
            delivered: RefCell::default(),
            remembered: RefCell::default(),
            logs: RefCell::default(),
        }
    }

    fn request() -> StopRequest {
        StopRequest {
            started: Instant::now(),
            was_held: false,
            log_text: false,
        }
    }

    impl StopPorts for Fake {
        async fn stop_recording(&self) -> Recorded {
            self.recording.take().expect("recorder stopped once")
        }
        fn settings(&self) -> Settings {
            Settings::default()
        }
        fn whisper_prompt(&self) -> Option<String> {
            None
        }
        async fn transcribe(
            &self,
            _: Vec<f32>,
            _: delulu_stt::Language,
            _: Option<String>,
        ) -> Result<delulu_stt::Transcript, String> {
            self.transcript.take().expect("transcribed once")
        }
        async fn clean(&self, _: &str, raw: String) -> cleanup::Cleaned {
            choose(raw, self.cleanup.take().expect("cleaned once"), 900)
        }
        fn remember(&self, topic: Option<String>, text: &str) {
            self.remembered.borrow_mut().push((topic, text.into()));
        }
        fn add_history(&self, e: NewEntry) -> Result<HistoryEntry, String> {
            if let Some(error) = &self.history_error {
                return Err(error.clone());
            }
            let entry = HistoryEntry {
                id: "h1".into(),
                created_at: 0,
                text: e.text,
                language: e.language,
                model: e.model,
                audio_ms: e.audio_ms,
                stt_ms: e.stt_ms,
                total_ms: e.total_ms,
                raw: e.raw,
                cleanup_ms: e.cleanup_ms,
                topic: e.topic,
            };
            self.history.borrow_mut().push(entry.clone());
            Ok(entry)
        }
        async fn wait_release(&self) -> bool {
            self.released
        }
        async fn deliver(&self, text: &str, _: InsertMode, held: bool) -> InsertResult {
            self.delivered.borrow_mut().push((text.into(), held));
            if held {
                InsertResult::Copied {
                    reason: Some("Hotkey still held".into()),
                }
            } else {
                InsertResult::Pasted
            }
        }
        fn last_release(&self) -> Option<Instant> {
            self.last_release
        }
        fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, String> {
            let mut history = self.history.borrow_mut();
            let entry = history.iter_mut().find(|e| e.id == id).ok_or("missing")?;
            entry.total_ms = total_ms;
            Ok(entry.clone())
        }
        fn log(&self, line: String) {
            self.logs.borrow_mut().push(line);
        }
    }

    fn delivered(outcome: StopOutcome) -> TranscriptEvent {
        match outcome {
            StopOutcome::Delivered(event) => event,
            StopOutcome::NothingHeard => panic!("expected a delivery, got Nothing heard"),
            StopOutcome::Failed { word, message } => {
                panic!("expected a delivery, got {word}: {message}")
            }
            StopOutcome::Unsaved { message, .. } => panic!("expected a delivery, got {message}"),
        }
    }

    #[tokio::test]
    async fn released_hotkey_types_the_cleaned_text_and_keeps_the_raw() {
        let app = fake(RAW);
        let event = delivered(run_stop(&app, request()).await);
        assert!(matches!(event.insert, InsertResult::Pasted));
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), false)]);
        let stored = &app.history.borrow()[0];
        assert_eq!(
            (stored.text.as_str(), stored.raw.as_deref()),
            (CLEAN, Some(RAW))
        );
        assert_eq!((stored.audio_ms, stored.stt_ms), (2400, 180));
        assert_eq!(event.entry.text, CLEAN);
        assert_eq!(
            *app.remembered.borrow(),
            [(Some("work".to_string()), CLEAN.to_string())]
        );
    }

    #[tokio::test]
    async fn hotkey_still_held_copies_and_counts_from_release() {
        let mut app = fake(RAW);
        app.released = false;
        let started = Instant::now() - Duration::from_secs(2);
        app.last_release = Some(started + Duration::from_millis(1500));
        let req = StopRequest {
            started,
            was_held: true,
            ..request()
        };
        let event = delivered(run_stop(&app, req).await);
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), true)]);
        assert!(matches!(event.insert, InsertResult::Copied { .. }));
        // From the release 0.5 s ago, not from the stop 2 s ago.
        let total = app.history.borrow()[0].total_ms;
        assert!((500..1500).contains(&total), "total {total} ms");
        assert_eq!(event.entry.total_ms, total);
    }

    #[tokio::test]
    async fn empty_transcript_is_nothing_heard() {
        let app = fake("");
        assert!(matches!(
            run_stop(&app, request()).await,
            StopOutcome::NothingHeard
        ));
        assert!(app.history.borrow().is_empty());
        assert!(app.delivered.borrow().is_empty());
    }

    #[tokio::test]
    async fn failures_end_in_error_without_typing() {
        let recorder = fake(RAW);
        recorder.recording.replace(Some(Err((
            "No microphone",
            "microphone not found: usb".into(),
        ))));
        let engine = fake(RAW);
        engine
            .transcript
            .replace(Some(Err("inference: out of memory".into())));
        for (app, want_word, want_message) in [
            (recorder, "No microphone", "microphone not found: usb"),
            (engine, "Not transcribed", "inference: out of memory"),
        ] {
            match run_stop(&app, request()).await {
                StopOutcome::Failed { word, message } => {
                    assert_eq!((word, message.as_str()), (want_word, want_message))
                }
                _ => panic!("{want_word}: expected a failure"),
            }
            assert!(app.delivered.borrow().is_empty(), "{want_word}");
            assert!(app.history.borrow().is_empty(), "{want_word}");
        }
    }

    #[tokio::test]
    async fn history_save_failure_still_types_the_text() {
        let mut app = fake(RAW);
        app.history_error = Some("store: disk full".into());
        match run_stop(&app, request()).await {
            StopOutcome::Unsaved { insert, message } => {
                assert!(matches!(insert, InsertResult::Pasted));
                assert_eq!(message, "Not saved to History: store: disk full");
            }
            _ => panic!("expected the text delivered and the save failure reported"),
        }
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), false)]);
    }

    #[tokio::test]
    async fn cleanup_failure_types_the_raw_text() {
        let app = fake(RAW);
        app.cleanup.set(Some(CleanResult::Failed));
        let event = delivered(run_stop(&app, request()).await);
        assert_eq!(*app.delivered.borrow(), [(RAW.to_string(), false)]);
        assert_eq!(
            (event.entry.text.as_str(), event.entry.raw.as_deref()),
            (RAW, None)
        );
    }

    #[tokio::test]
    async fn log_holds_dictated_text_only_when_opted_in() {
        let app = fake(RAW);
        delivered(run_stop(&app, request()).await);
        let logs = app.logs.take();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("audio=2400ms stt=180ms"), "{}", logs[0]);
        for text in [RAW, CLEAN, "secret"] {
            assert!(!logs[0].contains(text), "leaked {text:?}: {}", logs[0]);
        }

        let app = fake(RAW);
        let req = StopRequest {
            log_text: true,
            ..request()
        };
        delivered(run_stop(&app, req).await);
        let logs = app.logs.take();
        assert!(
            logs[0].contains(RAW) && logs[0].contains(CLEAN),
            "{}",
            logs[0]
        );

        assert!(text_logging(Some("1")));
        assert!(!text_logging(None) && !text_logging(Some("0")));
    }

    #[test]
    fn total_counts_from_release_only_after_a_toggle() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let release = Some(at(300));
        assert_eq!(total_ms(start, false, release, at(1000)), 1000);
        assert_eq!(total_ms(start, true, release, at(1000)), 700);
        assert_eq!(total_ms(start, true, None, at(1000)), 1000);
        // A release stamped after `now` never underflows.
        assert_eq!(total_ms(start, true, Some(at(2000)), at(1000)), 0);
    }
}
