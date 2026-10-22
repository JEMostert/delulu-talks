//! Model catalog entries and model cache management.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::speech_models::{SpeechBackendId, SpeechIdentity};

use super::{MagicModelId, SpeechModelId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVariant {
    pub label: String,
    pub revision: Option<String>,
    pub conversion: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvenance {
    pub license_name: String,
    pub license_url: String,
    pub variants: Vec<ModelVariant>,
}

/// A speech model without its selection key (`Omit<ModelInfo, "id">`), as
/// used for the CPU models.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescription {
    pub identity: SpeechIdentity,
    pub backend_ids: Vec<SpeechBackendId>,
    pub runtime: String,
    pub download_size: String,
    pub hf_id: String,
    pub name: String,
    pub description: String,
    pub provenance: ModelProvenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: SpeechModelId,
    #[serde(flatten)]
    pub model: ModelDescription,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicModelInfo {
    pub id: MagicModelId,
    pub hf_id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub provenance: ModelProvenance,
    pub parameters: String,
    pub memory: String,
    pub speed: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleUsage {
    pub counts: BTreeMap<String, u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheEntry {
    pub id: String,
    pub label: String,
    pub bytes: u64,
    pub size_complete: bool,
}

string_enum! {
    pub enum SpeechDownloadId {
        Canary180m = "canary-180m",
        ParakeetV2 = "parakeet-v2",
        ParakeetV3 = "parakeet-v3",
        R2t2 = "r2t2",
    }
}

/// A downloaded speech checkpoint the user can delete from Models.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDownload {
    pub id: SpeechDownloadId,
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCachePreview {
    pub token: String,
    pub entries: Vec<ModelCacheEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheFailure {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheCleanupResult {
    pub deleted_ids: Vec<String>,
    pub failures: Vec<ModelCacheFailure>,
}
