//! macOS privacy permissions (`accessibilityPermission.ts`,
//! `microphonePermission.ts`). Every other platform reports
//! `not-applicable`.

use crate::types::{
    AccessibilityPermission, AccessibilityState, MicrophonePermission, MicrophoneState, Platform,
};

const ACCESSIBILITY_SETTINGS: &str = "System Settings → Privacy & Security → Accessibility";
const MICROPHONE_SETTINGS: &str = "System Settings → Privacy & Security → Microphone";

pub fn accessibility_permission(platform: Platform) -> AccessibilityPermission {
    if platform != Platform::Darwin {
        return AccessibilityPermission {
            state: AccessibilityState::NotApplicable,
            can_attempt_paste: true,
            detail: "macOS Accessibility permission does not apply on this platform.".into(),
        };
    }
    mac_accessibility_from(mac::accessibility_trusted())
}

/// Maps `AXIsProcessTrusted()` (or the reason it could not be read).
pub fn mac_accessibility_from(trusted: Result<bool, String>) -> AccessibilityPermission {
    match trusted {
        Ok(true) => AccessibilityPermission {
            state: AccessibilityState::Granted,
            can_attempt_paste: true,
            detail: "macOS has granted Accessibility access to Delulu Talks for automatic paste.".into(),
        },
        Ok(false) => AccessibilityPermission {
            state: AccessibilityState::Denied,
            can_attempt_paste: false,
            detail: format!(
                "Enable Delulu Talks in {ACCESSIBILITY_SETTINGS}, then quit and reopen the app to use automatic paste."
            ),
        },
        Err(reason) => AccessibilityPermission {
            state: AccessibilityState::Unknown,
            can_attempt_paste: false,
            detail: format!(
                "Could not read macOS Accessibility permission: {reason}. Enable Delulu Talks in {ACCESSIBILITY_SETTINGS}, then quit and reopen the app to use automatic paste."
            ),
        },
    }
}

pub fn microphone_permission() -> MicrophonePermission {
    if Platform::current() != Platform::Darwin {
        return MicrophonePermission {
            state: MicrophoneState::NotApplicable,
            can_request_capture: true,
            detail: "Microphone access is requested when dictation starts.".into(),
        };
    }
    mac_microphone_from(mac::microphone_authorization())
}

/// Maps `AVCaptureDevice.authorizationStatus(for: .audio)`:
/// 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn mac_microphone_from(status: Result<isize, String>) -> MicrophonePermission {
    let (state, can_request_capture, detail) = match status {
        Ok(0) => (
            MicrophoneState::NotDetermined,
            true,
            "Start dictation to request microphone access, then allow Delulu Talks in the macOS prompt.".to_owned(),
        ),
        Ok(3) => (MicrophoneState::Granted, true, "macOS has granted microphone access to Delulu Talks.".to_owned()),
        Ok(2) => (
            MicrophoneState::Denied,
            false,
            format!("Enable Delulu Talks in {MICROPHONE_SETTINGS}, then quit and reopen the app before trying again."),
        ),
        Ok(1) => (
            MicrophoneState::Restricted,
            false,
            format!(
                "macOS restricts microphone access. Check {MICROPHONE_SETTINGS} and ask your device administrator to allow access, then quit and reopen Delulu Talks."
            ),
        ),
        Ok(_) => (
            MicrophoneState::Unknown,
            false,
            format!(
                "macOS could not determine microphone access. Check Delulu Talks in {MICROPHONE_SETTINGS}, then quit and reopen the app before trying again."
            ),
        ),
        Err(reason) => (
            MicrophoneState::Unknown,
            false,
            format!(
                "Could not read macOS microphone permission: {reason}. Check Delulu Talks in {MICROPHONE_SETTINGS}, then quit and reopen the app before trying again."
            ),
        ),
    };
    MicrophonePermission { state, can_request_capture, detail }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::runtime::AnyClass;
    use objc2::msg_send;
    use objc2_foundation::NSString;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    /// `isTrustedAccessibilityClient(false)`: checks without prompting.
    pub fn accessibility_trusted() -> Result<bool, String> {
        // SAFETY: AXIsProcessTrusted takes no arguments and has no preconditions.
        Ok(unsafe { AXIsProcessTrusted() })
    }

    pub fn microphone_authorization() -> Result<isize, String> {
        let class = AnyClass::get(c"AVCaptureDevice").ok_or_else(|| "AVCaptureDevice is unavailable".to_owned())?;
        // SAFETY: +[AVCaptureDevice authorizationStatusForMediaType:] takes an
        // AVMediaType (NSString) and returns AVAuthorizationStatus (NSInteger).
        let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio] };
        Ok(status)
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    pub fn accessibility_trusted() -> Result<bool, String> {
        Err("not macOS".into())
    }
    pub fn microphone_authorization() -> Result<isize, String> {
        Err("not macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_mac_platforms_are_not_applicable_and_mac_states_map_like_electron() {
        assert_eq!(accessibility_permission(Platform::Linux).state, AccessibilityState::NotApplicable);
        assert!(accessibility_permission(Platform::Win32).can_attempt_paste);
        assert_eq!(mac_accessibility_from(Ok(true)).state, AccessibilityState::Granted);
        assert!(!mac_accessibility_from(Err("x".into())).can_attempt_paste);
        let states: Vec<_> = (0..5).map(|s| mac_microphone_from(Ok(s)).state).collect();
        assert_eq!(
            states,
            [
                MicrophoneState::NotDetermined,
                MicrophoneState::Restricted,
                MicrophoneState::Denied,
                MicrophoneState::Granted,
                MicrophoneState::Unknown
            ]
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(microphone_permission().state, MicrophoneState::NotApplicable);
    }
}
