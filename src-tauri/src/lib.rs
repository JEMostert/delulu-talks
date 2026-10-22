#[cfg(target_os = "linux")]
mod webview_linux;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn probe_report(report: serde_json::Value) {
    println!("PROBE {}", report);
}

#[tauri::command]
fn probe_binary(request: tauri::ipc::Request) -> tauri::ipc::Response {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => Vec::new(),
    };
    println!("PROBE binary-received {}", bytes.len());
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
fn probe_done(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .on_permission_request(|_, kind| {
            println!("PROBE permission-request {:?}", kind);
            match kind {
                PermissionKind::Microphone => PermissionResponse::Allow,
                _ => PermissionResponse::Deny,
            }
        })
        .setup(|app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .title("Delulu Talks")
            .inner_size(1100.0, 760.0)
            .build()?;
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| webview_linux::configure(&webview.inner()))?;
            let url = if cfg!(debug_assertions) {
                "http://127.0.0.1:1420/spike-gum.html".parse().unwrap()
            } else {
                "tauri://localhost/spike-gum.html".parse().unwrap()
            };
            window.navigate(url)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe_report, probe_binary, probe_done])
        .run(tauri::generate_context!())
        .expect("error while running Delulu Talks");
}
