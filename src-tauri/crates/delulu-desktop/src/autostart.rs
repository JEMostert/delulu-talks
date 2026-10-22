//! Launch at login (`autostart.ts` and `syncLoginItem` in `main.ts`).
//! Linux writes an XDG autostart entry; macOS and Windows go through the
//! app's login-item integration ([`LoginItems`], e.g.
//! tauri-plugin-autostart / SMAppService).

use std::fs;
use std::path::{Path, PathBuf};

use crate::env::DesktopEnv;
use crate::types::Platform;

const FILE: &str = "delulu-talks.desktop";

/// `$XDG_CONFIG_HOME/autostart/delulu-talks.desktop`.
pub fn linux_autostart_path(env: &DesktopEnv) -> PathBuf {
    let config = env
        .var("XDG_CONFIG_HOME")
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"));
    config.join("autostart").join(FILE)
}

fn quote(path: &str) -> String {
    if path.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | '$' | '`')) {
        let mut quoted = String::with_capacity(path.len() + 2);
        quoted.push('"');
        for c in path.chars() {
            if matches!(c, '"' | '\\' | '$' | '`') {
                quoted.push('\\');
            }
            quoted.push(c);
        }
        quoted.push('"');
        quoted
    } else {
        path.to_owned()
    }
}

pub fn linux_autostart_entry(executable: &str) -> String {
    [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Delulu Talks",
        "Comment=Private local dictation",
        &format!("Exec={} --hidden", quote(executable)),
        "Icon=delulu-talks",
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ]
    .join("\n")
}

/// An AppImage starts from its stable image path, not the mounted binary.
pub fn autostart_executable(env: &DesktopEnv) -> PathBuf {
    match env.var("APPIMAGE").filter(|path| !path.is_empty()) {
        Some(image) => PathBuf::from(image),
        None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("delulu-talks")),
    }
}

/// Writes (mode 0644) or removes the entry.
pub fn set_linux_autostart(enabled: bool, env: &DesktopEnv, executable: &Path) -> std::io::Result<()> {
    let path = linux_autostart_path(env);
    if !enabled {
        return match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, linux_autostart_entry(&executable.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
    }
    Ok(())
}

pub fn linux_autostart_enabled(env: &DesktopEnv) -> bool {
    linux_autostart_path(env).exists()
}

/// macOS/Windows login items, implemented by the app crate.
pub trait LoginItems: Send + Sync {
    /// `args` is `["--hidden"]` on Windows and empty on macOS (Electron
    /// passed no args there; the app detects a login launch itself).
    fn set_open_at_login(&self, enabled: bool, args: &[&str]) -> Result<(), String>;
}

/// Applies `settings.launchAtLogin`. The caller skips this for unpackaged
/// builds and smoke tests. The error is the user-facing notification text.
pub fn sync_login_item(enabled: bool, env: &DesktopEnv, login_items: Option<&dyn LoginItems>) -> Result<(), String> {
    let result = match env.platform {
        Platform::Linux => set_linux_autostart(enabled, env, &autostart_executable(env)).map_err(|e| e.to_string()),
        Platform::Win32 => login_items.map_or(Ok(()), |items| items.set_open_at_login(enabled, &["--hidden"])),
        Platform::Darwin => login_items.map_or(Ok(()), |items| items.set_open_at_login(enabled, &[])),
    };
    result.map_err(|reason| format!("Could not change launch at login: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_autostart_writes_and_removes_an_xdg_entry() {
        let dir = tempfile::tempdir().unwrap();
        let env = DesktopEnv::new(Platform::Linux, [("XDG_CONFIG_HOME", dir.path().to_str().unwrap())]);
        set_linux_autostart(true, &env, Path::new("/opt/Delulu Talks/delulu-talks")).unwrap();
        assert_eq!(linux_autostart_path(&env), dir.path().join("autostart").join("delulu-talks.desktop"));
        let entry = fs::read_to_string(linux_autostart_path(&env)).unwrap();
        assert!(entry.contains("Exec=\"/opt/Delulu Talks/delulu-talks\" --hidden"));
        assert!(linux_autostart_enabled(&env));
        set_linux_autostart(false, &env, Path::new("unused")).unwrap();
        assert!(!linux_autostart_enabled(&env));
        set_linux_autostart(false, &env, Path::new("unused")).unwrap();
        assert_eq!(quote("/a/$b`c\""), "\"/a/\\$b\\`c\\\"\"");
        assert_eq!(quote("/usr/bin/delulu-talks"), "/usr/bin/delulu-talks");
    }

    #[test]
    fn appimage_path_is_preferred_for_exec() {
        let env = DesktopEnv::new(Platform::Linux, [("APPIMAGE", "/home/me/Apps/Delulu.AppImage")]);
        assert_eq!(autostart_executable(&env), PathBuf::from("/home/me/Apps/Delulu.AppImage"));
    }
}
