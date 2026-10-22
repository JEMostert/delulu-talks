//! Wire types owned by this crate. They serialize exactly like the
//! TypeScript types in `src/types.ts`; `delulu-domain` may later re-export
//! or convert them.

use serde::{Deserialize, Serialize};

/// `PasteShortcut`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasteShortcut {
    #[default]
    Standard,
    /// Ctrl+Shift+V for terminals.
    Terminal,
}

/// `PlatformCapabilities["platform"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "darwin")]
    Darwin,
    #[serde(rename = "win32")]
    Win32,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Linux
        }
    }
}

/// `PlatformCapabilities["overlayMethod"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayMethod {
    LayerShell,
    MacPanel,
    #[default]
    Unavailable,
}

/// `PlatformCapabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// Filled in by the caller (`largeSpeechSupported()` lives elsewhere).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub large_speech_available: Option<bool>,
    pub platform: Platform,
    pub desktop: String,
    pub session_type: String,
    /// `wayland-portal`, an injector program name, or `clipboard-only`.
    pub paste_method: String,
    pub overlay_method: OverlayMethod,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub overlay_detail: Option<String>,
    pub wayland: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutMethod {
    Portal,
    Native,
}

/// `ShortcutStatus`. `lastTriggeredAt` is always present (`null` until the
/// first activation), like the TypeScript service's initial status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
    pub method: ShortcutMethod,
    pub message: String,
    #[serde(default)]
    pub last_triggered_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessibilityState {
    Granted,
    Denied,
    Unknown,
    NotApplicable,
}

/// `AccessibilityPermission`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityPermission {
    pub state: AccessibilityState,
    pub can_attempt_paste: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicrophoneState {
    NotDetermined,
    Granted,
    Denied,
    Restricted,
    Unknown,
    NotApplicable,
}

/// `MicrophonePermission`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePermission {
    pub state: MicrophoneState,
    pub can_request_capture: bool,
    pub detail: String,
}

/// The two `PipelineTimings` fields this crate measures.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DeliveryTimings {
    pub clipboard_ms: Option<f64>,
    pub paste_ms: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_types_match_typescript() {
        let status = ShortcutStatus {
            accelerator: "Super+Z".into(),
            registered: false,
            method: ShortcutMethod::Portal,
            message: "Shortcut registration pending".into(),
            last_triggered_at: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({"accelerator":"Super+Z","registered":false,"method":"portal","message":"Shortcut registration pending","lastTriggeredAt":null})
        );
        let caps = PlatformCapabilities {
            large_speech_available: None,
            platform: Platform::Win32,
            desktop: "unknown".into(),
            session_type: "unknown".into(),
            paste_method: "powershell.exe".into(),
            overlay_method: OverlayMethod::LayerShell,
            overlay_detail: None,
            wayland: false,
        };
        assert_eq!(
            serde_json::to_value(&caps).unwrap(),
            json!({"platform":"win32","desktop":"unknown","sessionType":"unknown","pasteMethod":"powershell.exe","overlayMethod":"layer-shell","wayland":false})
        );
        let mic = MicrophonePermission {
            state: MicrophoneState::NotDetermined,
            can_request_capture: true,
            detail: String::new(),
        };
        assert_eq!(serde_json::to_value(&mic).unwrap()["state"], "not-determined");
        assert_eq!(serde_json::to_value(PasteShortcut::Terminal).unwrap(), "terminal");
    }
}
