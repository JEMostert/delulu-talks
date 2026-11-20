//! Desktop integration through the XDG desktop portals, shared by the app and the
//! daemon: the global dictation shortcut ([`hotkey`]) and typing text into the
//! focused window ([`insert`]).

/// The app ID the portals know Delulu Talks by. Shortcut bindings and the typing
/// permission are stored under it.
pub const APP_ID: &str = "com.joran.delulu-talks";

mod hotkey_types;
mod insert_types;

#[cfg_attr(target_os = "macos", path = "macos/hotkey.rs")]
pub mod hotkey;
#[cfg_attr(target_os = "macos", path = "macos/insert.rs")]
pub mod insert;

/// Tells xdg-desktop-portal that this D-Bus connection belongs to [`APP_ID`], so
/// the shortcut binding and the typing permission stored under that ID apply. It
/// must be the first portal call on the connection: the portal caches the app ID
/// per connection at its first method call. A failure is logged as a warning
/// because it is what brings the permission dialogs back; a correctly named
/// systemd unit (`app-com.joran.delulu-talks@….service`) still gives the same ID.
#[cfg(target_os = "linux")]
pub(crate) async fn register(connection: &zbus::Connection) {
    if ashpd::is_sandboxed() {
        return;
    }
    let result = connection
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.host.portal.Registry"),
            "Register",
            &(
                APP_ID,
                std::collections::HashMap::<&str, zbus::zvariant::Value>::new(),
            ),
        )
        .await;
    if let Err(error) = result {
        log::warn!(
            "portal: registering as {APP_ID} failed, permission dialogs may come back: {error}"
        );
    }
}
