//! Development desktop entry (Linux). xdg-desktop-portal accepts the
//! GlobalShortcuts `Registry.Register("delulu-talks")` call only when a
//! `delulu-talks.desktop` file is installed, so development builds write one
//! pointing at the current executable (`ensureDevelopmentDesktopEntry`).
//! An existing entry anywhere on the XDG data path is never touched: a
//! user-local file would shadow an installed package's entry.

use std::path::{Path, PathBuf};

pub const FILE: &str = "delulu-talks.desktop";

fn data_home() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => dirs_home().join(".local").join("share"),
    }
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn data_dirs() -> Vec<PathBuf> {
    let value = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
    let value = if value.trim().is_empty() { "/usr/local/share:/usr/share".to_owned() } else { value };
    value.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from).collect()
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn entry(executable: &Path, icon: &Path) -> String {
    [
        "[Desktop Entry]".to_owned(),
        "Type=Application".to_owned(),
        "Name=Delulu Talks Dev".to_owned(),
        format!("Exec={}", quote(&executable.to_string_lossy())),
        format!("Icon={}", icon.display()),
        "Terminal=false".to_owned(),
        "NoDisplay=true".to_owned(),
        "Categories=AudioVideo;Utility;".to_owned(),
        "StartupWMClass=delulu-talks".to_owned(),
        String::new(),
    ]
    .join("\n")
}

/// Writes `$XDG_DATA_HOME/applications/delulu-talks.desktop` for a
/// development build when no entry of that name exists yet.
pub fn ensure_development_entry(icon: &Path) {
    if !cfg!(target_os = "linux") || !cfg!(debug_assertions) {
        return;
    }
    let target = data_home().join("applications").join(FILE);
    let installed = std::iter::once(target.clone())
        .chain(data_dirs().into_iter().map(|dir| dir.join("applications").join(FILE)))
        .any(|path| path.exists());
    if installed {
        return;
    }
    let Ok(executable) = std::env::current_exe() else { return };
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(target.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(&target, entry(&executable, icon))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => log::info!("Wrote development desktop entry {}", target.display()),
        Err(error) => log::warn!("Could not write {}: {error}", target.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_quotes_the_executable_and_matches_the_wm_class() {
        let text = entry(Path::new("/opt/my \"app\"/delulu-talks"), Path::new("/repo/build/icon.png"));
        assert!(text.contains("Exec=\"/opt/my \\\"app\\\"/delulu-talks\"\n"));
        assert!(text.contains("StartupWMClass=delulu-talks\n"));
    }
}
