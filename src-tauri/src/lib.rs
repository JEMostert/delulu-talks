use delulu_desktop::hotkey::{Command, Gesture, Hotkey, KeyEvent};
use delulu_desktop::insert::Inserter;
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
mod client;
mod context;
mod dictation;
mod engine;
mod ipc;
mod models;
mod music;
mod radio;
mod state;
mod tray;
mod vocabulary;
mod voice;
use cleanup::{cancel_cleanup_download, get_cleanup_status, start_cleanup};
use dictation::*;
use engine::*;
use ipc::*;
use models::*;
use music::{cancel_music_download, delete_music_model, download_music_model, get_music_model};
use radio::{
    check_radio, get_radio, radio_direction, radio_off, radio_pause, radio_play, radio_request,
    radio_skip, radio_volume,
};
use state::*;
use vocabulary::{
    add_preset_shelf, add_shelf, add_terms, delete_shelf, get_vocabulary, remove_term,
    rename_shelf, set_shelf_enabled,
};
use voice::{get_voice_status, install_voice_model, set_voice};

pub fn run() {
    // One dictation path, whatever the start order: a daemon that runs dictation
    // makes this window its client; DELULU_DAEMON=1 waits for that daemon.
    let flag = std::env::var("DELULU_DAEMON").as_deref() == Ok("1");
    let socket = client::socket();
    match client::decide(flag, client::probe(socket.as_deref(), client::PROBE_WAIT)) {
        client::Mode::App => run_app(),
        client::Mode::Client => run_client(socket),
    }
}

/// The window as the dictation daemon's client: no store, microphone, portals,
/// speech model, cleanup helper, pill or radio of its own.
fn run_client(socket: Option<std::path::PathBuf>) {
    eprintln!("delulu-talks: dictation runs in the daemon; this window is its client");
    let toggle = std::env::args().any(|a| a == "--toggle");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--toggle") {
                client::toggle(app);
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
        .manage(client::Client::new(socket, toggle))
        .setup(move |app| {
            tray::create(app)?;
            tauri::async_runtime::spawn(client::connect_forever(app.handle().clone()));
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
            get_voice_status,
            install_voice_model,
            set_voice,
            list_microphones,
            list_languages,
            client::cmd_get_status,
            client::cmd_get_settings,
            client::cmd_set_settings,
            client::cmd_list_models,
            client::cmd_download_model,
            client::cmd_cancel_download,
            client::cmd_start_mic_test,
            client::cmd_stop_mic_test,
            client::cmd_start_dictation,
            client::cmd_stop_dictation,
            client::cmd_prepare_insert,
            client::cmd_change_hotkey,
            client::cmd_get_history,
            client::cmd_delete_history,
            client::cmd_clear_history,
            client::cmd_copy_text,
            client::cmd_reinsert,
            client::cmd_finish_first_run,
            client::cmd_get_cleanup_status,
            client::cmd_start_cleanup,
            client::cmd_cancel_cleanup_download,
            client::cmd_get_vocabulary,
            client::cmd_add_shelf,
            client::cmd_add_preset_shelf,
            client::cmd_rename_shelf,
            client::cmd_delete_shelf,
            client::cmd_set_shelf_enabled,
            client::cmd_add_terms,
            client::cmd_remove_term,
            client::cmd_get_radio,
            client::cmd_check_radio,
            client::cmd_radio_play,
            client::cmd_radio_pause,
            client::cmd_radio_off,
            client::cmd_radio_skip,
            client::cmd_radio_volume,
            client::cmd_radio_direction,
            client::cmd_radio_request,
            client::cmd_get_music_model,
            client::cmd_download_music_model,
            client::cmd_cancel_music_download,
            client::cmd_delete_music_model
        ])
        .build(tauri::generate_context!())
        .expect("Tauri failed")
        .run(|_, _| {});
}

/// The window runs dictation itself, as it did before the daemon.
fn run_app() {
    let store = Arc::new(Store::open_default().expect("open store"));
    Store::start_daily_pruning(&store);
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
    let app_slot: cleanup::AppSlot = Default::default();
    let cleanup = cleanup::supervisor(
        &store,
        initial_settings.cleanup,
        delulu_stt::file_ready(&store.models_dir(), &cleanup::CLEANUP_MODEL),
        app_slot.clone(),
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
                    delulu_desktop::hotkey::HotkeyStatus {
                        bound: false,
                        trigger: None,
                        error: Some("Portals disabled for unattended tests".into()),
                    }
                } else {
                    Default::default()
                },
                insert: if no_portals {
                    delulu_desktop::insert::InsertStatus {
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
            context: Default::default(),
            radio_writer: AtomicBool::new(false),
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = app_slot.set(handle.clone());
            tray::create(app)?;
            let s = app.state::<Shell>();
            let settings = s.store.settings();
            let radio = radio::Radio::new(&handle, s.store.data_dir().join("radio"));
            app.manage(radio);
            app.manage(music::MusicModel::default());
            radio::start(&handle);
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
            if let Some(id) = ready_model(&s.store.models_dir(), &settings.model) {
                // Cleanup syncs once Whisper has loaded.
                load_model(&handle, id);
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
            get_voice_status,
            install_voice_model,
            set_voice,
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
            remove_term,
            get_radio,
            check_radio,
            radio_play,
            radio_pause,
            radio_off,
            radio_skip,
            radio_volume,
            radio_direction,
            radio_request,
            get_music_model,
            download_music_model,
            cancel_music_download,
            delete_music_model
        ])
        .build(tauri::generate_context!())
        .expect("Tauri failed")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                radio::shutdown(app);
            }
        });
}
