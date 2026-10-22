//! The renderer-facing Tauri commands. See `docs/TAURI_MIGRATION.md`.

pub mod router;

use std::sync::Arc;

use delulu_core::Envelope;
use serde_json::Value;
use tauri::{State, Webview};

use crate::state::AppState;
pub use router::Router;

pub const MAIN_WINDOW: &str = "main";

/// `DELULU_IPC_LOG=1` logs every request's channel and outcome (debugging).
pub fn log_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("DELULU_IPC_LOG").as_deref() == Ok("1"))
}

fn log_result<T: serde::Serialize>(channel: &str, envelope: &Envelope<T>) {
    if !log_enabled() {
        return;
    }
    match envelope {
        Envelope::Ok { .. } => log::info!("ipc {channel}: ok"),
        Envelope::Err { error, .. } => log::warn!("ipc {channel}: {:?} {}", error.code, error.message),
    }
}

/// Only the main window's webview may reach the backend.
fn trusted(webview: &Webview) -> bool {
    webview.label() == MAIN_WINDOW
}

#[tauri::command]
pub async fn ipc_invoke(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Envelope<Value>, ()> {
    let state = Arc::clone(&state);
    let router = Arc::clone(&state.router);
    let envelope = router.invoke(state, trusted(&webview), &channel, args).await;
    log_result(&channel, &envelope);
    Ok(envelope)
}

#[tauri::command]
pub fn ipc_send(webview: Webview, state: State<'_, Arc<AppState>>, channel: String, args: Vec<Value>) {
    let state = Arc::clone(&state);
    let router = Arc::clone(&state.router);
    if log_enabled() {
        log::info!("ipc send {channel}");
    }
    router.send(state, trusted(&webview), &channel, args);
}

#[tauri::command]
pub async fn ipc_bytes(
    webview: Webview,
    state: State<'_, Arc<AppState>>,
    channel: String,
    args: Vec<Value>,
) -> Result<tauri::ipc::Response, Envelope<()>> {
    let state = Arc::clone(&state);
    let router = Arc::clone(&state.router);
    let operation = channel.clone();
    let result = router
        .invoke_bytes(state, trusted(&webview), &channel, args)
        .await
        .map(tauri::ipc::Response::new)
        .map_err(|error| Envelope::err(error.to_failure(&delulu_core::uuid(), &operation)));
    match &result {
        Ok(_) => log_result(&channel, &Envelope::ok(())),
        Err(envelope) => log_result(&channel, envelope),
    }
    result
}
