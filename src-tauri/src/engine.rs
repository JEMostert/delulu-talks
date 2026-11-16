use super::*;
use delulu_dictation::stt::EngineHost;
pub(crate) use delulu_dictation::stt::{ready_model, EngineJob};

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
    delulu_dictation::stt::engine_thread(AppEngine(app), rx);
}

/// The engine thread's view of the app.
struct AppEngine(tauri::AppHandle);
impl EngineHost for AppEngine {
    fn models_dir(&self) -> std::path::PathBuf {
        self.0.state::<Shell>().store.models_dir()
    }
    fn before_load(&self) {
        cleanup::wait_released(&self.0, Duration::from_secs(5));
    }
    fn loaded(&self, id: String, result: Result<String, String>) {
        let app = &self.0;
        match result {
            Ok(backend) => {
                update(app, |s| {
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
                    event(app, KeyEvent::Activated);
                }
                cleanup::whisper_settled(app);
            }
            Err(e) => {
                update(app, |s| {
                    s.model = None;
                    s.backend = None;
                });
                if !delulu_stt::is_downloaded(&self.models_dir(), &id) {
                    phase(app, "needsSetup", None);
                } else {
                    phase(app, "error", Some(e));
                }
                cleanup::whisper_settled(app);
            }
        }
    }
    fn recovered(&self, id: String, result: Result<String, String>) {
        match result {
            // Ready again; the phase stays as the dictation left it, so its error
            // (the engine stopped) remains visible.
            Ok(backend) => update(&self.0, |s| {
                s.backend = Some(backend);
                s.model = Some(id);
            }),
            // The model stays chosen, so the error phase still lets a dictation start,
            // and that dictation tries the engine again.
            Err(e) => {
                update(&self.0, |s| s.model = Some(id));
                phase(&self.0, "error", Some(e));
            }
        }
    }
}
