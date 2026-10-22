//! Runtime diagnostics, setup logs and setup snapshots.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::serde_js::{self, double_option};

use super::{AccessibilityPermission, MagicModelId, MicrophonePermission};

string_enum! {
    pub enum RuntimeSetupKind { Speech = "speech", Rewrite = "rewrite", Voice = "voice" }
}

string_enum! {
    pub enum SetupLogEntryType {
        Stage = "stage",
        Command = "command",
        Stdout = "stdout",
        Stderr = "stderr",
        Exit = "exit",
        Error = "error",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupLogEntry {
    pub at: u64,
    #[serde(rename = "type")]
    pub kind: SetupLogEntryType,
    pub stage: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<SetupCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub exit_code: Option<Option<i32>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
    pub signal: Option<Option<String>>,
}

string_enum! {
    pub enum SetupOutcome {
        Idle = "idle",
        Running = "running",
        Success = "success",
        Error = "error",
        Cancelled = "cancelled",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupLog {
    pub kind: RuntimeSetupKind,
    pub attempt_id: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub outcome: SetupOutcome,
    pub entries: Vec<RuntimeSetupLogEntry>,
    pub truncated: bool,
    pub max_entries: u64,
    pub max_characters: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub platform: String,
    pub arch: String,
    #[serde(rename = "memoryGB", serialize_with = "serde_js::f64")]
    pub memory_gb: f64,
    #[serde(rename = "freeMemoryGB", serialize_with = "serde_js::f64")]
    pub free_memory_gb: f64,
    pub python: String,
    pub ffmpeg: String,
    pub data_directory: String,
    pub runtime_installed: bool,
    pub packages: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<MicrophonePermission>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<AccessibilityPermission>,
    pub checked_at: u64,
}

string_enum! {
    pub enum SetupRuntimeKind { Speech = "speech", Magic = "magic" }
}

string_enum! {
    pub enum RuntimePresence { Present = "present", Missing = "missing", Unknown = "unknown" }
}

string_enum! {
    pub enum InterpreterStatus {
        Observed = "observed",
        Missing = "missing",
        Unknown = "unknown",
        Unsupported = "unsupported",
    }
}

string_enum! {
    pub enum ModuleStatus { Located = "located", Missing = "missing", Unknown = "unknown" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupModuleObservation {
    pub name: String,
    pub status: ModuleStatus,
    pub location: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInterpreterObservation {
    pub command: String,
    pub status: InterpreterStatus,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub machine: Option<String>,
    pub modules: Vec<SetupModuleObservation>,
    pub detail: String,
}

string_enum! {
    pub enum CachedInventoryStatus { Cached = "cached", Missing = "missing", Unreadable = "unreadable" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedInventory {
    pub status: CachedInventoryStatus,
    pub created_at: Option<String>,
    pub revision: Option<String>,
    pub interpreter: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRuntimeObservation {
    pub kind: SetupRuntimeKind,
    pub root: String,
    pub directory: Option<String>,
    pub runtime_state: RuntimePresence,
    pub expected_revision: String,
    pub backend: String,
    pub device_preference: String,
    pub device_observation: String,
    pub interpreter: SetupInterpreterObservation,
    pub bootstrap: Vec<SetupInterpreterObservation>,
    pub import_probe: String,
    pub cached_inventory: CachedInventory,
}

string_enum! {
    pub enum SetupSnapshotSource { Desktop = "desktop", Preview = "preview" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupSnapshot {
    pub checked_at: u64,
    pub platform: String,
    pub arch: String,
    pub source: SetupSnapshotSource,
    pub space: Option<SetupSpaceSnapshot>,
    pub runtimes: Vec<SetupRuntimeObservation>,
}

string_enum! {
    pub enum DiskObservation { Observed = "observed", Unknown = "unknown" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDiskCapacity {
    pub label: String,
    pub requested_path: String,
    pub queried_path: Option<String>,
    pub available_bytes: Option<u64>,
    pub filesystem: Option<String>,
    pub status: DiskObservation,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSpacePlan {
    pub kind: SetupRuntimeKind,
    pub model_name: String,
    pub model_download_bytes: u64,
    pub model_installed_bytes: u64,
    pub model_temporary_bytes: u64,
    pub basis: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSpaceSnapshot {
    pub magic_model: MagicModelId,
    pub checked_at: u64,
    pub disk: Vec<SetupDiskCapacity>,
    pub plans: Vec<SetupSpacePlan>,
    pub runtime_download: String,
    pub runtime_installed: String,
    pub runtime_temporary: String,
    pub caveat: String,
}
