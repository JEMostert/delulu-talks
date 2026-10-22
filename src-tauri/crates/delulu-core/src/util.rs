//! Small helpers shared by every crate.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, like `Date.now()`.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A random UUID v4, like `crypto.randomUUID()`.
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Writes `bytes` to a new private temporary file beside `path`, fsyncs it
/// and returns its path. The caller publishes it with [`publish`]. Files are
/// created exclusively with mode 0600 on Unix.
pub fn stage_private(path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temporary = path.with_file_name(format!("{name}.{}.tmp", uuid()));
    let result = (|| {
        let mut file = create_private(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

/// Renames a staged file over `path`, removing the staged file on failure.
pub fn publish(temporary: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(temporary);
    })
}

/// Atomic private replacement: stage, fsync, rename.
pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = stage_private(path, bytes)?;
    publish(&temporary, path)
}

/// Creates a new file exclusively, readable only by the owner on Unix.
pub fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Truncates to at most `max` UTF-16 code units without splitting a
/// surrogate pair, matching the renderer's JavaScript string limits.
pub fn truncate_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// Length in UTF-16 code units (JavaScript `string.length`).
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_private_atomic(&path, b"one").unwrap();
        write_private_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn utf16_truncation_respects_surrogates() {
        assert_eq!(truncate_utf16("ab😀c", 3), "ab");
        assert_eq!(truncate_utf16("ab😀c", 4), "ab😀");
        assert_eq!(utf16_len("ab😀"), 4);
    }
}
