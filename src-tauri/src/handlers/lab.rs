//! `electron/ipc/lab.ts`: audio and video imports, the import queue and
//! in-app review of linked sources.

use std::path::PathBuf;
use std::sync::Arc;

use delulu_core::DomainResult;
use delulu_data::audio_jobs::{absolute, validate_audio_file, JobChanges};
use delulu_data::audio_source::load_linked_audio;
use delulu_data::media_inspection::inspect_media;
use delulu_domain::{AudioFileSelection, AudioJobState, LabRequest, SUPPORTED_AUDIO_EXTENSIONS};
use serde_json::Value;

use crate::dialogs::{self, Filter};
use crate::handlers::blocking;
use crate::ipc::Router;
use crate::state::{plain, AppState};

fn resolved(path: &str) -> String {
    absolute(std::path::Path::new(path)).to_string_lossy().into_owned()
}

fn busy(state: &AppState) -> bool {
    state.speech.dictation.is_active() || state.speech.asr.is_busy()
}

async fn choose_paths(state: &AppState, multiple: bool) -> Vec<String> {
    let filter = Filter { name: "Audio and video", extensions: SUPPORTED_AUDIO_EXTENSIONS };
    dialogs::open(&state.app, "Choose audio or video", filter, multiple)
        .await
        .into_iter()
        .map(|path: PathBuf| path.to_string_lossy().into_owned())
        .collect()
}

fn require_job(state: &AppState, path: &str, message: &str) -> DomainResult<()> {
    if !state.lab.has_job(path)? {
        return Err(plain(message));
    }
    Ok(())
}

fn ensure_queue_idle(state: &AppState, message: &str) -> DomainResult<()> {
    if state.lab.queue_running()? {
        return Err(plain(message));
    }
    Ok(())
}

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("lab:queueGet", |state, _| async move { Ok(state.lab.queue()?.get()) })
        .handle("lab:queueEnqueue", |state, args| async move {
            let file = validate_audio_file(&args.get::<String>(0)?)?;
            if !state.lab.selected.lock().contains(&file.path) {
                return Err(plain("Choose this file in History first"));
            }
            state.lab.queue()?.enqueue(&file)
        })
        .handle("lab:queuePause", |state, args| async move { state.lab.queue()?.set_paused(args.get(0)?) })
        .handle("lab:queueMove", |state, args| async move {
            let id: String = args.get(0)?;
            let direction: f64 = args.get(1)?;
            state.lab.queue()?.move_job(&id, if direction < 0.0 { -1 } else { 1 })
        })
        .handle("lab:queueCancel", |state, args| async move { state.lab.queue()?.cancel(&args.get::<String>(0)?) })
        .handle("lab:queueRetry", |state, args| async move {
            let id: String = args.get(0)?;
            let queue = state.lab.queue()?;
            if let Some(job) = queue.get().jobs.into_iter().find(|job| job.id == id) {
                validate_audio_file(&job.path)?;
            }
            queue.retry(&id)
        })
        .handle("lab:queueClearFinished", |state, _| async move { state.lab.queue()?.clear_finished() })
        .handle("lab:chooseAudio", |state, _| async move {
            let paths = choose_paths(&state, false).await;
            if paths.is_empty() {
                return Ok(None);
            }
            Ok(state.lab.select(&paths, busy(&state))?.into_iter().next())
        })
        .handle("lab:chooseAudioFiles", |state, _| async move {
            let paths = choose_paths(&state, true).await;
            if paths.is_empty() {
                return Ok(Vec::new());
            }
            state.lab.select(&paths, busy(&state))
        })
        .handle("lab:resolveAudioPaths", |state, args| async move {
            let paths: Vec<String> = args.get(0)?;
            state.lab.select(&paths, busy(&state))
        })
        .handle("lab:run", |state: Arc<AppState>, args| async move {
            let request: LabRequest = args.get(0)?;
            ensure_queue_idle(&state, "Wait for the active queued import")?;
            let file = validate_audio_file(&request.path)?;
            if !state.lab.selected.lock().contains(&file.path) {
                return Err(plain("Choose or drop the file in History first"));
            }
            let jobs = state.lab.jobs()?;
            jobs.update(
                &file.path,
                JobChanges { state: Some(AudioJobState::Running), error: Some(None), ..Default::default() },
            )?;
            let record = match state.speech.transcribe_file(&file.path, None).await {
                Ok(record) => record,
                Err(error) => {
                    let changes = JobChanges {
                        state: Some(AudioJobState::Failed),
                        error: Some(Some(error.message.clone())),
                        ..Default::default()
                    };
                    let _ = jobs.update(&file.path, changes);
                    return Err(error);
                }
            };
            let changes = JobChanges {
                state: Some(AudioJobState::Done),
                result_id: Some(Some(record.id.clone())),
                error: Some(None),
            };
            if let Err(error) = jobs.update(&file.path, changes) {
                return Err(plain(format!(
                    "Transcription completed ({}), but job metadata could not be saved. Check History before retrying: {}",
                    record.id, error.message
                )));
            }
            Ok(record)
        })
        .handle("lab:getJobs", |state, _| async move {
            let jobs = state.lab.jobs()?.get_jobs();
            let mut selected = state.lab.selected.lock();
            let jobs: Vec<_> = jobs
                .into_iter()
                .map(|mut job| match validate_audio_file(&job.file.path) {
                    Ok(file) => {
                        selected.insert(file.path);
                        job.source_available = Some(true);
                        job
                    }
                    Err(error) => {
                        if job.state != AudioJobState::Done {
                            job.state = AudioJobState::Failed;
                        }
                        job.source_available = Some(false);
                        job.source_error = Some(error.message);
                        job
                    }
                })
                .collect();
            Ok(jobs)
        })
        .handle_bytes("lab:loadSource", |state, args| async move {
            let key = resolved(&args.get::<String>(0)?);
            require_job(&state, &key, "Choose this file in History before listening to it")?;
            validate_audio_file(&key)?;
            blocking(move || Ok(load_linked_audio(std::path::Path::new(&key))?.bytes)).await
        })
        .handle("lab:relinkJob", |state, args| async move {
            if busy(&state) {
                return Err(plain("Finish the current operation before relinking a source"));
            }
            let key = resolved(&args.get::<String>(0)?);
            require_job(&state, &key, "This import job was removed")?;
            let Some(path) = choose_paths(&state, false).await.into_iter().next() else { return Ok(Value::Null) };
            let chosen: AudioFileSelection = validate_audio_file(&path)?;
            if busy(&state) {
                return Err(plain("Relink cancelled because another operation started"));
            }
            ensure_queue_idle(&state, "Wait for the active queued import before relinking")?;
            let current = validate_audio_file(&chosen.path)?;
            let mut updated = state.lab.jobs()?.relink(&key, &current)?;
            state.lab.queue()?.replace(state.lab.restored_jobs()?)?;
            {
                let mut selected = state.lab.selected.lock();
                selected.remove(&key);
                selected.insert(updated.file.path.clone());
            }
            updated.source_available = Some(true);
            Ok(serde_json::to_value(updated)?)
        })
        .handle("lab:removeJob", |state, args| async move {
            if state.speech.dictation.is_active() {
                return Err(plain("Finish the current recording or import first"));
            }
            let key = resolved(&args.get::<String>(0)?);
            ensure_queue_idle(&state, "Wait for the active queued import")?;
            state.lab.jobs()?.remove(&key)?;
            state.lab.queue()?.replace(state.lab.restored_jobs()?)?;
            state.lab.selected.lock().remove(&key);
            Ok(())
        })
        .handle("lab:inspectAudio", |state, args| async move {
            let path = resolved(&args.get::<String>(0)?);
            if !state.lab.selected.lock().contains(&path) || !std::path::Path::new(&path).exists() {
                return Err(plain("Choose the file in History first"));
            }
            let python = delulu_runtime::location::runtime_python(&state.paths.speech_venv()).ok().filter(|p| p.exists());
            blocking(move || Ok(inspect_media(std::path::Path::new(&path), python.as_deref()))).await
        });
}
