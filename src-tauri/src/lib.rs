use delulu_store::{HistoryEntry, NewEntry, Settings, Store};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
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
    store: Store,
    status: Mutex<Status>,
    mic: AtomicBool,
    download: AtomicBool,
    downloaded: Mutex<std::collections::HashSet<String>>,
}
fn status_value(s: &Shell) -> Status {
    s.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
fn phase(app: &tauri::AppHandle, s: &Shell, value: &str) {
    s.status.lock().unwrap_or_else(|e| e.into_inner()).phase = value.into();
    let _ = app.emit("status", status_value(s));
}
#[tauri::command]
fn get_status(s: State<'_, Shell>) -> Status {
    status_value(&s)
}
#[tauri::command]
fn get_settings(s: State<'_, Shell>) -> Settings {
    s.store.settings()
}
#[tauri::command]
fn set_settings(s: State<'_, Shell>, settings: Settings) -> Result<Settings, String> {
    s.store
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
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
            downloaded: s
                .downloaded
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(m.id)
                || delulu_stt::is_downloaded(&s.store.models_dir(), m.id),
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
    s.download.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        for i in 0..=60 {
            if !app.state::<Shell>().download.load(Ordering::SeqCst) {
                break;
            }
            if i == 60 {
                app.state::<Shell>()
                    .downloaded
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id.clone());
            }
            let _ = app.emit(
                "model-download",
                Progress {
                    id: id.clone(),
                    done_bytes: total * i / 60,
                    total_bytes: total,
                    finished: i == 60,
                    error: None,
                },
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
    Ok(())
}
#[tauri::command]
fn cancel_download(s: State<'_, Shell>) {
    s.download.store(false, Ordering::SeqCst);
}
#[tauri::command]
fn start_mic_test(app: tauri::AppHandle, s: State<'_, Shell>) {
    if s.mic.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut n = 0f32;
        while app.state::<Shell>().mic.load(Ordering::SeqCst) {
            let _ = app.emit("mic-level", (n.sin() + 1.0) / 2.0);
            n += 0.3;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
}
#[tauri::command]
fn stop_mic_test(s: State<'_, Shell>) {
    s.mic.store(false, Ordering::SeqCst);
}
#[tauri::command]
fn start_dictation(app: tauri::AppHandle, s: State<'_, Shell>) {
    if status_value(&s).phase == "idle" {
        phase(&app, &s, "recording");
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum InsertResult {
    Copied { reason: Option<String> },
    Failed { reason: String },
}
#[derive(Clone, Serialize)]
struct TranscriptEvent {
    entry: HistoryEntry,
    insert: InsertResult,
}
#[tauri::command]
fn stop_dictation(app: tauri::AppHandle, s: State<'_, Shell>) {
    if status_value(&s).phase != "recording" {
        return;
    }
    phase(&app, &s, "transcribing");
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let s = app.state::<Shell>();
        let result = s.store.add_history(NewEntry {
            text: "stub transcript".into(),
            language: "en".into(),
            model: s.store.settings().model,
            audio_ms: 1000,
            stt_ms: 0,
            total_ms: 0,
        });
        if let Ok(entry) = result {
            let _ = app.emit(
                "transcript",
                TranscriptEvent {
                    entry,
                    insert: InsertResult::Copied {
                        reason: Some("Stub insertion".into()),
                    },
                },
            );
        }
        phase(&app, &s, "idle");
    });
}
#[tauri::command]
fn prepare_insert() -> delulu_insert::InsertStatus {
    delulu_insert::InsertStatus::default()
}
#[tauri::command]
fn change_hotkey() {}
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
fn copy_text(_text: String) {}
#[tauri::command]
fn reinsert(s: State<'_, Shell>, id: String) -> InsertResult {
    if s.store.history(None, usize::MAX).iter().any(|e| e.id == id) {
        InsertResult::Copied {
            reason: Some("Stub insertion".into()),
        }
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
    phase(&app, &s, "idle");
    Ok(())
}
pub fn run() {
    let store = Store::open_default().expect("stub store");
    let initial = if std::env::var("DELULU_STUB_FIRST_RUN").as_deref() == Ok("1") {
        "needsSetup"
    } else {
        "idle"
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--toggle") {
                let s = app.state::<Shell>();
                if status_value(&s).phase == "recording" {
                    stop_dictation(app.clone(), s);
                } else {
                    start_dictation(app.clone(), s);
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
                phase: initial.into(),
                message: None,
                hotkey: delulu_hotkey::HotkeyStatus {
                    bound: true,
                    trigger: Some("Super+Z".into()),
                    error: None,
                },
                insert: delulu_insert::InsertStatus::default(),
                backend: Some("Stub".into()),
                model: Some(delulu_stt::DEFAULT_MODEL.into()),
            }),
            mic: AtomicBool::new(false),
            download: AtomicBool::new(false),
            downloaded: Mutex::new(std::collections::HashSet::new()),
        })
        .setup(|app| {
            if !std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            let _ = app.emit("status", status_value(&app.state::<Shell>()));
            Ok(())
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
