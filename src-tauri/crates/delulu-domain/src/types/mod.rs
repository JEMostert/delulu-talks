//! Wire types from `src/types.ts`. They serialize exactly like the
//! TypeScript values (camelCase keys, string-literal unions, absent optional
//! keys). Types owned by other TypeScript modules live beside their logic
//! (`listening`, `voice`, `import_queue`, `speech_models`, `word_packs`,
//! `capture_diagnostics`, `pipeline_timings`) and are re-exported here.
//!
//! Renderer-capture types (`RecorderCommand`, `RecordingSubmission`,
//! `VoicePlaybackChunk`, `VoicePlaybackEvent`, `ListenCommand`,
//! `ListenCaptureEvent`) are not ported: capture and playback are native now.

mod audio;
mod history;
mod magic;
mod models;
mod platform;
mod runtime;
mod settings;
mod status;

pub use audio::*;
pub use history::*;
pub use magic::*;
pub use models::*;
pub use platform::*;
pub use runtime::*;
pub use settings::*;
pub use status::*;

pub use crate::capture_diagnostics::CaptureDiagnostics;
pub use crate::import_queue::{ImportJobState, ImportQueueJob, ImportQueueSnapshot};
pub use crate::listening::*;
pub use crate::pipeline_timings::PipelineTimings;
pub use crate::speech_models::{SpeechBackendId, SpeechDevice, SpeechExecution, SpeechIdentity, SpeechPrecision};
pub use crate::voice::{
    VoiceAgentSetup, VoiceBridgeStatus, VoiceCurrentUtterance, VoiceEngineId, VoiceSpeakRequest, VoiceSpeakResult,
    VoiceStatus,
};
pub use crate::word_packs::WordPackId;
pub use delulu_core::{DomainErrorCode, DomainFailure, RetryPolicy};
