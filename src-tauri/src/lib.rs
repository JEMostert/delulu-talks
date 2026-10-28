use delulu_hotkey::{Command, Gesture, Hotkey, KeyEvent};
use delulu_insert::{InsertOutcome, Inserter, PasteKey};
use delulu_overlay::{Pill, PillState};
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

mod cleanup;
mod dictation;
mod engine;
mod ipc;
mod models;
mod state;
mod tray;
mod vocabulary;
use cleanup::{cancel_cleanup_download, get_cleanup_status, start_cleanup};
use dictation::*;
use engine::*;
use ipc::*;
use models::*;
use state::*;
use vocabulary::{
    add_preset_shelf, add_shelf, add_terms, delete_shelf, get_vocabulary, remove_term,
    rename_shelf, set_shelf_enabled,
};

pub fn run() {
    let store = Arc::new(Store::open_default().expect("open store"));
    let initial_state = store.state();
    let initial_settings = store.settings();
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
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    // Unattended end-to-end runs must never open desktop permission dialogs.
    let no_portals = std::env::var("DELULU_NO_PORTALS").as_deref() == Ok("1");
    let data_dir = store.data_dir().to_string_lossy().into_owned();
    let cleanup = cleanup::Cleanup::new(
        initial_settings.cleanup,
        delulu_stt::file_ready(&store.models_dir(), &cleanup::CLEANUP_MODEL),
    );
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
                hotkey: if no_portals {
                    delulu_hotkey::HotkeyStatus {
                        bound: false,
                        trigger: None,
                        error: Some("Portals disabled for unattended tests".into()),
                    }
                } else {
                    Default::default()
                },
                insert: if no_portals {
                    delulu_insert::InsertStatus {
                        ready: false,
                        error: Some("Portals disabled for unattended tests".into()),
                    }
                } else {
                    Default::default()
                },
                backend: None,
                model: None,
                data_dir,
            }),
            recorder: delulu_audio::Recorder::new(),
            inserter,
            hotkey: tokio::sync::Mutex::new(None),
            gesture: Mutex::new(Gesture::new()),
            engine: tx,
            download: Arc::new(AtomicBool::new(false)),
            downloading: Arc::new(AtomicBool::new(false)),
            events,
            no_portals,
            last_release: Mutex::new(None),
            mic: AtomicBool::new(false),
            pending_toggle: AtomicBool::new(std::env::args().any(|a| a == "--toggle")),
            pill: Pill::new(),
            cleanup,
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::create(app)?;
            let s = app.state::<Shell>();
            let settings = s.store.settings();
            apply_autostart(&handle, settings.start_at_login).map_err(std::io::Error::other)?;
            let engine_app = handle.clone();
            std::thread::spawn(move || engine_thread(engine_app, rx));
            let hot_app = handle.clone();
            tauri::async_runtime::spawn(async move {
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
            if delulu_stt::is_downloaded(&s.store.models_dir(), &settings.model) {
                // Cleanup syncs once Whisper has loaded.
                load_model(&handle, settings.model);
            } else {
                phase(&handle, "needsSetup", None);
                cleanup::whisper_settled(&handle);
            }
            // `--toggle` on a cold start (GNOME custom shortcut fallback) records without a window.
            if !std::env::args().any(|a| a == "--hidden" || a == "--toggle") {
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
            finish_first_run,
            get_cleanup_status,
            start_cleanup,
            cancel_cleanup_download,
            get_vocabulary,
            add_shelf,
            add_preset_shelf,
            rename_shelf,
            delete_shelf,
            set_shelf_enabled,
            add_terms,
            remove_term
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
                autostart: false,
                cleanup: false
            }
        );
        new.cleanup_model_ok = true;
        assert!(!settings_diff(&old, &new).cleanup);
        new.model = "small".into();
        new.start_at_login = false;
        new.cleanup = false;
        assert_eq!(
            settings_diff(&old, &new),
            SettingsDiff {
                model: true,
                autostart: true,
                cleanup: true
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
