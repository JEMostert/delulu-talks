use super::*;

/// The model to load: the selected one, or else any downloaded one, so dictation
/// keeps working while a newly picked model is still downloading.
pub(crate) fn ready_model(dir: &std::path::Path, selected: &str) -> Option<String> {
    std::iter::once(selected)
        .chain(delulu_stt::models().iter().map(|m| m.id))
        .find(|id| delulu_stt::is_downloaded(dir, id))
        .map(str::to_string)
}
pub(crate) fn load_model(app: &tauri::AppHandle, id: String) {
    // Whisper loads first; cleanup frees the GPU and reloads once it has settled.
    cleanup::whisper_loading(app);
    let message = match delulu_stt::model_info(&id).map(|m| m.engine) {
        Some(delulu_stt::EngineKind::Parakeet) => "Loading Parakeet",
        _ => "Preparing GPU (first run only)",
    };
    phase(app, "loadingModel", Some(message.into()));
    if app
        .state::<Shell>()
        .engine
        .send(EngineJob::Load(id))
        .is_err()
    {
        phase(app, "error", Some("Engine thread stopped".into()));
    }
}
pub(crate) fn engine_thread(app: tauri::AppHandle, rx: mpsc::Receiver<EngineJob>) {
    let mut engine: Option<delulu_stt::Engine> = None;
    for job in rx {
        match job {
            EngineJob::Load(id) => {
                cleanup::wait_released(&app, Duration::from_secs(5));
                let dir = app.state::<Shell>().store.models_dir();
                // Drop the old model first so two never sit in memory at once.
                drop(engine.take());
                let result = delulu_stt::Engine::load(&dir, &id).map_err(|e| e.to_string());
                match result {
                    Ok(e) => {
                        let backend = e.backend();
                        engine = Some(e);
                        update(&app, |s| {
                            s.backend = Some(backend);
                            s.model = Some(id);
                            s.message = None;
                            s.phase = ready_phase(&app.state::<Shell>()).into();
                        });
                        if app
                            .state::<Shell>()
                            .pending_toggle
                            .swap(false, Ordering::SeqCst)
                        {
                            event(&app, KeyEvent::Activated);
                        }
                        cleanup::whisper_settled(&app);
                    }
                    Err(e) => {
                        engine = None;
                        update(&app, |s| {
                            s.model = None;
                            s.backend = None;
                        });
                        if !delulu_stt::is_downloaded(&dir, &id) {
                            phase(&app, "needsSetup", None);
                        } else {
                            phase(&app, "error", Some(e));
                        }
                        cleanup::whisper_settled(&app);
                    }
                }
            }
            EngineJob::Transcribe(samples, language, prompt, reply) => {
                let result = engine
                    .as_mut()
                    .ok_or_else(|| "Model is not loaded".to_string())
                    .and_then(|e| {
                        e.transcribe(
                            &samples,
                            &delulu_stt::Language::from_setting(&language),
                            prompt.as_deref(),
                        )
                        .map_err(|e| e.to_string())
                    });
                let _ = reply.send(result);
            }
        }
    }
}
