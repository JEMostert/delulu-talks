//! Desktop integration for Delulu Talks: transcript delivery (clipboard +
//! paste), clipboard restore, the global dictation shortcut, the recording
//! pill, tray host detection and tray state, launch at login and macOS
//! privacy permissions.
//!
//! The concrete services stand in for `electron/services/desktopAdapters.ts`:
//! [`PasteService`] (DesktopPasteAdapter), [`ShortcutService`]
//! (DesktopShortcutAdapter), [`PillService`] (DesktopIndicatorAdapter) and
//! [`accessibility_permission`] (DesktopPermissionAdapter).
//!
//! App-level integrations are traits the app crate implements:
//! [`NativeShortcuts`] (tauri-plugin-global-shortcut), [`MacPillFactory`]
//! (the macOS panel window) and [`LoginItems`] (macOS/Windows login items).

// `DomainError` (delulu-core, frozen) is 128 bytes; boxing it per call
// site would diverge from the shared error contract.
#![allow(clippy::result_large_err)]

pub mod autostart;
pub mod clipboard;
pub mod clipboard_restore;
pub mod command;
pub mod env;
pub mod mac_pill;
pub mod paste;
pub mod permissions;
pub mod pill;
#[cfg(target_os = "linux")]
pub mod portal;
pub mod shortcut;
pub mod tray;
pub mod types;

pub use autostart::{sync_login_item, LoginItems};
pub use clipboard::{ClipboardBackend, ClipboardSnapshot, SystemClipboard};
pub use command::{CommandRunner, SystemCommandRunner};
pub use env::DesktopEnv;
pub use paste::{is_clipboard_copy_error, PasteIo, PasteService, RemoteDesktopPortal, APP_ID};
pub use permissions::{accessibility_permission, microphone_permission};
pub use pill::{MacPillFactory, MacPillWindow, PillCommand, PillIo, PillService, PillState};
pub use shortcut::{
    default_global_shortcuts_portal, NativeShortcuts, ShortcutActions, ShortcutMode, ShortcutService,
};
pub use tray::{menu_preview, tray_host_available, tray_state, TrayInputs, TrayState};
pub use types::*;

/// `platform:capabilities`: paste and overlay facts for this desktop. The
/// caller adds `large_speech_available`.
pub fn platform_capabilities(paste: &PasteService, pill: &PillService) -> PlatformCapabilities {
    paste.capabilities(pill.method(), Some(pill.detail()))
}
