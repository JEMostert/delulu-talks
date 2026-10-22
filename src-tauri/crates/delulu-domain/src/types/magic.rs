//! Optional rewriting ("Magic") requests and results.

use serde::{Deserialize, Serialize};

use crate::pipeline_timings::PipelineTimings;
use crate::serde_js;

use super::{MagicModelId, MagicPreset, RuntimeLifecycle};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicRewriteContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicRewriteRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub text: String,
    pub preset: MagicPreset,
    /// Optional style request for this rewrite only; never a saved preference. Max 4,000 UTF-16 units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<MagicRewriteContext>,
    pub allow_inferences: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicRewriteResult {
    #[serde(flatten)]
    pub lifecycle: RuntimeLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<PipelineTimings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<MagicPreset>,
    pub text: String,
    pub model: MagicModelId,
    #[serde(serialize_with = "serde_js::f64")]
    pub processing_time_ms: f64,
    pub input_characters: u64,
    pub output_characters: u64,
    /// Records permission to add assumptions, not evidence that any were added.
    pub included_inferences: bool,
}
