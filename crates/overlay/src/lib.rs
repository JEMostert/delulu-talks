//! The recording pill: a tiny click-through pearl at the bottom of the screen.
//!
//! The app runs it as a helper process of its own binary (`--pill`, see
//! [`run_pill`]) and drives it with [`Pill`], one JSON [`Message`] per line.

mod client;
mod draw;
mod helper;
mod model;

pub use client::Pill;
pub use draw::render_preview;
pub use helper::{run_pill, UNAVAILABLE};
pub use model::{audible_level, Message, PillState};
