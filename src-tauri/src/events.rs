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
        if crate::ipc::log_enabled() && channel != "recorder:level" {
            // Status objects: phase, engine and message are what matter.
            let pick = |key: &str| payload.get(key).map(|value| format!(" {key}={value}")).unwrap_or_default();
            let summary = format!("{}{}{}", pick("phase"), pick("engine"), pick("message"));
            let preview: String =
                if summary.is_empty() { payload.to_string() } else { summary }.chars().take(240).collect();
            log::info!("event {channel}:{preview}");
        }
        // A closed or not-yet-created window simply misses the event; the
        // renderer re-reads state through its getters when it starts.
        let _ = self.app.emit_to(MAIN_WINDOW, channel, payload);
    }
}
