//! IPC handlers, one module per area (`electron/ipc/*.ts`). Every channel in
//! `delulu_domain::ipc_requests::ipc_request_channels()` has exactly one handler.

mod audio;
mod dictation;
pub mod history;
mod lab;
mod paste;
mod renderer;
mod runtime;
mod settings;
mod updates;
mod voice;

use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    settings::register(router);
    runtime::register(router);
    dictation::register(router);
    paste::register(router);
    history::register(router);
    lab::register(router);
    voice::register(router);
    updates::register(router);
    renderer::register(router);
    audio::register(router);
}

/// Runs blocking work (device enumeration, file reads, key derivation) off
/// the async workers.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> delulu_core::DomainResult<T> + Send + 'static,
) -> delulu_core::DomainResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| delulu_core::DomainError::failed(format!("Background task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn every_validated_channel_has_exactly_one_handler() {
        let mut router = Router::<AppState>::new(delulu_domain::parse_ipc_request);
        register(&mut router);
        let handled: Vec<&str> = router.channels().copied().collect();
        let unique: BTreeSet<&str> = handled.iter().copied().collect();
        assert_eq!(unique.len(), handled.len(), "a channel is registered twice");
        let validated: BTreeSet<&str> = delulu_domain::ipc_requests::ipc_request_channels().collect();
        let missing: Vec<_> = validated.difference(&unique).collect();
        let unknown: Vec<_> = unique.difference(&validated).collect();
        assert!(missing.is_empty(), "channels without a handler: {missing:?}");
        assert!(unknown.is_empty(), "handlers for unvalidated channels: {unknown:?}");
        for channel in delulu_domain::FIRE_AND_FORGET_CHANNELS {
            assert!(unique.contains(channel), "fire-and-forget channel {channel} has no handler");
        }
    }
}
