//! Local data overview (`localData.ts`).
//!
//! Metadata only: never reads transcript/settings content, follows links or
//! mutates data. Blocking; run it on a blocking task for large profiles.

use std::fs;
use std::path::{Path, PathBuf};

use delulu_core::error::io_error_code;
use delulu_core::now_ms;
use delulu_domain::{LocalDataCategory, LocalDataCategoryId, LocalDataLocation, LocalDataOverview, LocalDataStatus};

const SCAN_LIMIT: usize = 100_000;
const LIMIT_PROBLEM: &str = "Scan limit reached; size is a lower bound.";

pub fn inspect_local_data_location(path: &Path) -> LocalDataLocation {
    let mut result = LocalDataLocation {
        path: path.to_string_lossy().into_owned(),
        status: LocalDataStatus::Present,
        bytes: 0,
        files: 0,
        skipped_links: 0,
        problems: Vec::new(),
    };
    let mut pending: Vec<PathBuf> = vec![path.to_path_buf()];
    let mut visited = 0;
    while let Some(current) = pending.pop() {
        visited += 1;
        if visited > SCAN_LIMIT {
            result.status = LocalDataStatus::Partial;
            result.problems.push(LIMIT_PROBLEM.into());
            break;
        }
        let outcome = (|| -> std::io::Result<()> {
            let stat = fs::symlink_metadata(&current)?;
            if stat.file_type().is_symlink() {
                result.skipped_links += 1;
            } else if stat.is_dir() {
                let names: Vec<_> = fs::read_dir(&current)?.filter_map(Result::ok).map(|e| e.file_name()).collect();
                let available = SCAN_LIMIT.saturating_sub(visited + pending.len());
                for name in names.iter().take(available) {
                    pending.push(current.join(name));
                }
                if names.len() > available {
                    result.status = LocalDataStatus::Partial;
                    if !result.problems.iter().any(|p| p == LIMIT_PROBLEM) {
                        result.problems.push(LIMIT_PROBLEM.into());
                    }
                }
            } else if stat.is_file() {
                result.bytes += stat.len();
                result.files += 1;
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            let code = io_error_code(&error).unwrap_or("UNKNOWN");
            if current == path && code == "ENOENT" {
                result.status = LocalDataStatus::Missing;
            } else {
                result.status = LocalDataStatus::Partial;
                if result.problems.len() < 5 {
                    result.problems.push(format!("{}: {code}", current.display()));
                }
            }
        }
    }
    result
}

pub fn local_data_overview(data_directory: &Path) -> LocalDataOverview {
    let definitions: [(LocalDataCategoryId, &str, &str, &[&str]); 5] = [
        (
            LocalDataCategoryId::History,
            "History",
            "Saved original transcripts, corrections and rewrites. Turning off history stops new saves; existing text remains.",
            &["history.json", "history.json.tmp"],
        ),
        (
            LocalDataCategoryId::Settings,
            "Settings",
            "Preferences, vocabulary, shortcuts and local permission tokens, including any interrupted settings write.",
            &["settings.json", "settings.json.tmp"],
        ),
        (
            LocalDataCategoryId::Models,
            "Model cache",
            "Downloaded speech, optional Qwen 3.5 and voice weights, download cache and converted checkpoints. Separate from Python runtimes.",
            &["models"],
        ),
        (
            LocalDataCategoryId::Runtimes,
            "Runtimes",
            "Speech, writing, voice and preserved legacy Python environments. A legacy environment may still be used for writing; presence does not establish readiness.",
            &["speech-venv", "magic-venv", "voice-venv", "asr-venv"],
        ),
        (
            LocalDataCategoryId::Audio,
            "Temporary audio",
            "Recording files, including failed recordings retained for retry. Imported source audio stays at its original location and is not counted here.",
            &["audio-cache"],
        ),
    ];
    let categories = definitions
        .into_iter()
        .map(|(id, label, description, paths)| LocalDataCategory {
            id,
            label: label.into(),
            description: description.into(),
            locations: paths.iter().map(|path| inspect_local_data_location(&data_directory.join(path))).collect(),
        })
        .collect();
    LocalDataOverview {
        data_directory: data_directory.to_string_lossy().into_owned(),
        checked_at: now_ms(),
        categories,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_files_and_reports_missing_locations() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("history.json"), "[]").unwrap();
        fs::create_dir_all(dir.path().join("models/a")).unwrap();
        fs::write(dir.path().join("models/a/w.bin"), [0u8; 10]).unwrap();
        let overview = local_data_overview(dir.path());
        let history = &overview.categories[0].locations;
        assert_eq!((history[0].status, history[0].bytes), (LocalDataStatus::Present, 2));
        assert_eq!(history[1].status, LocalDataStatus::Missing);
        assert_eq!(overview.categories[2].locations[0].bytes, 10);
    }
}
