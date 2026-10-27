//! Audio-file imports (`electron/ipc/lab.ts`): durable job metadata, the
//! import queue runner and the set of sources the user selected through the
//! app. Both services start on first use, like the TypeScript.

use std::collections::HashSet;
use std::sync::Arc;

use delulu_core::{DomainResult, SharedSink};
use delulu_data::audio_jobs::{restored_queue_jobs, validate_audio_file, AudioJobsService};
use delulu_data::import_queue::{AbortSignal, ImportQueue, ImportRunner};
use delulu_domain::{AudioFileSelection, ImportJobState, ImportQueueJob, MAX_AUDIO_BATCH_FILES};
use delulu_speech::Speech;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::state::plain;

pub struct Lab {
    data: std::path::PathBuf,
    speech: Arc<Speech>,
    sink: SharedSink,
    jobs: Mutex<Option<Arc<AudioJobsService>>>,
    queue: Mutex<Option<ImportQueue>>,
    /// Sources chosen or dropped through Audio files (`selectedAudioFiles`).
    pub selected: Mutex<HashSet<String>>,
}

pub fn source_id(path: &str) -> String {
    hex::encode(Sha256::digest(path.as_bytes()))
}

impl Lab {
    pub fn new(data: std::path::PathBuf, speech: Arc<Speech>, sink: SharedSink) -> Self {
        Self {
            data,
            speech,
            sink,
            jobs: Mutex::new(None),
            queue: Mutex::new(None),
            selected: Mutex::new(HashSet::new()),
        }
    }

    /// `importJobs()`; a failed load is retried on the next call.
    pub fn jobs(&self) -> DomainResult<Arc<AudioJobsService>> {
        let mut slot = self.jobs.lock();
        if let Some(jobs) = slot.as_ref() {
            return Ok(jobs.clone());
        }
        let jobs = Arc::new(AudioJobsService::new(&self.data)?);
        *slot = Some(jobs.clone());
        Ok(jobs)
    }

    pub fn has_job(&self, path: &str) -> DomainResult<bool> {
        Ok(self.jobs()?.get_jobs().iter().any(|job| job.file.path == path))
    }

    pub fn restored_jobs(&self) -> DomainResult<Vec<ImportQueueJob>> {
        Ok(restored_queue_jobs(&self.jobs()?.get_jobs()))
    }

    /// `getImportQueue()`.
    pub fn queue(&self) -> DomainResult<ImportQueue> {
        let mut slot = self.queue.lock();
        if let Some(queue) = slot.as_ref() {
            return Ok(queue.clone());
        }
        let jobs = self.jobs()?;
        let speech = self.speech.clone();
        let runner_jobs = jobs.clone();
        let runner: ImportRunner = Arc::new(move |path: String, signal: AbortSignal| {
            let speech = speech.clone();
            let jobs = runner_jobs.clone();
            Box::pin(async move {
                validate_audio_file(&path)?;
                if !jobs.get_jobs().iter().any(|job| job.file.path == path) {
                    return Err(plain("Import job no longer exists"));
                }
                let cancel = CancellationToken::new();
                let forward = {
                    let cancel = cancel.clone();
                    let signal = signal.clone();
                    tokio::spawn(async move {
                        signal.aborted().await;
                        cancel.cancel();
                    })
                };
                let result = speech.transcribe_file(&path, Some(cancel)).await;
                forward.abort();
                Ok(result?.id)
            })
        });
        let persist_jobs = jobs.clone();
        let queue = ImportQueue::new(
            tauri::async_runtime::handle().inner().clone(),
            runner,
            ImportQueue::sink_listener(self.sink.clone()),
            Some(Arc::new(move |snapshot| persist_jobs.replace_queue(&snapshot.jobs))),
            restored_queue_jobs(&jobs.get_jobs()),
        );
        *slot = Some(queue.clone());
        Ok(queue)
    }

    pub fn queue_running(&self) -> DomainResult<bool> {
        Ok(self
            .queue()?
            .get()
            .jobs
            .iter()
            .any(|job| matches!(job.state, ImportJobState::Running | ImportJobState::Cancelling)))
    }

    /// `selectAudioFiles`: validates the whole batch, adds new sources to the
    /// queue and remembers them as selected. When the queue would overflow,
    /// the oldest completed imports (already in History) make room.
    /// `busy` is the dictation/runtime check.
    pub fn select(&self, paths: &[String], busy: bool) -> DomainResult<Vec<AudioFileSelection>> {
        if paths.len() > MAX_AUDIO_BATCH_FILES {
            return Err(plain(format!("Choose at most {MAX_AUDIO_BATCH_FILES} files at once")));
        }
        let files = paths.iter().map(|path| validate_audio_file(path)).collect::<DomainResult<Vec<_>>>()?;
        // Register only after every file passes, so invalid batches are rejected whole.
        if busy || self.queue_running()? {
            return Err(plain("Finish the active operation before replacing sources"));
        }
        let queue = self.queue()?;
        let existing = queue.get().jobs;
        let mut additions: Vec<ImportQueueJob> = Vec::new();
        for file in &files {
            if existing.iter().chain(additions.iter()).any(|job| job.path == file.path) {
                continue;
            }
            additions.push(ImportQueueJob {
                id: source_id(&file.path),
                path: file.path.clone(),
                name: file.name.clone(),
                size: file.size,
                source_mtime_ms: file.source_mtime_ms,
                state: ImportJobState::Queued,
                error: None,
                transcript_id: None,
            });
        }
        let mut excess = (existing.len() + additions.len()).saturating_sub(MAX_AUDIO_BATCH_FILES);
        let mut kept = existing;
        kept.retain(|job| {
            let drop = excess > 0 && job.state == ImportJobState::Completed;
            excess -= usize::from(drop);
            !drop
        });
        if excess > 0 {
            return Err(plain(format!(
                "Up to {MAX_AUDIO_BATCH_FILES} files can wait at once. Remove some before adding more"
            )));
        }
        queue.replace(kept.into_iter().chain(additions).collect())?;
        let mut selected = self.selected.lock();
        for file in &files {
            selected.insert(file.path.clone());
        }
        Ok(files)
    }

    pub fn shutdown(&self) -> DomainResult<()> {
        let queue = self.queue.lock().clone();
        if let Some(queue) = queue {
            queue.shutdown()?;
        }
        Ok(())
    }
}
