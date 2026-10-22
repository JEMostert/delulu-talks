//! The AppImage bundles the WebKitGTK and GTK of its Ubuntu 22.04 build host.
//! On a newer system that copy can be far slower than the system's: on KDE
//! Wayland with an NVIDIA GPU, bundled WebKitGTK 2.50 painted every frame of
//! the moving ocean on its main thread (5 fps, one core busy) where the
//! system's 2.54 held 60 fps. When the host has a newer WebKitGTK that loads,
//! the AppImage restarts itself on the host libraries, as the pacman package
//! runs the same binary. `DELULU_BUNDLED_WEBKIT=1` keeps the bundled copy.

use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// `delulu-talks --print-webkit-version` prints the loaded WebKitGTK version.
pub const VERSION_FLAG: &str = "--print-webkit-version";
/// Set on the restarted process to the host library directory it runs on.
const HOST_MARKER: &str = "DELULU_HOST_WEBKIT";
const OPT_OUT: &str = "DELULU_BUNDLED_WEBKIT";

type Version = (u32, u32, u32);

pub fn webkit_version() -> Version {
    // SAFETY: plain getters of the linked library's version constants.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    }
}

pub fn print_webkit_version() {
    let (major, minor, micro) = webkit_version();
    println!("{major}.{minor}.{micro}");
}

fn parse_version(text: &str) -> Option<Version> {
    let mut parts = text.trim().split('.').map(|part| part.parse().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// The host directory holding WebKitGTK 4.1, by distribution layout.
fn host_library_dir() -> Option<PathBuf> {
    let multiarch = PathBuf::from(format!("/usr/lib/{}-linux-gnu", std::env::consts::ARCH));
    [multiarch, "/usr/lib64".into(), "/usr/lib".into()]
        .into_iter()
        .find(|dir| dir.join("libwebkit2gtk-4.1.so.0").exists())
}

/// The host's environment (without the AppImage's library, GTK and GIO
/// paths) with `library_dir` searched first. The GTK hook also forces an
/// Adwaita theme that only the bundled GTK needs.
fn host_environment(library_dir: &Path) -> Vec<(OsString, OsString)> {
    with_host_library_dir(delulu_core::host_vars(), library_dir)
}

fn with_host_library_dir(vars: Vec<(OsString, OsString)>, library_dir: &Path) -> Vec<(OsString, OsString)> {
    let mut search = library_dir.as_os_str().to_owned();
    let mut vars: Vec<(OsString, OsString)> = vars
        .into_iter()
        .filter(|(key, value)| {
            if key == "LD_LIBRARY_PATH" {
                search.push(":");
                search.push(value);
                return false;
            }
            !(key == "GTK_THEME" && value.to_string_lossy().starts_with("Adwaita:"))
        })
        .collect();
    vars.push(("LD_LIBRARY_PATH".into(), search));
    vars
}

/// The host's WebKitGTK version, if the binary starts on the host libraries.
fn host_webkit_version(exe: &Path, env: &[(OsString, OsString)]) -> Option<Version> {
    let output = Command::new(exe)
        .arg(VERSION_FLAG)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_version(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
}

/// Restarts the AppImage on a newer host WebKitGTK; returns when it stays.
pub fn use_host_webkit() {
    if let Some(dir) = std::env::var_os(HOST_MARKER) {
        // Restarted: the loader already searched the host directory, so
        // children (WebKit's helpers, Python, FFmpeg) get the plain host path.
        std::env::remove_var(HOST_MARKER);
        restore_library_path(&dir);
        let (major, minor, micro) = webkit_version();
        log::info!("Using the system WebKitGTK {major}.{minor}.{micro} from {}", dir.to_string_lossy());
        return;
    }
    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os(OPT_OUT).is_some_and(|value| value == "1") {
        return;
    }
    let bundled = webkit_version();
    let (Some(dir), Ok(exe)) = (host_library_dir(), std::env::current_exe()) else {
        return;
    };
    let env = host_environment(&dir);
    let Some(host) = host_webkit_version(&exe, &env) else {
        log::info!("The system WebKitGTK did not load; using the bundled one");
        return;
    };
    if host <= bundled {
        return;
    }
    log::info!(
        "Restarting on the system WebKitGTK {}.{}.{} (bundled {}.{}.{})",
        host.0,
        host.1,
        host.2,
        bundled.0,
        bundled.1,
        bundled.2
    );
    let error = Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .env(HOST_MARKER, &dir)
        .exec();
    log::warn!("Could not restart on the system WebKitGTK: {error}");
}

/// Drops the leading host directory [`host_environment`] added.
fn restore_library_path(dir: &OsStr) {
    let Some(value) = std::env::var_os("LD_LIBRARY_PATH") else { return };
    let value = value.to_string_lossy().into_owned();
    let dir = dir.to_string_lossy();
    match value.strip_prefix(dir.as_ref()) {
        Some("") => std::env::remove_var("LD_LIBRARY_PATH"),
        Some(rest) if rest.starts_with(':') => std::env::set_var("LD_LIBRARY_PATH", &rest[1..]),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("2.54.1\n"), Some((2, 54, 1)));
        assert_eq!(parse_version("2.54"), None);
        assert_eq!(parse_version("x"), None);
        assert_eq!(parse_version("2.54.1.0"), None);
        assert!(parse_version("2.54.1").unwrap() > parse_version("2.50.4").unwrap());
    }

    #[test]
    fn host_libraries_take_precedence_without_losing_appimage_identity() {
        let vars = [
            ("LD_LIBRARY_PATH", "/opt/custom/lib"),
            ("APPIMAGE", "/home/me/Delulu.AppImage"),
            ("APPDIR", "/tmp/.mount_Delulu"),
            ("GTK_THEME", "Adwaita:dark"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        let env: std::collections::HashMap<_, _> = with_host_library_dir(vars, Path::new("/usr/lib")).into_iter().collect();
        assert_eq!(env[OsStr::new("LD_LIBRARY_PATH")], "/usr/lib:/opt/custom/lib");
        assert_eq!(env[OsStr::new("APPIMAGE")], "/home/me/Delulu.AppImage");
        assert_eq!(env[OsStr::new("APPDIR")], "/tmp/.mount_Delulu");
        assert!(!env.contains_key(OsStr::new("GTK_THEME")));
    }

    #[test]
    fn unavailable_host_libraries_leave_the_bundle_in_use() {
        assert_eq!(host_webkit_version(Path::new("/nonexistent/delulu-talks"), &[]), None);
        assert_eq!(host_webkit_version(Path::new("/usr/bin/false"), &[]), None);
    }
}
