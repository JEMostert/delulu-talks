//! Platform capabilities, shortcuts, updates, permissions, paste and local data.

use serde::{Deserialize, Serialize};

use crate::serde_js;

string_enum! {
    pub enum Platform { Linux = "linux", Darwin = "darwin", Win32 = "win32" }
}

impl Platform {
    /// The platform this binary was built for (Node's `process.platform`).
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(target_os = "windows") {
            Platform::Win32
        } else {
            Platform::Linux
        }
    }
}

string_enum! {
    pub enum OverlayMethod { LayerShell = "layer-shell", MacPanel = "mac-panel", Unavailable = "unavailable" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// R2T2 (Large) can run on this platform and architecture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_speech_available: Option<bool>,
    pub platform: Platform,
    pub desktop: String,
    pub session_type: String,
    pub paste_method: String,
    pub overlay_method: OverlayMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_detail: Option<String>,
    pub wayland: bool,
}

string_enum! {
    pub enum ShortcutMethod { Portal = "portal", Native = "native" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
    pub method: ShortcutMethod,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_triggered_at: Option<u64>,
}

string_enum! {
    pub enum UpdatePhase {
        Unsupported = "unsupported",
        Idle = "idle",
        Checking = "checking",
        Available = "available",
        Downloading = "downloading",
        Downloaded = "downloaded",
        UpToDate = "upToDate",
        Error = "error",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub current_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub transferred: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub bytes_per_second: Option<f64>,
}

string_enum! {
    pub enum RenderingMode { Hardware = "hardware", Software = "software" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererRecoveryState {
    pub can_reload: bool,
    pub reason: Option<String>,
    pub can_stop_recording: bool,
}

string_enum! {
    pub enum MicrophonePermissionState {
        NotDetermined = "not-determined",
        Granted = "granted",
        Denied = "denied",
        Restricted = "restricted",
        Unknown = "unknown",
        NotApplicable = "not-applicable",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePermission {
    pub state: MicrophonePermissionState,
    pub can_request_capture: bool,
    pub detail: String,
}

string_enum! {
    pub enum AccessibilityPermissionState {
        Granted = "granted",
        Denied = "denied",
        Unknown = "unknown",
        NotApplicable = "not-applicable",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityPermission {
    pub state: AccessibilityPermissionState,
    pub can_attempt_paste: bool,
    pub detail: String,
}

string_enum! {
    pub enum PasteLastPhase {
        Idle = "idle",
        Pending = "pending",
        Delivering = "delivering",
        Attempted = "attempted",
        Copied = "copied",
        Cancelled = "cancelled",
        Error = "error",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteLastStatus {
    pub phase: PasteLastPhase,
    pub operation_id: Option<String>,
    pub due_at: Option<u64>,
    #[serde(serialize_with = "serde_js::f64")]
    pub remaining_seconds: f64,
    pub message: String,
}

string_enum! {
    pub enum LocalDataStatus { Present = "present", Missing = "missing", Partial = "partial" }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataLocation {
    pub path: String,
    pub status: LocalDataStatus,
    pub bytes: u64,
    pub files: u64,
    pub skipped_links: u64,
    pub problems: Vec<String>,
}

string_enum! {
    pub enum LocalDataCategoryId {
        History = "history",
        Settings = "settings",
        Models = "models",
        Runtimes = "runtimes",
        Audio = "audio",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataCategory {
    pub id: LocalDataCategoryId,
    pub label: String,
    pub description: String,
    pub locations: Vec<LocalDataLocation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataOverview {
    pub data_directory: String,
    pub checked_at: u64,
    pub categories: Vec<LocalDataCategory>,
}
