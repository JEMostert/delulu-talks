//! Worker JSON-lines protocol (`electron/runtime/workerProtocol.ts`): request
//! and result schemas, bounded stdout framing and the stderr diagnostic tail.
//! Validation errors are plain messages; the client maps them to domain codes.

use delulu_core::util::utf16_len;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::types::{
    voice_limits, DownloadBytes, DownloadBytesKind, MAX_RECOGNITION_HINT_CHARS, VOICE_EVENT_TAGS, VOICE_STYLES,
};

pub const WORKER_PROTOCOL_VERSION: u8 = 1;
pub const RESPONSE_PREFIX: &str = "@delulu:";
pub const PROGRESS_PREFIX: &str = "@delulu-progress:";

const PRESETS: &[&str] =
    &["spoken-corrections", "polish", "concise", "structured", "prompt", "bullet-points", "professional-message"];
const MAGIC_MODELS: &[&str] = &["qwen35Small", "qwen35Medium", "qwen35Large"];
const SPEECH_MODELS: &[&str] = &["r2t2", "canary-180m", "parakeet-v2", "parakeet-v3"];
pub const COMMANDS: &[&str] = &[
    "status",
    "load",
    "unload",
    "magicStatus",
    "magicLoad",
    "magicRewrite",
    "transcribe",
    "shutdown",
    "capabilities",
    "voiceStatus",
    "voiceLoad",
    "voiceUnload",
    "voiceSynthesize",
];
// Keep aligned with the shared PipelineTimings contract; unknown stages are omitted.
const TIMING_FIELDS: &[&str] = &[
    "captureEndMs",
    "preprocessingMs",
    "speechLoadMs",
    "speechRequestMs",
    "backendPreprocessingMs",
    "inferenceMs",
    "rewriteLoadMs",
    "rewritingMs",
    "clipboardMs",
    "pasteMs",
];
const STATUS_COMMANDS: &[&str] =
    &["status", "load", "unload", "magicStatus", "magicLoad", "voiceStatus", "voiceLoad", "voiceUnload"];

type Object = Map<String, Value>;
type Checked<T = ()> = Result<T, String>;

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerResponse {
    Ok { id: String, result: Value },
    Err { id: String, error: String },
}

impl WorkerResponse {
    pub fn id(&self) -> &str {
        match self {
            Self::Ok { id, .. } | Self::Err { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerProgress {
    pub protocol_version: u8,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub id: String,
    pub command: String,
    pub stage: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_bytes: Option<DownloadBytes>,
}

fn object<'a>(value: &'a Value, label: &str) -> Checked<&'a Object> {
    value.as_object().ok_or_else(|| format!("Invalid model worker {label}: expected an object"))
}

fn string_field(value: &Object, key: &str, required: bool, nonempty: bool) -> Checked {
    if !value.contains_key(key) && !required {
        return Ok(());
    }
    match value.get(key) {
        Some(Value::String(text)) if !(nonempty && text.is_empty()) => Ok(()),
        _ => Err(format!(
            "Invalid model worker {key}: expected {} string",
            if nonempty { "a nonempty" } else { "a" }
        )),
    }
}

fn number_field(value: &Object, key: &str, required: bool) -> Checked {
    if !value.contains_key(key) && !required {
        return Ok(());
    }
    match value.get(key).and_then(Value::as_f64) {
        Some(number) if number.is_finite() && number >= 0.0 => Ok(()),
        _ => Err(format!("Invalid model worker {key}: expected a finite nonnegative number")),
    }
}

fn boolean_field(value: &Object, key: &str, required: bool) -> Checked {
    if !value.contains_key(key) && !required {
        return Ok(());
    }
    match value.get(key) {
        Some(Value::Bool(_)) => Ok(()),
        _ => Err(format!("Invalid model worker {key}: expected a boolean")),
    }
}

fn str_of<'a>(value: &'a Object, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `value.key !== undefined && !set.has(value.key)`.
fn outside(value: &Object, key: &str, set: &[&str]) -> bool {
    value.get(key).is_some_and(|field| !field.as_str().is_some_and(|text| set.contains(&text)))
}

fn is_voice_engine(value: Option<&Value>) -> bool {
    matches!(value.and_then(Value::as_str), Some("kokoro" | "chatterbox-turbo"))
}

fn is_protocol_version(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64) == Some(f64::from(WORKER_PROTOCOL_VERSION))
}

fn is_safe_integer(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

fn lifecycle_fields(value: &Object) -> Checked {
    if value.contains_key("residency") && !matches!(str_of(value, "residency"), Some("unloaded" | "resident")) {
        return Err("Invalid model worker residency state".into());
    }
    if value.contains_key("warmup")
        && !matches!(str_of(value, "warmup"), Some("unknown" | "not-started" | "warming" | "complete"))
    {
        return Err("Invalid model worker warmup state".into());
    }
    if !matches!(value.get("device"), Some(Value::Null)) {
        string_field(value, "device", false, false)?;
    }
    if str_of(value, "residency") == Some("resident") {
        string_field(value, "device", true, true)?;
    }
    if str_of(value, "residency") == Some("unloaded") && !matches!(value.get("device"), None | Some(Value::Null)) {
        return Err("Unloaded model worker must not report an active device".into());
    }
    Ok(())
}

// Keep schema traversal bounded independently of the serialized byte budget.
fn json_value(value: &Value, depth: usize) -> Checked {
    if depth > 64 {
        return Err("Model worker JSON exceeds 64 nesting levels".into());
    }
    match value {
        Value::Array(items) => items.iter().try_for_each(|item| json_value(item, depth + 1)),
        Value::Object(map) => map.values().try_for_each(|item| json_value(item, depth + 1)),
        _ => Ok(()),
    }
}

pub fn validate_worker_request(value: &Value) -> Checked {
    let request = object(value, "request")?;
    if !is_protocol_version(request.get("protocolVersion")) {
        return Err("Model worker protocol version mismatch. Restart the app or repair its runtime.".into());
    }
    string_field(request, "id", true, true)?;
    string_field(request, "command", true, true)?;
    let id = str_of(request, "id").unwrap_or_default();
    let command = str_of(request, "command").unwrap_or_default();
    if id.len() > 128 || command.len() > 64 {
        return Err("Model worker request ID/command exceeds its byte limit".into());
    }
    if !COMMANDS.contains(&command) {
        return Err(format!("Unknown model worker command: {command}"));
    }
    json_value(value, 0)?;
    if command == "load" || command == "magicLoad" {
        string_field(request, "cacheDir", false, false)?;
    }
    if command == "load" && outside(request, "device", &["auto", "cpu"]) {
        return Err("Unsupported speech device preference".into());
    }
    if command == "load" || command == "transcribe" {
        string_field(request, "model", false, false)?;
        string_field(request, "language", false, false)?;
        if outside(request, "model", SPEECH_MODELS) {
            return Err("Invalid model worker speech model".into());
        }
    }
    if command == "magicLoad" {
        string_field(request, "model", false, false)?;
        if outside(request, "model", MAGIC_MODELS) {
            return Err("Invalid model worker writing model".into());
        }
    }
    if command == "transcribe" {
        string_field(request, "audioPath", true, true)?;
        string_field(request, "language", false, false)?;
        string_field(request, "hotwords", false, false)?;
        if str_of(request, "hotwords").is_some_and(|hotwords| utf16_len(hotwords) > MAX_RECOGNITION_HINT_CHARS) {
            return Err("Model worker speech hotwords are too long".into());
        }
        number_field(request, "durationMs", false)?;
        for key in ["timestamps", "vocabularyBiasing"] {
            boolean_field(request, key, false)?;
            if request.get(key) == Some(&Value::Bool(true)) {
                return Err(format!(
                    "Current R2T2 adapter does not support {key}. Use buffered transcription with a language hint."
                ));
            }
        }
    }
    if command == "capabilities" {
        if !matches!(str_of(request, "engine"), Some("speech" | "writing")) {
            return Err("Model worker capability query requires speech or writing engine".into());
        }
        string_field(request, "model", false, false)?;
        if outside(request, "model", SPEECH_MODELS) {
            return Err("Invalid model worker speech model".into());
        }
    }
    if command == "voiceLoad" {
        if !is_voice_engine(request.get("engine")) {
            return Err("Invalid model worker voice engine".into());
        }
        string_field(request, "cacheDir", false, false)?;
        if outside(request, "device", &["auto", "cpu"]) {
            return Err("Unsupported voice device preference".into());
        }
    }
    if command == "voiceSynthesize" {
        voice_synthesize_request(request)?;
    }
    if command == "magicRewrite" {
        string_field(request, "text", true, false)?;
        string_field(request, "preset", false, false)?;
        string_field(request, "instructions", false, false)?;
        boolean_field(request, "allowInferences", false)?;
        let text = str_of(request, "text").map(utf16_len).unwrap_or(0);
        let instructions = str_of(request, "instructions").map(utf16_len).unwrap_or(0);
        if text > 500_000 || instructions > 4_000 {
            return Err("Model worker writing input exceeds its character limit".into());
        }
        if outside(request, "preset", PRESETS) {
            return Err("Invalid model worker rewrite preset".into());
        }
    }
    Ok(())
}

fn voice_synthesize_request(request: &Object) -> Checked {
    if !is_voice_engine(request.get("engine")) {
        return Err("Invalid model worker voice engine".into());
    }
    string_field(request, "voice", true, true)?;
    if str_of(request, "voice").unwrap_or_default().len() > 64 {
        return Err("Model worker voice name is too long".into());
    }
    if request.contains_key("reference") {
        string_field(request, "reference", true, true)?;
        if str_of(request, "reference").unwrap_or_default().len() > 4096 {
            return Err("Model worker voice reference path is too long".into());
        }
    }
    match request.get("speed").and_then(Value::as_f64) {
        Some(speed) if (0.25..=4.0).contains(&speed) => {}
        _ => return Err("Model worker voice speed must be between 0.25 and 4".into()),
    }
    let styles_valid = request.get("styles").and_then(Value::as_array).is_some_and(|styles| {
        styles.len() <= voice_limits::STYLES
            && styles.iter().enumerate().all(|(index, style)| {
                style.as_str().is_some_and(|name| VOICE_STYLES.contains(&name)) && !styles[..index].contains(style)
            })
    });
    if !styles_valid {
        return Err("Invalid model worker voice styles".into());
    }
    let parts = match request.get("parts").and_then(Value::as_array) {
        Some(parts) if !parts.is_empty() && parts.len() <= voice_limits::CHUNK_PARTS => parts,
        _ => return Err("Model worker voice parts must be a nonempty bounded list".into()),
    };
    let mut characters = 0;
    for value in parts {
        let part = object(value, "voice part")?;
        match str_of(part, "kind") {
            Some("text") => {
                string_field(part, "text", true, false)?;
                characters += utf16_len(str_of(part, "text").unwrap_or_default());
            }
            Some("event") => {
                if !str_of(part, "tag").is_some_and(|tag| VOICE_EVENT_TAGS.contains(&tag)) {
                    return Err("Invalid model worker voice event".into());
                }
            }
            Some("pause") => {
                number_field(part, "ms", true)?;
                if part.get("ms").and_then(Value::as_f64).unwrap_or(0.0) > voice_limits::PAUSE_MS {
                    return Err("Model worker voice pause is too long".into());
                }
            }
            _ => return Err("Invalid model worker voice part".into()),
        }
    }
    if characters > voice_limits::CHUNK_CHARACTERS {
        return Err("Model worker voice text exceeds its chunk limit".into());
    }
    Ok(())
}

pub fn validate_worker_response(value: &Value) -> Checked<WorkerResponse> {
    let response = object(value, "response")?;
    if !is_protocol_version(response.get("protocolVersion")) {
        return Err("Model worker protocol version mismatch. Restart the app or repair its runtime.".into());
    }
    string_field(response, "id", true, true)?;
    let id = str_of(response, "id").unwrap_or_default().to_owned();
    if id.len() > 128 {
        return Err("Invalid model worker response ID".into());
    }
    boolean_field(response, "ok", true)?;
    if response.get("ok") == Some(&Value::Bool(true)) {
        let Some(result) = response.get("result").filter(|_| !response.contains_key("error")) else {
            return Err("Invalid model worker success response".into());
        };
        json_value(result, 0)?;
        Ok(WorkerResponse::Ok { id, result: result.clone() })
    } else {
        string_field(response, "error", true, true)?;
        let error = str_of(response, "error").unwrap_or_default();
        if response.contains_key("result") || error.len() > 8_000 {
            return Err("Invalid model worker failure response".into());
        }
        Ok(WorkerResponse::Err { id, error: error.to_owned() })
    }
}

pub fn validate_worker_progress(value: &Value) -> Checked<WorkerProgress> {
    let event = object(value, "progress event")?;
    if !is_protocol_version(event.get("protocolVersion")) || str_of(event, "type") != Some("progress") {
        return Err("Model worker progress protocol mismatch. Restart the app or repair its runtime.".into());
    }
    for key in ["id", "command", "stage"] {
        string_field(event, key, true, true)?;
    }
    string_field(event, "detail", true, false)?;
    for (key, limit) in [("id", 128), ("command", 64), ("stage", 64), ("detail", 4_000)] {
        if str_of(event, key).unwrap_or_default().len() > limit {
            return Err(format!("Model worker progress {key} exceeds {limit} UTF-8 bytes"));
        }
    }
    number_field(event, "fraction", false)?;
    let fraction = event.get("fraction").and_then(Value::as_f64);
    if fraction.is_some_and(|f| f > 1.0) {
        return Err("Model worker progress fraction must be between zero and one".into());
    }
    let mut progress = WorkerProgress {
        protocol_version: WORKER_PROTOCOL_VERSION,
        kind: "progress",
        id: str_of(event, "id").unwrap_or_default().to_owned(),
        command: str_of(event, "command").unwrap_or_default().to_owned(),
        stage: str_of(event, "stage").unwrap_or_default().to_owned(),
        detail: str_of(event, "detail").unwrap_or_default().to_owned(),
        fraction,
        download_bytes: None,
    };
    if let Some(raw) = event.get("downloadBytes") {
        let bytes = object(raw, "download bytes")?;
        let completed = bytes.get("completed");
        let total = bytes.get("total");
        let kind = match str_of(bytes, "kind") {
            Some("transfer") => Some(DownloadBytesKind::Transfer),
            Some("reconstruction") => Some(DownloadBytesKind::Reconstruction),
            _ => None,
        };
        let completed_value = completed.and_then(Value::as_f64).unwrap_or(-1.0);
        let total_valid = match total {
            Some(Value::Null) => true,
            other => is_safe_integer(other) && other.and_then(Value::as_f64).unwrap_or(-1.0) >= completed_value,
        };
        if !is_safe_integer(completed) || completed_value < 0.0 || !total_valid || kind.is_none() {
            return Err("Model worker download counters must be nonnegative safe integers with a nullable total and known byte kind".into());
        }
        progress.download_bytes = Some(DownloadBytes {
            completed: completed_value as u64,
            total: total.and_then(Value::as_f64).map(|t| t as u64),
            kind: kind.unwrap_or(DownloadBytesKind::Transfer),
        });
    }
    Ok(progress)
}

pub fn validate_worker_result(command: &str, value: &Value) -> Checked {
    let result = object(value, "result")?;
    if let Some(timings) = result.get("timings") {
        let timings = object(timings, "timings")?;
        for key in timings.keys() {
            if !TIMING_FIELDS.contains(&key.as_str()) {
                return Err(format!("Invalid model worker timing field: {key}"));
            }
            number_field(timings, key, true)?;
        }
    }
    if command == "capabilities" {
        let speech = match (result.get("schemaVersion").and_then(Value::as_f64), str_of(result, "engine")) {
            (Some(1.0), Some(engine @ ("speech" | "writing"))) => engine == "speech",
            _ => return Err("Invalid model worker capability schema or engine".into()),
        };
        let (families, backends): (&[&str], &[&str]) = if speech {
            (&["r2t2", "canary", "parakeet"], &["mlx", "cuda-transformers", "onnx-cpu"])
        } else {
            (&["qwen3.5"], &["transformers"])
        };
        if !str_of(result, "modelFamily").is_some_and(|f| families.contains(&f))
            || !str_of(result, "backend").is_some_and(|b| backends.contains(&b))
        {
            return Err("Invalid model worker capability backend/model family".into());
        }
        for key in ["timestamps", "vocabularyBiasing"] {
            boolean_field(result, key, true)?;
        }
        let hints = object(result.get("languageHints").unwrap_or(&Value::Null), "language hint capability")?;
        boolean_field(hints, "supported", true)?;
        let languages = match hints.get("languages").and_then(Value::as_array) {
            Some(languages)
                if languages.len() <= 128
                    && languages.iter().all(|code| code.as_str().is_some_and(|c| !c.is_empty() && c.len() <= 64)) =>
            {
                languages
            }
            _ => return Err("Invalid model worker language capability list".into()),
        };
        let duplicate = languages.iter().enumerate().any(|(index, code)| languages[..index].contains(code));
        if duplicate || (hints.get("supported") == Some(&Value::Bool(false)) && !languages.is_empty()) {
            return Err("Inconsistent model worker language capabilities".into());
        }
    } else if STATUS_COMMANDS.contains(&command) {
        boolean_field(result, "loaded", true)?;
        lifecycle_fields(result)?;
        let loaded = result.get("loaded") == Some(&Value::Bool(true));
        match str_of(result, "residency") {
            Some("resident") if !loaded => return Err("Model worker residency disagrees with loaded state".into()),
            Some("unloaded") if loaded => return Err("Model worker residency disagrees with loaded state".into()),
            _ => {}
        }
        for key in ["model", "device"] {
            if !matches!(result.get(key), Some(Value::Null)) {
                string_field(result, key, false, false)?;
            }
        }
        if command.starts_with("voice")
            && !matches!(result.get("engine"), Some(Value::Null))
            && !is_voice_engine(result.get("engine"))
        {
            return Err("Invalid model worker voice engine".into());
        }
    } else if command == "voiceSynthesize" {
        let rate = result.get("sampleRate").and_then(Value::as_f64);
        if !rate.is_some_and(|r| r.fract() == 0.0 && (8000.0..=48000.0).contains(&r)) {
            return Err("Invalid model worker voice sample rate".into());
        }
        string_field(result, "audio", true, false)?;
        for key in ["durationMs", "processingTimeMs"] {
            number_field(result, key, true)?;
        }
        if result.get("durationMs").and_then(Value::as_f64).unwrap_or(0.0) > voice_limits::CHUNK_AUDIO_SECONDS * 1000.0 {
            return Err("Model worker voice audio exceeds its chunk limit".into());
        }
        if !is_voice_engine(result.get("engine")) {
            return Err("Invalid model worker voice engine".into());
        }
        string_field(result, "device", true, true)?;
        let unsupported_valid = result.get("unsupported").and_then(Value::as_array).is_some_and(|tags| {
            tags.len() <= 32 && tags.iter().all(|tag| tag.as_str().is_some_and(|t| !t.is_empty() && t.len() <= 64))
        });
        if !unsupported_valid {
            return Err("Invalid model worker unsupported voice tags".into());
        }
    } else if command == "transcribe" {
        string_field(result, "text", true, false)?;
        string_field(result, "language", true, false)?;
        for key in ["duration", "processingTime"] {
            number_field(result, key, true)?;
        }
        number_field(result, "inferenceTime", false)?;
    } else if command == "magicRewrite" {
        lifecycle_fields(result)?;
        string_field(result, "text", true, false)?;
        string_field(result, "model", true, false)?;
        for key in ["processingTimeMs", "inputCharacters", "outputCharacters"] {
            number_field(result, key, true)?;
        }
        for key in ["inputCharacters", "outputCharacters"] {
            if !is_safe_integer(result.get(key)) {
                return Err(format!("Invalid model worker {key}: expected a safe integer"));
            }
        }
        boolean_field(result, "includedInferences", true)?;
    } else if command == "shutdown" && result.get("shutdown") != Some(&Value::Bool(true)) {
        return Err("Invalid model worker shutdown result".into());
    }
    Ok(())
}

/// UTF-8 wire bytes exclude the newline delimiter; stdout includes log lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerProtocolLimits {
    pub request_bytes: usize,
    pub stdout_line_bytes: usize,
    pub pending_requests: usize,
    pub stderr_bytes: usize,
}

pub const DEFAULT_WORKER_PROTOCOL_LIMITS: WorkerProtocolLimits = WorkerProtocolLimits {
    request_bytes: 4 * 1024 * 1024,
    stdout_line_bytes: 8 * 1024 * 1024,
    pending_requests: 8,
    stderr_bytes: 80_000,
};

impl Default for WorkerProtocolLimits {
    fn default() -> Self {
        DEFAULT_WORKER_PROTOCOL_LIMITS
    }
}

impl WorkerProtocolLimits {
    pub fn validate(self) -> Checked<Self> {
        for (name, value) in [
            ("requestBytes", self.request_bytes),
            ("stdoutLineBytes", self.stdout_line_bytes),
            ("pendingRequests", self.pending_requests),
            ("stderrBytes", self.stderr_bytes),
        ] {
            if value < 1 || value as u64 > 9_007_199_254_740_991 {
                return Err(format!("Worker protocol limit {name} must be a positive integer"));
            }
        }
        Ok(self)
    }
}

/// Grows one bounded buffer instead of retaining arbitrarily many tiny chunks.
/// Lines end at LF, CR or CRLF (even split across chunks).
pub struct BoundedWorkerLines {
    buffer: Vec<u8>,
    max_bytes: usize,
    after_cr: bool,
}

impl BoundedWorkerLines {
    pub fn new(max_bytes: usize) -> Self {
        Self { buffer: Vec::new(), max_bytes, after_cr: false }
    }

    fn append(&mut self, chunk: &[u8]) -> Checked {
        let length = self.buffer.len() + chunk.len();
        if length > self.max_bytes {
            return Err(format!(
                "Model worker stdout line exceeds {} UTF-8 bytes. Load the model to retry.",
                self.max_bytes
            ));
        }
        if length > self.buffer.capacity() {
            let target = self.max_bytes.min(length.max(self.buffer.capacity() * 2).max(1024));
            self.buffer.reserve_exact(target - self.buffer.len());
        }
        self.buffer.extend_from_slice(chunk);
        Ok(())
    }

    fn take(&mut self) -> String {
        let line = String::from_utf8_lossy(&self.buffer).into_owned();
        self.buffer.clear();
        line
    }

    /// Feeds a chunk; `on_line` returns whether to keep consuming this chunk.
    /// Errors are line-limit overflows or errors raised by `on_line`.
    pub fn push(&mut self, chunk: &[u8], on_line: &mut dyn FnMut(String) -> Checked<bool>) -> Checked {
        let mut offset = 0;
        while offset < chunk.len() {
            if self.after_cr {
                self.after_cr = false;
                if chunk[offset] == b'\n' {
                    offset += 1;
                    continue;
                }
            }
            let Some(relative) = chunk[offset..].iter().position(|&b| b == b'\n' || b == b'\r') else {
                return self.append(&chunk[offset..]);
            };
            let newline = offset + relative;
            self.append(&chunk[offset..newline])?;
            self.after_cr = chunk[newline] == b'\r';
            let line = self.take();
            if !on_line(line)? {
                return Ok(());
            }
            offset = newline + 1;
        }
        Ok(())
    }

    pub fn end(&mut self, on_line: &mut dyn FnMut(String) -> Checked<bool>) -> Checked {
        if !self.buffer.is_empty() {
            let line = self.take();
            on_line(line)?;
        }
        Ok(())
    }
}

/// Keeps raw bytes across chunks so cutting the tail cannot split UTF-8 text.
#[derive(Debug, Clone)]
pub struct WorkerDiagnosticTail {
    buffer: Vec<u8>,
    max_bytes: usize,
}

/// Decodes like Node's `StringDecoder.write`: invalid sequences become U+FFFD
/// and an incomplete trailing sequence is withheld.
fn decode_utf8_prefix(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    Some(length) => {
                        out.push('\u{FFFD}');
                        rest = &after[length..];
                    }
                    None => return out,
                }
            }
        }
    }
}

fn skip_continuation(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|&b| b & 0xc0 != 0x80).unwrap_or(bytes.len());
    &bytes[start..]
}

impl WorkerDiagnosticTail {
    pub fn new(max_bytes: usize) -> Self {
        Self { buffer: Vec::new(), max_bytes }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.max_bytes {
            self.buffer = chunk[chunk.len() - self.max_bytes..].to_vec();
        } else {
            let retained = self.buffer.len().min(self.max_bytes - chunk.len());
            self.buffer.drain(..self.buffer.len() - retained);
            self.buffer.extend_from_slice(chunk);
        }
    }

    pub fn text(&self) -> String {
        let text = decode_utf8_prefix(skip_continuation(&self.buffer));
        // Invalid input can expand into replacement characters; keep that bounded too.
        if text.len() <= self.max_bytes {
            return text;
        }
        decode_utf8_prefix(skip_continuation(&text.as_bytes()[text.len() - self.max_bytes..]))
    }
}

/// Builds `{...payload, protocolVersion, id, command}` plus the newline, after
/// validating the envelope and the UTF-8 byte budget.
pub fn serialize_worker_request(id: &str, command: &str, payload: &Value, max_bytes: usize) -> Checked<String> {
    if command.is_empty() {
        return Err("Model worker command must be a nonempty string".into());
    }
    let Some(payload) = payload.as_object() else {
        return Err("Model worker payload must be a JSON object".into());
    };
    let mut envelope = payload.clone();
    envelope.insert("protocolVersion".into(), Value::from(WORKER_PROTOCOL_VERSION));
    envelope.insert("id".into(), Value::from(id));
    envelope.insert("command".into(), Value::from(command));
    let envelope = Value::Object(envelope);
    let serialized = validate_worker_request(&envelope)
        .and_then(|()| serde_json::to_string(&envelope).map_err(|error| error.to_string()))
        .map_err(|reason| {
            format!("Model worker request cannot be serialized as JSON: {reason}. Correct the request and try again.")
        })?;
    if serialized.len() > max_bytes {
        return Err(format!(
            "Model worker request exceeds {max_bytes} UTF-8 bytes ({} bytes). Use a smaller text selection and try again.",
            serialized.len()
        ));
    }
    Ok(format!("{serialized}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn collect(parser: &mut BoundedWorkerLines, bytes: &[u8], lines: &mut Vec<String>) -> Checked {
        parser.push(bytes, &mut |line| {
            lines.push(line);
            Ok(true)
        })
    }

    #[test]
    fn framing_preserves_fragmented_unicode_and_final_output_while_bounding_logs() {
        let mut parser = BoundedWorkerLines::new(32);
        let mut lines = Vec::new();
        for byte in "café 🎙️\r\nfinal".as_bytes() {
            collect(&mut parser, &[*byte], &mut lines).unwrap();
        }
        parser
            .end(&mut |line| {
                lines.push(line);
                Ok(true)
            })
            .unwrap();
        assert_eq!(lines, vec!["café 🎙️", "final"]);
        let mut runaway = BoundedWorkerLines::new(4);
        collect(&mut runaway, b"1234", &mut lines).unwrap();
        assert!(collect(&mut runaway, b"5", &mut lines).unwrap_err().contains("exceeds 4"));
        let mut diagnostics = WorkerDiagnosticTail::new(7);
        for byte in "old diagnostics 👋é".as_bytes() {
            diagnostics.push(&[*byte]);
        }
        assert_eq!(diagnostics.text(), " 👋é");
    }

    #[test]
    fn oversized_and_invalid_requests_are_rejected_before_dispatch() {
        let payload = json!({ "text": "🎙️" });
        let request = serialize_worker_request("request", "status", &payload, 1024).unwrap();
        let bytes = request.len() - 1;
        assert_eq!(serialize_worker_request("request", "status", &payload, bytes).unwrap(), request);
        let error = serialize_worker_request("request", "status", &payload, bytes - 1).unwrap_err();
        assert!(error.contains("UTF-8 bytes"), "{error}");
        assert!(serialize_worker_request("request", "status", &json!([]), 1024).unwrap_err().contains("JSON object"));
        // A payload cannot replace the envelope fields.
        let wire = serialize_worker_request("request", "status", &json!({ "id": "foreign" }), 1024).unwrap();
        assert_eq!(serde_json::from_str::<Value>(wire.trim()).unwrap()["id"], "request");
        let error = serialize_worker_request("request", "streamStart", &json!({}), 1024).unwrap_err();
        assert!(error.contains("cannot be serialized"), "{error}");
    }

    #[test]
    fn schemas_reject_removed_commands_and_malformed_transcriptions() {
        let error = validate_worker_request(&json!({ "protocolVersion": 1, "id": "request", "command": "streamStart" }))
            .unwrap_err();
        assert_eq!(error, "Unknown model worker command: streamStart");
        let result = json!({ "text": "Saved", "language": "und", "duration": 1, "processingTime": 0.1 });
        validate_worker_result("transcribe", &result).unwrap();
        let mut bad = result.clone();
        bad["text"] = Value::Null;
        assert!(validate_worker_result("transcribe", &bad).is_err());
        let mut bad = result;
        bad["duration"] = json!(-1);
        assert!(validate_worker_result("transcribe", &bad).is_err());
    }

    #[test]
    fn cpu_speech_negotiation_keeps_writing_isolation() {
        for (model, family, languages) in [
            ("canary-180m", "canary", json!(["en", "de", "fr", "es"])),
            ("parakeet-v2", "parakeet", json!(["en"])),
            ("parakeet-v3", "parakeet", json!([])),
        ] {
            validate_worker_request(&json!({
                "protocolVersion": 1, "id": format!("{model}-load"), "command": "load",
                "model": model, "language": "en", "device": "cpu",
            }))
            .unwrap();
            let supported = !languages.as_array().unwrap().is_empty();
            let mut capabilities = json!({
                "schemaVersion": 1, "engine": "speech", "backend": "onnx-cpu", "modelFamily": family,
                "timestamps": false, "languageHints": { "supported": supported, "languages": languages },
                "vocabularyBiasing": false,
            });
            validate_worker_result("capabilities", &capabilities).unwrap();
            capabilities["engine"] = json!("writing");
            assert!(validate_worker_result("capabilities", &capabilities).is_err());
        }
    }

    #[test]
    fn speech_engines_are_limited_to_the_three_sizes() {
        let identity = |extra: Value| {
            let mut value = json!({ "protocolVersion": 1, "id": "request" });
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            value
        };
        validate_worker_request(&identity(json!({ "command": "load", "model": "canary-180m" }))).unwrap();
        for model in ["nemotron", "redux"] {
            let error = validate_worker_request(&identity(json!({ "command": "load", "model": model }))).unwrap_err();
            assert!(error.contains("Invalid model worker speech model"));
        }
        validate_worker_request(&identity(json!({ "command": "capabilities", "engine": "speech", "model": "parakeet-v3" })))
            .unwrap();
        let error =
            validate_worker_request(&identity(json!({ "command": "capabilities", "engine": "speech", "model": "redux" })))
                .unwrap_err();
        assert!(error.contains("Invalid model worker speech model"));
        let mut capabilities = json!({
            "schemaVersion": 1, "engine": "speech", "backend": "cuda-transformers", "modelFamily": "r2t2",
            "timestamps": false, "languageHints": { "supported": true, "languages": ["en"] }, "vocabularyBiasing": false,
        });
        validate_worker_result("capabilities", &capabilities).unwrap();
        capabilities["backend"] = json!("photon-cpu");
        capabilities["modelFamily"] = json!("nemotron");
        assert!(validate_worker_result("capabilities", &capabilities)
            .unwrap_err()
            .contains("Invalid model worker capability backend/model family"));
    }

    #[test]
    fn transcription_hotwords_must_be_a_bounded_string() {
        let transcribe = json!({
            "protocolVersion": 1, "id": "hints", "command": "transcribe",
            "audioPath": "/tmp/a.wav", "language": "auto", "hotwords": "Kestrel, Moondream",
        });
        validate_worker_request(&transcribe).unwrap();
        let mut bad = transcribe.clone();
        bad["hotwords"] = json!(["Kestrel"]);
        assert!(validate_worker_request(&bad).is_err());
        let mut long = transcribe;
        long["hotwords"] = json!("x".repeat(MAX_RECOGNITION_HINT_CHARS + 1));
        assert!(validate_worker_request(&long).unwrap_err().contains("too long"));
    }

    #[test]
    fn voice_requests_are_validated_before_they_reach_the_worker() {
        let request = |command: &str, payload: Value| {
            let mut value = json!({ "protocolVersion": 1, "id": "voice", "command": command });
            value.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());
            validate_worker_request(&value)
        };
        let synthesis = json!({
            "engine": "chatterbox-turbo", "voice": "af_heart", "speed": 1, "styles": ["whisper"],
            "parts": [
                { "kind": "text", "text": "Okay, that one was my fault" },
                { "kind": "event", "tag": "laugh" },
                { "kind": "pause", "ms": 400 },
                { "kind": "text", "text": ". Fixed it" },
            ],
        });
        let with = |key: &str, value: Value| {
            let mut copy = synthesis.clone();
            copy[key] = value;
            copy
        };
        request("voiceLoad", json!({ "engine": "kokoro" })).unwrap();
        assert!(request("voiceLoad", json!({ "engine": "orpheus" })).unwrap_err().contains("voice engine"));
        request("voiceSynthesize", synthesis.clone()).unwrap();
        request("voiceSynthesize", with("reference", json!("/clip.wav"))).unwrap();
        assert!(request("voiceSynthesize", with("speed", json!(9))).unwrap_err().contains("speed"));
        assert!(request("voiceSynthesize", with("styles", json!(["whisper", "whisper"]))).unwrap_err().contains("styles"));
        assert!(request("voiceSynthesize", with("styles", json!(["sad"]))).unwrap_err().contains("styles"));
        assert!(request("voiceSynthesize", with("parts", json!([]))).unwrap_err().contains("parts"));
        let event = with("parts", json!([{ "kind": "event", "tag": "scream" }]));
        assert!(request("voiceSynthesize", event).unwrap_err().contains("event"));
        let pause = with("parts", json!([{ "kind": "pause", "ms": 60_000 }]));
        assert!(request("voiceSynthesize", pause).unwrap_err().contains("pause"));
        let long = with("parts", json!([{ "kind": "text", "text": "a".repeat(601) }]));
        assert!(request("voiceSynthesize", long).unwrap_err().contains("chunk limit"));
    }

    #[test]
    fn voice_results_must_describe_bounded_playable_audio() {
        let result = json!({
            "sampleRate": 24_000, "audio": "AAAA", "durationMs": 1200, "processingTimeMs": 210,
            "engine": "kokoro", "device": "cpu", "unsupported": ["laugh"],
        });
        let with = |key: &str, value: Value| {
            let mut copy = result.clone();
            copy[key] = value;
            validate_worker_result("voiceSynthesize", &copy)
        };
        validate_worker_result("voiceSynthesize", &result).unwrap();
        assert!(with("sampleRate", json!(1)).unwrap_err().contains("sample rate"));
        assert!(with("durationMs", json!(91_000)).unwrap_err().contains("chunk limit"));
        assert!(with("unsupported", json!([1])).unwrap_err().contains("unsupported"));
        validate_worker_result(
            "voiceLoad",
            &json!({
                "loaded": true, "model": "csukuangfj/kokoro-multi-lang-v1_0", "device": "cpu",
                "residency": "resident", "warmup": "complete", "engine": "kokoro",
            }),
        )
        .unwrap();
        let error = validate_worker_result(
            "voiceStatus",
            &json!({
                "loaded": false, "model": null, "device": null, "residency": "unloaded",
                "warmup": "not-started", "engine": "piper",
            }),
        )
        .unwrap_err();
        assert!(error.contains("voice engine"));
    }

    #[test]
    fn progress_events_are_bounded() {
        let progress = validate_worker_progress(&json!({
            "protocolVersion": 1, "type": "progress", "id": "a", "command": "load", "stage": "download",
            "detail": "x", "fraction": 0.5, "downloadBytes": { "completed": 1, "total": null, "kind": "transfer" },
        }))
        .unwrap();
        assert_eq!(progress.download_bytes.unwrap().total, None);
        let error = validate_worker_progress(&json!({
            "protocolVersion": 1, "type": "progress", "id": "a", "command": "load", "stage": "download",
            "detail": "x", "downloadBytes": { "completed": 5, "total": 1, "kind": "transfer" },
        }))
        .unwrap_err();
        assert!(error.contains("download counters"));
    }
}
