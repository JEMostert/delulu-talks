//! Speech services for Delulu Talks: the speech and rewriting ("Magic")
//! runtimes (`electron/services/asr.ts`), the dictation pipeline over the
//! native recorder (`electron/services/dictation.ts`), paste-last
//! (`electron/services/pasteLast.ts`) and the dictation, paste-recovery and
//! session-transcript bookkeeping that lived in `electron/main.ts`.
//!
//! [`Speech`] wires everything; the app crate builds it once and routes IPC
//! handlers, tray items and shortcuts to it. Storage is reached only through
//! the [`Profile`] trait, which the app crate implements over delulu-data.
//!
//! Events (Tauri channel names = Electron channel names):
//! - `runtime:statusChanged` — [`delulu_domain::DictationStatus`]
//! - `magic:statusChanged` — [`delulu_domain::MagicStatus`]
//! - `recorder:level` — number 0–1, about 20 Hz while recording
//! - `history:added` — [`delulu_domain::TranscriptRecord`]
//! - `paste:recoveryChanged` — [`delulu_domain::PasteRecovery`] or `null`
//! - `dictation:pasteLastChanged` — [`delulu_domain::PasteLastStatus`]

// `DomainError` is the workspace's shared (frozen) error contract.
#![allow(clippy::result_large_err)]

pub mod asr;
pub mod dictation;
pub mod paste_last;
pub mod ports;
pub mod profile;
pub mod retry_audio;
mod speech;
mod status;
mod support;
pub mod transcripts;

#[cfg(test)]
mod tests;

pub use asr::{speech_engine_id, speech_model_name, AsrService, SpeechWorkerModel};
pub use dictation::DictationService;
pub use paste_last::PasteLastService;
pub use ports::{Capture, Delivery, Indicator, SpeechEngine};
pub use profile::Profile;
pub use speech::{Speech, SpeechDeps, SpeechHooks};
pub use transcripts::Transcripts;

/// Channel names.
pub mod channels {
    pub const RUNTIME_STATUS: &str = "runtime:statusChanged";
    pub const MAGIC_STATUS: &str = "magic:statusChanged";
    pub const RECORDER_LEVEL: &str = "recorder:level";
    pub const HISTORY_ADDED: &str = "history:added";
    pub const PASTE_RECOVERY: &str = "paste:recoveryChanged";
    pub const PASTE_LAST: &str = "dictation:pasteLastChanged";
}
