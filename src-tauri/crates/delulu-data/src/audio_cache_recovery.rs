//! Removal of generated recording WAVs left by an earlier session
//! (`audioCacheRecovery.ts`). Run once after the single-instance lock,
//! before workers, capture or import can start.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCacheRecovery {
    pub removed: u64,
    pub skipped: u64,
    pub failure_count: u64,
    pub failures: Vec<String>,
}

fn generated_audio() -> &'static Regex {
    // These are the files created exclusively by dictation and import, never an imported source path.
    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
            r"^(?:dictation|import)-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$",
        )
        .expect("valid regex")
    });
    &RE
}

fn single_link(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() == 1
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

/// Removes prior-session generated WAVs older than `started_at` (epoch ms).
/// Never recurses, follows links or touches anything else.
pub fn recover_temporary_audio(cache_directory: &Path, started_at: u64) -> AudioCacheRecovery {
    let mut report = AudioCacheRecovery::default();
    let fail = |report: &mut AudioCacheRecovery, name: &str, detail: &str| {
        report.failure_count += 1;
        if report.failures.len() < 20 {
            report.failures.push(format!("{name}: {}", delulu_core::util::truncate_utf16(detail, 500)));
        }
    };
    let names: Vec<String> = match fs::symlink_metadata(cache_directory) {
        Ok(stat) if !stat.is_dir() || stat.file_type().is_symlink() => {
            fail(
                &mut report,
                "Audio cache",
                "Expected Delulu's own regular audio-cache directory; cleanup did not follow this path.",
            );
            return report;
        }
        Ok(_) => match fs::read_dir(cache_directory) {
            Ok(entries) => entries.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
            Err(error) => {
                fail(&mut report, "Audio cache", &error.to_string());
                return report;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return report,
        Err(error) => {
            fail(&mut report, "Audio cache", &error.to_string());
            return report;
        }
    };
    for name in names {
        let created = generated_audio().captures(&name).and_then(|c| c[1].parse::<u64>().ok());
        if created.is_none_or(|created| created >= started_at) {
            report.skipped += 1;
            continue;
        }
        let path = cache_directory.join(&name);
        let result = (|| -> std::io::Result<bool> {
            // lstat inspects the entry itself. Never recurse, follow links or touch source media.
            let file = fs::symlink_metadata(&path)?;
            let modified = file.modified()?.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            if !file.is_file() || file.file_type().is_symlink() || !single_link(&file) || modified >= started_at {
                return Ok(false);
            }
            fs::remove_file(&path)?;
            Ok(true)
        })();
        match result {
            Ok(true) => report.removed += 1,
            Ok(false) => report.skipped += 1,
            // Another cleanup may already have removed the entry; other failures remain visible.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => fail(&mut report, &name, &error.to_string()),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_old_generated_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let old = "dictation-1000000000000-0b6f1a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.wav";
        let other = "notes.wav";
        fs::write(dir.path().join(old), b"x").unwrap();
        fs::write(dir.path().join(other), b"x").unwrap();
        let report = recover_temporary_audio(dir.path(), delulu_core::now_ms() + 10_000);
        assert_eq!((report.removed, report.skipped, report.failure_count), (1, 1, 0));
        assert!(dir.path().join(other).exists());
        assert_eq!(recover_temporary_audio(&dir.path().join("missing"), 0), AudioCacheRecovery::default());
    }
}
