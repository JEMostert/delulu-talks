//! Desktop entry for builds that no package installs (Linux). xdg-desktop-portal
//! accepts the GlobalShortcuts `Registry.Register("delulu-talks")` call only
//! when a `delulu-talks.desktop` file is installed. The deb, rpm and pacman
//! packages ship one; development builds and AppImages write a hidden one to
//! `$XDG_DATA_HOME/applications` pointing at the current executable or
//! `$APPIMAGE`. A user-local entry is only rewritten when this app wrote it and
//! the executable moved. Once a package provides the entry, a hidden one this
//! app left in the user's data directory is removed, because it would shadow
//! the package's launcher.

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

/// True for an entry this app wrote. Current builds mark it with
/// `X-Delulu-Managed`. Older builds wrote the same entry without the marker;
/// that one must match line for line, so a user's own edited launcher is
/// never mistaken for it.
fn written_by_us(text: &str) -> bool {
    if text.contains(MANAGED) {
        return true;
    }
    let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
    let [header, kind, name, exec, icon, terminal, hidden, categories, wm_class] = lines[..] else { return false };
    header == "[Desktop Entry]"
        && kind == "Type=Application"
        && (name == "Name=Delulu Talks" || name == "Name=Delulu Talks Dev")
        && exec.strip_prefix("Exec=\"").is_some_and(|rest| rest.ends_with("delulu-talks\"") && !rest.contains("\" "))
        && icon.starts_with("Icon=")
        && terminal == "Terminal=false"
        && hidden == "NoDisplay=true"
        && categories == "Categories=AudioVideo;Utility;"
        && wm_class == "StartupWMClass=delulu-talks"
}

/// Writes `$XDG_DATA_HOME/applications/delulu-talks.desktop` for a
/// development build or an AppImage when no package provides the entry, and
/// removes one this app wrote once a package does.
pub fn ensure_development_entry(icon: &Path) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let target = data_home().join("applications").join(FILE);
    let existing = std::fs::read_to_string(&target).ok();
    let ours = existing.as_deref().is_some_and(written_by_us);
    if data_dirs().into_iter().any(|dir| dir.join("applications").join(FILE).exists()) {
        if ours {
            match std::fs::remove_file(&target) {
                Ok(()) => log::info!("Removed {}; the installed package provides it", target.display()),
                Err(error) => log::warn!("Could not remove {}: {error}", target.display()),
            }
        }
        return;
    }
    let appimage = std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()).map(PathBuf::from);
    if !(cfg!(debug_assertions) || appimage.is_some()) {
        return;
    }
    let Some(executable) = appimage.or_else(|| std::env::current_exe().ok()) else { return };
    let content = entry(&executable, icon);
    if existing.is_some() && (!ours || existing.as_deref() == Some(content.as_str())) {
        return;
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

    #[test]
    fn recognizes_current_and_legacy_entries_but_not_user_ones() {
        assert!(written_by_us(&entry(Path::new("/x/delulu-talks"), Path::new("/x/icon.png"))));
        let legacy = entry(Path::new("/repo/target/debug/delulu-talks"), Path::new("/repo/build/icon.png"))
            .replace(&format!("{MANAGED}\n"), "");
        assert!(written_by_us(&legacy));
        // A hidden copy of the packaged launcher with a customized Exec stays the user's.
        let customized = legacy.replace(
            "Exec=\"/repo/target/debug/delulu-talks\"",
            "Exec=\"/usr/bin/delulu-talks\" --verbose",
        );
        assert!(!written_by_us(&customized));
        let packaged_copy = "[Desktop Entry]\nCategories=AudioVideo;Utility;\nComment=Dictation\nExec=delulu-talks\nIcon=delulu-talks\nName=Delulu Talks\nNoDisplay=true\nStartupWMClass=delulu-talks\nTerminal=false\nType=Application\n";
        assert!(!written_by_us(packaged_copy));
    }
}
