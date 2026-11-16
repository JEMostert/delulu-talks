//! `delulu-engine stt`: speech to text as a worker. The app and the daemon keep one
//! running while dictation is on (crates/dictation `stt`), so a GPU fault here can
//! never take the hotkey down with it.
//!
//! It speaks the worker protocol (`delulu_proto::worker`) on stdin/stdout:
//! `hello{role: stt}` → `ready`; `load{model: {id, path}}` → `loaded` (the previous
//! model is freed first); `job{transcribe}` followed by the clip as `audio` frames
//! (16 kHz mono, ended by `last: true`) → `done{transcript}`; `cancel{id}` stops a
//! job at its next decoding step; `unload` frees the model; `shutdown` → `bye`.
//! Whisper (whisper.cpp on the engine's one ggml) and Parakeet v3 (ONNX Runtime) are
//! the engines; see `engine`.
use delulu_proto::worker::{
    AudioSource, Capability, FromWorker, JobPayload, JobResult, ModelRef, Role, SttPrompt,
    ToWorker, WorkerErrorKind, WORKER_PROTOCOL_VERSION,
};
use delulu_stt::{Language, Prompt, Transcript};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::Instant;

mod closing;
mod engine;
mod pieces;
mod vad;

const ENGINE: &str = "delulu-engine stt";
const USAGE: &str = "usage: delulu-engine stt   (speaks the worker protocol on stdin/stdout)";
/// The rate every clip arrives at.
const RATE: u32 = 16_000;
/// The longest clip a job takes: 30 minutes (115 MB of samples).
const MAX_SAMPLES: usize = 30 * 60 * RATE as usize;

#[derive(Debug, thiserror::Error)]
pub enum SttError {
    #[error("model: {0}")]
    Model(String),
    #[error("inference: {0}")]
    Inference(String),
}

pub fn main(mut args: impl Iterator<Item = String>) -> ExitCode {
    if let Some(arg) = args.next() {
        eprintln!("delulu-engine stt: unknown argument {arg}\n{USAGE}");
        return ExitCode::from(2);
    }
    let _ = log::set_logger(&Stderr).map(|()| log::set_max_level(log::LevelFilter::Info));
    let out = crate::llm::protocol_out();
    let mut models = Models { engine: None };
    match serve(std::io::stdin(), out, &mut models) {
        Ok(()) => ExitCode::SUCCESS,
        // The app closed our stdout: it is gone.
        Err(_) => ExitCode::FAILURE,
    }
}

/// `log` lines (the engine's notes on second decodes, the detector) on stderr. They
/// never hold transcript text.
struct Stderr;
impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("delulu-engine stt: {}", record.args());
        }
    }
    fn flush(&self) {}
}

/// What the protocol needs from the speech engines; a fake in the tests.
trait Transcriber {
    /// Load `model` in place of the current one: where it runs, or why it failed.
    fn load(&mut self, model: &ModelRef) -> Result<String, String>;
    fn unload(&mut self);
    fn is_loaded(&self) -> bool;
    fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
        prompt: Option<&Prompt>,
    ) -> Result<Transcript, String>;
}

struct Models {
    engine: Option<engine::Engine>,
}

impl Transcriber for Models {
    fn load(&mut self, model: &ModelRef) -> Result<String, String> {
        // Free the old model first, so two never sit in memory at once.
        self.engine = None;
        if !tensor_layout_matches() {
            return Err(
                "delulu-engine was built with a ggml whose GGML_MAX_NAME differs from \
                 whisper.cpp's; rebuild llama-cpp-sys-2 (cargo clean -p llama-cpp-sys-2)"
                    .into(),
            );
        }
        let engine = engine::Engine::load(&model.id, std::path::Path::new(&model.path))
            .map_err(|e| e.to_string())?;
        let device = engine.backend();
        self.engine = Some(engine);
        Ok(device)
    }
    fn unload(&mut self) {
        self.engine = None;
    }
    fn is_loaded(&self) -> bool {
        self.engine.is_some()
    }
    fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
        prompt: Option<&Prompt>,
    ) -> Result<Transcript, String> {
        self.engine
            .as_mut()
            .ok_or("no model loaded")?
            .transcribe(samples, language, prompt)
            .map_err(|e| e.to_string())
    }
}

extern "C" {
    /// `sizeof(struct ggml_tensor)` as whisper.cpp was compiled
    /// (vendor/whisper-rs-sys/layout.c, built into libwhisper).
    fn delulu_whisper_tensor_size() -> usize;
}

/// whisper.cpp and the linked ggml agree on `struct ggml_tensor`, which
/// `GGML_MAX_NAME` changes. A stale build cache can break that, and a model loaded
/// then would corrupt memory.
fn tensor_layout_matches() -> bool {
    use whisper_rs_sys as sys;
    // SAFETY: a tiny no-alloc context, freed again; the shim only returns a size.
    unsafe {
        let params = sys::ggml_init_params {
            mem_size: 4 * sys::ggml_tensor_overhead(),
            mem_buffer: std::ptr::null_mut(),
            no_alloc: true,
        };
        let ctx = sys::ggml_init(params);
        if ctx.is_null() {
            return false;
        }
        // A tensor's offset in a fresh context is the object header; the overhead is
        // header plus tensor.
        let tensor = sys::ggml_new_tensor_1d(ctx, sys::ggml_type_GGML_TYPE_F32, 1);
        let header = (tensor as usize).wrapping_sub(sys::ggml_get_mem_buffer(ctx) as usize);
        let in_ggml = sys::ggml_tensor_overhead() - header;
        sys::ggml_free(ctx);
        in_ggml == delulu_whisper_tensor_size()
    }
}

/// A transcription job with all of its audio.
struct Clip {
    id: u64,
    job: Transcribe,
    /// The audio, or why the frames could not be taken.
    samples: Result<Vec<f32>, String>,
}

/// The fields of a `transcribe` payload.
struct Transcribe {
    language: Option<String>,
    languages: Vec<String>,
    prompt: Option<SttPrompt>,
}

enum Incoming {
    Message(ToWorker),
    Clip(Clip),
    Bad(String),
    Eof,
}

/// A clip whose frames are still arriving.
struct Pending {
    job: Transcribe,
    samples: Vec<f32>,
    error: Option<String>,
}

/// Reads the protocol on a thread, so `cancel` reaches a decoding job, and joins each
/// job's `audio` frames into one clip. A frame's bytes are always consumed, also when
/// they are refused, so the stream stays in step.
fn reader<R: Read + Send + 'static>(input: R) -> mpsc::Receiver<Incoming> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = BufReader::new(input);
        let mut pending: HashMap<u64, Pending> = HashMap::new();
        let mut line = String::new();
        loop {
            line.clear();
            match input.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.trim().is_empty() {
                continue;
            }
            let incoming = match serde_json::from_str::<ToWorker>(&line) {
                // Not `{e}`: serde can quote the text it choked on.
                Err(e) => {
                    Incoming::Bad(format!("{:?} error at column {}", e.classify(), e.column()))
                }
                Ok(ToWorker::Cancel { id }) => {
                    engine::cancel(id);
                    // A job still collecting frames ends with its last one.
                    continue;
                }
                Ok(ToWorker::Audio(header)) => {
                    let mut bytes = vec![0u8; header.bytes as usize];
                    if input.read_exact(&mut bytes).is_err() {
                        break;
                    }
                    let Some(clip) = pending.get_mut(&header.id) else {
                        continue;
                    };
                    if clip.error.is_none() {
                        if header.rate != RATE || !bytes.len().is_multiple_of(4) {
                            clip.error = Some(format!(
                                "audio must be 16 kHz mono f32, got {} Hz and {} bytes",
                                header.rate,
                                bytes.len()
                            ));
                        } else if clip.samples.len() + bytes.len() / 4 > MAX_SAMPLES {
                            clip.error = Some("the clip is longer than 30 minutes".into());
                            clip.samples = Vec::new();
                        } else {
                            clip.samples.extend(
                                bytes
                                    .as_chunks::<4>()
                                    .0
                                    .iter()
                                    .map(|b| f32::from_le_bytes(*b)),
                            );
                        }
                    }
                    if !header.last {
                        continue;
                    }
                    let clip = pending.remove(&header.id).expect("pending");
                    Incoming::Clip(Clip {
                        id: header.id,
                        job: clip.job,
                        samples: match clip.error {
                            Some(error) => Err(error),
                            None => Ok(clip.samples),
                        },
                    })
                }
                Ok(ToWorker::Job {
                    id,
                    payload:
                        JobPayload::Transcribe {
                            audio,
                            language,
                            languages,
                            prompt,
                            ..
                        },
                    ..
                }) => {
                    let job = Transcribe {
                        language,
                        languages,
                        prompt,
                    };
                    match audio {
                        AudioSource::Frames => {
                            pending.insert(
                                id,
                                Pending {
                                    job,
                                    samples: Vec::new(),
                                    error: None,
                                },
                            );
                            continue;
                        }
                        AudioSource::File { path } => Incoming::Clip(Clip {
                            id,
                            job,
                            samples: read_wav(&path),
                        }),
                    }
                }
                Ok(message) => Incoming::Message(message),
            };
            if tx.send(incoming).is_err() {
                return;
            }
        }
        let _ = tx.send(Incoming::Eof);
    });
    rx
}

/// A 16 kHz mono WAV file's samples.
fn read_wav(path: &str) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("{path}: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate != RATE || spec.channels != 1 {
        return Err(format!("{path}: not 16 kHz mono"));
    }
    let samples: Result<Vec<f32>, _> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect(),
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|s| s as f32 / scale))
                .collect()
        }
    };
    samples.map_err(|e| format!("{path}: {e}"))
}

fn send<W: Write>(out: &mut W, message: &FromWorker) -> std::io::Result<()> {
    let line = serde_json::to_string(message).expect("serialize");
    writeln!(out, "{line}")?;
    out.flush()
}

/// One protocol session. Returns when the peer closes its side or asks to shut down.
fn serve<R: Read + Send + 'static, W: Write>(
    input: R,
    mut out: W,
    models: &mut impl Transcriber,
) -> std::io::Result<()> {
    let rx = reader(input);
    while let Ok(incoming) = rx.recv() {
        let reply = match incoming {
            Incoming::Eof => return Ok(()),
            Incoming::Bad(detail) => {
                eprintln!("delulu-engine stt: bad message ({detail})");
                FromWorker::Error {
                    id: None,
                    kind: WorkerErrorKind::BadMessage,
                    message: detail,
                }
            }
            Incoming::Clip(clip) => transcribe(models, clip),
            Incoming::Message(message) => match message {
                ToWorker::Hello { role, protocol } => {
                    if role != Role::Stt || protocol != WORKER_PROTOCOL_VERSION {
                        FromWorker::Error {
                            id: None,
                            kind: WorkerErrorKind::Unsupported,
                            message: format!(
                                "this worker speaks role stt, protocol {WORKER_PROTOCOL_VERSION}"
                            ),
                        }
                    } else {
                        FromWorker::Ready {
                            engine: ENGINE.into(),
                            protocol: WORKER_PROTOCOL_VERSION,
                            device: None,
                            vram_bytes: None,
                            caps: vec![Capability::PromptBiasing, Capability::Languages],
                        }
                    }
                }
                ToWorker::Load { model, .. } => {
                    let started = Instant::now();
                    match models.load(&model) {
                        Ok(device) => {
                            let load_ms = started.elapsed().as_millis() as u64;
                            eprintln!(
                                "delulu-engine stt: loaded {} ({device}, {load_ms} ms)",
                                model.id
                            );
                            FromWorker::Loaded {
                                model_id: model.id,
                                load_ms,
                                vram_bytes: None,
                                device: Some(device),
                            }
                        }
                        Err(message) => {
                            eprintln!("delulu-engine stt: load {}: {message}", model.id);
                            FromWorker::Error {
                                id: None,
                                kind: WorkerErrorKind::LoadFailed,
                                message,
                            }
                        }
                    }
                }
                ToWorker::Job { id, .. } => FromWorker::Error {
                    id: Some(id),
                    kind: WorkerErrorKind::Unsupported,
                    message: "the stt role only transcribes".into(),
                },
                ToWorker::Unload => {
                    models.unload();
                    FromWorker::Unloaded
                }
                ToWorker::Shutdown => {
                    send(&mut out, &FromWorker::Bye)?;
                    return Ok(());
                }
                // Cancel and audio are taken by the reader; a clip is short work, so
                // pause has nothing to wait for.
                ToWorker::Cancel { .. }
                | ToWorker::Pause
                | ToWorker::Resume
                | ToWorker::Audio(_) => continue,
            },
        };
        send(&mut out, &reply)?;
    }
    Ok(())
}

fn transcribe(models: &mut impl Transcriber, clip: Clip) -> FromWorker {
    let failed = |kind, message: String| FromWorker::Error {
        id: Some(clip.id),
        kind,
        message,
    };
    let samples = match clip.samples {
        Ok(samples) => samples,
        Err(message) => return failed(WorkerErrorKind::JobFailed, message),
    };
    if !models.is_loaded() {
        return failed(WorkerErrorKind::JobFailed, "no model loaded".into());
    }
    let running = engine::Running::start(clip.id);
    if running.cancelled() {
        return failed(WorkerErrorKind::Cancelled, "cancelled".into());
    }
    let language = match clip.job.language {
        Some(code) => Language::Fixed(code),
        None => Language::Auto(clip.job.languages),
    };
    let prompt = clip.job.prompt.map(|p| Prompt {
        terms: p.terms,
        sentence: p.sentence,
    });
    match models.transcribe(&samples, &language, prompt.as_ref()) {
        Ok(t) => FromWorker::Done {
            id: clip.id,
            ms: t.elapsed_ms,
            result: JobResult::Transcript {
                text: t.text,
                language: t.language,
                audio_ms: t.audio_ms,
            },
        },
        Err(_) if running.cancelled() => failed(WorkerErrorKind::Cancelled, "cancelled".into()),
        Err(message) => failed(WorkerErrorKind::JobFailed, message),
    }
}

#[cfg(test)]
mod tests;
