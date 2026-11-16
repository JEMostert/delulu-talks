//! Daemon ⇄ engine worker protocol (architecture §3.4).
//!
//! A worker is `delulu-engine <role>` (or any program speaking this protocol, such
//! as an optional Python adapter). The daemon writes [`ToWorker`] messages to the
//! worker's stdin and reads [`FromWorker`] messages from its stdout, one JSON
//! object per line. Logs go to stderr.
//!
//! ```text
//! → hello{role, protocol}              ← ready{engine, protocol, device, vramBytes, caps}
//! → load{model, opts}                  ← loaded{modelId, loadMs, vramBytes} | error{kind, message}
//! → job{id, lane, payload}             ← progress{id,…} / chunk{id,…} / done{id, result, ms} / error{id, kind, message}
//! → cancel{id} | pause | resume
//! → unload                             ← unloaded
//! → shutdown                           ← bye
//! ```
//!
//! **Binary audio.** A message whose type is `audio` (either direction) is followed
//! on the same stream by exactly `bytes` raw bytes of little-endian `f32` mono PCM
//! at `rate` Hz, then the next JSON line. Audio is never base64 in JSON.
//!
//! **Mapping today's `delulu-cleanup` / `delulu-engine llm` lines.** The current
//! helper takes its model on the command line and speaks:
//!
//! | today                                   | here                                                              |
//! |-----------------------------------------|-------------------------------------------------------------------|
//! | (spawn with `--model <gguf>`)           | `hello{role: llm}` + `load{model: {id, path}}`                    |
//! | `{"type":"ready","backend","loadMs"}`   | `ready{device: backend}` + `loaded{loadMs}`                       |
//! | `{"type":"error","message"}` at load    | `error{id: null, kind: loadFailed, message}`                      |
//! | `{id, prompt, maxTokens, sampling?}`    | `job{id, lane, payload: generate{prompt: {raw: …}, maxTokens, sampling}}` |
//! | `{"type":"result",id,text,truncated,ms}`| `done{id, ms, result: text{text, truncated}}`                     |
//! | `{"type":"failed",id,message}`          | `error{id, kind: jobFailed, message}`                             |
//!
//! `sampling` keeps the same shape (`seed`, `temperature`, `topP`; absent = greedy).

use serde::{Deserialize, Serialize};

/// The worker protocol version, independent of the client API version.
pub const WORKER_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Stt,
    Llm,
    Tts,
    Music,
    Chat,
}

/// Queues inside one worker. Higher lanes jump the queue and preempt lower ones
/// at the next safe point (a token, a diffusion step).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    /// Dictation cleanup and transcription: never waits behind other lanes.
    Dictation,
    Conversation,
    Report,
    Radio,
}

/// Daemon → worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToWorker {
    Hello {
        role: Role,
        protocol: u32,
    },
    Load {
        model: ModelRef,
        #[serde(default)]
        opts: LoadOptions,
    },
    Job {
        id: u64,
        lane: Lane,
        payload: JobPayload,
    },
    /// Stop job `id`; the worker answers with `error{id, kind: cancelled}` or,
    /// if it already finished, its normal `done`.
    Cancel {
        id: u64,
    },
    /// Stop issuing GPU work at the next safe point, keeping state.
    Pause,
    Resume,
    /// Free the model (and its VRAM) but keep the process.
    Unload,
    /// Finish nothing, answer `bye`, exit.
    Shutdown,
    /// Audio for a streaming job; `bytes` raw bytes follow this line.
    Audio(AudioHeader),
}

/// Worker → daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FromWorker {
    /// Answer to `hello`: the worker runs and can load models.
    Ready {
        engine: String,
        protocol: u32,
        device: Option<String>,
        /// Free device memory as the worker measured it.
        vram_bytes: Option<u64>,
        #[serde(default)]
        caps: Vec<Capability>,
    },
    Loaded {
        model_id: String,
        load_ms: u64,
        /// Memory the loaded model takes on the device.
        vram_bytes: Option<u64>,
        /// Where this model runs, like "Vulkan: NVIDIA GeForce RTX 5060 Ti" or "CPU".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<String>,
    },
    Unloaded,
    Progress {
        id: u64,
        /// Overall 0..1 when known.
        fraction: Option<f32>,
        /// Engine stage, like "composing".
        stage: Option<String>,
    },
    /// Streaming output: tokens, a partial transcript, or (for audio) a header
    /// followed by raw bytes.
    Chunk {
        id: u64,
        chunk: Chunk,
    },
    Done {
        id: u64,
        ms: u64,
        result: JobResult,
    },
    /// `id` is null for errors outside a job (hello, load).
    Error {
        id: Option<u64>,
        kind: WorkerErrorKind,
        message: String,
    },
    /// Audio output; `bytes` raw bytes follow this line.
    Audio(AudioHeader),
    Bye,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Streaming,
    PromptBiasing,
    Languages,
    PrefixCache,
    Grammar,
    Voices,
    ResumeFromCheckpoint,
    FullDuplex,
    BargeIn,
    /// A capability from a newer worker.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerErrorKind {
    /// `hello` named a role or protocol the worker does not speak.
    Unsupported,
    LoadFailed,
    /// The model does not fit in free device memory.
    OutOfMemory,
    JobFailed,
    Cancelled,
    /// A message the worker could not read.
    BadMessage,
    #[serde(other)]
    Unknown,
}

/// A model from the registry, resolved to files on disk by the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub id: String,
    /// The main model file.
    pub path: String,
    /// Extra files (tokenizer, vocoder, …) by name.
    #[serde(default)]
    pub extra: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadOptions {
    /// Run without the GPU.
    #[serde(default)]
    pub cpu: bool,
    /// Context length for language models.
    pub context: Option<u32>,
    /// Fixed prompt prefix to precompute and keep (cleanup's KV cache).
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobPayload {
    /// stt: transcribe 16 kHz mono audio sent as `audio` frames for this job (ended
    /// by `last: true`), or a file.
    Transcribe {
        audio: AudioSource,
        /// The clip's language when the user fixed it; absent = detect it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        /// Languages detection may pick from; empty = the engine's default set.
        #[serde(default)]
        languages: Vec<String>,
        /// Context from earlier dictations, for engines that take a prompt.
        #[serde(default)]
        prompt: Option<SttPrompt>,
        /// Send partial transcripts as chunks.
        #[serde(default)]
        stream: bool,
    },
    /// llm: generate text.
    Generate {
        prompt: LlmPrompt,
        max_tokens: u32,
        /// Absent = greedy.
        sampling: Option<Sampling>,
        /// GBNF grammar the output must follow.
        grammar: Option<String>,
        /// Key of a cached prompt prefix to reuse.
        prefix_key: Option<String>,
        /// Send tokens as chunks.
        #[serde(default)]
        stream: bool,
    },
    /// tts: speak text; audio comes back as `audio` frames for this job.
    Speak {
        text: String,
        voice: Option<String>,
        language: Option<String>,
        /// Denoising steps; absent = the engine's default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<u32>,
    },
    /// music: compose a song into `output`.
    Compose {
        style: String,
        lyrics: String,
        seconds: u32,
        seed: u64,
        output: String,
        /// Resume from this checkpoint directory.
        checkpoint: Option<String>,
    },
    /// chat: open a duplex session fed by `audio` frames.
    Open {
        brain: String,
        voice: Option<String>,
        language: Option<String>,
    },
}

/// The two parts of a speech prompt, kept apart because the engine decides per clip
/// language whether the sentence goes in (see `delulu_stt::Prompt`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttPrompt {
    /// Vocabulary terms, already joined ("T3 Code, Tauri.").
    #[serde(default)]
    pub terms: Option<String>,
    /// The end of the previous dictation's text.
    #[serde(default)]
    pub sentence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AudioSource {
    /// `audio` frames carrying this job's id.
    Frames,
    File {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LlmPrompt {
    /// A prompt the daemon rendered itself, template included (today's format).
    Raw(String),
    /// Chat messages; the worker applies the model's own chat template.
    Messages(Vec<ChatMessage>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// "system", "user" or "assistant".
    pub role: String,
    pub content: String,
}

/// Seeded temperature and nucleus sampling (same shape as today's helper).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sampling {
    pub seed: u32,
    pub temperature: f32,
    pub top_p: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Chunk {
    Text {
        text: String,
    },
    /// A partial transcript that may still change.
    Partial {
        text: String,
    },
    /// A conversation turn boundary.
    Turn {
        speaker: String,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobResult {
    Transcript {
        text: String,
        language: String,
        audio_ms: u64,
    },
    Text {
        text: String,
        /// `maxTokens` cut the reply off.
        truncated: bool,
    },
    /// Speech was streamed as `audio` frames.
    Spoken {
        audio_ms: u64,
    },
    Song {
        path: String,
        seconds: f32,
    },
    SessionEnded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioHeader {
    /// The job this audio belongs to.
    pub id: u64,
    pub seq: u64,
    pub rate: u32,
    /// Raw bytes that follow the line: `4 × samples` (f32 LE, mono).
    pub bytes: u32,
    /// The last frame of this job's audio.
    #[serde(default)]
    pub last: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn todays_llm_request_maps_onto_a_generate_job() {
        // What `delulu-cleanup` reads today, re-expressed as a job without losing anything.
        let job = ToWorker::Job {
            id: 7,
            lane: Lane::Dictation,
            payload: JobPayload::Generate {
                prompt: LlmPrompt::Raw("<start_of_turn>user …".into()),
                max_tokens: 256,
                sampling: Some(Sampling {
                    seed: 1,
                    temperature: 0.8,
                    top_p: 0.95,
                }),
                grammar: None,
                prefix_key: None,
                stream: false,
            },
        };
        let value = serde_json::to_value(&job).unwrap();
        assert_eq!(value["type"], "job");
        assert_eq!(value["payload"]["kind"], "generate");
        assert_eq!(value["payload"]["maxTokens"], 256);
        let sampling = value["payload"]["sampling"].as_object().unwrap();
        let mut keys: Vec<_> = sampling.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["seed", "temperature", "topP"]);
        assert_eq!(serde_json::from_value::<ToWorker>(value).unwrap(), job);
    }

    #[test]
    fn worker_lines_tolerate_unknown_fields_and_capabilities() {
        let ready: FromWorker = serde_json::from_value(json!({
            "type": "ready", "engine": "llama.cpp", "protocol": 1,
            "device": "Vulkan0", "vramBytes": null,
            "caps": ["prefixCache", "teleport"], "newField": 1
        }))
        .unwrap();
        assert_eq!(
            ready,
            FromWorker::Ready {
                engine: "llama.cpp".into(),
                protocol: 1,
                device: Some("Vulkan0".into()),
                vram_bytes: None,
                caps: vec![Capability::PrefixCache, Capability::Unknown],
            }
        );
    }
}
