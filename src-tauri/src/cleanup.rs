//! Transcript cleanup in the app: the shared [`Supervisor`] over the app's settings,
//! plus its commands. Every miss falls back to the raw Whisper text; dictation never
//! waits for cleanup.
use super::*;
use delulu_dictation::cleanup::GenerateError;
pub(crate) use delulu_dictation::cleanup::{
    Cleaned, CleanupStatus, Supervisor, Want, CLEANUP_MODEL,
};

/// The supervisor publishes before the app exists; status changes go to the window
/// once `setup` has stored the handle here.
pub(crate) type AppSlot = Arc<std::sync::OnceLock<tauri::AppHandle>>;

pub(crate) fn supervisor(
    store: &Store,
    enabled: bool,
    file_ready: bool,
    slot: AppSlot,
) -> Arc<Supervisor> {
    Supervisor::new(
        enabled,
        file_ready,
        store.models_dir(),
        Box::new(move |status| {
            if let Some(app) = slot.get() {
                let _ = app.emit("cleanup-status", status);
            }
        }),
    )
}

fn want(s: &Shell) -> Want {
    let settings = s.store.settings();
    Want {
        // Delulu FM's writer uses the same helper while the station is on air.
        enabled: settings.cleanup || s.radio_writer.load(Ordering::SeqCst),
        first_run_done: s.store.state().first_run_done,
        model_ok: settings.cleanup_model_ok,
        file_ready: delulu_stt::file_ready(&s.store.models_dir(), &CLEANUP_MODEL),
    }
}
/// Bring the helper and download in line with the settings.
pub(crate) fn sync(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    s.cleanup.sync(want(&s));
}
/// `start_cleanup`: load the helper, or download the model first.
pub(crate) fn start(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    s.cleanup.start(want(&s));
}
pub(crate) fn cancel_download(app: &tauri::AppHandle) {
    app.state::<Shell>().cleanup.cancel_download();
}
/// Called before Whisper loads a model; cleanup waits until it has settled.
pub(crate) fn whisper_loading(app: &tauri::AppHandle) {
    app.state::<Shell>().cleanup.whisper_loading();
}
/// Blocks until no cleanup helper process is alive (or `timeout` passes), so Whisper
/// never competes with a retired helper for GPU memory. Call it off the main thread.
pub(crate) fn wait_released(app: &tauri::AppHandle, timeout: Duration) {
    app.state::<Shell>().cleanup.wait_released(timeout);
}
/// Called when Whisper finished loading or failed.
pub(crate) fn whisper_settled(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    s.cleanup.whisper_settled(want(&s));
}

/// Clean one transcript if the helper is ready right now; never waits for it.
pub(crate) async fn clean(app: &tauri::AppHandle, language: &str, raw: String) -> Cleaned {
    let s = app.state::<Shell>();
    let enabled = s.store.settings().cleanup;
    s.cleanup
        .clean(enabled, language, raw, || {
            s.store.vocabulary().active_terms()
        })
        .await
}

/// Delulu FM's writer: borrow the idle helper for one prompt. Dictation never waits for
/// it; while the radio holds the helper a dictation keeps its raw text.
pub(crate) fn generate(
    app: &tauri::AppHandle,
    prompt: String,
    max_tokens: u32,
    sampling: delulu_cleanup::Sampling,
    timeout: Duration,
) -> Result<String, delulu_radio::RadioError> {
    use delulu_radio::RadioError;
    app.state::<Shell>()
        .cleanup
        .generate(prompt, max_tokens, sampling, timeout)
        .map_err(|e| match e {
            GenerateError::Busy => RadioError::Busy,
            GenerateError::Unavailable(message) => RadioError::Unavailable(message),
            GenerateError::Writer(message) => RadioError::Writer(message),
        })
}

#[tauri::command]
pub(crate) fn get_cleanup_status(s: State<'_, Shell>) -> CleanupStatus {
    s.cleanup.status()
}
#[tauri::command]
pub(crate) fn start_cleanup(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
    let mut settings = s.store.settings();
    if !settings.cleanup_model_ok {
        settings.cleanup_model_ok = true;
        s.store
            .save_settings(&settings)
            .map_err(|e| e.to_string())?;
    }
    start(&app);
    Ok(())
}
#[tauri::command]
pub(crate) fn cancel_cleanup_download(app: tauri::AppHandle) {
    cancel_download(&app);
}
