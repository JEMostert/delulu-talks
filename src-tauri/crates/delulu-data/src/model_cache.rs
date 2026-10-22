//! Model cache preview/cleanup and speech checkpoint downloads
//! (`modelCache.ts`; `models:downloads`, `models:deleteDownload`,
//! `cache:preview`, `cache:cleanup`).

use std::collections::HashMap;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

use delulu_core::{now_ms, uuid, DomainError, DomainResult};
use delulu_domain::{
    ModelCacheCleanupResult, ModelCacheEntry, ModelCacheFailure, ModelCachePreview, SpeechDownload, SpeechDownloadId,
};
use parking_lot::Mutex;

use crate::plain_error;

const VERIFIED: &str = "hub/delulu-verified";

struct DownloadDefinition {
    id: SpeechDownloadId,
    name: &'static str,
    paths: &'static [&'static str],
}

/// Where each speech checkpoint lives in the model cache, relative to its root.
const SPEECH_DOWNLOADS: &[DownloadDefinition] = &[
    DownloadDefinition {
        id: SpeechDownloadId::Canary180m,
        name: "Small · Canary 180M",
        paths: &["csukuangfj--sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8"],
    },
    DownloadDefinition {
        id: SpeechDownloadId::ParakeetV2,
        name: "Medium · Parakeet v2 (English)",
        paths: &["csukuangfj--sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"],
    },
    DownloadDefinition {
        id: SpeechDownloadId::ParakeetV3,
        name: "Medium · Parakeet v3 (Automatic)",
        paths: &["csukuangfj--sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"],
    },
    DownloadDefinition {
        id: SpeechDownloadId::R2t2,
        name: "Large · R2T2",
        paths: &[
            "netease-youdao--Confucius4-R2T2",
            "mlx-community--Confucius4-R2T2-bf16",
            "!hub/models--netease-youdao--Confucius4-R2T2",
            "!hub/models--mlx-community--Confucius4-R2T2-bf16",
            "!delulu-r2t2-transformers",
        ],
    },
];

/// Paths prefixed with `!` are relative to the root, others to the verified hub.
fn download_path(root: &Path, relative: &str) -> PathBuf {
    match relative.strip_prefix('!') {
        Some(path) => root.join(path),
        None => root.join(VERIFIED).join(relative),
    }
}

const PLAN_LIFETIME_MS: u64 = 10 * 60 * 1000;
const MAX_SIZE_NODES: usize = 20_000;
const MAX_SIZE_DEPTH: usize = 64;
const MAX_PREVIEW_CHILDREN: usize = 2_000;

/// Identity and change stamp of a directory entry (dev, ino, mtime, ctime, mode).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp(Vec<i128>);

fn stamp(metadata: &Metadata) -> Stamp {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Stamp(vec![
            i128::from(metadata.dev()),
            i128::from(metadata.ino()),
            i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec()),
            i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()),
            i128::from(metadata.mode()),
        ])
    }
    #[cfg(not(unix))]
    {
        let time = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos() as i128)
        };
        Stamp(vec![time(metadata.modified()), time(metadata.created()), i128::from(metadata.is_dir())])
    }
}

fn optional_stat(path: &Path) -> DomainResult<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn is_canonical(path: &Path) -> bool {
    fs::canonicalize(path).is_ok_and(|real| real == path)
}

fn safe_directory(path: &Path) -> DomainResult<Option<Stamp>> {
    let stat = optional_stat(path)?;
    if let Some(stat) = &stat {
        if !stat.is_dir() || stat.file_type().is_symlink() || !is_canonical(path) {
            return Err(plain_error("The model cache location is not a local directory. No cache was deleted."));
        }
    }
    Ok(stat.as_ref().map(stamp))
}

fn directory_names(path: &Path, budget: &mut usize) -> DomainResult<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if *budget == 0 {
            return Err(plain_error(
                "The model cache contains too many entries to preview safely. No cache was deleted.",
            ));
        }
        *budget -= 1;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// Counts link bytes without visiting targets, using one shared budget.
fn size_of(path: &Path, budget: &mut usize) -> (u64, bool) {
    fn visit(current: &Path, depth: usize, budget: &mut usize, bytes: &mut u64, complete: &mut bool) {
        if *budget == 0 {
            *complete = false;
            return;
        }
        *budget -= 1;
        if depth > MAX_SIZE_DEPTH {
            *complete = false;
            return;
        }
        let result = (|| -> std::io::Result<()> {
            let stat = fs::symlink_metadata(current)?;
            if !stat.is_dir() || stat.file_type().is_symlink() {
                *bytes += stat.len();
                return Ok(());
            }
            for child in fs::read_dir(current)? {
                if *budget == 0 {
                    *complete = false;
                    break;
                }
                visit(&child?.path(), depth + 1, budget, bytes, complete);
            }
            Ok(())
        })();
        if result.is_err() {
            *complete = false;
        }
    }
    let (mut bytes, mut complete) = (0, true);
    visit(path, 0, budget, &mut bytes, &mut complete);
    if bytes > 9_007_199_254_740_991 {
        complete = false;
    }
    (bytes, complete)
}

fn remove_force(path: &Path) -> std::io::Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(stat) if stat.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match result {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

struct PlannedEntry {
    path: PathBuf,
    snapshot: Stamp,
}

struct CleanupPlan {
    token: String,
    expires_at: u64,
    root: Option<Stamp>,
    hub: Option<Stamp>,
    entries: HashMap<String, PlannedEntry>,
}

pub struct ModelCacheService {
    root: PathBuf,
    plan: Mutex<Option<CleanupPlan>>,
}

impl ModelCacheService {
    pub fn new(cache_root: impl Into<PathBuf>) -> Self {
        let root = cache_root.into();
        let root = if root.is_absolute() { root } else { std::env::current_dir().unwrap_or_default().join(root) };
        Self { root, plan: Mutex::new(None) }
    }

    /// Speech checkpoints present in the cache, with their size on disk.
    pub fn speech_downloads(&self) -> DomainResult<Vec<SpeechDownload>> {
        if safe_directory(&self.root)?.is_none() {
            return Ok(Vec::new());
        }
        let mut budget = MAX_SIZE_NODES;
        let mut downloads = Vec::new();
        for definition in SPEECH_DOWNLOADS {
            let mut present = Vec::new();
            for relative in definition.paths {
                let path = download_path(&self.root, relative);
                if optional_stat(&path)?.is_some() {
                    present.push(path);
                }
            }
            if present.is_empty() {
                continue;
            }
            let bytes = present.iter().map(|path| size_of(path, &mut budget).0).sum();
            downloads.push(SpeechDownload { id: definition.id, name: definition.name.into(), bytes });
        }
        Ok(downloads)
    }

    /// Deletes one speech checkpoint; it downloads again the next time it loads.
    pub fn delete_speech_download(&self, id: &str) -> DomainResult<Vec<SpeechDownload>> {
        let definition = SPEECH_DOWNLOADS
            .iter()
            .find(|definition| definition.id.as_str() == id)
            .ok_or_else(|| plain_error("Unknown speech model"))?;
        if safe_directory(&self.root)?.is_none() {
            return Ok(Vec::new());
        }
        *self.plan.lock() = None;
        for relative in definition.paths {
            let path = download_path(&self.root, relative);
            // Never follow a link out of the cache.
            if optional_stat(&path)?.is_some_and(|stat| stat.file_type().is_symlink()) {
                continue;
            }
            remove_force(&path)?;
            let mut lock = path.into_os_string();
            lock.push(".lock");
            remove_force(Path::new(&lock))?;
        }
        self.speech_downloads()
    }

    pub fn preview(&self) -> DomainResult<ModelCachePreview> {
        let mut plan = self.plan.lock();
        *plan = None;
        let root = safe_directory(&self.root)?;
        let hub_path = self.root.join("hub");
        let hub = if root.is_some() { safe_directory(&hub_path)? } else { None };
        let mut entries = Vec::new();
        let mut planned = HashMap::new();
        let mut size_budget = MAX_SIZE_NODES;
        let mut listing_budget = MAX_PREVIEW_CHILDREN;
        let mut add = |id: String, path: PathBuf, label: String| -> DomainResult<()> {
            let snapshot = fs::symlink_metadata(&path)?;
            if snapshot.file_type().is_symlink() || (!snapshot.is_file() && !snapshot.is_dir()) || !is_canonical(&path) {
                return Ok(());
            }
            let (bytes, size_complete) = size_of(&path, &mut size_budget);
            planned.insert(id.clone(), PlannedEntry { path, snapshot: stamp(&snapshot) });
            entries.push(ModelCacheEntry { id, label, bytes, size_complete });
            Ok(())
        };
        if root.is_some() {
            for name in directory_names(&self.root, &mut listing_budget)? {
                if name != "hub" {
                    add(name.clone(), self.root.join(&name), name)?;
                }
            }
        }
        if hub.is_some() {
            for name in directory_names(&hub_path, &mut listing_budget)? {
                let Some(repo) = name.strip_prefix("models--") else { continue };
                let path = hub_path.join(&name);
                let stat = fs::symlink_metadata(&path)?;
                if !stat.is_dir() || stat.file_type().is_symlink() {
                    continue;
                }
                add(format!("hub/{name}"), path, repo.split("--").collect::<Vec<_>>().join("/"))?;
            }
        }
        // Enumeration is read-only; reject a changing location rather than approve
        // a preview assembled across different directory identities.
        let hub_now = if root.is_some() { safe_directory(&hub_path)? } else { None };
        if root != safe_directory(&self.root)? || hub != hub_now {
            return Err(plain_error("The model cache changed during preview. Refresh the preview."));
        }
        let token = uuid();
        *plan = Some(CleanupPlan { token: token.clone(), expires_at: now_ms() + PLAN_LIFETIME_MS, root, hub, entries: planned });
        Ok(ModelCachePreview { token, entries })
    }

    pub fn cleanup(&self, token: &str, ids: &[String]) -> ModelCacheCleanupResult {
        let mut selected: Vec<String> = Vec::new();
        for id in ids {
            if !selected.contains(id) {
                selected.push(id.clone());
            }
        }
        let reject = |message: &str| ModelCacheCleanupResult {
            deleted_ids: Vec::new(),
            failures: selected.iter().map(|id| ModelCacheFailure { id: id.clone(), message: message.into() }).collect(),
        };
        let plan = {
            let mut guard = self.plan.lock();
            match guard.as_ref() {
                Some(plan) if plan.token == token => guard.take().expect("plan present"),
                _ => return reject("This cache preview is no longer current. Refresh before deleting."),
            }
        };
        if now_ms() >= plan.expires_at {
            return reject("This cache preview expired. Refresh before deleting.");
        }
        let validation = (|| -> DomainResult<()> {
            let hub_now = if plan.root.is_some() { safe_directory(&self.root.join("hub"))? } else { None };
            if plan.root != safe_directory(&self.root)? || plan.hub != hub_now {
                return Err(plain_error("The model cache changed. Refresh before deleting."));
            }
            // Validate every selection before any destructive operation. Renderer IDs
            // only look up private planned paths; they never become filesystem paths.
            for id in &selected {
                let entry = plan.entries.get(id).ok_or_else(|| {
                    plain_error("A selected cache entry was not in this preview. Refresh before deleting.")
                })?;
                let current = fs::symlink_metadata(&entry.path)?;
                if current.file_type().is_symlink() || !is_canonical(&entry.path) || stamp(&current) != entry.snapshot {
                    return Err(plain_error("A selected cache entry changed. Refresh before deleting."));
                }
            }
            Ok(())
        })();
        if let Err(error) = validation {
            return reject(&error.message);
        }
        let mut result = ModelCacheCleanupResult { deleted_ids: Vec::new(), failures: Vec::new() };
        for id in selected {
            let entry = &plan.entries[&id];
            let removed = match fs::symlink_metadata(&entry.path) {
                Ok(stat) if stat.is_dir() => fs::remove_dir_all(&entry.path),
                Ok(_) => fs::remove_file(&entry.path),
                Err(error) => Err(error),
            };
            match removed {
                Ok(()) => result.deleted_ids.push(id),
                Err(error) => result.failures.push(ModelCacheFailure { id, message: DomainError::from(error).message }),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verified(root: &Path, repo: &str) -> PathBuf {
        root.join("hub").join("delulu-verified").join(repo)
    }

    #[test]
    fn downloaded_speech_models_are_listed_with_their_size_and_deleted_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        // macOS temp lives behind a symlink, which the cache refuses to touch.
        let root = fs::canonicalize(dir.path()).unwrap();
        let canary = verified(&root, "csukuangfj--sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8");
        let r2t2 = verified(&root, "netease-youdao--Confucius4-R2T2");
        let converted = root.join("delulu-r2t2-transformers").join("v1");
        for directory in [&canary, &r2t2, &converted] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(canary.join("encoder.int8.onnx"), vec![0u8; 1000]).unwrap();
        fs::write(format!("{}.lock", canary.display()), "").unwrap();
        fs::write(r2t2.join("model.safetensors"), vec![0u8; 3000]).unwrap();
        fs::write(converted.join("model.safetensors"), vec![0u8; 2000]).unwrap();
        let cache = ModelCacheService::new(&root);

        let listed = cache.speech_downloads().unwrap();
        assert_eq!(listed.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["canary-180m", "r2t2"]);
        assert!(listed.iter().find(|d| d.id == SpeechDownloadId::R2t2).unwrap().bytes >= 5000);

        // R2T2 includes its converted copy; Canary is untouched.
        let remaining = cache.delete_speech_download("r2t2").unwrap();
        assert_eq!(remaining.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["canary-180m"]);
        assert!(!r2t2.exists());
        assert!(!root.join("delulu-r2t2-transformers").exists());
        assert!(canary.exists());

        assert!(cache.delete_speech_download("canary-180m").unwrap().is_empty());
        assert!(!Path::new(&format!("{}.lock", canary.display())).exists());
        assert_eq!(cache.delete_speech_download("../hub").unwrap_err().message, "Unknown speech model");
    }

    #[test]
    fn cleanup_deletes_only_unchanged_previewed_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("hub/models--org--repo/blobs")).unwrap();
        fs::write(root.join("hub/models--org--repo/blobs/a"), [0u8; 4]).unwrap();
        fs::create_dir_all(root.join("voice")).unwrap();
        let cache = ModelCacheService::new(&root);
        let preview = cache.preview().unwrap();
        let mut ids: Vec<_> = preview.entries.iter().map(|e| (e.id.as_str(), e.label.as_str(), e.bytes)).collect();
        ids.sort();
        assert_eq!(ids, [("hub/models--org--repo", "org/repo", 4), ("voice", "voice", 0)]);
        let stale = cache.cleanup("wrong", &["voice".into()]);
        assert_eq!(stale.failures.len(), 1);
        let preview = cache.preview().unwrap();
        let result = cache.cleanup(&preview.token, &["hub/models--org--repo".into()]);
        assert_eq!(result.deleted_ids, ["hub/models--org--repo"]);
        assert!(!root.join("hub/models--org--repo").exists());
        assert!(root.join("voice").exists());
        // A token is single-use.
        assert_eq!(cache.cleanup(&preview.token, &["voice".into()]).failures.len(), 1);
    }
}
