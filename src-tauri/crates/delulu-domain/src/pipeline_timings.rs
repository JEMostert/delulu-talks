//! Measured pipeline durations (`src/pipelineTimings.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;
use crate::serde_js;

/// Only measured finite durations survive IPC/storage; absence means unmeasured.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTimings {
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub capture_end_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub preprocessing_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub speech_load_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub speech_request_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub backend_preprocessing_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub inference_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub rewrite_load_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub rewriting_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub clipboard_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub paste_ms: Option<f64>,
}

/// `TIMING_LABELS`, in display order.
pub const TIMING_LABELS: &[(&str, &str)] = &[
    ("captureEndMs", "Capture finalization"),
    ("preprocessingMs", "Audio preparation"),
    ("speechLoadMs", "Speech model readiness wait"),
    ("speechRequestMs", "Speech worker round trip"),
    ("backendPreprocessingMs", "Backend audio preprocessing"),
    ("inferenceMs", "Speech inference"),
    ("rewriteLoadMs", "Writing model readiness wait"),
    ("rewritingMs", "Rewrite worker round trips"),
    ("clipboardMs", "Clipboard publication"),
    ("pasteMs", "Paste dispatch"),
];

impl PipelineTimings {
    fn slot(&mut self, key: &str) -> &mut Option<f64> {
        match key {
            "captureEndMs" => &mut self.capture_end_ms,
            "preprocessingMs" => &mut self.preprocessing_ms,
            "speechLoadMs" => &mut self.speech_load_ms,
            "speechRequestMs" => &mut self.speech_request_ms,
            "backendPreprocessingMs" => &mut self.backend_preprocessing_ms,
            "inferenceMs" => &mut self.inference_ms,
            "rewriteLoadMs" => &mut self.rewrite_load_ms,
            "rewritingMs" => &mut self.rewriting_ms,
            "clipboardMs" => &mut self.clipboard_ms,
            "pasteMs" => &mut self.paste_ms,
            _ => unreachable!("unknown timing {key}"),
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == PipelineTimings::default()
    }
}

/// Keeps finite, non-negative durations rounded to 0.01 ms; `None` when none remain.
pub fn normalize_timings(value: &Value) -> Option<PipelineTimings> {
    let source = value.as_object()?;
    let mut result = PipelineTimings::default();
    for (key, _) in TIMING_LABELS {
        if let Some(duration) = source.get(*key).and_then(Value::as_f64) {
            if duration.is_finite() && duration >= 0.0 {
                *result.slot(key) = Some(js::round(duration * 100.0) / 100.0);
            }
        }
    }
    (!result.is_empty()).then_some(result)
}

/// The capture and speech timings only, for a record whose rewrite was replaced.
pub fn without_rewrite_timings(value: &Value) -> Option<PipelineTimings> {
    let mut timings = normalize_timings(value)?;
    timings.rewrite_load_ms = None;
    timings.rewriting_ms = None;
    timings.clipboard_ms = None;
    timings.paste_ms = None;
    (!timings.is_empty()).then_some(timings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_measured_durations_only() {
        let timings = normalize_timings(&json!({"inferenceMs": 12.3456, "pasteMs": -1, "speechLoadMs": "3", "bogus": 1})).unwrap();
        assert_eq!(serde_json::to_value(&timings).unwrap(), json!({"inferenceMs": 12.35}));
        assert!(normalize_timings(&json!({"pasteMs": -1})).is_none());
        assert!(without_rewrite_timings(&json!({"rewritingMs": 4})).is_none());
    }
}
