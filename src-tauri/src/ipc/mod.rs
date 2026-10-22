//! The renderer-facing Tauri commands. See `docs/TAURI_MIGRATION.md`.

pub mod router;

use std::sync::Arc;

use delulu_core::Envelope;
use serde_json::Value;
use tauri::{State, Webview};

use crate::state::AppState;
pub use router::{Args, Router};

pub const MAIN_WINDOW: &str = "main";

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
    Ok(router.invoke(state, trusted(&webview), &channel, args).await)
}

#[tauri::command]
pub fn ipc_send(webview: Webview, state: State<'_, Arc<AppState>>, channel: String, args: Vec<Value>) {
    let state = Arc::clone(&state);
    let router = Arc::clone(&state.router);
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
    router
        .invoke_bytes(state, trusted(&webview), &channel, args)
        .await
        .map(tauri::ipc::Response::new)
        .map_err(|error| Envelope::err(error.to_failure(&delulu_core::uuid(), &operation)))
}
