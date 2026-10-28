use super::*;

pub(crate) fn load_model(app: &tauri::AppHandle, id: String) {
    // Whisper loads first; cleanup frees the GPU and reloads once it has settled.
    cleanup::whisper_loading(app);
    phase(
        app,
        "loadingModel",
        Some("Preparing GPU (first run only)".into()),
    );
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
                let dir = app.state::<Shell>().store.models_dir();
                let result = delulu_stt::model_path(&dir, &id)
                    .ok_or_else(|| "Unknown model".to_string())
                    .and_then(|path| delulu_stt::Engine::load(&path).map_err(|e| e.to_string()));
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
            EngineJob::Transcribe(samples, language, reply) => {
                let result = engine
                    .as_mut()
                    .ok_or_else(|| "Model is not loaded".to_string())
                    .and_then(|e| {
                        e.transcribe(&samples, &delulu_stt::Language::from_setting(&language))
                            .map_err(|e| e.to_string())
                    });
                let _ = reply.send(result);
            }
        }
    }
}
