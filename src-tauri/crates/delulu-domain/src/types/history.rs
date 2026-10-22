//! Transcript records and history management.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::capture_diagnostics::CaptureDiagnostics;
use crate::pipeline_timings::PipelineTimings;
use crate::serde_js::{self, double_option};
use crate::speech_models::SpeechExecution;

use super::{DictationFormatting, MagicModelId, MagicPreset, ModelId, TranscriptSource};

string_enum! {
    pub enum HistoryDeletionPhase { Pending = "pending", Failed = "failed" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeletionState {
    pub token: String,
    pub ids: Vec<String>,
    pub deadline: u64,
    pub phase: HistoryDeletionPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBatchSnapshot {
    pub deletion: Option<HistoryDeletionState>,
    pub records: Vec<TranscriptRecord>,
}

string_enum! {
    pub enum DeliveryState {
        Transcribed = "transcribed",
        Copied = "copied",
        PasteAttempted = "paste-attempted",
        Confirmed = "confirmed",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDelivery {
    pub state: DeliveryState,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRetentionPolicy {
    #[serde(serialize_with = "serde_js::opt_f64")]
    pub max_age_days: Option<f64>,
    #[serde(serialize_with = "serde_js::opt_f64")]
    pub max_count: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRetentionEffects {
    pub originals: u64,
    pub personalized: u64,
    pub corrections: u64,
    pub rewrites: u64,
    pub imported_references: u64,
    /// Retention removes transcript records only, never source audio files. Always 0.
    pub audio_files_deleted: u8,
}

string_enum! {
    pub enum RetentionReason { Age = "age", Count = "count", AgeAndCount = "ageAndCount" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionAffected {
    pub record: TranscriptRecord,
    pub reason: RetentionReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRetentionPreview {
    pub token: String,
    pub policy: HistoryRetentionPolicy,
    pub previewed_at: u64,
    pub total_saved: u64,
    pub retained_count: u64,
    pub effects: HistoryRetentionEffects,
    pub affected: Vec<RetentionAffected>,
}

string_enum! {
    pub enum LanguageStatus { Reported = "reported", Mixed = "mixed", Unknown = "unknown" }
}

/// A saved or session transcript.
///
/// Speech backends currently provide no calibrated confidence evidence.
/// Do not infer confidence from timing, length, model identity, or rewrites.
/// Add score/uncertainty UI only with a backend calibration contract.
///
/// Fields typed `x?: T | null` in TypeScript are `Option<Option<T>>` here:
/// `None` is absent, `Some(None)` is `null`. Unknown persisted keys are
/// preserved in `extra`. Numbers stay `f64` because legacy records were
/// normalized with `Number(...)` and may hold fractions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRecord {
    /// Never automatically persisted, even if history is enabled later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dictation_formatting: Option<DictationFormatting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<PipelineTimings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u8>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(serialize_with = "serde_js::f64")]
    pub created_at: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub duration_ms: f64,
    pub text: String,
    /// Monotonic version of the original/corrected source; legacy records start at zero.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub source_revision: Option<f64>,
    /// Source version used for this rewrite; null means unknown legacy provenance.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serde_js::opt_opt_f64",
        deserialize_with = "double_option::deserialize"
    )]
    pub rewrite_source_revision: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub personalized_text: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub edited_text: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub magic_text: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub magic_model: Option<Option<MagicModelId>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub magic_preset: Option<Option<MagicPreset>>,
    /// Historical name: assumptions were allowed; their presence is not detected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magic_included_inferences: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub magic_processing_time_ms: Option<f64>,
    pub model: ModelId,
    /// Observed at recognition time; absent on legacy records, never inferred.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_execution: Option<SpeechExecution>,
    pub language: String,
    /// Decoder hint, not a detected-language claim. Absent on legacy records.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub requested_language: Option<Option<String>>,
    /// Language reported by the backend; forced prompts may influence it.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub recognized_language: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recognized_languages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language_status: Option<LanguageStatus>,
    pub source: TranscriptSource,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub source_name: Option<Option<String>>,
    #[serde(serialize_with = "serde_js::f64")]
    pub processing_time_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<TranscriptDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_diagnostics: Option<CaptureDiagnostics>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[allow(clippy::derivable_impls)]
impl Default for ModelId {
    fn default() -> Self {
        ModelId::R2t2
    }
}

#[allow(clippy::derivable_impls)]
impl Default for TranscriptSource {
    fn default() -> Self {
        TranscriptSource::Dictation
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteRecovery {
    pub transcript_id: String,
    pub detail: String,
}
