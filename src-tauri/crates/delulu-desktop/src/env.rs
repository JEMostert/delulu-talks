//! A snapshot of the platform and the environment variables desktop
//! integration depends on, so every service is testable with a fake desktop.

use std::collections::HashMap;

use crate::types::Platform;

#[derive(Debug, Clone)]
pub struct DesktopEnv {
    pub platform: Platform,
    pub vars: HashMap<String, String>,
}

impl DesktopEnv {
    /// The running process.
    pub fn current() -> Self {
        Self { platform: Platform::current(), vars: delulu_core::host_vars().into_iter().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect() }
    }

    pub fn new<K: Into<String>, V: Into<String>>(platform: Platform, vars: impl IntoIterator<Item = (K, V)>) -> Self {
        Self { platform, vars: vars.into_iter().map(|(k, v)| (k.into(), v.into())).collect() }
    }

    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// `XDG_SESSION_TYPE`, lowercased.
    pub fn session_type(&self) -> Option<String> {
        self.var("XDG_SESSION_TYPE").map(str::to_lowercase)
    }

    /// Linux under a Wayland session: portals, layer-shell pill.
    pub fn is_linux_wayland(&self) -> bool {
        self.platform == Platform::Linux && self.session_type().as_deref() == Some("wayland")
    }

    /// `XDG_CURRENT_DESKTOP` contains a `KDE` entry.
    pub fn is_kde(&self) -> bool {
        self.var("XDG_CURRENT_DESKTOP")
            .is_some_and(|desktop| desktop.split(':').any(|entry| entry.eq_ignore_ascii_case("kde")))
    }

    /// `XDG_CURRENT_DESKTOP ?? DESKTOP_SESSION ?? "unknown"`.
    pub fn desktop(&self) -> String {
        self.var("XDG_CURRENT_DESKTOP").or_else(|| self.var("DESKTOP_SESSION")).unwrap_or("unknown").to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kde_detection_matches_desktop_list_entries() {
        let env = |desktop: &str| DesktopEnv::new(Platform::Linux, [("XDG_CURRENT_DESKTOP", desktop)]);
        assert!(env("KDE").is_kde());
        assert!(env("ubuntu:kde").is_kde());
        assert!(!env("GNOME").is_kde());
        assert!(!env("KDEish").is_kde());
    }
}
