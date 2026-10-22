//! The environment for programs the app starts (Python workers, the overlay,
//! FFmpeg, paste helpers).
//!
//! An AppImage launcher points `PATH`, `LD_LIBRARY_PATH`, `PYTHONHOME`,
//! `PYTHONPATH`, GTK, GIO and GStreamer variables into its own mount so the
//! bundled WebKit finds its libraries. System programs must not see those:
//! the system Python, for example, aborts with "Failed to import encodings"
//! under the bundle's `PYTHONHOME`. The app itself keeps its environment
//! (WebKit's helper processes need it); every child gets the host's.

use std::ffi::{OsStr, OsString};
use std::sync::OnceLock;

/// The current environment without entries that point into the AppImage
/// mount. Identical to `std::env::vars_os()` outside an AppImage.
pub fn host_vars() -> Vec<(OsString, OsString)> {
    match appimage_dir() {
        Some(dir) => clean_vars(std::env::vars_os(), &dir),
        None => std::env::vars_os().collect(),
    }
}

/// Changes that turn this process's environment into the host's: `Some` sets
/// a variable, `None` removes it. Empty outside an AppImage.
pub fn host_env_overrides() -> &'static [(OsString, Option<OsString>)] {
    static OVERRIDES: OnceLock<Vec<(OsString, Option<OsString>)>> = OnceLock::new();
    OVERRIDES.get_or_init(|| match appimage_dir() {
        Some(dir) => overrides(std::env::vars_os(), &dir),
        None => Vec::new(),
    })
}

/// Applies [`host_env_overrides`] to a command. Call it before the command's
/// own `env` settings so those still take precedence.
pub trait HostEnv {
    fn host_env(&mut self) -> &mut Self;
}

impl HostEnv for std::process::Command {
    fn host_env(&mut self) -> &mut Self {
        for (key, value) in host_env_overrides() {
            match value {
                Some(value) => self.env(key, value),
                None => self.env_remove(key),
            };
        }
        self
    }
}

#[cfg(feature = "tokio")]
impl HostEnv for tokio::process::Command {
    fn host_env(&mut self) -> &mut Self {
        for (key, value) in host_env_overrides() {
            match value {
                Some(value) => self.env(key, value),
                None => self.env_remove(key),
            };
        }
        self
    }
}

fn appimage_dir() -> Option<OsString> {
    std::env::var_os("APPIMAGE")?;
    std::env::var_os("APPDIR").filter(|dir| dir.len() > 1)
}

/// Drops every `:`-separated entry under `dir`; a variable left empty is removed.
fn clean_value(value: &OsStr, dir: &OsStr) -> Option<OsString> {
    let value = value.to_string_lossy();
    let dir = dir.to_string_lossy();
    let dir = dir.trim_end_matches('/');
    let under = |entry: &str| entry == dir || entry.starts_with(&format!("{dir}/"));
    if !value.contains(dir) {
        return Some(value.into_owned().into());
    }
    let kept: Vec<&str> = value.split(':').filter(|entry| !entry.is_empty() && !under(entry)).collect();
    (!kept.is_empty()).then(|| kept.join(":").into())
}

fn overrides(vars: impl Iterator<Item = (OsString, OsString)>, dir: &OsStr) -> Vec<(OsString, Option<OsString>)> {
    vars.filter_map(|(key, value)| {
        if key == "APPDIR" || key == "APPIMAGE" || key == "ARGV0" || key == "OWD" {
            // Kept: the app's own self-location (autostart, agent setup) reads them.
            return None;
        }
        let cleaned = clean_value(&value, dir);
        (cleaned.as_deref() != Some(value.as_os_str())).then_some((key, cleaned))
    })
    .collect()
}

fn clean_vars(vars: impl Iterator<Item = (OsString, OsString)>, dir: &OsStr) -> Vec<(OsString, OsString)> {
    vars.filter_map(|(key, value)| {
        if key == "APPDIR" || key == "APPIMAGE" || key == "ARGV0" || key == "OWD" {
            return Some((key, value));
        }
        clean_value(&value, dir).map(|value| (key, value))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn removes_appimage_entries_and_keeps_host_entries() {
        let dir = OsStr::new("/tmp/.mount_Delulu");
        let input = vars(&[
            ("PATH", "/tmp/.mount_Delulu/usr/bin/:/usr/local/bin:/usr/bin"),
            ("PYTHONHOME", "/tmp/.mount_Delulu/usr/"),
            ("PYTHONPATH", "/tmp/.mount_Delulu/usr/share/pyshared/:"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_Delulu/usr/lib/"),
            ("XDG_DATA_DIRS", "/tmp/.mount_Delulu/usr/share:/usr/share:/usr/local/share"),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_Delulu/usr/lib/gstreamer-1.0:"),
            ("GTK_EXE_PREFIX", "/tmp/.mount_Delulu//usr"),
            ("HOME", "/home/me"),
            ("APPDIR", "/tmp/.mount_Delulu"),
        ]);
        let cleaned: std::collections::HashMap<_, _> = clean_vars(input.clone().into_iter(), dir).into_iter().collect();
        assert_eq!(cleaned[OsStr::new("PATH")], "/usr/local/bin:/usr/bin");
        assert_eq!(cleaned[OsStr::new("XDG_DATA_DIRS")], "/usr/share:/usr/local/share");
        assert_eq!(cleaned[OsStr::new("HOME")], "/home/me");
        assert_eq!(cleaned[OsStr::new("APPDIR")], "/tmp/.mount_Delulu");
        for removed in ["PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0", "GTK_EXE_PREFIX"] {
            assert!(!cleaned.contains_key(OsStr::new(removed)), "{removed} should be removed");
        }

        let changes = overrides(input.into_iter(), dir);
        assert!(changes.contains(&("PYTHONHOME".into(), None)));
        assert!(changes.contains(&("PATH".into(), Some("/usr/local/bin:/usr/bin".into()))));
        assert!(!changes.iter().any(|(key, _)| key == "HOME" || key == "APPDIR"));
    }

    #[test]
    fn a_similar_prefix_is_not_the_mount() {
        let dir = OsStr::new("/tmp/.mount_Delulu");
        let cleaned = clean_value(OsStr::new("/tmp/.mount_DeluluOther/bin:/usr/bin"), dir);
        assert_eq!(cleaned.unwrap(), "/tmp/.mount_DeluluOther/bin:/usr/bin");
    }
}
