//! Desktop integration through the XDG desktop portals, shared by the app and the
//! daemon: the global dictation shortcut ([`hotkey`]) and typing text into the
//! focused window ([`insert`]).

/// The app ID the portals know Delulu Talks by. Shortcut bindings and the typing
/// permission are stored under it.
pub const APP_ID: &str = "com.joran.delulu-talks";

pub mod hotkey;
pub mod insert;
