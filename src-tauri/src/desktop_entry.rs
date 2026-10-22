//! Desktop entry for builds that no package installs (Linux). xdg-desktop-portal
//! accepts the GlobalShortcuts `Registry.Register("delulu-talks")` call only
//! when a `delulu-talks.desktop` file is installed. The deb, rpm and pacman
//! packages ship one; development builds and AppImages write a hidden one to
//! `$XDG_DATA_HOME/applications` pointing at the current executable or
//! `$APPIMAGE`. A package's entry is never shadowed, and a user-local entry is
//! only rewritten when this app wrote it (`X-Delulu-Managed`) and the
//! executable moved.

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

const MANAGED: &str = "X-Delulu-Managed=true";

pub fn entry(executable: &Path, icon: &Path) -> String {
    let name = if cfg!(debug_assertions) { "Delulu Talks Dev" } else { "Delulu Talks" };
    [
        "[Desktop Entry]".to_owned(),
        "Type=Application".to_owned(),
        format!("Name={name}"),
        format!("Exec={}", quote(&executable.to_string_lossy())),
        format!("Icon={}", icon.display()),
        "Terminal=false".to_owned(),
        "NoDisplay=true".to_owned(),
        "Categories=AudioVideo;Utility;".to_owned(),
        "StartupWMClass=delulu-talks".to_owned(),
        MANAGED.to_owned(),
        String::new(),
    ]
    .join("\n")
}

/// Writes `$XDG_DATA_HOME/applications/delulu-talks.desktop` for a
/// development build or an AppImage when no package provides the entry.
pub fn ensure_development_entry(icon: &Path) {
    let appimage = std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()).map(PathBuf::from);
    if !cfg!(target_os = "linux") || !(cfg!(debug_assertions) || appimage.is_some()) {
        return;
    }
    let Some(executable) = appimage.or_else(|| std::env::current_exe().ok()) else { return };
    let target = data_home().join("applications").join(FILE);
    if data_dirs().into_iter().any(|dir| dir.join("applications").join(FILE).exists()) {
        return;
    }
    let content = entry(&executable, icon);
    if let Ok(existing) = std::fs::read_to_string(&target) {
        if !existing.contains(MANAGED) || existing == content {
            return;
        }
    }
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(target.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(&target, &content)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => log::info!("Wrote desktop entry {}", target.display()),
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
