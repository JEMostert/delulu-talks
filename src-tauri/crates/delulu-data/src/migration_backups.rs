//! Raw profile snapshots taken before a migration rewrites settings or
//! history (`migrationBackups.ts`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use delulu_core::util::create_private;
use delulu_core::{now_ms, uuid, DomainError};
use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{json as js, plain_error};

pub const BACKUP_DIRECTORY: &str = "migration-backups";
const OWNER: &str = "delulu-profile-migration";
const FILES: [&str; 2] = ["settings.json", "history.json"];

fn snapshot_name() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^migration-\d+-[0-9a-f-]{36}$").expect("valid regex"));
    &RE
}

fn pending_name() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^\.pending-\d+-[0-9a-f-]{36}$").expect("valid regex"));
    &RE
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct Snapshot {
    directory: PathBuf,
    manifest: Map<String, Value>,
    created_at: f64,
    files: Map<String, Value>,
}

fn completed_snapshots(root: &Path, include_pending: bool) -> std::io::Result<Vec<Snapshot>> {
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.file_type()?.is_dir()
            || (!snapshot_name().is_match(&name) && !(include_pending && pending_name().is_match(&name)))
        {
            continue;
        }
        let directory = root.join(&name);
        let Ok(text) = fs::read_to_string(directory.join("manifest.json")) else { continue };
        let Ok(Value::Object(manifest)) = serde_json::from_str::<Value>(&text) else { continue };
        let created_at = manifest.get("createdAt").and_then(Value::as_f64);
        let files = manifest.get("files").and_then(Value::as_object).cloned();
        let (Some(created_at), Some(files)) = (created_at, files) else { continue };
        if manifest.get("owner").and_then(Value::as_str) != Some(OWNER)
            || manifest.get("version").and_then(Value::as_f64) != Some(1.0)
            || files.keys().any(|name| !FILES.contains(&name.as_str()))
        {
            continue;
        }
        snapshots.push(Snapshot { directory, manifest, created_at, files });
    }
    Ok(snapshots)
}

fn write_new_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = create_private(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn create_private_dir(path: &Path, recursive: bool) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Copies the raw source files into a new snapshot before any migration
/// write, reusing an identical verified snapshot. Keeps the newest five.
/// Sources map `settings.json`/`history.json` to the file to copy.
pub fn backup_profile_migration(data_directory: &Path, sources: &[(&str, Option<PathBuf>)]) -> Result<(), DomainError> {
    let mut contents: Vec<(&str, Vec<u8>)> = Vec::new();
    for name in FILES {
        let path = sources.iter().find(|(n, _)| *n == name).and_then(|(_, p)| p.clone());
        if let Some(path) = path.filter(|p| p.exists()) {
            contents.push((name, fs::read(&path)?));
        }
    }
    if contents.is_empty() {
        return Ok(());
    }
    let root = data_directory.join(BACKUP_DIRECTORY);
    create_private_dir(&root, true)?;
    let expected: Map<String, Value> =
        contents.iter().map(|(name, bytes)| (name.to_string(), Value::String(sha256_hex(bytes)))).collect();
    let mut completed = completed_snapshots(&root, false)?;
    // Verify reusable bytes, not merely a matching manifest, before skipping a backup.
    let mut keep = completed
        .iter()
        .find(|snapshot| {
            snapshot.files.len() == contents.len()
                && contents.iter().all(|(name, _)| {
                    snapshot.files.get(*name) == expected.get(*name)
                        && fs::read(snapshot.directory.join(name))
                            .map(|bytes| Some(&Value::String(sha256_hex(&bytes))) == expected.get(*name))
                            .unwrap_or(false)
                })
        })
        .map(|snapshot| snapshot.directory.clone());
    if keep.is_none() {
        let id = format!("{}-{}", now_ms(), uuid());
        let pending = root.join(format!(".pending-{id}"));
        let destination = root.join(format!("migration-{id}"));
        create_private_dir(&pending, false)?;
        let result = (|| -> std::io::Result<()> {
            // Ownership metadata precedes copied history, so explicit deletion can
            // revoke history from an interrupted pending snapshot as well.
            let manifest = json!({"owner": OWNER, "version": 1, "createdAt": now_ms(), "files": expected});
            write_new_private(&pending.join("manifest.json"), js::profile_bytes(&manifest).as_bytes())?;
            for (name, bytes) in &contents {
                write_new_private(&pending.join(name), bytes)?;
            }
            fs::rename(&pending, &destination)
        })();
        if let Err(error) = result {
            if let Err(cleanup) = fs::remove_dir_all(&pending) {
                if cleanup.kind() != std::io::ErrorKind::NotFound {
                    return Err(plain_error(format!(
                        "Migration backup failed and its partial snapshot could not be removed: {error}; {cleanup}"
                    )));
                }
            }
            return Err(plain_error(
                "Could not preserve a backup before profile migration; existing profile files were not replaced",
            ));
        }
        keep = Some(destination);
        completed = completed_snapshots(&root, false)?;
    }
    // Always retain the current source snapshot, even if the system clock moved.
    let mut old: Vec<Snapshot> = completed.into_iter().filter(|s| Some(&s.directory) != keep.as_ref()).collect();
    old.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
    for snapshot in old.iter().skip(4) {
        remove_dir_retrying(&snapshot.directory)?;
    }
    Ok(())
}

fn remove_dir_retrying(path: &Path) -> std::io::Result<()> {
    retry(|| match fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
}

fn remove_file_force(path: &Path) -> std::io::Result<()> {
    retry(|| match fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
}

fn retry(mut action: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match action() {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 3 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(error) => return Err(error),
        }
    }
}

/// The history deletion itself is durable; only revoking backup copies failed.
pub fn history_backup_cleanup_error(cause: &str) -> DomainError {
    DomainError::failed(format!(
        "The deletion was saved, but older copies in migration backups could not be removed ({cause}). Delete another transcript to retry, or remove the migration-backups folder from the data directory."
    ))
    .with_cause("HistoryBackupCleanupError", None)
}

/// Whether an error is a [`history_backup_cleanup_error`]: the deletion was
/// saved, so callers update session state and then report the failure.
pub fn is_history_backup_cleanup_error(error: &DomainError) -> bool {
    error.cause.as_ref().is_some_and(|cause| cause.name == "HistoryBackupCleanupError")
}

/// Explicit history deletion also revokes historical backup copies of that content.
pub fn remove_migration_history_backups(data_directory: &Path) -> std::io::Result<()> {
    let root = data_directory.join(BACKUP_DIRECTORY);
    if !root.exists() {
        return Ok(());
    }
    for snapshot in completed_snapshots(&root, true)? {
        if !snapshot.files.contains_key("history.json") {
            continue;
        }
        remove_file_force(&snapshot.directory.join("history.json"))?;
        let mut remaining = snapshot.files.clone();
        remaining.shift_remove("history.json");
        if remaining.is_empty() {
            remove_dir_retrying(&snapshot.directory)?;
            continue;
        }
        let mut manifest = snapshot.manifest.clone();
        manifest.insert("files".into(), Value::Object(remaining));
        let temporary = snapshot.directory.join(format!("manifest-{}.tmp", uuid()));
        let result = write_new_private(&temporary, js::profile_bytes(&Value::Object(manifest)).as_bytes())
            .and_then(|()| fs::rename(&temporary, snapshot.directory.join("manifest.json")));
        let _ = fs::remove_file(&temporary);
        result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_are_reused_and_history_copies_are_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let history = dir.path().join("history.json");
        fs::write(&settings, "{}").unwrap();
        fs::write(&history, "[]").unwrap();
        let sources = [("settings.json", Some(settings.clone())), ("history.json", Some(history.clone()))];
        backup_profile_migration(dir.path(), &sources).unwrap();
        backup_profile_migration(dir.path(), &sources).unwrap();
        let root = dir.path().join(BACKUP_DIRECTORY);
        let snapshots: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(fs::read(snapshots[0].join("history.json")).unwrap(), b"[]");
        remove_migration_history_backups(dir.path()).unwrap();
        assert!(!snapshots[0].join("history.json").exists());
        let manifest: Value = serde_json::from_str(&fs::read_to_string(snapshots[0].join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["files"].as_object().unwrap().keys().collect::<Vec<_>>(), ["settings.json"]);
    }

    #[test]
    fn keeps_the_newest_five_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        for index in 0..7 {
            fs::write(&settings, format!("{{\"n\":{index}}}")).unwrap();
            backup_profile_migration(dir.path(), &[("settings.json", Some(settings.clone()))]).unwrap();
        }
        assert_eq!(fs::read_dir(dir.path().join(BACKUP_DIRECTORY)).unwrap().count(), 5);
    }
}
