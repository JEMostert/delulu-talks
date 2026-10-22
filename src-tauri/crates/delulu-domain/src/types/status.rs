//! Runtime lifecycle and engine status shared by dictation, rewriting and voice.

use serde::{Deserialize, Serialize};

use crate::serde_js;
use crate::speech_models::SpeechExecution;
use crate::types::{MagicModelId, SpeechModelId};
use delulu_core::DomainFailure;

string_enum! {
    pub enum SetupState {
        Running = "running",
        Cancelling = "cancelling",
        Cancelled = "cancelled",
        Complete = "complete",
        Failed = "failed",
    }
}

string_enum! {
    pub enum DictationPhase {
        Idle = "idle",
        Preparing = "preparing",
        Loading = "loading",
        Listening = "listening",
        Paused = "paused",
        Transcribing = "transcribing",
        Error = "error",
    }
}

string_enum! {
    pub enum EnginePhase {
        Missing = "missing",
        Unloaded = "unloaded",
        SettingUp = "settingUp",
        Loading = "loading",
        Ready = "ready",
        Error = "error",
    }
}

string_enum! {
    pub enum MagicPhase {
        Idle = "idle",
        Preparing = "preparing",
        Loading = "loading",
        Rewriting = "rewriting",
        Error = "error",
    }
}

string_enum! {
    pub enum SetupStage {
        RuntimeCheck = "runtime-check",
        RuntimePrepare = "runtime-prepare",
        RuntimePackages = "runtime-packages",
        RuntimeDownload = "runtime-download",
        RuntimeInstall = "runtime-install",
        RuntimeBuild = "runtime-build",
        RuntimeValidate = "runtime-validate",
        ModelPrepare = "model-prepare",
        ModelDownload = "model-download",
        ModelLoad = "model-load",
        ModelConversion = "model-conversion",
        Warmup = "warmup",
        ModelLoaded = "model-loaded",
        Ready = "ready",
    }
}

string_enum! {
    pub enum ModelResidency {
        Unknown = "unknown",
        Unloaded = "unloaded",
        Loading = "loading",
        Resident = "resident",
        Unloading = "unloading",
    }
}

string_enum! {
    pub enum WarmupState {
        Unknown = "unknown",
        NotStarted = "not-started",
        Warming = "warming",
        Complete = "complete",
    }
}

string_enum! {
    pub enum CapabilityEngine { Speech = "speech", Writing = "writing" }
}

string_enum! {
    pub enum CapabilityBackend {
        Mlx = "mlx",
        CudaVllm = "cuda-vllm",
        CudaTransformers = "cuda-transformers",
        Transformers = "transformers",
        OnnxCpu = "onnx-cpu",
    }
}

string_enum! {
    pub enum ModelFamily {
        R2t2 = "r2t2",
        Canary = "canary",
        Parakeet = "parakeet",
        Qwen35 = "qwen3.5",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageHints {
    pub supported: bool,
    pub languages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCapabilities {
    /// Always 1.
    pub schema_version: u8,
    pub engine: CapabilityEngine,
    pub backend: CapabilityBackend,
    pub model_family: ModelFamily,
    pub timestamps: bool,
    pub language_hints: LanguageHints,
    pub vocabulary_biasing: bool,
}

/// Fields every engine status and result carries (`RuntimeLifecycle`).
/// Flattened into the status types.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLifecycle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub residency: Option<ModelResidency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warmup: Option<WarmupState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_unload_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<BackendCapabilities>,
}

string_enum! {
    pub enum DownloadKind { Transfer = "transfer", Reconstruction = "reconstruction" }
}

/// Observed downloader counters; aggregate totals may change during discovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadBytes {
    pub completed: u64,
    pub total: Option<u64>,
    pub kind: DownloadKind,
}

/// Rewriting engine status. Optional `T | null` fields serialize as absent
/// when `None`; the renderer treats absent and `null` alike for statuses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicStatus {
    #[serde(flatten)]
    pub lifecycle: RuntimeLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_stage: Option<SetupStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<DownloadBytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<DomainFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_state: Option<SetupState>,
    pub phase: MagicPhase,
    pub engine: EnginePhase,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<MagicModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub progress: Option<f64>,
}

string_enum! {
    pub enum RetryAudioPhase { Empty = "empty", Available = "available", Retrying = "retrying" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryAudioState {
    pub phase: RetryAudioPhase,
    pub byte_length: u64,
    #[serde(serialize_with = "serde_js::opt_f64")]
    pub duration_ms: Option<f64>,
    pub discarded: bool,
    /// Always `true`.
    pub session_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    #[serde(flatten)]
    pub lifecycle: RuntimeLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_stage: Option<SetupStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_execution: Option<SpeechExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<DownloadBytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<DomainFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_state: Option<SetupState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_model: Option<SpeechModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_input_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_audio: Option<RetryAudioState>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub silence_countdown_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_required: Option<bool>,
    pub phase: DictationPhase,
    pub engine: EnginePhase,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<SpeechModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub progress: Option<f64>,
}
