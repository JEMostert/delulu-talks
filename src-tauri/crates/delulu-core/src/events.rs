//! Main-to-renderer events. Services emit through [`EventSink`] so they stay
//! testable without a window; the app crate provides the Tauri implementation.
//! Channel names are the Electron channel names (for example
//! `settings:changed`), which the renderer bridge subscribes to unchanged.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit_value(&self, channel: &str, payload: Value);
}

pub type SharedSink = Arc<dyn EventSink>;

/// Serializes and emits; serialization failures are programming errors and
/// are dropped rather than crashing the emitting service.
pub fn emit<T: Serialize + ?Sized>(sink: &dyn EventSink, channel: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(value) => sink.emit_value(channel, value),
        Err(error) => log_drop(channel, &error),
    }
}

fn log_drop(channel: &str, error: &serde_json::Error) {
    eprintln!("[delulu] dropped event {channel}: {error}");
}

/// Discards every event.
#[derive(Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit_value(&self, _channel: &str, _payload: Value) {}
}

/// Records events for tests.
#[derive(Default)]
pub struct RecordingSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl RecordingSink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn take(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.events.lock())
    }
    pub fn channel(&self, channel: &str) -> Vec<Value> {
        self.events
            .lock()
            .iter()
            .filter(|(name, _)| name == channel)
            .map(|(_, value)| value.clone())
            .collect()
    }
}

impl EventSink for RecordingSink {
    fn emit_value(&self, channel: &str, payload: Value) {
        self.events.lock().push((channel.to_owned(), payload));
    }
}
