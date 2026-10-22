//! Delulu Talks domain: the wire types from `src/types.ts` and the modules
//! it imports, catalogs and defaults, IPC request validation, and the shared
//! text logic (personalization, formatting, voice markup) the backend runs.
//!
//! Everything here is pure: no I/O, no platform calls. Behavior follows the
//! TypeScript sources at the Electron cutover, including JavaScript string
//! semantics (UTF-16 lengths, ECMAScript whitespace); see [`js`].

// `DomainError` is the shared error contract from delulu-core; boxing it here
// would only push the indirection onto every caller.
#![allow(clippy::result_large_err)]

#[macro_use]
mod macros;

pub mod catalog;
pub mod capture_diagnostics;
pub mod import_queue;
pub mod ipc_requests;
pub mod js;
pub mod listening;
pub mod persisted_schema;
pub mod pipeline_timings;
pub mod serde_js;
pub mod speech_capabilities;
pub mod speech_models;
pub mod text;
pub mod types;
pub mod voice;
pub mod word_packs;

pub use catalog::*;
pub use ipc_requests::{parse_ipc_request, FIRE_AND_FORGET_CHANNELS};
pub use types::*;

/// A plain `Error` thrown by the TypeScript, as the IPC registrar serialized
/// it: `OPERATION_FAILED` with the safe cause category `Error`.
pub(crate) fn plain_error(message: impl Into<String>) -> delulu_core::DomainError {
    delulu_core::DomainError::failed(message).with_cause("Error", None)
}
