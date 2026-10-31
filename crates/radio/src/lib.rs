//! Delulu FM: an optional radio station made on this computer.
//!
//! Gemma 4 E4B (the cleanup model) writes each song's title, style and lyrics and the
//! host's lines; YuE2 makes the music natively in the `delulu-music` helper (see
//! `music`); the host speaks through `delulu speak` with Chatterbox Turbo's bundled
//! voice. This crate holds the station, its storage and the native player; the app
//! supplies the helpers and decides when the GPU may be used.
pub mod audio;
pub mod model;
pub mod music;
pub mod player;
pub mod station;
pub mod voice;
pub mod writer;

pub use model::{Direction, Item, Kind, State};
pub use player::{Player, PlayerEvent, Position};
pub use station::{Backend, Next, Station};

#[derive(Debug, thiserror::Error)]
pub enum RadioError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Audio(String),
    #[error("{0}")]
    Writer(String),
    #[error("{0}")]
    Music(String),
    #[error("{0}")]
    Voice(String),
    /// A service is missing or not running; production waits without counting a failure.
    #[error("{0}")]
    Unavailable(String),
    /// The model is in use (dictation); try again shortly.
    #[error("busy")]
    Busy,
    #[error("cancelled")]
    Cancelled,
    /// The listener's input was rejected; the message is for them.
    #[error("{0}")]
    Invalid(String),
}
