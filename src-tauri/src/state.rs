//! Application state shared by IPC handlers, the tray and lifecycle hooks.

use std::sync::Arc;

use delulu_core::AppPaths;

use crate::ipc::Router;

pub struct AppState {
    pub paths: AppPaths,
    pub router: Arc<Router<AppState>>,
}
