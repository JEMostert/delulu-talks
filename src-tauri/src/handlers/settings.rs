//! `electron/ipc/settings.ts`.

use std::sync::Arc;

use serde_json::Value;

use crate::ipc::Router;
use crate::state::AppState;

fn rule_ids(state: &AppState) -> Vec<String> {
    state.storage.get_settings().custom_words.iter().map(|rule| rule.id.clone()).collect()
}

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("settings:get", |state, _| async move { Ok(state.storage.get_settings()) })
        .handle("rules:usage", |state, _| async move { Ok(state.rule_usage.get(&rule_ids(&state))) })
        .handle("rules:resetUsage", |state, _| async move {
            state.rule_usage.reset()?;
            Ok(state.rule_usage.get(&rule_ids(&state)))
        })
        .handle("settings:update", |state: Arc<AppState>, args| async move {
            let patch: Value = args.get(0)?;
            crate::settings::persist_settings(&state, patch).await
        })
        .handle("shortcut:status", |state, _| async move { Ok(state.shortcut.status()) })
        .handle("shortcut:configure", |state, _| async move { state.shortcut.configure().await });
}
