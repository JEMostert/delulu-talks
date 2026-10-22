//! Foundations shared by every Delulu Talks crate: the domain error contract,
//! the renderer event sink, profile/resource paths and small utilities.

pub mod error;
pub mod events;
pub mod paths;
pub mod process;
pub mod util;

pub use error::{CancellationEffect, DomainError, DomainErrorCode, DomainFailure, DomainResult, Envelope, RetryPolicy};
pub use events::{emit, EventSink, NullSink, RecordingSink, SharedSink};
pub use paths::AppPaths;
pub use process::{host_vars, HostEnv};
pub use util::{now_ms, uuid};
