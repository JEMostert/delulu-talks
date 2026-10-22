//! Shared text logic the backend runs on transcripts and rewrites.

use serde::{Deserialize, Serialize};

pub mod dictation_formatting;
pub mod personalization;
pub mod recognition_hints;
pub mod rewrite_context;
pub mod session_retention;
pub mod spoken_formatting;
pub mod technical_identifiers;
pub mod transcript_language;
pub mod transcript_text;
pub mod transcript_title;

pub use dictation_formatting::format_dictation;
pub use personalization::*;
pub use recognition_hints::*;
pub use rewrite_context::*;
pub use session_retention::*;
pub use spoken_formatting::format_spoken_commands;
pub use technical_identifiers::*;
pub use transcript_language::*;
pub use transcript_text::*;
pub use transcript_title::*;

/// A run of text and whether it must reach output unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPart {
    pub text: String,
    pub protected: bool,
}

impl TextPart {
    pub fn new(text: impl Into<String>, protected: bool) -> Self {
        Self { text: text.into(), protected }
    }
}
