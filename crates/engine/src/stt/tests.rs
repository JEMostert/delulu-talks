use super::*;
use delulu_proto::worker::{AudioHeader, Lane};
use std::io::Cursor;
use std::sync::Mutex;

/// Sessions share the process-wide cancel state, so they run one at a time.
static SESSION: Mutex<()> = Mutex::new(());

/// What a job reached the engine with.
#[derive(Debug, Clone, PartialEq)]
struct Call {
    samples: Vec<f32>,
    language: Language,
    prompt: Option<Prompt>,
}

#[derive(Default)]
struct Fake {
    loaded: Option<String>,
    fail_load: bool,
    /// Simulates a `cancel` arriving while this job decodes: whisper.cpp then stops
    /// with an error.
    cancel_while_running: Option<u64>,
    calls: Vec<Call>,
}

impl Transcriber for Fake {
    fn load(&mut self, model: &ModelRef) -> Result<String, String> {
        self.loaded = None;
        if self.fail_load {
            return Err("not a model file".into());
        }
        self.loaded = Some(model.id.clone());
        Ok("Vulkan: Test GPU".into())
    }
    fn unload(&mut self) {
        self.loaded = None;
    }
    fn is_loaded(&self) -> bool {
        self.loaded.is_some()
    }
    fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
        prompt: Option<&Prompt>,
    ) -> Result<Transcript, String> {
        self.calls.push(Call {
            samples: samples.to_vec(),
            language: language.clone(),
            prompt: prompt.cloned(),
        });
        if let Some(id) = self.cancel_while_running.take() {
            engine::cancel(id);
            return Err("inference: failed to run the model".into());
        }
        Ok(Transcript {
            text: format!("{} samples", samples.len()),
            language: match language {
                Language::Fixed(code) => code.clone(),
                Language::Auto(_) => "nl".into(),
            },
            audio_ms: samples.len() as u64 / 16,
            elapsed_ms: 42,
        })
    }
}

fn line(message: &ToWorker) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(message).unwrap();
    bytes.push(b'\n');
    bytes
}

fn audio(id: u64, seq: u64, rate: u32, samples: &[f32], last: bool) -> Vec<u8> {
    let mut bytes = line(&ToWorker::Audio(AudioHeader {
        id,
        seq,
        rate,
        bytes: (samples.len() * 4) as u32,
        last,
    }));
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

fn job(id: u64, language: Option<&str>, prompt: Option<SttPrompt>) -> Vec<u8> {
    line(&ToWorker::Job {
        id,
        lane: Lane::Dictation,
        payload: JobPayload::Transcribe {
            audio: AudioSource::Frames,
            language: language.map(str::to_string),
            languages: vec!["nl".into(), "en".into()],
            prompt,
            stream: false,
        },
    })
}

fn hello_and_load() -> Vec<u8> {
    [
        line(&ToWorker::Hello {
            role: Role::Stt,
            protocol: WORKER_PROTOCOL_VERSION,
        }),
        line(&ToWorker::Load {
            model: ModelRef {
                id: "large-v3-turbo-q5_0".into(),
                path: "/models/ggml-large-v3-turbo-q5_0.bin".into(),
                extra: Default::default(),
            },
            opts: Default::default(),
        }),
    ]
    .concat()
}

/// Runs one session over `input` and returns every reply.
fn session(input: Vec<u8>, fake: &mut Fake) -> Vec<FromWorker> {
    let _one = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    serve(Cursor::new(input), &mut out, fake).unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn done_text(reply: &FromWorker) -> Option<(u64, &str)> {
    match reply {
        FromWorker::Done {
            id,
            result: JobResult::Transcript { text, .. },
            ..
        } => Some((*id, text)),
        _ => None,
    }
}

fn error_of(reply: &FromWorker) -> Option<(Option<u64>, WorkerErrorKind)> {
    match reply {
        FromWorker::Error { id, kind, .. } => Some((*id, *kind)),
        _ => None,
    }
}

#[test]
fn a_clip_arrives_whole_with_its_language_and_prompt() {
    let prompt = SttPrompt {
        terms: Some("T3 Code, Tauri.".into()),
        sentence: Some("Fix the merge conflict.".into()),
    };
    let input = [
        hello_and_load(),
        job(1, None, Some(prompt)),
        audio(1, 0, 16_000, &[0.1, -0.2], false),
        audio(1, 1, 16_000, &[0.3], true),
        job(2, Some("de"), None),
        audio(2, 0, 16_000, &[0.5; 32], true),
        line(&ToWorker::Shutdown),
    ]
    .concat();
    let mut fake = Fake::default();
    let replies = session(input, &mut fake);

    assert!(matches!(
        &replies[0],
        FromWorker::Ready { caps, .. } if caps.contains(&Capability::PromptBiasing)
    ));
    assert!(matches!(
        &replies[1],
        FromWorker::Loaded { model_id, device: Some(device), .. }
            if model_id == "large-v3-turbo-q5_0" && device == "Vulkan: Test GPU"
    ));
    assert_eq!(done_text(&replies[2]), Some((1, "3 samples")));
    assert_eq!(done_text(&replies[3]), Some((2, "32 samples")));
    assert_eq!(replies[4], FromWorker::Bye);
    assert_eq!(
        fake.calls,
        [
            Call {
                samples: vec![0.1, -0.2, 0.3],
                language: Language::Auto(vec!["nl".into(), "en".into()]),
                prompt: Some(Prompt {
                    terms: Some("T3 Code, Tauri.".into()),
                    sentence: Some("Fix the merge conflict.".into()),
                }),
            },
            Call {
                samples: vec![0.5; 32],
                language: Language::Fixed("de".into()),
                prompt: None,
            },
        ]
    );
}

#[test]
fn failures_answer_the_request_and_the_session_goes_on() {
    let input = [
        // A clip before any model is loaded.
        job(1, None, None),
        audio(1, 0, 16_000, &[0.1; 8], true),
        hello_and_load(),
        // Audio at the wrong rate: refused, and its bytes are skipped.
        job(2, None, None),
        audio(2, 0, 48_000, &[0.1; 8], true),
        b"{\"type\": \"job\", \"id\": \n".to_vec(),
        job(3, None, None),
        audio(3, 0, 16_000, &[0.1; 8], true),
    ]
    .concat();
    let mut fake = Fake::default();
    let replies = session(input, &mut fake);
    assert_eq!(
        error_of(&replies[0]),
        Some((Some(1), WorkerErrorKind::JobFailed))
    );
    assert_eq!(
        error_of(&replies[3]),
        Some((Some(2), WorkerErrorKind::JobFailed))
    );
    assert_eq!(
        error_of(&replies[4]),
        Some((None, WorkerErrorKind::BadMessage))
    );
    assert_eq!(done_text(&replies[5]), Some((3, "8 samples")));
    assert_eq!(replies.len(), 6);

    // A model that does not load leaves nothing loaded.
    let mut fake = Fake {
        fail_load: true,
        ..Fake::default()
    };
    let replies = session(
        [
            hello_and_load(),
            job(4, None, None),
            audio(4, 0, 16_000, &[0.1; 8], true),
        ]
        .concat(),
        &mut fake,
    );
    assert_eq!(
        error_of(&replies[1]),
        Some((None, WorkerErrorKind::LoadFailed))
    );
    assert_eq!(
        error_of(&replies[2]),
        Some((Some(4), WorkerErrorKind::JobFailed))
    );
}

#[test]
fn a_cancelled_job_is_answered_cancelled_and_the_next_one_runs() {
    let input = [
        hello_and_load(),
        // Cancelled while its frames still arrive: never decoded.
        job(10, None, None),
        audio(10, 0, 16_000, &[0.1; 8], false),
        line(&ToWorker::Cancel { id: 10 }),
        audio(10, 1, 16_000, &[0.1; 8], true),
        // Cancelled while decoding.
        job(11, None, None),
        audio(11, 0, 16_000, &[0.1; 8], true),
        // Not cancelled.
        job(12, None, None),
        audio(12, 0, 16_000, &[0.1; 4], true),
    ]
    .concat();
    let mut fake = Fake {
        cancel_while_running: Some(11),
        ..Fake::default()
    };
    let replies = session(input, &mut fake);
    assert_eq!(
        error_of(&replies[2]),
        Some((Some(10), WorkerErrorKind::Cancelled))
    );
    assert_eq!(
        error_of(&replies[3]),
        Some((Some(11), WorkerErrorKind::Cancelled))
    );
    assert_eq!(done_text(&replies[4]), Some((12, "4 samples")));
    assert_eq!(fake.calls.len(), 2, "job 10 never reached the engine");
}

#[test]
fn the_language_list_is_whisper_cpps() {
    let whisper: Vec<_> = (0..=whisper_rs::get_lang_max_id())
        .filter_map(|id| {
            Some((
                whisper_rs::get_lang_str(id)?,
                whisper_rs::get_lang_str_full(id)?,
            ))
        })
        .collect();
    assert_eq!(delulu_stt::languages(), whisper);
}

/// Fails when whisper.cpp was compiled without the GGML_MAX_NAME the linked ggml
/// uses (vendor/whisper-rs-sys/shared-ggml.cmake missing, or a stale build cache):
/// every model load would corrupt memory.
#[test]
fn whisper_and_the_linked_ggml_agree_on_tensor_layout() {
    assert!(tensor_layout_matches());
}
