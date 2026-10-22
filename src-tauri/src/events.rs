//! Delivers service events to the main window under their Electron channel names.

use delulu_core::EventSink;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::ipc::MAIN_WINDOW;

pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriSink {
    fn emit_value(&self, channel: &str, payload: Value) {
        // A closed or not-yet-created window simply misses the event; the
        // renderer re-reads state through its getters when it starts.
        let _ = self.app.emit_to(MAIN_WINDOW, channel, payload);
    }
}
