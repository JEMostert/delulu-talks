//! Engine status objects updated with TypeScript-style partial patches
//! (`updateStatus` / `updateMagicStatus` in `asr.ts`).
//!
//! A patch is a JSON object merged like `{ ...status, ...patch }`, so the
//! presence of a key (not its value) drives the rules, exactly as before.

use std::sync::Arc;

use delulu_core::{emit, SharedSink};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

pub(crate) type Listener<T> = Arc<dyn Fn(&T) + Send + Sync>;

/// `UNLOADED_LIFECYCLE`.
pub(crate) fn unloaded_lifecycle() -> Map<String, Value> {
    match json!({
        "residency": "unloaded",
        "warmup": "not-started",
        "device": null,
        "idleUnloadAt": null,
        "capabilities": null,
    }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

/// `failedLifecycle(running)`.
pub(crate) fn failed_lifecycle(running: bool) -> Map<String, Value> {
    if running {
        match json!({"residency": "unknown", "warmup": "unknown", "device": null, "idleUnloadAt": null, "capabilities": null})
        {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    } else {
        unloaded_lifecycle()
    }
}

pub(crate) struct StatusCell<T> {
    channel: &'static str,
    /// Speech status clears `speechExecution` unless the engine is ready.
    speech: bool,
    value: Mutex<T>,
    sink: SharedSink,
    listeners: Mutex<Vec<Listener<T>>>,
}

impl<T: Serialize + DeserializeOwned + Clone + Send + 'static> StatusCell<T> {
    pub fn new(channel: &'static str, speech: bool, initial: T, sink: SharedSink) -> Self {
        Self {
            channel,
            speech,
            value: Mutex::new(initial),
            sink,
            listeners: Mutex::new(Vec::new()),
        }
    }

    pub fn get(&self) -> T {
        self.value.lock().clone()
    }

    pub fn on_change(&self, listener: Listener<T>) {
        self.listeners.lock().push(listener);
    }

    /// Applies `patch` (a JSON object), then emits and notifies listeners
    /// outside the lock so they may read the status again.
    pub fn update(&self, patch: Value) {
        let Value::Object(mut patch) = patch else {
            return;
        };
        let snapshot = {
            let mut value = self.value.lock();
            let Ok(Value::Object(mut status)) = serde_json::to_value(&*value) else {
                return;
            };
            let text = |map: &Map<String, Value>, key: &str| {
                map.get(key).and_then(Value::as_str).map(str::to_owned)
            };
            let phase = text(&patch, "phase");
            let engine = text(&patch, "engine");
            if phase.as_deref().is_some_and(|p| p != "error")
                || engine.as_deref().is_some_and(|e| e != "error")
            {
                patch.insert("failure".into(), Value::Null);
            }
            if matches!(engine.as_deref(), Some("unloaded" | "missing" | "error")) {
                status.insert("setupStage".into(), Value::Null);
            }
            if matches!(engine.as_deref(), Some("unloaded" | "missing")) {
                status.extend(unloaded_lifecycle());
            }
            let phase_patched = patch.contains_key("phase");
            status.extend(patch);
            if self.speech && text(&status, "engine").as_deref() != Some("ready") {
                status.insert("speechExecution".into(), Value::Null);
            }
            if phase_patched
                || !matches!(
                    text(&status, "phase").as_deref(),
                    Some("preparing" | "loading")
                )
            {
                status.insert("downloadBytes".into(), Value::Null);
            }
            match serde_json::from_value::<T>(Value::Object(status)) {
                Ok(next) => *value = next,
                Err(error) => {
                    log::error!("dropped invalid {} patch: {error}", self.channel);
                    return;
                }
            }
            value.clone()
        };
        emit(&*self.sink, self.channel, &snapshot);
        let listeners = self.listeners.lock().clone();
        for listener in listeners {
            listener(&snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use delulu_core::RecordingSink;
    use delulu_domain::{DictationStatus, EnginePhase};

    #[test]
    fn patches_follow_the_typescript_rules() {
        let sink = RecordingSink::new();
        let initial: DictationStatus = serde_json::from_value(json!({
            "phase": "loading", "engine": "loading", "message": "x", "setupStage": "model-load",
            "downloadBytes": {"completed": 1, "total": null, "kind": "transfer"},
            "failure": null, "residency": "resident"
        }))
        .unwrap();
        let cell = StatusCell::new("runtime:statusChanged", true, initial, sink.clone());
        cell.update(json!({"detail": "progress"}));
        assert!(
            cell.get().download_bytes.is_some(),
            "loading keeps download counters"
        );
        cell.update(json!({"engine": "unloaded"}));
        let status = cell.get();
        assert_eq!(status.engine, EnginePhase::Unloaded);
        assert!(status.setup_stage.is_none());
        assert_eq!(
            serde_json::to_value(&status).unwrap()["residency"],
            "unloaded"
        );
        cell.update(json!({"phase": "loading"}));
        assert!(
            cell.get().download_bytes.is_none(),
            "a phase patch clears counters"
        );
        assert_eq!(sink.channel("runtime:statusChanged").len(), 3);
    }
}
