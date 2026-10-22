//! Tray host detection (`trayHost.ts`) and the pure tray menu/icon state
//! mapping (`trayState.ts`).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::types::ShortcutStatus;

pub const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";
pub const TRAY_HOST_TIMEOUT: Duration = Duration::from_millis(1500);

/// Linux trays need a StatusNotifier host (KDE, most desktops, or GNOME
/// with the AppIndicator extension); without one the icon is invisible.
/// Unknown (no bus, timeout) counts as available so close-to-tray keeps
/// working. Always `true` off Linux.
pub async fn tray_host_available(timeout: Duration) -> bool {
    if cfg!(not(target_os = "linux")) {
        return true;
    }
    status_notifier_watcher_owned(timeout).await.unwrap_or(true)
}

/// `NameHasOwner("org.kde.StatusNotifierWatcher")`; `None` when the bus
/// could not be asked in time.
pub async fn status_notifier_watcher_owned(timeout: Duration) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        let query = async {
            let connection = zbus::Connection::session().await?;
            let proxy = zbus::fdo::DBusProxy::new(&connection).await?;
            let name = zbus::names::BusName::try_from(STATUS_NOTIFIER_WATCHER)?;
            proxy.name_has_owner(name).await.map_err(zbus::Error::from)
        };
        tokio::time::timeout(timeout, query).await.ok()?.ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = timeout;
        None
    }
}

// ---------------------------------------------------------------------------
// Tray state. Inputs deserialize from the full TypeScript status objects
// (unknown fields ignored), so callers can pass `serde_json::to_value(status)`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationPhase {
    Idle,
    Preparing,
    Loading,
    Listening,
    Paused,
    Transcribing,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnginePhase {
    Missing,
    Unloaded,
    SettingUp,
    Loading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MagicPhase {
    Idle,
    Preparing,
    Loading,
    Rewriting,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Unsupported,
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    UpToDate,
    Error,
}

/// The `DictationStatus` fields the tray reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySpeech {
    pub phase: DictationPhase,
    pub engine: EnginePhase,
    #[serde(default)]
    pub migration_required: Option<bool>,
}

/// The `MagicStatus` fields the tray reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TrayRewrite {
    pub phase: MagicPhase,
}

/// The `UpdateStatus` fields the tray reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TrayUpdate {
    pub phase: UpdatePhase,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayIcon {
    Idle,
    Recording,
    Busy,
    Attention,
    Update,
}

impl TrayIcon {
    /// `tray/tray-<state>.png` resource name.
    pub fn as_str(self) -> &'static str {
        match self {
            TrayIcon::Idle => "idle",
            TrayIcon::Recording => "recording",
            TrayIcon::Busy => "busy",
            TrayIcon::Attention => "attention",
            TrayIcon::Update => "update",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub icon: TrayIcon,
    /// Shown as a disabled first menu row; sublabels do not render on Linux/Windows.
    pub status_line: String,
    pub tooltip: String,
}

pub struct TrayInputs<'a> {
    pub speech: &'a TraySpeech,
    pub rewrite: &'a TrayRewrite,
    pub shortcut: Option<&'a ShortcutStatus>,
    pub update: Option<&'a TrayUpdate>,
    pub delivering: bool,
}

/// Recording > busy > attention > update-ready > idle.
pub fn tray_state(inputs: TrayInputs<'_>) -> TrayState {
    let result = |icon: TrayIcon, status_line: String| TrayState {
        icon,
        tooltip: format!("Delulu Talks — {status_line}"),
        status_line,
    };
    let TrayInputs { speech, rewrite, shortcut, update, delivering } = inputs;
    use DictationPhase as D;
    match speech.phase {
        D::Listening => return result(TrayIcon::Recording, "● Recording".into()),
        D::Paused => return result(TrayIcon::Recording, "Paused — microphone open".into()),
        D::Transcribing => return result(TrayIcon::Busy, "Transcribing…".into()),
        D::Preparing => return result(TrayIcon::Busy, "Preparing…".into()),
        D::Loading => return result(TrayIcon::Busy, "Loading speech…".into()),
        _ => {}
    }
    match rewrite.phase {
        MagicPhase::Rewriting => return result(TrayIcon::Busy, "Rewriting…".into()),
        MagicPhase::Loading | MagicPhase::Preparing => return result(TrayIcon::Busy, "Loading rewriting…".into()),
        _ => {}
    }
    if delivering {
        return result(TrayIcon::Busy, "Pasting…".into());
    }
    match speech.engine {
        EnginePhase::SettingUp => return result(TrayIcon::Busy, "Installing speech…".into()),
        EnginePhase::Missing => {
            let line = if speech.migration_required == Some(true) {
                "Speech runtime update needed"
            } else {
                "Speech setup needed"
            };
            return result(TrayIcon::Attention, line.into());
        }
        _ => {}
    }
    if speech.engine == EnginePhase::Error || speech.phase == D::Error {
        return result(TrayIcon::Attention, "Speech needs attention".into());
    }
    if shortcut.is_some_and(|s| !s.registered) {
        return result(TrayIcon::Attention, "Shortcut unavailable — open Settings".into());
    }
    if let Some(update) = update {
        let version = update.version.as_deref().unwrap_or("");
        match update.phase {
            UpdatePhase::Error => return result(TrayIcon::Attention, "Update failed".into()),
            UpdatePhase::Downloaded => {
                return result(TrayIcon::Update, format!("Update {version} ready").replacen("  ", " ", 1))
            }
            UpdatePhase::Available => {
                return result(TrayIcon::Update, format!("Update {version} available").replacen("  ", " ", 1))
            }
            _ => {}
        }
    }
    let suffix = match shortcut {
        Some(shortcut) if shortcut.registered => format!(" · {}", shortcut.accelerator),
        _ => String::new(),
    };
    result(TrayIcon::Idle, format!("Ready{suffix}"))
}

/// One-line preview of a transcript for a menu label (default length 40).
pub fn menu_preview(text: &str, length: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    // Menu labels treat "&" as a mnemonic marker on Windows and Linux.
    let safe = line.replace('&', "&&");
    if delulu_core::util::utf16_len(&safe) > length {
        let cut = delulu_core::util::truncate_utf16(&safe, length.saturating_sub(1)).trim_end();
        format!("{cut}…")
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ShortcutMethod;
    use serde_json::json;

    fn speech(phase: &str, engine: &str) -> TraySpeech {
        serde_json::from_value(json!({"phase": phase, "engine": engine, "message": "Ready"})).unwrap()
    }
    const REWRITE: TrayRewrite = TrayRewrite { phase: MagicPhase::Idle };

    fn shortcut(registered: bool) -> ShortcutStatus {
        ShortcutStatus {
            accelerator: "Super+Z".into(),
            registered,
            method: ShortcutMethod::Native,
            message: String::new(),
            last_triggered_at: None,
        }
    }

    fn inputs<'a>(speech: &'a TraySpeech) -> TrayInputs<'a> {
        TrayInputs { speech, rewrite: &REWRITE, shortcut: None, update: None, delivering: false }
    }

    #[test]
    fn recording_outranks_every_other_tray_state() {
        let update = TrayUpdate { phase: UpdatePhase::Downloaded, version: None };
        let listening = speech("listening", "error");
        assert_eq!(tray_state(TrayInputs { update: Some(&update), ..inputs(&listening) }).icon, TrayIcon::Recording);
    }

    #[test]
    fn idle_shows_the_shortcut_and_attention_explains_what_is_wrong() {
        let ready = speech("idle", "ready");
        let registered = shortcut(true);
        assert_eq!(
            tray_state(TrayInputs { shortcut: Some(&registered), ..inputs(&ready) }),
            TrayState {
                icon: TrayIcon::Idle,
                status_line: "Ready · Super+Z".into(),
                tooltip: "Delulu Talks — Ready · Super+Z".into()
            }
        );
        let unregistered = shortcut(false);
        assert_eq!(
            tray_state(TrayInputs { shortcut: Some(&unregistered), ..inputs(&ready) }).status_line,
            "Shortcut unavailable — open Settings"
        );
        assert_eq!(tray_state(inputs(&speech("idle", "missing"))).icon, TrayIcon::Attention);
    }

    #[test]
    fn a_ready_update_shows_its_version() {
        let ready = speech("idle", "ready");
        let update = TrayUpdate { phase: UpdatePhase::Downloaded, version: Some("0.11.1".into()) };
        let state = tray_state(TrayInputs { update: Some(&update), ..inputs(&ready) });
        assert_eq!((state.icon, state.status_line.as_str()), (TrayIcon::Update, "Update 0.11.1 ready"));
        let unversioned = TrayUpdate { phase: UpdatePhase::Available, version: None };
        assert_eq!(tray_state(TrayInputs { update: Some(&unversioned), ..inputs(&ready) }).status_line, "Update available");
    }

    #[test]
    fn menu_previews_are_one_escaped_line() {
        assert_eq!(menu_preview("Tom &\n  Jerry", 40), "Tom && Jerry");
        assert_eq!(menu_preview(&"a".repeat(60), 10), format!("{}…", "a".repeat(9)));
    }

    /// Manual check: `cargo test -p delulu-desktop -- --ignored tray_host --nocapture`.
    #[tokio::test]
    #[ignore = "talks to the session bus"]
    async fn tray_host_query() {
        let owned = status_notifier_watcher_owned(TRAY_HOST_TIMEOUT).await;
        println!("StatusNotifierWatcher owned: {owned:?}");
        assert!(owned.is_some());
    }
}
