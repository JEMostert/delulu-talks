//! Durable audio import job metadata (`audioJobs.ts`) and the audio file
//! validation the Lab IPC applied to every selected path.

use std::fs;
use std::path::{Path, PathBuf};

use delulu_core::util::{publish, stage_private, truncate_utf16, utf16_len};
use delulu_core::{now_ms, DomainResult};
use delulu_domain::{
    AudioFileSelection, AudioImportJob, AudioJobState, ImportJobState, ImportQueueJob, MAX_AUDIO_BATCH_FILES,
    MAX_AUDIO_FILE_BYTES, SUPPORTED_AUDIO_EXTENSIONS,
};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::{json as js, plain_error};

const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
pub const IMPORT_JOBS_FILE: &str = "import-jobs.json";

/// `validateAudioFile`: an existing regular file of a supported format
/// within the size limit, with its absolute path, name, size and mtime.
pub fn validate_audio_file(value: &str) -> DomainResult<AudioFileSelection> {
    if delulu_domain::js::trim(value).is_empty() || utf16_len(value) > 4096 {
        return Err(plain_error("Invalid audio file path"));
    }
    let path = absolute(Path::new(value));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !SUPPORTED_AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        return Err(plain_error(format!("{name}: unsupported audio or video format")));
    }
    let info = fs::metadata(&path).map_err(|_| plain_error(format!("{name}: file does not exist or cannot be accessed")))?;
    if !info.is_file() {
        return Err(plain_error(format!("{name}: choose a regular file")));
    }
    if info.len() > MAX_AUDIO_FILE_BYTES {
        return Err(plain_error(format!("{name}: file exceeds the 500 MiB limit")));
    }
    let mtime = info
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0);
    Ok(AudioFileSelection { source_mtime_ms: mtime, path: path.to_string_lossy().into_owned(), name, size: info.len() })
}

/// `path.resolve`: absolute and lexically normalized, without following links.
pub fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn bounded_string(value: Option<&Value>, limit: usize) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty() && utf16_len(text) <= limit)
}

fn selection(value: &Value) -> DomainResult<AudioFileSelection> {
    let Some(source) = value.as_object() else { return Err(plain_error("Invalid audio job metadata")) };
    let path = bounded_string(source.get("path"), 4096).filter(|p| Path::new(p).is_absolute());
    let name = bounded_string(source.get("name"), 512);
    let size = source
        .get("size")
        .and_then(Value::as_f64)
        .filter(|s| delulu_domain::js::is_safe_integer(*s) && *s >= 0.0 && *s <= MAX_AUDIO_FILE_BYTES as f64);
    let (Some(path), Some(name), Some(size)) = (path, name, size) else {
        return Err(plain_error("Invalid audio job file metadata"));
    };
    Ok(AudioFileSelection {
        path: path.into(),
        name: name.into(),
        size: size as u64,
        source_mtime_ms: source.get("sourceMtimeMs").and_then(Value::as_f64).filter(|m| *m >= 0.0),
    })
}

fn persisted_job(value: &Value) -> DomainResult<AudioImportJob> {
    let file = selection(value)?;
    let source = value.as_object().expect("selection checked the object");
    let state = source.get("state").and_then(Value::as_str).and_then(AudioJobState::parse);
    let stamp = |key: &str| source.get(key).and_then(Value::as_f64).filter(|t| *t >= 0.0);
    let (created_at, updated_at) = (stamp("createdAt"), stamp("updatedAt"));
    let result_ok = source.get("resultId").is_none() || bounded_string(source.get("resultId"), 128).is_some();
    let error_ok = match source.get("error") {
        None => true,
        Some(Value::String(error)) => utf16_len(error) <= 500,
        Some(_) => false,
    };
    let (Some(state), Some(created_at), Some(updated_at), true, true) = (state, created_at, updated_at, result_ok, error_ok)
    else {
        return Err(plain_error("Invalid audio job status metadata"));
    };
    Ok(AudioImportJob {
        file,
        state,
        queue_id: source.get("queueId").and_then(Value::as_str).filter(|id| utf16_len(id) <= 128).map(Into::into),
        queue_state: source.get("queueState").and_then(Value::as_str).and_then(ImportJobState::parse),
        created_at: created_at as u64,
        updated_at: updated_at as u64,
        result_id: source.get("resultId").and_then(Value::as_str).map(Into::into),
        error: source.get("error").and_then(Value::as_str).map(Into::into),
        source_available: None,
        source_error: None,
    })
}

/// The persisted JSON of a job, in the TypeScript key order.
fn job_value(job: &AudioImportJob) -> Value {
    let mut map = Map::new();
    map.insert("path".into(), json!(job.file.path));
    map.insert("name".into(), json!(job.file.name));
    map.insert("size".into(), json!(job.file.size));
    if let Some(mtime) = job.file.source_mtime_ms {
        map.insert("sourceMtimeMs".into(), js::number(mtime));
    }
    if let Some(id) = &job.queue_id {
        map.insert("queueId".into(), json!(id));
    }
    if let Some(state) = job.queue_state {
        map.insert("queueState".into(), json!(state.as_str()));
    }
    map.insert("state".into(), json!(job.state.as_str()));
    map.insert("createdAt".into(), json!(job.created_at));
    map.insert("updatedAt".into(), json!(job.updated_at));
    if let Some(id) = &job.result_id {
        map.insert("resultId".into(), json!(id));
    }
    if let Some(error) = &job.error {
        map.insert("error".into(), json!(error));
    }
    Value::Object(map)
}

/// Changes for [`AudioJobsService::update`]; `Some(None)` removes a field.
#[derive(Debug, Clone, Default)]
pub struct JobChanges {
    pub state: Option<AudioJobState>,
    pub result_id: Option<Option<String>>,
    pub error: Option<Option<String>>,
}

pub struct AudioJobsService {
    directory: PathBuf,
    file_path: PathBuf,
    jobs: Mutex<Vec<AudioImportJob>>,
}

impl AudioJobsService {
    /// Loads `import-jobs.json`. A present but unreadable file is an error
    /// and stays untouched; running jobs from a crashed session become failed.
    pub fn new(directory: &Path) -> DomainResult<Self> {
        let file_path = directory.join(IMPORT_JOBS_FILE);
        let service = |jobs| Self { directory: directory.to_path_buf(), file_path: file_path.clone(), jobs: Mutex::new(jobs) };
        let loaded = (|| -> Result<Vec<AudioImportJob>, Option<String>> {
            let metadata = fs::metadata(&file_path).map_err(|error| {
                (error.kind() != std::io::ErrorKind::NotFound).then(|| error.to_string())
            })?;
            if metadata.len() > MAX_JSON_BYTES {
                return Err(Some("Import jobs file exceeds the 4 MiB metadata limit".into()));
            }
            let text = fs::read_to_string(&file_path).map_err(|error| Some(error.to_string()))?;
            let data: Value = serde_json::from_str(&text).map_err(|error| Some(error.to_string()))?;
            let Some(source) = data.as_object() else { return Err(Some("Expected an import jobs object".into())) };
            if source.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) {
                return Err(Some("Unsupported import jobs schemaVersion; expected 1".into()));
            }
            let items = match source.get("jobs") {
                Some(Value::Array(items)) if items.len() <= MAX_AUDIO_BATCH_FILES => items,
                _ => return Err(Some(format!("Expected at most {MAX_AUDIO_BATCH_FILES} import jobs"))),
            };
            let jobs = items.iter().map(persisted_job).collect::<DomainResult<Vec<_>>>().map_err(|e| Some(e.message))?;
            let mut paths: Vec<&str> = jobs.iter().map(|job| job.file.path.as_str()).collect();
            paths.sort_unstable();
            paths.dedup();
            if paths.len() != jobs.len() {
                return Err(Some("Duplicate import job paths".into()));
            }
            let now = now_ms();
            Ok(jobs
                .into_iter()
                .map(|job| {
                    if job.state == AudioJobState::Running {
                        AudioImportJob {
                            state: AudioJobState::Failed,
                            updated_at: now,
                            error: Some("Interrupted; retry explicitly".into()),
                            ..job
                        }
                    } else {
                        job
                    }
                })
                .collect())
        })();
        match loaded {
            Ok(jobs) => Ok(service(jobs)),
            Err(None) => Ok(service(Vec::new())),
            Err(Some(detail)) => Err(plain_error(format!(
                "Could not load audio jobs at {}: {detail}. The file has been preserved. Restore a compatible backup or repair this metadata file before importing files again.",
                file_path.display()
            ))),
        }
    }

    pub fn get_jobs(&self) -> Vec<AudioImportJob> {
        self.jobs.lock().clone()
    }

    /// Mirrors the import queue into durable job metadata.
    pub fn replace_queue(&self, jobs: &[ImportQueueJob]) -> DomainResult<()> {
        if jobs.len() > MAX_AUDIO_BATCH_FILES {
            return Err(plain_error("Too many durable import jobs"));
        }
        let mut current = self.jobs.lock();
        let now = now_ms();
        let next = jobs
            .iter()
            .map(|job| {
                let previous = current.iter().find(|p| p.file.path == job.path);
                let state = match job.state {
                    ImportJobState::Completed => "done",
                    ImportJobState::Queued => "pending",
                    ImportJobState::Cancelling | ImportJobState::Running => "running",
                    ImportJobState::Failed => "failed",
                    ImportJobState::Cancelled => "cancelled",
                };
                let mut value = json!({
                    "path": job.path,
                    "name": job.name,
                    "size": job.size,
                    "createdAt": previous.map_or(now, |p| p.created_at),
                    "updatedAt": now,
                    "queueId": job.id,
                    "queueState": job.state.as_str(),
                    "state": state,
                });
                let map = value.as_object_mut().expect("object");
                if let Some(mtime) = job.source_mtime_ms {
                    map.insert("sourceMtimeMs".into(), js::number(mtime));
                }
                if let Some(id) = &job.transcript_id {
                    map.insert("resultId".into(), json!(id));
                }
                if let Some(error) = &job.error {
                    map.insert("error".into(), json!(error));
                }
                persisted_job(&value)
            })
            .collect::<DomainResult<Vec<_>>>()?;
        self.persist(&mut current, next)
    }

    pub fn replace_selection(&self, files: &[AudioFileSelection]) -> DomainResult<Vec<AudioImportJob>> {
        if files.len() > MAX_AUDIO_BATCH_FILES {
            return Err(plain_error(format!("Choose at most {MAX_AUDIO_BATCH_FILES} import files")));
        }
        let mut selected: Vec<AudioFileSelection> = Vec::new();
        for file in files {
            let file = selection(&serde_json::to_value(file).unwrap_or(Value::Null))?;
            // Later duplicates replace earlier ones in place, like a Map keyed by path.
            match selected.iter_mut().find(|s| s.path == file.path) {
                Some(slot) => *slot = file,
                None => selected.push(file),
            }
        }
        let now = now_ms();
        let jobs = selected
            .into_iter()
            .map(|file| AudioImportJob {
                file,
                state: AudioJobState::Pending,
                queue_id: None,
                queue_state: None,
                created_at: now,
                updated_at: now,
                result_id: None,
                error: None,
                source_available: None,
                source_error: None,
            })
            .collect();
        let mut current = self.jobs.lock();
        self.persist(&mut current, jobs)?;
        Ok(current.clone())
    }

    pub fn update(&self, path: &str, changes: JobChanges) -> DomainResult<AudioImportJob> {
        let mut current = self.jobs.lock();
        let index = current
            .iter()
            .position(|job| job.file.path == path)
            .ok_or_else(|| plain_error("Audio job no longer exists; select the file again explicitly"))?;
        let mut updated = AudioImportJob { updated_at: now_ms(), ..current[index].clone() };
        if let Some(state) = changes.state {
            updated.state = state;
        }
        if let Some(result_id) = changes.result_id {
            if result_id.as_ref().is_some_and(|id| id.is_empty() || utf16_len(id) > 128) {
                return Err(plain_error("Invalid audio job result ID"));
            }
            updated.result_id = result_id;
        }
        if let Some(error) = changes.error {
            updated.error = error.map(|e| truncate_utf16(&e, 500).to_owned());
        }
        let mut next = current.clone();
        next[index] = updated.clone();
        self.persist(&mut current, next)?;
        Ok(updated)
    }

    pub fn relink(&self, old_path: &str, file: &AudioFileSelection) -> DomainResult<AudioImportJob> {
        let mut current = self.jobs.lock();
        let index = current
            .iter()
            .position(|job| job.file.path == old_path)
            .ok_or_else(|| plain_error("Audio job no longer exists; select the file again explicitly"))?;
        if current[index].state == AudioJobState::Running {
            return Err(plain_error("Wait for this audio job to finish before relinking its source"));
        }
        let replacement = selection(&serde_json::to_value(file).unwrap_or(Value::Null))?;
        if current.iter().enumerate().any(|(position, job)| position != index && job.file.path == replacement.path) {
            return Err(plain_error("This source file already belongs to another audio job"));
        }
        let updated = AudioImportJob {
            file: replacement,
            state: AudioJobState::Pending,
            queue_id: None,
            queue_state: None,
            created_at: current[index].created_at,
            updated_at: now_ms(),
            result_id: None,
            error: None,
            source_available: None,
            source_error: None,
        };
        let mut next = current.clone();
        next[index] = updated.clone();
        self.persist(&mut current, next)?;
        Ok(updated)
    }

    pub fn remove(&self, path: &str) -> DomainResult<()> {
        let mut current = self.jobs.lock();
        let next = current.iter().filter(|job| job.file.path != path).cloned().collect();
        self.persist(&mut current, next)
    }

    fn persist(&self, current: &mut Vec<AudioImportJob>, jobs: Vec<AudioImportJob>) -> DomainResult<()> {
        let values: Vec<Value> = jobs.iter().map(job_value).collect();
        let metadata = values.iter().map(persisted_job).collect::<DomainResult<Vec<_>>>()?;
        create_private_dir(&self.directory)?;
        let mut text = js::stringify(&json!({"schemaVersion": 1, "jobs": values}));
        text.push('\n');
        let temporary = stage_private(&self.file_path, text.as_bytes())?;
        publish(&temporary, &self.file_path)?;
        *current = metadata;
        Ok(())
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// `restoredJobs` from the Lab IPC: durable jobs as import queue jobs.
/// Jobs interrupted while running come back as failed.
pub fn restored_queue_jobs(jobs: &[AudioImportJob]) -> Vec<ImportQueueJob> {
    use sha2::{Digest, Sha256};
    jobs.iter()
        .map(|job| {
            let mut state = job.queue_state.unwrap_or(match job.state {
                AudioJobState::Pending => ImportJobState::Queued,
                AudioJobState::Done => ImportJobState::Completed,
                AudioJobState::Cancelled => ImportJobState::Cancelled,
                _ => ImportJobState::Failed,
            });
            if matches!(state, ImportJobState::Running | ImportJobState::Cancelling) {
                state = ImportJobState::Failed;
            }
            ImportQueueJob {
                id: job.queue_id.clone().unwrap_or_else(|| hex::encode(Sha256::digest(job.file.path.as_bytes()))),
                path: job.file.path.clone(),
                name: job.file.name.clone(),
                size: job.file.size,
                source_mtime_ms: job.file.source_mtime_ms,
                state,
                error: job.error.clone(),
                transcript_id: job.result_id.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dir: &Path, name: &str) -> AudioFileSelection {
        let path = dir.join(name);
        fs::write(&path, b"RIFF").unwrap();
        validate_audio_file(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn jobs_persist_and_interrupted_runs_become_failed() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = AudioJobsService::new(dir.path()).unwrap();
        let a = file(dir.path(), "a.wav");
        jobs.replace_selection(&[a.clone(), file(dir.path(), "b.mp3")]).unwrap();
        jobs.update(&a.path, JobChanges { state: Some(AudioJobState::Running), ..Default::default() }).unwrap();
        let reopened = AudioJobsService::new(dir.path()).unwrap().get_jobs();
        assert_eq!(reopened.len(), 2);
        assert_eq!(reopened[0].state, AudioJobState::Failed);
        assert_eq!(reopened[0].error.as_deref(), Some("Interrupted; retry explicitly"));
        let restored = restored_queue_jobs(&reopened);
        assert_eq!(restored[1].state, ImportJobState::Queued);
        assert_eq!(restored[1].id.len(), 64);
        assert!(validate_audio_file(dir.path().join("x.txt").to_str().unwrap()).is_err());
    }

    #[test]
    fn unreadable_metadata_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(IMPORT_JOBS_FILE), "{bad").unwrap();
        let error = AudioJobsService::new(dir.path()).err().unwrap();
        assert!(error.message.contains("The file has been preserved"));
        assert_eq!(fs::read_to_string(dir.path().join(IMPORT_JOBS_FILE)).unwrap(), "{bad");
    }
}
