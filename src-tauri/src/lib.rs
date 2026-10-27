use delulu_hotkey::{Command, Gesture, Hotkey, KeyEvent};
use delulu_insert::{InsertOutcome, Inserter, PasteKey};
use delulu_store::{HistoryEntry, InsertMode, NewEntry, Settings, Store};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    phase: String,
    message: Option<String>,
    hotkey: delulu_hotkey::HotkeyStatus,
    insert: delulu_insert::InsertStatus,
    backend: Option<String>,
    model: Option<String>,
}
struct Shell {
    store: Arc<Store>,
    status: Mutex<Status>,
    recorder: delulu_audio::Recorder,
    inserter: Inserter,
    hotkey: tokio::sync::Mutex<Option<Hotkey>>,
    gesture: Mutex<Gesture>,
    engine: mpsc::Sender<EngineJob>,
    download: Arc<AtomicBool>,
    downloading: Arc<AtomicBool>,
    stub_downloaded: Mutex<std::collections::HashSet<String>>,
    mic: AtomicBool,
}
enum EngineJob {
    Load(String),
    Transcribe(
        Vec<f32>,
        String,
        tokio::sync::oneshot::Sender<Result<delulu_stt::Transcript, String>>,
    ),
}
fn status_value(s: &Shell) -> Status {
    s.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut Status)) {
    let s = app.state::<Shell>();
    let value = {
        let mut status = s.status.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut status);
        status.clone()
    };
    eprintln!(
        "status {}{}",
        value.phase,
        value
            .message
            .as_deref()
            .map(|m| format!(": {m}"))
            .unwrap_or_default()
    );
    let _ = app.emit("status", value.clone());
    tray::set_icon(app, &value.phase);
}
fn phase(app: &tauri::AppHandle, value: &str, message: Option<String>) {
    update(app, |s| {
        s.phase = value.into();
        s.message = message;
    });
}
fn ready_phase(s: &Shell) -> &'static str {
    if s.store.state().first_run_done {
        "idle"
    } else {
        "needsSetup"
    }
}
fn load_model(app: &tauri::AppHandle, id: String) {
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
fn engine_thread(app: tauri::AppHandle, rx: mpsc::Receiver<EngineJob>) {
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
                        if backend == "Stub"
                            && std::env::var("DELULU_STUB_FIRST_RUN").as_deref() != Ok("1")
                        {
                            let shell = app.state::<Shell>();
                            let mut state = shell.store.state();
                            state.first_run_done = true;
                            let _ = shell.store.save_state(&state);
                        }
                        engine = Some(e);
                        update(&app, |s| {
                            s.backend = Some(backend);
                            s.model = Some(id);
                            s.message = None;
                            s.phase = ready_phase(&app.state::<Shell>()).into();
                        });
                    }
                    Err(e) => {
                        engine = None;
                        let shell = app.state::<Shell>();
                        if !shell.store.state().first_run_done
                            && !delulu_stt::is_downloaded(&dir, &id)
                        {
                            phase(&app, "needsSetup", None);
                        } else {
                            phase(&app, "error", Some(e));
                        }
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
fn event(app: &tauri::AppHandle, ev: KeyEvent) {
    let shell = app.state::<Shell>();
    let command = {
        let mut gesture = shell.gesture.lock().unwrap_or_else(|e| e.into_inner());
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
        Some(Command::Stop) => stop(app),
        None => {}
    }
}
fn start(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    if status_value(&s).phase != "idle" {
        return;
    }
    if s.mic.load(Ordering::SeqCst) {
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
enum InsertResult {
    Pasted,
    Copied { reason: Option<String> },
    Failed { reason: String },
}
#[derive(Clone, Serialize)]
struct TranscriptEvent {
    entry: HistoryEntry,
    insert: InsertResult,
}
fn paste_key(mode: InsertMode) -> Option<PasteKey> {
    match mode {
        InsertMode::ShiftInsert => Some(PasteKey::ShiftInsert),
        InsertMode::CtrlV => Some(PasteKey::CtrlV),
        InsertMode::CtrlShiftV => Some(PasteKey::CtrlShiftV),
        InsertMode::Off => None,
    }
}
async fn deliver(inserter: &Inserter, text: &str, mode: InsertMode, held: bool) -> InsertResult {
    if held || mode == InsertMode::Off {
        return match inserter.copy(text) {
            Ok(()) => InsertResult::Copied {
                reason: held.then(|| "Hotkey still held".into()),
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
async fn wait_release(mut down: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while down() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}
fn stop(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    if status_value(&s).phase != "recording" {
        return;
    }
    phase(app, "transcribing", None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
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
                    let insert =
                        deliver(&s.inserter, &transcript.text, settings.insert, !released).await;
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
        phase(&app, ready_phase(&s), None);
    });
}
#[tauri::command]
fn get_status(s: State<'_, Shell>) -> Status {
    status_value(&s)
}
#[tauri::command]
fn get_settings(s: State<'_, Shell>) -> Settings {
    s.store.settings()
}
#[derive(Debug, PartialEq)]
struct SettingsDiff {
    model: bool,
    autostart: bool,
}
fn settings_diff(old: &Settings, new: &Settings) -> SettingsDiff {
    SettingsDiff {
        model: old.model != new.model,
        autostart: old.start_at_login != new.start_at_login,
    }
}
fn apply_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
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
fn set_settings(
    app: tauri::AppHandle,
    s: State<'_, Shell>,
    settings: Settings,
) -> Result<Settings, String> {
    let diff = settings_diff(&s.store.settings(), &settings);
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
    if diff.model {
        load_model(&app, settings.model.clone());
    }
    Ok(settings)
}
#[tauri::command]
fn list_microphones() -> Result<Vec<delulu_audio::InputDevice>, String> {
    delulu_audio::list_inputs().map_err(|e| e.to_string())
}
#[derive(Serialize)]
struct Language {
    code: &'static str,
    name: &'static str,
}
#[tauri::command]
fn list_languages() -> Vec<Language> {
    delulu_stt::languages()
        .into_iter()
        .map(|(code, name)| Language { code, name })
        .collect()
}
#[derive(Serialize)]
struct ModelStatus {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    downloaded: bool,
}
#[tauri::command]
fn list_models(s: State<'_, Shell>) -> Vec<ModelStatus> {
    delulu_stt::models()
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            label: m.label,
            bytes: m.bytes,
            downloaded: delulu_stt::is_downloaded(&s.store.models_dir(), m.id)
                || s.stub_downloaded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(m.id),
        })
        .collect()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    done_bytes: u64,
    total_bytes: u64,
    finished: bool,
    error: Option<String>,
}
#[tauri::command]
fn download_model(app: tauri::AppHandle, s: State<'_, Shell>, id: String) -> Result<(), String> {
    let total = delulu_stt::model_info(&id).ok_or("Unknown model")?.bytes;
    if s.downloading.swap(true, Ordering::SeqCst) {
        return Err("Download already in progress".into());
    }
    let cancel = s.download.clone();
    cancel.store(false, Ordering::SeqCst);
    let downloading = s.downloading.clone();
    let dir = s.store.models_dir();
    tauri::async_runtime::spawn_blocking(move || {
        // The public download API uses true to request cancellation.
        let mut progress = |done, total| {
            let _ = app.emit(
                "model-download",
                Progress {
                    id: id.clone(),
                    done_bytes: done,
                    total_bytes: total,
                    finished: false,
                    error: None,
                },
            );
        };
        let result = delulu_stt::download(&dir, &id, &mut progress, &cancel);
        let stub = matches!(&result, Err(delulu_stt::SttError::Download(message)) if message == "Stub download");
        if stub {
            for i in 0..=60 {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                progress(total * i / 60, total);
                std::thread::sleep(Duration::from_millis(50));
            }
            if !cancel.load(Ordering::SeqCst) {
                app.state::<Shell>()
                    .stub_downloaded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone());
            }
        }
        downloading.store(false, Ordering::SeqCst);
        let (finished, error) = if stub && !cancel.load(Ordering::SeqCst) {
            (true, None)
        } else {
            match result {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e.to_string())),
            }
        };
        let _ = app.emit(
            "model-download",
            Progress {
                id: id.clone(),
                done_bytes: if finished { total } else { 0 },
                total_bytes: total,
                finished,
                error,
            },
        );
        if finished && app.state::<Shell>().store.settings().model == id {
            load_model(&app, id);
        }
    });
    Ok(())
}
#[tauri::command]
fn cancel_download(s: State<'_, Shell>) {
    s.download.store(true, Ordering::SeqCst);
}
#[tauri::command]
fn start_mic_test(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
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
    if status_value(&s).backend.as_deref() == Some("Stub")
        || std::env::var("DELULU_STUB_FIRST_RUN").as_deref() == Ok("1")
    {
        tauri::async_runtime::spawn(async move {
            let mut n: f32 = 0.0;
            while app.state::<Shell>().mic.load(Ordering::SeqCst) {
                let _ = app.emit("mic-level", (n.sin() + 1.0) / 2.0);
                n += 0.3;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
    }
    Ok(())
}
#[tauri::command]
fn stop_mic_test(s: State<'_, Shell>) {
    if s.mic.swap(false, Ordering::SeqCst) {
        s.recorder.cancel();
    }
}
#[tauri::command]
fn start_dictation(app: tauri::AppHandle) {
    start(&app);
}
#[tauri::command]
fn stop_dictation(app: tauri::AppHandle) {
    stop(&app);
}
#[tauri::command]
async fn prepare_insert(app: tauri::AppHandle) -> delulu_insert::InsertStatus {
    let status = app.state::<Shell>().inserter.prepare().await;
    update(&app, |s| s.insert = status.clone());
    status
}
#[tauri::command]
async fn change_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    let s = app.state::<Shell>();
    let hotkey = s.hotkey.lock().await;
    match hotkey.as_ref() {
        Some(h) => h.configure().await,
        None => Err("Hotkey is unavailable".into()),
    }
}
#[tauri::command]
fn get_history(s: State<'_, Shell>, query: Option<String>, limit: usize) -> Vec<HistoryEntry> {
    s.store.history(query.as_deref(), limit)
}
#[tauri::command]
fn delete_history(s: State<'_, Shell>, id: String) -> Result<(), String> {
    s.store.delete_history(&id).map_err(|e| e.to_string())
}
#[tauri::command]
fn clear_history(s: State<'_, Shell>) -> Result<(), String> {
    s.store.clear_history().map_err(|e| e.to_string())
}
#[tauri::command]
fn copy_text(s: State<'_, Shell>, text: String) -> Result<(), String> {
    s.inserter.copy(&text).map_err(|e| e.to_string())
}
#[tauri::command]
async fn reinsert(app: tauri::AppHandle, id: String) -> InsertResult {
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
        deliver(&s.inserter, &entry.text, s.store.settings().insert, false).await
    } else {
        InsertResult::Failed {
            reason: "Transcript not found".into(),
        }
    }
}
#[tauri::command]
fn finish_first_run(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
    let mut state = s.store.state();
    state.first_run_done = true;
    s.store.save_state(&state).map_err(|e| e.to_string())?;
    phase(&app, "idle", None);
    Ok(())
}
mod tray;
pub fn run() {
    let store = Arc::new(Store::open_default().expect("open store"));
    let initial_state = store.state();
    let save_store = store.clone();
    let inserter = Inserter::new(
        initial_state.remote_desktop_token,
        Box::new(move |token| {
            let mut state = save_store.state();
            state.remote_desktop_token = token;
            if let Err(e) = save_store.save_state(&state) {
                eprintln!("save insertion token: {e}");
            }
        }),
    );
    let (tx, rx) = mpsc::channel();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--toggle") {
                event(app, KeyEvent::Activated);
            } else if !args.iter().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .manage(Shell {
            store,
            status: Mutex::new(Status {
                phase: "needsSetup".into(),
                message: None,
                hotkey: Default::default(),
                insert: Default::default(),
                backend: None,
                model: None,
            }),
            recorder: delulu_audio::Recorder::new(),
            inserter,
            hotkey: tokio::sync::Mutex::new(None),
            gesture: Mutex::new(Gesture::new()),
            engine: tx,
            download: Arc::new(AtomicBool::new(false)),
            downloading: Arc::new(AtomicBool::new(false)),
            stub_downloaded: Mutex::new(std::collections::HashSet::new()),
            mic: AtomicBool::new(false),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::create(app)?;
            let s = app.state::<Shell>();
            let settings = s.store.settings();
            apply_autostart(&handle, settings.start_at_login).map_err(std::io::Error::other)?;
            let engine_app = handle.clone();
            std::thread::spawn(move || engine_thread(engine_app, rx));
            let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let hot_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let callback_app = hot_app.clone();
                let (hotkey, status) = Hotkey::bind(
                    delulu_hotkey::DEFAULT_TRIGGER,
                    events,
                    Box::new(move |status| update(&callback_app, |s| s.hotkey = status)),
                )
                .await;
                *hot_app.state::<Shell>().hotkey.lock().await = hotkey;
                update(&hot_app, |s| s.hotkey = status);
                while let Some(ev) = receiver.recv().await {
                    event(&hot_app, ev);
                }
            });
            if initial_state.first_run_done {
                let a = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = prepare_insert(a).await;
                });
            }
            // The stub engine accepts a missing path; real engines reject it. This lets the
            // skeleton exercise dictation without a model while real first run stays gated.
            if delulu_stt::is_downloaded(&s.store.models_dir(), &settings.model)
                || (cfg!(debug_assertions)
                    && std::env::var("DELULU_STUB_FIRST_RUN").as_deref() != Ok("1"))
            {
                load_model(&handle, settings.model);
            } else {
                phase(&handle, ready_phase(&s), None);
            }
            if !std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_settings,
            set_settings,
            list_microphones,
            list_languages,
            list_models,
            download_model,
            cancel_download,
            start_mic_test,
            stop_mic_test,
            start_dictation,
            stop_dictation,
            prepare_insert,
            change_hotkey,
            get_history,
            delete_history,
            clear_history,
            copy_text,
            reinsert,
            finish_first_run
        ])
        .run(tauri::generate_context!())
        .expect("Tauri failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_only_relevant_settings_changes() {
        let old = Settings::default();
        let mut new = old.clone();
        new.language = "nl".into();
        assert_eq!(
            settings_diff(&old, &new),
            SettingsDiff {
                model: false,
                autostart: false
            }
        );
        new.model = "small".into();
        new.start_at_login = false;
        assert_eq!(
            settings_diff(&old, &new),
            SettingsDiff {
                model: true,
                autostart: true
            }
        );
    }
    #[tokio::test]
    async fn waits_for_release_and_times_out() {
        let mut polls = 0;
        assert!(
            wait_release(
                || {
                    polls += 1;
                    polls < 3
                },
                Duration::from_millis(100)
            )
            .await
        );
        assert!(!wait_release(|| true, Duration::from_millis(15)).await);
        assert!(wait_release(|| false, Duration::ZERO).await);
    }
}
