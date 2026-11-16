//! The speech engine thread: one Whisper (or Parakeet) model, loaded and used on a
//! dedicated thread because loading and inference block for seconds.
use delulu_stt::{Engine, Language, Prompt, Transcript};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

pub enum EngineJob {
    Load(String),
    /// Samples, language setting, Whisper prompt from the context.
    Transcribe(
        Vec<f32>,
        Language,
        Option<Prompt>,
        tokio::sync::oneshot::Sender<Result<Transcript, String>>,
    ),
}

/// What the engine thread needs from the process that runs it.
pub trait EngineHost: Send + 'static {
    fn models_dir(&self) -> PathBuf;
    /// Runs on the engine thread just before a model loads, to free the GPU for it.
    fn before_load(&self);
    /// A load finished: the compute backend, or why it failed.
    fn loaded(&self, id: String, result: Result<String, String>);
}

/// The model to load: the selected one, or else any downloaded one, so dictation
/// keeps working while a newly picked model is still downloading.
pub fn ready_model(dir: &Path, selected: &str) -> Option<String> {
    std::iter::once(selected)
        .chain(delulu_stt::models().iter().map(|m| m.id))
        .find(|id| delulu_stt::is_downloaded(dir, id))
        .map(str::to_string)
}

/// Runs jobs until every sender is gone.
pub fn engine_thread(host: impl EngineHost, rx: mpsc::Receiver<EngineJob>) {
    let mut engine: Option<Engine> = None;
    for job in rx {
        match job {
            EngineJob::Load(id) => {
                host.before_load();
                let dir = host.models_dir();
                // Drop the old model first so two never sit in memory at once.
                drop(engine.take());
                match Engine::load(&dir, &id).map_err(|e| e.to_string()) {
                    Ok(e) => {
                        let backend = e.backend();
                        engine = Some(e);
                        host.loaded(id, Ok(backend));
                    }
                    Err(e) => {
                        engine = None;
                        host.loaded(id, Err(e));
                    }
                }
            }
            EngineJob::Transcribe(samples, language, prompt, reply) => {
                let result = engine
                    .as_mut()
                    .ok_or_else(|| "Model is not loaded".to_string())
                    .and_then(|e| {
                        e.transcribe(&samples, &language, prompt.as_ref())
                            .map_err(|e| e.to_string())
                    });
                let _ = reply.send(result);
            }
        }
    }
}
