//! Delulu Talks data layer: settings and history storage with migrations,
//! backups and staged validated writes, plus retention, batch deletion,
//! encrypted history, exports, local-data overview, rule usage, model cache,
//! audio cache recovery, audio import jobs and the import queue.
//!
//! Persisted JSON is handled as `serde_json::Value` with JavaScript object
//! semantics (key order, number formatting), so a profile written by the
//! Electron app loads and saves byte-for-byte the same way.

// `DomainError` is the shared error contract from delulu-core.
#![allow(clippy::result_large_err)]

pub mod audio_cache_recovery;
pub mod audio_jobs;
pub mod audio_source;
pub mod encrypted_history;
pub mod history_batch;
pub mod history_retention;
pub mod import_queue;
pub mod json;
pub mod local_data;
pub mod media_inspection;
pub mod migration_backups;
pub mod model_cache;
pub mod profile_restore;
pub mod profile_write;
pub mod retry_audio;
pub mod rule_usage;
pub mod storage;
pub mod time;
pub mod transcripts;

pub use storage::{normalize_settings, normalize_settings_value, StorageService};

/// A plain `Error` thrown by the TypeScript, as the IPC registrar serialized
/// it: `OPERATION_FAILED` with the safe cause category `Error`.
pub(crate) fn plain_error(message: impl Into<String>) -> delulu_core::DomainError {
    delulu_core::DomainError::failed(message).with_cause("Error", None)
}
