mod events;
mod ipc;
mod state;
#[cfg(target_os = "linux")]
mod webview_linux;

use std::sync::Arc;

use delulu_core::AppPaths;
use tauri::webview::PermissionResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::ipc::{Router, MAIN_WINDOW};
use crate::state::AppState;

fn resources_dir(app: &tauri::App, packaged: bool) -> std::path::PathBuf {
    if packaged {
        app.path().resource_dir().unwrap_or_default()
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .setup(|app| {
            let packaged = !cfg!(debug_assertions);
            let paths = AppPaths::resolve(packaged, resources_dir(app, packaged));
            let router = Router::new(delulu_domain::parse_ipc_request);
            app.manage(Arc::new(AppState { paths, router: Arc::new(router) }));

            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Delulu Talks")
                .inner_size(1100.0, 760.0)
                .min_inner_size(720.0, 520.0)
                .build()?;
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| webview_linux::configure(&webview.inner()))?;
            let _ = window;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc::ipc_invoke, ipc::ipc_send, ipc::ipc_bytes])
        .run(tauri::generate_context!())
        .expect("error while running Delulu Talks");
}
