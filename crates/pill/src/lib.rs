//! The recording pill: a small click-through pearl at the bottom of the screen
//! while the dictation key is held.
//!
//! The `delulu-pill` binary draws it without GTK: a wlr-layer-shell surface
//! where the compositor offers one (KDE Plasma, wlroots), an override-redirect
//! window under XWayland otherwise (GNOME). It reads one JSON [`Message`] per
//! line on stdin, the same protocol as the app's GTK `--pill` helper, exits 0
//! at the end of input and [`UNAVAILABLE`] when there is nothing to draw on.
//!
//! Without features this crate is only the protocol and the model, which the
//! daemon uses to drive a pill; `render` adds the drawing.

#[cfg(feature = "render")]
pub mod draw;
pub mod model;
pub mod protocol;
pub mod select;
#[cfg(feature = "render")]
mod text;

pub use model::{audible_level, Message, PillState};

/// Exit code when there is nothing to draw on; the client stops trying it.
pub const UNAVAILABLE: i32 = 3;

/// The pill is drawn at this size relative to its logical layout.
pub const SCALE: f64 = 1.2;
/// The pill's bottom edge sits this far above the bottom of the work area.
pub const BOTTOM_MARGIN: f64 = 28.0;
/// XWayland often reports the full screen as work area, hiding Wayland panels
/// (a KDE panel is about 54 px plus its floating gap); stay clear of them then.
pub const PANEL_CLEARANCE: f64 = 80.0;
