//! The recording pill: a tiny click-through pearl at the bottom of the screen.
//!
//! The app runs it as a helper process of its own binary (`--pill`, see
//! [`run_pill`]) and drives it with [`Pill`], one JSON [`Message`] per line.

mod client;
#[cfg(feature = "helper")]
mod draw;
#[cfg(feature = "helper")]
mod helper;
mod model;

pub use client::Pill;
#[cfg(feature = "helper")]
pub use draw::{render_demo, render_preview};
#[cfg(feature = "helper")]
pub use helper::run_pill;
pub use model::{audible_level, Message, PillState};

/// Exit code when there is no X display to draw on; the client stops trying.
pub const UNAVAILABLE: i32 = 3;
