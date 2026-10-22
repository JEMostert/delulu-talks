//! The non-portal global shortcut (`NativeShortcuts`) on
//! tauri-plugin-global-shortcut. Wayland sessions use the GlobalShortcuts
//! portal inside delulu-desktop instead.

use std::sync::Arc;

use delulu_desktop::NativeShortcuts;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub struct TauriShortcuts(pub AppHandle);

impl NativeShortcuts for TauriShortcuts {
    fn register(&self, accelerator: &str, on_trigger: Box<dyn Fn() + Send + Sync>) -> bool {
        let shortcuts = self.0.global_shortcut();
        let _ = shortcuts.unregister_all();
        let trigger: Arc<dyn Fn() + Send + Sync> = Arc::from(on_trigger);
        let result = shortcuts.on_shortcut(accelerator, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                // Dictation spawns its work on the Tokio runtime.
                let trigger = trigger.clone();
                tauri::async_runtime::spawn(async move { trigger() });
            }
        });
        if let Err(error) = &result {
            log::warn!("Global shortcut {accelerator} was not registered: {error}");
        }
        result.is_ok()
    }

    fn unregister_all(&self) {
        let _ = self.0.global_shortcut().unregister_all();
    }
}
