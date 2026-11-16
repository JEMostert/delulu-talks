use super::*;
pub(crate) use delulu_dictation::stop::*;

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
    fn whisper_prompt(&self) -> Option<delulu_stt::Prompt> {
        let s = self.shell();
        s.context.whisper_prompt(&s.store.vocabulary())
    }
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: delulu_stt::Language,
        prompt: Option<delulu_stt::Prompt>,
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
