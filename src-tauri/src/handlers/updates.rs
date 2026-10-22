//! `electron/ipc/updates.ts`.

use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("updates:get", |state, _| async move { Ok(state.updates.status()) })
        .handle("updates:check", |state, _| async move { Ok(state.updates.check().await) })
        .handle("updates:download", |state, _| async move { Ok(state.updates.download().await) })
        .handle("updates:install", |state, _| async move { state.updates.install() });
}
