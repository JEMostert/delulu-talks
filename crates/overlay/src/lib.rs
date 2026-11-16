//! The recording pill: a tiny click-through pearl at the bottom of the screen.
//!
//! [`Pill`] drives it, one JSON [`Message`] per line. It starts the native
//! `delulu-pill` (crate `delulu-pill`) when installed, and falls back to the
//! app's GTK helper (`delulu-talks --pill`, see [`run_pill`]) when it is missing
//! or cannot draw here. Both draw the same frames.

mod client;
#[cfg(feature = "helper")]
mod helper;

pub use client::{native_pill, Pill};
pub use delulu_pill::{audible_level, Message, PillState, UNAVAILABLE};
#[cfg(feature = "helper")]
pub use helper::run_pill;
