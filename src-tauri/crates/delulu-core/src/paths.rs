//! Profile and resource locations.
//!
//! The profile directory stays where the Electron releases kept it
//! (`~/.config/Delulu Talks` on Linux, `~/Library/Application Support/Delulu
//! Talks` on macOS, `%APPDATA%\Delulu Talks` on Windows), so settings,
//! history, Python runtimes and multi-gigabyte model downloads carry over.
//! Development builds use `Delulu Talks Dev`; `DELULU_USER_DATA_DIR`
//! overrides both. Tauri's identifier-based directory is deliberately not
//! used: `~/.local/share/com.joran.delulu-talks` is the legacy location that
//! storage migrates *from*.

use std::path::{Path, PathBuf};

pub const PRODUCT_NAME: &str = "Delulu Talks";
pub const DEV_PRODUCT_NAME: &str = "Delulu Talks Dev";
pub const SETTINGS_FILE: &str = "settings.json";
pub const HISTORY_FILE: &str = "history.json";

#[derive(Debug, Clone)]
pub struct AppPaths {
    /// Profile directory (Electron's `userData`).
    pub data: PathBuf,
    /// Bundled read-only resources: `python/`, `overlay/`, `voice/`, `tray/`.
    pub resources: PathBuf,
    pub home: PathBuf,
    pub packaged: bool,
}

impl AppPaths {
    /// Resolves the profile directory for this build. `resources` is the
    /// bundle's resource directory, or the repository root in development.
    pub fn resolve(packaged: bool, resources: PathBuf) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let data = match std::env::var_os("DELULU_USER_DATA_DIR") {
            Some(dir) if !dir.is_empty() => absolute(PathBuf::from(dir)),
            _ => {
                let base = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
                base.join(if packaged { PRODUCT_NAME } else { DEV_PRODUCT_NAME })
            }
        };
        Self { data, resources, home, packaged }
    }

    /// Fixed locations, for tests.
    pub fn at(data: impl Into<PathBuf>, resources: impl Into<PathBuf>) -> Self {
        let data = data.into();
        Self { home: data.clone(), data, resources: resources.into(), packaged: false }
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data.join(SETTINGS_FILE)
    }
    pub fn history_file(&self) -> PathBuf {
        self.data.join(HISTORY_FILE)
    }
    pub fn audio_cache(&self) -> PathBuf {
        self.data.join("audio-cache")
    }
    pub fn speech_venv(&self) -> PathBuf {
        self.data.join("speech-venv")
    }
    /// Releases before split runtimes installed Magic into `asr-venv`; keep
    /// using a working legacy environment instead of forcing a reinstall.
    pub fn magic_venv(&self) -> PathBuf {
        let dedicated = self.data.join("magic-venv");
        let legacy = self.legacy_venv();
        if dedicated.exists() || !legacy.exists() {
            dedicated
        } else {
            legacy
        }
    }
    pub fn legacy_venv(&self) -> PathBuf {
        self.data.join("asr-venv")
    }
    pub fn voice_venv(&self) -> PathBuf {
        self.data.join("voice-venv")
    }
    /// Voice bridge socket, `bridge.json`, reference clips and the agent script.
    pub fn voice_dir(&self) -> PathBuf {
        self.data.join("voice")
    }
    pub fn models(&self) -> PathBuf {
        self.data.join("models")
    }
    pub fn runtime_cache(&self, role: &str) -> PathBuf {
        self.data.join("runtime-cache").join(role)
    }

    /// A bundled resource. Packaged builds read from the resource directory;
    /// development builds map to the source tree (see [`dev_resource`]).
    pub fn resource(&self, relative: &str) -> PathBuf {
        if self.packaged {
            self.resources.join(relative)
        } else {
            self.resources.join(dev_resource(relative))
        }
    }

    /// Legacy Linux profile locations from the original Tauri releases.
    pub fn legacy_profile_candidates(&self) -> Vec<PathBuf> {
        if !self.packaged || !cfg!(target_os = "linux") {
            return Vec::new();
        }
        let share = self.home.join(".local").join("share");
        vec![share.join("com.joran.delulu-talks"), share.join("delulu-talks")]
    }
}

/// Maps a packaged resource path to its source-tree location.
pub fn dev_resource(relative: &str) -> PathBuf {
    let (head, rest) = relative.split_once('/').unwrap_or((relative, ""));
    match head {
        "python" if rest.ends_with(".md") || rest.starts_with("licenses/") => {
            if rest == "THIRD_PARTY_NOTICES.md" {
                PathBuf::from("docs/THIRD_PARTY_NOTICES.md")
            } else {
                Path::new("docs").join(rest)
            }
        }
        "python" => Path::new("backend/python").join(rest),
        "overlay" => Path::new("backend/overlay").join(rest),
        "voice" if rest == "skill/SKILL.md" => PathBuf::from("skills/delulu-voice/SKILL.md"),
        "voice" => Path::new("backend/voice").join(rest),
        "tray" => Path::new("build/tray").join(rest),
        "icon.png" => PathBuf::from("build/icon.png"),
        _ => PathBuf::from(relative),
    }
}

fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map(|cwd| cwd.join(&path)).unwrap_or(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_resources_map_to_source_tree() {
        assert_eq!(dev_resource("python/worker_protocol.py"), PathBuf::from("backend/python/worker_protocol.py"));
        assert_eq!(dev_resource("python/THIRD_PARTY_NOTICES.md"), PathBuf::from("docs/THIRD_PARTY_NOTICES.md"));
        assert_eq!(dev_resource("overlay/pill.py"), PathBuf::from("backend/overlay/pill.py"));
        assert_eq!(dev_resource("voice/skill/SKILL.md"), PathBuf::from("skills/delulu-voice/SKILL.md"));
        assert_eq!(dev_resource("tray/tray-idle.png"), PathBuf::from("build/tray/tray-idle.png"));
    }

    #[test]
    fn legacy_magic_venv_is_reused_only_when_dedicated_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::at(dir.path(), dir.path());
        assert_eq!(paths.magic_venv(), dir.path().join("magic-venv"));
        std::fs::create_dir(dir.path().join("asr-venv")).unwrap();
        assert_eq!(paths.magic_venv(), dir.path().join("asr-venv"));
        std::fs::create_dir(dir.path().join("magic-venv")).unwrap();
        assert_eq!(paths.magic_venv(), dir.path().join("magic-venv"));
    }
}
