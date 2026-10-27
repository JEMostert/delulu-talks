use super::*;

pub(crate) fn event(app: &tauri::AppHandle, ev: KeyEvent) {
    let received_at = Instant::now();
    let shell = app.state::<Shell>();
    let command = {
        let mut gesture = shell.gesture.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(ev, KeyEvent::Released) && gesture.keys_down() {
            *shell.last_release.lock().unwrap_or_else(|e| e.into_inner()) = Some(received_at);
        }
        let current = status_value(&shell).phase;
        if current == "transcribing" && !matches!(ev, KeyEvent::Released) {
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
    let app2 = app.clone();
    match s.recorder.start(
        s.store.settings().microphone.as_deref(),
        Box::new(move |level| {
            let _ = app2.emit("mic-level", level);
        }),
    ) {
        Ok(()) => phase(app, "recording", None),
        Err(e) => {
            s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
            phase(app, "error", Some(e.to_string()));
        }
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
    let started = stopped_at;
    let was_held = s
        .gesture
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys_down();
    *s.last_release.lock().unwrap_or_else(|e| e.into_inner()) = None;
    phase(app, "transcribing", None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = started;
        let app2 = app.clone();
        let clip = tokio::task::spawn_blocking(move || app2.state::<Shell>().recorder.stop()).await;
        let clip = match clip {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                phase(&app, "error", Some(e.to_string()));
                return;
            }
            Err(e) => {
                phase(&app, "error", Some(e.to_string()));
                return;
            }
        };
        let s = app.state::<Shell>();
        let settings = s.store.settings();
        let (tx, rx) = tokio::sync::oneshot::channel();
        if s.engine
            .send(EngineJob::Transcribe(
                clip.samples,
                settings.language.clone(),
                tx,
            ))
            .is_err()
        {
            phase(&app, "error", Some("Engine thread stopped".into()));
            return;
        }
        let transcript = match rx.await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                phase(&app, "error", Some(e));
                return;
            }
            Err(e) => {
                phase(&app, "error", Some(e.to_string()));
                return;
            }
        };
        if !transcript.text.is_empty() {
            let entry = s.store.add_history(NewEntry {
                text: transcript.text.clone(),
                language: transcript.language.clone(),
                model: settings.model,
                audio_ms: transcript.audio_ms,
                stt_ms: transcript.elapsed_ms,
                total_ms: start.elapsed().as_millis() as u64,
            });
            match entry {
                Ok(entry) => {
                    let released = wait_release(
                        || {
                            s.gesture
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .keys_down()
                        },
                        Duration::from_secs(3),
                    )
                    .await;
                    let delivery_start = Instant::now();
                    let insert = deliver(
                        &s.inserter,
                        &transcript.text,
                        settings.insert,
                        !released,
                        s.no_portals,
                    )
                    .await;
                    let release = if was_held {
                        *s.last_release.lock().unwrap_or_else(|e| e.into_inner())
                    } else {
                        Some(start)
                    };
                    let total_ms = release.unwrap_or(start).elapsed().as_millis() as u64;
                    let entry = match s.store.set_total_ms(&entry.id, total_ms) {
                        Ok(updated) => updated,
                        Err(e) => {
                            eprintln!("save delivery timing: {e}");
                            entry
                        }
                    };
                    eprintln!(
                        "dictation audio={}ms stt={}ms insert={}ms total={}ms lang={} transcript={:?} history={}",
                        transcript.audio_ms,
                        transcript.elapsed_ms,
                        delivery_start.elapsed().as_millis(),
                        start.elapsed().as_millis(),
                        transcript.language, entry.text, entry.id
                    );
                    let _ = app.emit("transcript", TranscriptEvent { entry, insert });
                }
                Err(e) => {
                    phase(&app, "error", Some(e.to_string()));
                    return;
                }
            }
        }
        s.gesture.lock().unwrap_or_else(|e| e.into_inner()).reset();
        phase(&app, ready_phase(&s), None);
    });
}
