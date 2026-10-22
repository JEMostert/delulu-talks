//! The main window lifecycle, notifications, the macOS Dock, launch at login
//! and quitting (window/app parts of `electron/main.ts`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_domain::{AppSettings, Page, Theme};
use parking_lot::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::ipc::MAIN_WINDOW;
use crate::state::AppState;

/// Window and quit flags (module state in main.ts).
pub struct Shell {
    /// Launch-at-login starts in the tray; any explicit reopen shows the window.
    pub start_hidden: bool,
    /// False on Linux desktops with no StatusNotifier host, where a tray is invisible.
    pub tray_visible: AtomicBool,
    hidden_notice_shown: AtomicBool,
    pub quitting: AtomicBool,
    pub shutdown_complete: AtomicBool,
    /// Set by the updater: restart instead of exiting once shut down.
    pub restart_after_quit: AtomicBool,
    loaded: AtomicBool,
    revealed: AtomicBool,
    pending_page: Mutex<Option<Page>>,
    visibility: Mutex<Option<bool>>,
}

impl Shell {
    pub fn new(start_hidden: bool) -> Self {
        Self {
            start_hidden,
            tray_visible: AtomicBool::new(true),
            hidden_notice_shown: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            restart_after_quit: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
            revealed: AtomicBool::new(false),
            pending_page: Mutex::new(None),
            visibility: Mutex::new(None),
        }
    }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Matches the renderer canvas so the first frame never flashes the wrong theme.
fn window_background(theme: Theme, system_dark: bool) -> Color {
    let dark = theme == Theme::Dark || (theme == Theme::System && system_dark);
    if dark {
        Color(0x03, 0x14, 0x24, 0xff)
    } else {
        Color(0xcf, 0xea, 0xf4, 0xff)
    }
}

pub fn apply_theme(state: &AppState, settings: &AppSettings) {
    if let Some(window) = main_window(&state.app) {
        let system_dark = window.theme().is_ok_and(|theme| theme == tauri::Theme::Dark);
        let _ = window.set_background_color(Some(window_background(settings.theme, system_dark)));
    }
}

/// The app's own pages: the bundled `tauri://` origin or the dev server.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("127.0.0.1") | Some("localhost") => cfg!(debug_assertions) && url.port() == Some(1420),
            _ => false,
        },
        _ => false,
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if url.scheme() == "https" {
        use tauri_plugin_opener::OpenerExt;
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            log::warn!("Could not open {url}: {error}");
        }
    }
}

pub fn create_main_window(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<WebviewWindow> {
    let settings = state.storage.get_settings();
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Delulu Talks")
        .inner_size(800.0, 620.0)
        .min_inner_size(480.0, 420.0)
        .center()
        .visible(false)
        .background_color(window_background(settings.theme, false))
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            open_external(&navigation_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&popup_app, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            let Some(state) = AppState::get(window.app_handle()) else { return };
            match payload.event() {
                PageLoadEvent::Started => page_started(&state),
                PageLoadEvent::Finished => page_finished(&state),
            }
        })
        .build()?;
    #[cfg(target_os = "linux")]
    window.with_webview(|webview| crate::webview_linux::configure(&webview.inner()))?;
    apply_theme(state, &settings);
    let events = app.clone();
    window.on_window_event(move |event| {
        let Some(state) = AppState::get(&events) else { return };
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                if state.shell.quitting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                hide_main_window(&state);
                if !state.shell.tray_visible.load(Ordering::SeqCst)
                    && !state.shell.hidden_notice_shown.swap(true, Ordering::SeqCst)
                {
                    state.notify(
                        "Delulu Talks is still running, so your shortcut keeps working. Open it again from your app launcher.",
                    );
                }
            }
            WindowEvent::Resized(_) | WindowEvent::Focused(_) => publish_visibility(&state, false),
            _ => {}
        }
    });
    Ok(window)
}

fn page_started(state: &AppState) {
    state.shell.loaded.store(false, Ordering::SeqCst);
    state.speech.paste_last.cancel_pending("Scheduled paste cancelled because the workspace reloaded.");
}

fn page_finished(state: &Arc<AppState>) {
    state.shell.loaded.store(true, Ordering::SeqCst);
    publish_visibility(state, true);
    if !state.shell.revealed.swap(true, Ordering::SeqCst) {
        reveal(state);
    }
    if let Some(page) = state.shell.pending_page.lock().take() {
        state.emit("app:navigate", &page);
    }
}

/// Keep the renderer alive, but require an installed tray before
/// suppressing startup visibility. Explicit reopen actions still show it.
fn reveal(state: &AppState) {
    let tray_hidden_start =
        state.shell.start_hidden && state.tray.installed() && state.shell.tray_visible.load(Ordering::SeqCst);
    if menu_bar_only_active(state) || tray_hidden_start {
        return;
    }
    if let Some(window) = main_window(&state.app) {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
            publish_visibility(state, false);
        }
    }
}

/// `app:visibility`: shown and not minimized.
pub fn window_visible(app: &AppHandle) -> bool {
    main_window(app).is_some_and(|window| {
        window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    })
}

pub fn publish_visibility(state: &AppState, force: bool) {
    let visible = window_visible(&state.app);
    let changed = state.shell.visibility.lock().replace(visible) != Some(visible);
    if changed || force {
        state.emit("app:visibility", &visible);
    }
}

pub fn hide_main_window(state: &AppState) {
    if let Some(window) = main_window(&state.app) {
        let _ = window.hide();
    }
    publish_visibility(state, false);
}

/// `showMainWindow(page?)`.
pub fn show_main_window(state: &AppState, page: Option<Page>) {
    if let Some(window) = main_window(&state.app) {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
    publish_visibility(state, false);
    let Some(page) = page else { return };
    if state.shell.loaded.load(Ordering::SeqCst) {
        state.emit("app:navigate", &page);
    } else {
        *state.shell.pending_page.lock() = Some(page);
    }
}

pub fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title("Delulu Talks").body(body).show() {
        log::warn!("Notification not shown ({error}): {body}");
    }
}

pub fn menu_bar_only_active(state: &AppState) -> bool {
    cfg!(target_os = "macos") && state.tray.installed() && state.storage.get_settings().menu_bar_only
}

/// Hide or show the Dock icon to match `menuBarOnly` (macOS).
pub fn sync_mac_dock(state: &AppState) {
    #[cfg(target_os = "macos")]
    {
        let policy = if menu_bar_only_active(state) {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        if state.app.set_activation_policy(policy).is_err() {
            state.notify("Could not show the Dock icon. Use the menu bar to reopen Delulu Talks.");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = state;
}

/// macOS and Windows login items through tauri-plugin-autostart.
pub struct AutostartItems(AppHandle);

impl delulu_desktop::LoginItems for AutostartItems {
    fn set_open_at_login(&self, enabled: bool, _args: &[&str]) -> Result<(), String> {
        // The launch arguments (`--hidden` on Windows) are fixed when the plugin starts.
        use tauri_plugin_autostart::ManagerExt;
        let manager = self.0.autolaunch();
        if enabled { manager.enable() } else { manager.disable() }.map_err(|error| error.to_string())
    }
}

pub fn login_items(app: &AppHandle) -> Option<AutostartItems> {
    cfg!(any(target_os = "macos", windows)).then(|| AutostartItems(app.clone()))
}

/// Quits after releasing workers, the overlay, the shortcut and the tray.
/// Safe to call more than once; later calls are ignored.
pub fn quit(app: &AppHandle) {
    let Some(state) = AppState::get(app) else {
        app.exit(0);
        return;
    };
    if state.shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        shutdown(&state).await;
        state.shell.shutdown_complete.store(true, Ordering::SeqCst);
        if state.shell.restart_after_quit.load(Ordering::SeqCst) {
            state.app.request_restart();
        } else {
            state.app.exit(0);
        }
    });
}

async fn shutdown(state: &Arc<AppState>) {
    log::info!("Shutting down");
    if let Err(error) = state.lab.shutdown() {
        log::error!("Could not save import queue during shutdown: {}", error.message);
    }
    state.pill.shutdown();
    state.tray.destroy(&state.app);
    drop(state.device_watcher.lock().take());
    // Wait for model workers (and their GPU children) to exit, but never hang quit.
    let work = async {
        tokio::join!(state.paste.shutdown(), state.shortcut.shutdown(), state.speech.shutdown(), state.voice.shutdown());
    };
    if tokio::time::timeout(Duration::from_secs(6), work).await.is_err() {
        log::warn!("Shutdown timed out; quitting anyway");
    }
    log::info!("Shutdown complete");
}
