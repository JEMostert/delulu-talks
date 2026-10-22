//! The Delulu Talks desktop app: composes the service crates, routes the
//! renderer's IPC channels and owns the window, tray, menus and plugins.
//! Replaces `electron/main.ts` and `electron/ipc/*.ts`.

// `DomainError` is the workspace's shared (frozen) error contract.
#![allow(clippy::result_large_err)]

mod desktop_entry;
mod dialogs;
mod events;
mod handlers;
mod ipc;
mod lab;
mod logging;
mod mac_pill;
mod profile;
mod services;
mod settings;
mod shell;
mod shortcuts;
mod state;
mod tray;
mod updates;
#[cfg(target_os = "linux")]
mod webview_linux;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use delulu_core::AppPaths;
use tauri::webview::PermissionResponse;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::ipc::Router;
use crate::state::AppState;

/// The bundle's resource directory, or the repository root in development.
fn resources_dir(app: &AppHandle, packaged: bool) -> PathBuf {
    if packaged {
        app.path().resource_dir().unwrap_or_default()
    } else {
        dev_resources()
    }
}

fn dev_resources() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    std::fs::canonicalize(&root).unwrap_or(root)
}

/// Profile paths for the `mcp` subcommand, resolved like the app does
/// (resources are not needed there).
pub fn cli_paths() -> AppPaths {
    let packaged = !cfg!(debug_assertions);
    AppPaths::resolve(packaged, if packaged { PathBuf::new() } else { dev_resources() })
}

/// Environment that must be set before the webview starts.
pub fn prepare_environment() {
    #[cfg(target_os = "linux")]
    {
        // Escape hatch for drivers that cannot composite this window.
        if std::env::var("DELULU_SOFTWARE_RENDERING").as_deref() == Ok("1") {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // The Wayland app_id and X11 WM_CLASS must match `delulu-talks.desktop`
        // (StartupWMClass) for the portals and the launcher.
        webkit2gtk::glib::set_prgname(Some(delulu_desktop::APP_ID));
    }
}

/// `second-instance`: `--toggle-dictation` lets desktops without a shortcut
/// portal bind the app itself to a custom keyboard shortcut.
fn second_instance(app: &AppHandle, argv: Vec<String>) {
    let Some(state) = AppState::get(app) else { return };
    log::info!("Second instance: {:?}", argv.get(1..).unwrap_or_default());
    if argv.iter().any(|arg| arg == "--toggle-dictation") {
        tray::run_action(&state, tray::Action::ToggleDictation);
        return;
    }
    let notify_app = app.clone();
    if !state.voice.handle_launch_args(&argv, move |message| shell::notify(&notify_app, &message)) {
        shell::show_main_window(&state, None);
    }
}

fn fail_startup(app: &AppHandle, detail: String) {
    log::error!("Delulu Talks failed to start: {detail}");
    let exit = app.clone();
    app.dialog()
        .message(detail)
        .title("Delulu Talks failed to start")
        .kind(MessageDialogKind::Error)
        .show(move |_| exit.exit(1));
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let packaged = !cfg!(debug_assertions);
    let paths = AppPaths::resolve(packaged, resources_dir(&handle, packaged));
    log::info!("Profile: {}", paths.data.display());
    desktop_entry::ensure_development_entry(&paths.resource("icon.png"));
    let start_hidden = std::env::args().any(|arg| arg == "--hidden");

    let mut router = Router::new(delulu_domain::parse_ipc_request);
    handlers::register(&mut router);
    let router = Arc::new(router);

    // Speech, voice and the import queue capture the current Tokio runtime.
    let built = tauri::async_runtime::block_on({
        let handle = handle.clone();
        async move { services::build(&handle, paths, router, start_hidden) }
    });
    let built = match built {
        Ok(built) => built,
        Err(error) => {
            fail_startup(&handle, error.message);
            return Ok(());
        }
    };
    let state = built.state;
    app.manage(Arc::clone(&state));

    if built.audio_recovery.failure_count > 0 {
        let detail = format!(
            "{} temporary-audio cleanup failure(s). Some prior-session audio may remain on disk.\n\n{}\n\nClose Delulu before inspecting the audio-cache directory in its local data folder. Only remove generated dictation/import WAVs you recognise. Your saved history, settings, source media, models and runtimes were not removed by this cleanup.",
            built.audio_recovery.failure_count,
            built.audio_recovery.failures.join("\n")
        );
        log::error!("Temporary audio cleanup incomplete: {detail}");
        handle
            .dialog()
            .message(detail)
            .title("Temporary audio cleanup needs attention")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }

    shell::create_main_window(&handle, &state)?;
    install_app_menu(&handle);

    let register_shortcut = packaged || std::env::var("DELULU_REGISTER_SHORTCUT").as_deref() == Ok("1");
    if register_shortcut {
        let shortcut = state.shortcut.clone();
        let accelerator = state.storage.get_settings().shortcut;
        tauri::async_runtime::spawn(async move {
            if let Err(error) = shortcut.register(&accelerator).await {
                log::warn!("Shortcut was not registered: {}", error.message);
            }
        });
    }
    if let Err(error) = state.tray.install(&state) {
        log::error!("Tray icon was not created: {error}");
    }
    {
        let state = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            let available = delulu_desktop::tray_host_available(delulu_desktop::tray::TRAY_HOST_TIMEOUT).await;
            log::info!("Tray host available: {available}");
            state.shell.tray_visible.store(available, Ordering::SeqCst);
            if !available && state.shell.start_hidden {
                shell::show_main_window(&state, None);
            }
        });
    }
    state.updates.schedule_checks();
    settings::sync_login(&state, state.storage.get_settings().launch_at_login);
    {
        let state = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            tokio::join!(state.speech.initialize(), state.voice.start());
            log::info!("Speech and voice runtimes checked");
        });
    }
    Ok(())
}

/// Production windows have no reload or developer-tools shortcuts: a reload
/// would abort a recording. macOS keeps the standard app, edit and window menus.
fn install_app_menu(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
        let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
            let app_menu = Submenu::with_items(
                app,
                "Delulu Talks",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let window = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;
            Menu::with_items(app, &[&app_menu, &edit, &window])
        })();
        match menu {
            Ok(menu) => {
                let _ = app.set_menu(menu);
            }
            Err(error) => log::warn!("Application menu was not installed: {error}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, .. } => {
            // Quit only after the workers and helpers were released.
            let complete = AppState::get(app).is_none_or(|state| state.shell.shutdown_complete.load(Ordering::SeqCst));
            if !complete {
                api.prevent_exit();
                shell::quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(state) = AppState::get(app) {
                shell::show_main_window(&state, None);
            }
        }
        _ => {}
    }
}

pub fn run() {
    logging::init();
    prepare_environment();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| second_instance(app, argv)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(any(target_os = "macos", windows))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        if cfg!(windows) { Some(vec!["--hidden"]) } else { None },
    ));
    let app = builder
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .setup(setup)
        .invoke_handler(tauri::generate_handler![ipc::ipc_invoke, ipc::ipc_send, ipc::ipc_bytes])
        .build(tauri::generate_context!())
        .expect("error while building Delulu Talks");
    app.run(on_run_event);
}
