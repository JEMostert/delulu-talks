//! Audio files, imports and input devices.

use serde::{Deserialize, Serialize};

use crate::import_queue::ImportJobState;
use crate::serde_js;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileSelection {
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub source_mtime_ms: Option<f64>,
    pub path: String,
    pub name: String,
    pub size: u64,
}

string_enum! {
    pub enum AudioDecoder { Soundfile = "soundfile", Ffmpeg = "FFmpeg" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileMetadata {
    #[serde(serialize_with = "serde_js::opt_f64")]
    pub duration_seconds: Option<f64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub decoder: AudioDecoder,
    pub decoder_ready: bool,
    pub decoder_detail: String,
    pub estimated_pcm_bytes: Option<u64>,
    pub processing_time_estimate: String,
}

string_enum! {
    pub enum AudioJobState {
        Pending = "pending",
        Running = "running",
        Done = "done",
        Failed = "failed",
        Cancelled = "cancelled",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportJob {
    #[serde(flatten)]
    pub file: AudioFileSelection,
    pub state: AudioJobState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_state: Option<ImportJobState>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabRequest {
    pub path: String,
}

/// An audio input or output device. The first entry of a listing is
/// `{ deviceId: "default", label: "System default" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDevice {
    pub device_id: String,
    pub label: String,
    /// False when privacy permissions hide the real label; default tracks inventory visibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_known: Option<bool>,
}
