//! Python runtimes for Delulu Talks: interpreter discovery, isolated venv
//! generations and the pinned-package installer, the persistent JSON-lines
//! worker client, setup snapshots and runtime diagnostics.
//!
//! Port of `electron/runtime/*` (except `graphics.ts` and the development-only
//! `nativeInferenceHarness.ts`).

// `DomainError` is the shared, frozen error contract; boxing it per crate would
// only add noise at every call site.
#![allow(clippy::result_large_err)]

pub mod artifacts;
pub mod diagnostics;
pub mod environment;
pub mod installer;
pub mod inventory;
pub mod location;
pub mod manifest;
pub mod platform;
pub mod prerequisites;
pub mod private_diagnostics;
pub mod protocol;
pub mod serial_queue;
pub mod setup_log;
pub mod setup_snapshot;
pub mod setup_space;
mod support;
pub mod types;
pub mod worker;

pub use environment::{runtime_environment, ChildEnv};
pub use installer::{InstallProgress, InstallSettings, InstallerPaths, RuntimeInstaller};
pub use inventory::RuntimeKind;
pub use platform::{SpeechRuntimeProfile, TargetPlatform};
pub use serial_queue::SerialQueue;
pub use setup_log::{RuntimeSetupKind, RuntimeSetupLog, SetupLog};
pub use worker::{operation_timeout, transcription_timeout, WorkerClient, WorkerClientOptions, WorkerConfig};

#[cfg(test)]
mod tests {
    use super::*;

    /// Services spawn these futures on a multi-threaded runtime.
    #[allow(dead_code)]
    fn public_futures_are_send(
        installer: &RuntimeInstaller,
        settings: &InstallSettings,
        client: &WorkerClient,
        snapshots: &setup_snapshot::SetupSnapshots,
        inputs: &setup_space::SetupInputs,
    ) {
        fn send<T: Send>(_: T) {}
        send(installer.install(RuntimeKind::Voice, settings, |_| {}, None));
        send(installer.ready(RuntimeKind::Voice, SpeechRuntimeProfile::Cpu));
        send(installer.stop_and_wait());
        send(client.request("status", serde_json::json!({}), None));
        send(client.stop_and_wait(None));
        send(snapshots.snapshot(inputs));
        send(SerialQueue::new().run(|| async {}));
    }
}
