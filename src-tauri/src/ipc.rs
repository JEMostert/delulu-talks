use super::*;

#[tauri::command]
pub(crate) fn get_status(s: State<'_, Shell>) -> Status {
    status_value(&s)
}
/// Settings as the UI sees them, with the first-run flag from the app state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    first_run_done: bool,
}
fn settings_view(s: &Shell, settings: Settings) -> SettingsView {
    SettingsView {
        settings,
        first_run_done: s.store.state().first_run_done,
    }
}
#[tauri::command]
pub(crate) fn get_settings(s: State<'_, Shell>) -> SettingsView {
    settings_view(&s, s.store.settings())
}
#[derive(Debug, PartialEq)]
pub(crate) struct SettingsDiff {
    pub(crate) model: bool,
    pub(crate) autostart: bool,
    pub(crate) cleanup: bool,
}
pub(crate) fn settings_diff(old: &Settings, new: &Settings) -> SettingsDiff {
    SettingsDiff {
        model: old.model != new.model,
        autostart: old.start_at_login != new.start_at_login,
        cleanup: old.cleanup != new.cleanup,
    }
}
pub(crate) fn apply_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())?;
    }
    #[cfg(debug_assertions)]
    {
        let _ = (app, enabled);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn set_settings(
    app: tauri::AppHandle,
    s: State<'_, Shell>,
    mut settings: Settings,
) -> Result<SettingsView, String> {
    let old = s.store.settings();
    // Internal flag: the app owns it, so a stale UI copy can't reset it.
    settings.cleanup_model_ok = old.cleanup_model_ok;
    let diff = settings_diff(&old, &settings);
    if diff.model
        && matches!(
            status_value(&s).phase.as_str(),
            "recording" | "transcribing" | "loadingModel"
        )
    {
        return Err("Wait for dictation or model loading to finish".into());
    }
    s.store
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
    if diff.autostart {
        apply_autostart(&app, settings.start_at_login)?;
    }
    if !settings.overlay {
        s.pill.hide();
    }
    // A model that isn't downloaded yet loads when its download finishes; until
    // then the current one keeps working.
    if diff.model && delulu_stt::is_downloaded(&s.store.models_dir(), &settings.model) {
        load_model(&app, settings.model.clone());
    }
    if diff.cleanup {
        cleanup::sync(&app);
    }
    if !settings.smart_context {
        context::clear(&app);
    }
    Ok(settings_view(&s, settings))
}
#[tauri::command]
pub(crate) fn list_microphones() -> Result<Vec<delulu_audio::InputDevice>, String> {
    delulu_audio::list_inputs().map_err(|e| e.to_string())
}
#[derive(Serialize)]
pub(crate) struct Language {
    code: &'static str,
    name: &'static str,
}
#[tauri::command]
pub(crate) fn list_languages() -> Vec<Language> {
    delulu_stt::languages()
        .into_iter()
        .map(|(code, name)| Language { code, name })
        .collect()
}
#[tauri::command]
pub(crate) fn start_mic_test(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
    if matches!(
        status_value(&s).phase.as_str(),
        "recording" | "transcribing"
    ) {
        return Err("Dictation is in progress".into());
    }
    if s.mic.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let app2 = app.clone();
    if let Err(e) = s.recorder.start(
        s.store.settings().microphone.as_deref(),
        Box::new(move |level| {
            let _ = app2.emit("mic-level", level);
        }),
    ) {
        s.mic.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn stop_mic_test(s: State<'_, Shell>) {
    if s.mic.swap(false, Ordering::SeqCst) {
        s.recorder.cancel();
    }
}
#[tauri::command]
pub(crate) fn start_dictation(app: tauri::AppHandle) {
    start(&app);
}
#[tauri::command]
pub(crate) fn stop_dictation(app: tauri::AppHandle) {
    stop(&app, Instant::now());
}
pub(crate) async fn bind_hotkey(app: &tauri::AppHandle) {
    let shell = app.state::<Shell>();
    if shell.no_portals {
        return;
    }
    let mut guard = shell.hotkey.lock().await;
    if guard.is_some() {
        return;
    }
    let callback_app = app.clone();
    let (hotkey, status) = Hotkey::bind(
        delulu_hotkey::DEFAULT_TRIGGER,
        shell.events.clone(),
        Box::new(move |status| update(&callback_app, |s| s.hotkey = status)),
    )
    .await;
    *guard = hotkey;
    update(app, |s| s.hotkey = status);
}
#[tauri::command]
pub(crate) async fn prepare_insert(app: tauri::AppHandle) -> delulu_insert::InsertStatus {
    let shell = app.state::<Shell>();
    if shell.no_portals {
        return status_value(&shell).insert;
    }
    bind_hotkey(&app).await;
    let status = shell.inserter.prepare().await;
    update(&app, |s| s.insert = status.clone());
    status
}
#[tauri::command]
pub(crate) async fn change_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    let s = app.state::<Shell>();
    if s.no_portals {
        return Err("Hotkey is unavailable".into());
    }
    {
        let mut hotkey = s.hotkey.lock().await;
        if let Some(h) = hotkey.as_ref().filter(|h| h.status().bound) {
            return h.configure().await;
        }
        // Skipped or declined during first run: drop the unbound session and bind again.
        if let Some(h) = hotkey.take() {
            h.close().await;
        }
    }
    bind_hotkey(&app).await;
    Ok(())
}
#[tauri::command]
pub(crate) fn get_history(
    s: State<'_, Shell>,
    query: Option<String>,
    limit: usize,
) -> Vec<HistoryEntry> {
    s.store.history(query.as_deref(), limit)
}
#[tauri::command]
pub(crate) fn delete_history(s: State<'_, Shell>, id: String) -> Result<(), String> {
    s.store.delete_history(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn clear_history(s: State<'_, Shell>) -> Result<(), String> {
    s.store.clear_history().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn copy_text(s: State<'_, Shell>, text: String) -> Result<(), String> {
    s.inserter.copy(&text).map_err(|e| e.to_string())
}
#[tauri::command]
/// `raw` inserts what was said before cleanup, when the entry has it.
pub(crate) async fn reinsert(app: tauri::AppHandle, id: String, raw: Option<bool>) -> InsertResult {
    let s = app.state::<Shell>();
    let entry = s
        .store
        .history(None, usize::MAX)
        .into_iter()
        .find(|e| e.id == id);
    if let Some(entry) = entry {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let text = match (raw, &entry.raw) {
            (Some(true), Some(raw)) => raw,
            _ => &entry.text,
        };
        deliver(
            &s.inserter,
            text,
            s.store.settings().insert,
            false,
            s.no_portals,
        )
        .await
    } else {
        InsertResult::Failed {
            reason: "Transcript not found".into(),
        }
    }
}
#[tauri::command]
pub(crate) fn finish_first_run(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
    let mut state = s.store.state();
    state.first_run_done = true;
    s.store.save_state(&state).map_err(|e| e.to_string())?;
    // The first-run Model step disclosed the cleanup download.
    let mut settings = s.store.settings();
    settings.cleanup_model_ok = true;
    s.store
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
    if status_value(&s).model.is_some() {
        phase(&app, "idle", None);
    }
    cleanup::sync(&app);
    Ok(())
}
