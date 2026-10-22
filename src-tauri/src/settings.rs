//! The settings queue and `applySettings` from `electron/main.ts`: every
//! settings change is serialized, saved (inside a shortcut transaction when
//! the shortcut changes) and then fanned out to the services.

use std::sync::Arc;

use delulu_core::DomainResult;
use delulu_data::normalize_settings;
use delulu_desktop::{sync_login_item, DesktopEnv, LoginItems};
use delulu_domain::AppSettings;
use serde_json::Value;

use crate::state::{plain, AppState};

/// `persistSettings`: queued behind earlier settings work.
pub async fn persist_settings(state: &Arc<AppState>, patch: Value) -> DomainResult<AppSettings> {
    let task = Arc::clone(state);
    state.settings_queue.run(move || async move { apply_settings(&task, patch).await }).await
}

async fn apply_settings(state: &Arc<AppState>, patch: Value) -> DomainResult<AppSettings> {
    let Some(fields) = patch.as_object() else {
        return Err(plain("Expected a settings object"));
    };
    let previous = state.storage.get_settings();
    let mut merged = state.storage.settings_json().as_object().cloned().unwrap_or_default();
    for (key, value) in fields {
        merged.insert(key.clone(), value.clone());
    }
    let next = normalize_settings(&Value::Object(merged))?;
    state.speech.assert_engine_change_idle(&previous, &next)?;
    let persist = || async {
        // Portal registration can await permission while capture/inference starts.
        // Revalidate before the write, so the transaction restores the old shortcut.
        state.speech.assert_engine_change_idle(&previous, &next)?;
        state.storage.patch_settings(&patch).map(|(_, saved)| saved)
    };
    let saved = if next.shortcut != previous.shortcut {
        state.shortcut.change(&next.shortcut, &previous.shortcut, persist).await?
    } else {
        persist().await?
    };
    if saved.menu_bar_only != previous.menu_bar_only {
        crate::shell::sync_mac_dock(state);
    }
    if saved.launch_at_login != previous.launch_at_login {
        sync_login(state, saved.launch_at_login);
    }
    if saved.show_overlay && !previous.show_overlay {
        state.pill.prepare();
    }
    // Settings are already saved: side effects only log their failures.
    state.speech.settings_changed(&previous, &saved).await;
    state.voice.settings_changed(&previous, &saved).await;
    if saved.theme != previous.theme {
        crate::shell::apply_theme(state, &saved);
    }
    state.emit("settings:changed", &saved);
    state.rebuild_tray();
    Ok(saved)
}

/// `syncLoginItem`: XDG autostart on Linux, login items elsewhere. Skipped
/// for development builds.
pub fn sync_login(state: &AppState, enabled: bool) {
    if !state.paths.packaged {
        return;
    }
    let login_items = crate::shell::login_items(&state.app);
    let items = login_items.as_ref().map(|items| items as &dyn LoginItems);
    if let Err(message) = sync_login_item(enabled, &DesktopEnv::current(), items) {
        state.notify(&message);
    }
}
