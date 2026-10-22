//! Capture level diagnostics (`src/captureDiagnostics.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;
use crate::serde_js;

/// Samples at or above 99.9% of digital full scale may indicate input clipping.
/// This cannot establish whether a microphone or upstream hardware clipped.
pub const CLIPPING_THRESHOLD: f64 = 0.999;

/// Diagnostics of captured mono PCM before resampling/encoding, not hardware gain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    pub sample_count: u64,
    #[serde(serialize_with = "serde_js::f64")]
    pub sample_rate: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub peak_amplitude: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub rms_amplitude: f64,
    pub clipped_sample_count: u64,
    #[serde(serialize_with = "serde_js::f64")]
    pub clipping_threshold: f64,
}

/// Accepts only internally consistent diagnostics; anything else is dropped.
pub fn normalize_capture_diagnostics(value: &Value) -> Option<CaptureDiagnostics> {
    let source = value.as_object()?;
    let field = |name: &str| source.get(name).and_then(Value::as_f64);
    let sample_count = field("sampleCount")?;
    let sample_rate = field("sampleRate")?;
    let peak_amplitude = field("peakAmplitude")?;
    let rms_amplitude = field("rmsAmplitude")?;
    let clipped_sample_count = field("clippedSampleCount")?;
    let clipping_threshold = field("clippingThreshold")?;
    if !js::is_safe_integer(sample_count)
        || sample_count <= 0.0
        || !js::is_safe_integer(clipped_sample_count)
        || clipped_sample_count < 0.0
        || clipped_sample_count > sample_count
        || !(8000.0..=384_000.0).contains(&sample_rate)
        || peak_amplitude < 0.0
        || rms_amplitude < 0.0
        || rms_amplitude > peak_amplitude
        || clipping_threshold != CLIPPING_THRESHOLD
    {
        return None;
    }
    Some(CaptureDiagnostics {
        sample_count: sample_count as u64,
        sample_rate,
        peak_amplitude,
        rms_amplitude,
        clipped_sample_count: clipped_sample_count as u64,
        clipping_threshold,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_consistent_diagnostics_only() {
        let valid = json!({"sampleCount": 48000, "sampleRate": 48000, "peakAmplitude": 0.5,
            "rmsAmplitude": 0.1, "clippedSampleCount": 0, "clippingThreshold": 0.999, "extra": 1});
        let parsed = normalize_capture_diagnostics(&valid).unwrap();
        let mut expected = valid.clone();
        expected.as_object_mut().unwrap().remove("extra");
        assert_eq!(serde_json::to_value(parsed).unwrap(), expected);
        let mut louder_rms = valid.clone();
        louder_rms["rmsAmplitude"] = json!(0.6);
        assert!(normalize_capture_diagnostics(&louder_rms).is_none());
        assert!(normalize_capture_diagnostics(&json!([1])).is_none());
    }
}
