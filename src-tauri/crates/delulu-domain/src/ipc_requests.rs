//! Runtime contracts for renderer requests (`src/ipcRequests.ts`): every
//! channel has an exact arity and a parser that truncates or rejects input
//! exactly like the TypeScript. The renderer validates first; the IPC router
//! validates again before any handler runs.
//!
//! Arguments arrive as JSON, so a TypeScript `undefined` argument arrives as
//! `null`; where the TypeScript accepted `undefined` (the optional source
//! revision of `history:setRewrite`), `null` is accepted in its place.
//!
//! Renderer-capture channels (`recorder:*`, `listen:event`, `voice:playback`,
//! `lab:resolveAudioFiles`) are gone: capture and playback are native.

use std::collections::HashSet;

use delulu_core::DomainError;
use serde_json::{Map, Value};

use crate::catalog::{is_magic_preset, DEFAULT_SETTINGS_JSON, MAX_AUDIO_BATCH_FILES};
use crate::js;
use crate::pipeline_timings::normalize_timings;
use crate::plain_error;
use crate::serde_js;
use crate::types::MagicModelId;
use crate::voice::{VoiceSource, VoiceSpeakRequest, VOICE_LIMITS};

type Parse = fn(&[Value]) -> Result<Vec<Value>, DomainError>;
type Object = Map<String, Value>;

fn object<'v>(value: &'v Value, label: &str) -> Result<&'v Object, DomainError> {
    value.as_object().ok_or_else(|| plain_error(format!("Expected {label} object")))
}

/// A text argument truncated to `max` UTF-16 units.
pub fn request_text(value: &Value, max: usize) -> Result<String, DomainError> {
    match value {
        Value::String(text) => Ok(js::truncate_utf16(text, max).to_owned()),
        _ => Err(plain_error("Expected text input")),
    }
}

fn text_value(value: &Value, max: usize) -> Result<Value, DomainError> {
    request_text(value, max).map(Value::String)
}

fn finite_number(value: &Value, label: &str) -> Result<f64, DomainError> {
    value.as_f64().filter(|number| number.is_finite()).ok_or_else(|| plain_error(format!("Expected a finite {label}")))
}

fn optional_boolean(source: &Object, key: &str) -> Result<(), DomainError> {
    match source.get(key) {
        Some(value) if !value.is_boolean() => Err(plain_error(format!("Expected {key} to be a boolean"))),
        _ => Ok(()),
    }
}

fn optional_string(source: &Object, key: &str) -> Result<(), DomainError> {
    match source.get(key) {
        Some(value) if !value.is_string() => Err(plain_error(format!("Expected {key} to be text"))),
        _ => Ok(()),
    }
}

const NULL: Value = Value::Null;

fn field<'v>(source: &'v Object, key: &str) -> &'v Value {
    source.get(key).unwrap_or(&NULL)
}

/// Arbitrary JSON within depth, list and text limits.
pub fn json_input(value: &Value) -> Result<Value, DomainError> {
    json_input_at(value, 0)
}

fn json_input_at(value: &Value, depth: usize) -> Result<Value, DomainError> {
    if depth > 64 {
        return Err(plain_error("Request nesting is too deep"));
    }
    Ok(match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(_) => text_value(value, 500_000)?,
        Value::Array(items) => {
            if items.len() > 1000 {
                return Err(plain_error("Request list is too long"));
            }
            Value::Array(items.iter().map(|item| json_input_at(item, depth + 1)).collect::<Result<_, _>>()?)
        }
        Value::Object(source) => Value::Object(
            source.iter().map(|(key, item)| Ok((key.clone(), json_input_at(item, depth + 1)?))).collect::<Result<_, DomainError>>()?,
        ),
    })
}

fn parse_custom_words(value: &Value) -> Result<Value, DomainError> {
    let Value::Array(items) = value else {
        return Err(plain_error("Expected customWords array"));
    };
    let mut words = Vec::new();
    for item in items.iter().take(500) {
        let word = object(item, "custom word")?;
        optional_string(word, "kind")?;
        optional_boolean(word, "enabled")?;
        // Storage continues to supply legacy defaults and normalize empty terms.
        let mut parsed = object(&json_input(item)?, "custom word")?.clone();
        for (key, max) in [("id", 128), ("term", 256), ("soundsLike", 1024), ("replacement", 4096)] {
            optional_string(word, key)?;
            if let Some(Value::String(text)) = word.get(key) {
                let text = if key == "replacement" { text.as_str() } else { js::trim(text) };
                parsed.insert(key.into(), Value::String(js::truncate_utf16(text, max).to_owned()));
            }
        }
        for key in ["kind", "enabled"] {
            if let Some(original) = word.get(key) {
                parsed.insert(key.into(), original.clone());
            }
        }
        words.push(Value::Object(parsed));
    }
    Ok(Value::Array(words))
}

/// A partial settings update: only known keys, with the default's type.
pub fn parse_settings_patch(value: &Value) -> Result<Object, DomainError> {
    let source = object(value, "settings")?;
    let mut patch = Object::new();
    for (key, value) in source {
        let Some(fallback) = DEFAULT_SETTINGS_JSON.get(key) else {
            return Err(plain_error(format!("Unknown setting: {key}")));
        };
        match fallback {
            Value::Bool(_) if !value.is_boolean() => return Err(plain_error(format!("Expected {key} boolean"))),
            Value::Number(_) => {
                finite_number(value, key)?;
            }
            // Type check only: settings text is bounded by storage, not truncated here.
            Value::String(_) => {
                request_text(value, 4096)?;
            }
            _ => {}
        }
        if key == "customWords" {
            patch.insert(key.clone(), parse_custom_words(value)?);
        } else {
            if fallback.is_object() || fallback.is_array() {
                json_input(value)?;
            }
            patch.insert(key.clone(), value.clone());
        }
    }
    for (key, message) in
        [("schemaVersion", "Unsupported settings schema version"), ("workflowVersion", "Unsupported workflow version")]
    {
        if source.get(key).is_some_and(|version| version.as_f64() != Some(1.0)) {
            return Err(plain_error(message));
        }
    }
    Ok(patch)
}

/// A Magic rewrite request. `context` stays raw JSON here; the rewrite
/// service validates it with `normalize_rewrite_context`.
pub fn parse_magic_request(value: &Value) -> Result<Value, DomainError> {
    let source = object(value, "Magic rewrite request")?;
    optional_string(source, "preset")?;
    optional_boolean(source, "allowInferences")?;
    let mut request = Object::new();
    let text = request_text(field(source, "text"), 50_000)?;
    request.insert("text".into(), Value::String(text.clone()));
    if let Some(context) = source.get("context") {
        request.insert("context".into(), json_input(context)?);
    }
    if let Some(operation_id) = source.get("operationId") {
        request.insert("operationId".into(), text_value(operation_id, 128)?);
    }
    if let Some(language) = source.get("sourceLanguage") {
        request.insert("sourceLanguage".into(), text_value(language, 64)?);
    }
    let preset = source.get("preset").and_then(Value::as_str).filter(|preset| is_magic_preset(preset)).unwrap_or("polish");
    request.insert("preset".into(), preset.into());
    let instructions = match source.get("instructions") {
        None | Some(Value::Null) => String::new(),
        Some(instructions) => request_text(instructions, 4_000)?,
    };
    request.insert("instructions".into(), js::trim(&instructions).into());
    request.insert("allowInferences".into(), Value::Bool(source.get("allowInferences") == Some(&Value::Bool(true))));
    if js::trim(&text).is_empty() {
        return Err(plain_error("Add a transcript or draft before using Magic"));
    }
    Ok(Value::Object(request))
}

fn parse_rewrite_result(value: &Value) -> Result<Value, DomainError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let source = object(value, "rewrite")?;
    optional_string(source, "preset")?;
    optional_string(source, "model")?;
    optional_boolean(source, "includedInferences")?;
    for key in ["inputCharacters", "outputCharacters"] {
        if let Some(count) = source.get(key) {
            if finite_number(count, key)? < 0.0 {
                return Err(plain_error(format!("Invalid {key}")));
            }
        }
    }
    let text = request_text(field(source, "text"), 500_000)?;
    if js::trim(&text).is_empty() {
        return Err(plain_error("A rewrite cannot be empty"));
    }
    let processing_time_ms = match source.get("processingTimeMs") {
        None => 0.0,
        Some(time) => finite_number(time, "rewrite processing time")?.max(0.0),
    };
    let mut result = Object::new();
    result.insert("text".into(), Value::String(text));
    if let Some(preset) = source.get("preset").and_then(Value::as_str).filter(|preset| is_magic_preset(preset)) {
        result.insert("preset".into(), preset.into());
    }
    if let Some(model) = source.get("model").and_then(Value::as_str).filter(|model| MagicModelId::parse(model).is_some()) {
        result.insert("model".into(), model.into());
    }
    result.insert(
        "includedInferences".into(),
        Value::Bool(source.get("includedInferences") == Some(&Value::Bool(true))),
    );
    result.insert("processingTimeMs".into(), serde_js::number(processing_time_ms));
    if let Some(timings) = source.get("timings").and_then(normalize_timings) {
        result.insert("timings".into(), serde_json::to_value(timings)?);
    }
    Ok(Value::Object(result))
}

/// A speak request from the app: only the `app` and `clipboard` sources.
pub fn parse_voice_speak_request(value: &Value) -> Result<VoiceSpeakRequest, DomainError> {
    let source = object(value, "speak request")?;
    optional_boolean(source, "interrupt")?;
    optional_boolean(source, "normalize")?;
    let speech_source = match source.get("source") {
        None => VoiceSource::App,
        Some(Value::String(name)) if name == "app" => VoiceSource::App,
        Some(Value::String(name)) if name == "clipboard" => VoiceSource::Clipboard,
        Some(_) => return Err(plain_error("Expected an app or clipboard speech source")),
    };
    let text = request_text(field(source, "text"), VOICE_LIMITS.request_characters)?;
    if js::trim(&text).is_empty() {
        return Err(plain_error("There is nothing to say"));
    }
    Ok(VoiceSpeakRequest {
        text,
        source: Some(speech_source),
        agent: None,
        interrupt: source.get("interrupt").and_then(Value::as_bool),
        normalize: source.get("normalize").and_then(Value::as_bool),
        response_id: None,
    })
}

fn string_ids(value: &Value, limit: usize, count: usize) -> Result<Value, DomainError> {
    let Value::Array(items) = value else {
        return Err(plain_error("Invalid selection list"));
    };
    if items.len() > count {
        return Err(plain_error("Invalid selection list"));
    }
    let ids = items.iter().map(|item| request_text(item, limit)).collect::<Result<Vec<_>, _>>()?;
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(plain_error("Duplicate selection entries"));
    }
    Ok(Value::Array(ids.into_iter().map(Value::String).collect()))
}

fn ids(value: &Value) -> Result<Value, DomainError> {
    string_ids(value, 128, 500)
}

fn none(_: &[Value]) -> Result<Vec<Value>, DomainError> {
    Ok(Vec::new())
}
fn id128(args: &[Value]) -> Result<Vec<Value>, DomainError> {
    Ok(vec![text_value(&args[0], 128)?])
}
fn path4096(args: &[Value]) -> Result<Vec<Value>, DomainError> {
    Ok(vec![text_value(&args[0], 4096)?])
}
fn passphrase(args: &[Value]) -> Result<Vec<Value>, DomainError> {
    Ok(vec![text_value(&args[0], 1024)?])
}

/// Every request channel with its argument count and parser.
const SCHEMAS: &[(&str, usize, Parse)] = &[
    ("listen:status", 0, none),
    ("listen:start", 0, none),
    ("listen:stop", 0, none),
    ("voice:installSkill", 0, none),
    ("voice:status", 0, none),
    ("voice:setup", 0, none),
    ("voice:cancelSetup", 0, none),
    ("voice:load", 0, none),
    ("voice:unload", 0, none),
    ("voice:speak", 1, |args| Ok(vec![serde_json::to_value(parse_voice_speak_request(&args[0])?)?])),
    ("voice:stop", 0, none),
    ("voice:speakClipboard", 0, none),
    ("voice:chooseReference", 0, none),
    ("voice:removeReference", 0, none),
    ("voice:agentSetup", 0, none),
    ("audio:inputs", 0, none),
    ("audio:outputs", 0, none),
    ("audio:testCue", 0, none),
    ("cache:preview", 0, none),
    ("models:downloads", 0, none),
    ("models:deleteDownload", 1, |args| Ok(vec![text_value(&args[0], 32)?])),
    ("cache:cleanup", 2, |args| Ok(vec![text_value(&args[0], 128)?, ids(&args[1])?])),
    ("rules:usage", 0, none),
    ("rules:resetUsage", 0, none),
    ("dictation:pasteLastStatus", 0, none),
    ("dictation:cancelPasteLast", 1, id128),
    ("history:batchSnapshot", 0, none),
    ("history:stageDeletion", 1, |args| Ok(vec![ids(&args[0])?])),
    ("history:undoDeletion", 1, id128),
    ("history:exportSelection", 2, |args| Ok(vec![ids(&args[0])?, text_value(&args[1], 16)?])),
    ("history:encryptedExport", 1, passphrase),
    ("history:encryptedRecover", 1, passphrase),
    ("history:retentionPreview", 1, |args| Ok(vec![json_input(&args[0])?])),
    ("history:retentionApply", 1, id128),
    ("history:setTitle", 2, |args| {
        let title = if args[1].is_null() { Value::Null } else { text_value(&args[1], 512)? };
        Ok(vec![text_value(&args[0], 128)?, title])
    }),
    ("lab:chooseAudioFiles", 0, none),
    ("lab:getJobs", 0, none),
    ("lab:loadSource", 1, path4096),
    ("lab:removeJob", 1, path4096),
    ("lab:relinkJob", 1, path4096),
    ("lab:resolveAudioPaths", 1, |args| Ok(vec![string_ids(&args[0], 4096, MAX_AUDIO_BATCH_FILES)?])),
    ("lab:queueGet", 0, none),
    ("lab:queueClearFinished", 0, none),
    ("lab:queueEnqueue", 1, path4096),
    ("lab:queuePause", 1, |args| match &args[0] {
        Value::Bool(paused) => Ok(vec![Value::Bool(*paused)]),
        _ => Err(plain_error("Expected pause boolean")),
    }),
    ("lab:queueMove", 2, |args| {
        if !matches!(args[1].as_f64(), Some(direction) if direction == -1.0 || direction == 1.0) {
            return Err(plain_error("Expected move direction"));
        }
        Ok(vec![text_value(&args[0], 128)?, args[1].clone()])
    }),
    ("lab:queueCancel", 1, id128),
    ("lab:queueRetry", 1, id128),
    ("magic:cancelRewrite", 1, id128),
    ("paste:recovery", 0, none),
    ("paste:copyInstead", 1, id128),
    ("paste:dismissRecovery", 1, id128),
    ("dictation:pause", 0, none),
    ("dictation:resume", 0, none),
    ("runtime:setupLog", 1, |args| match args[0].as_str() {
        Some("speech" | "rewrite" | "voice") => Ok(vec![args[0].clone()]),
        _ => Err(plain_error("Choose speech, rewriting or voice setup logs")),
    }),
    ("runtime:setupSnapshot", 0, none),
    ("storage:overview", 0, none),
    ("renderer:recoveryState", 0, none),
    ("renderer:reload", 0, none),
    ("renderer:controllerFailed", 0, none),
    ("runtime:diagnostics", 0, none),
    ("runtime:renderingMode", 0, none),
    ("dictation:pasteLast", 0, none),
    ("dictation:discardFailed", 0, none),
    ("dictation:retry", 0, none),
    ("settings:get", 0, none),
    ("settings:update", 1, |args| Ok(vec![Value::Object(parse_settings_patch(&args[0])?)])),
    ("runtime:status", 0, none),
    ("shortcut:status", 0, none),
    ("shortcut:configure", 0, none),
    ("runtime:setup", 0, none),
    ("runtime:cancelSetup", 0, none),
    ("runtime:load", 0, none),
    ("runtime:unload", 0, none),
    ("runtime:reset", 0, none),
    ("magic:status", 0, none),
    ("magic:setup", 0, none),
    ("magic:cancelSetup", 0, none),
    ("magic:load", 0, none),
    ("magic:unload", 0, none),
    ("magic:rewrite", 1, |args| Ok(vec![parse_magic_request(&args[0])?])),
    ("platform:capabilities", 0, none),
    ("app:visibility", 0, none),
    ("updates:get", 0, none),
    ("updates:check", 0, none),
    ("updates:download", 0, none),
    ("updates:install", 0, none),
    ("dictation:start", 0, none),
    ("dictation:stop", 0, none),
    ("dictation:toggle", 0, none),
    ("dictation:cancel", 0, none),
    ("clipboard:copy", 1, |args| Ok(vec![text_value(&args[0], 500_000)?])),
    ("paste:authorize", 0, none),
    ("paste:test", 0, none),
    ("history:get", 0, none),
    ("history:updateTranscript", 2, |args| {
        let text = if args[1].is_null() { Value::Null } else { text_value(&args[1], 500_000)? };
        Ok(vec![text_value(&args[0], 128)?, text])
    }),
    ("history:setRewrite", 4, |args| {
        let id = text_value(&args[0], 128)?;
        let result = parse_rewrite_result(&args[1])?;
        let expected = text_value(&args[2], 500_000)?;
        // `undefined` crosses JSON as `null`.
        let revision = if args[3].is_null() {
            Value::Null
        } else {
            finite_number(&args[3], "source revision")?;
            args[3].clone()
        };
        Ok(vec![id, result, expected, revision])
    }),
    ("history:delete", 1, id128),
    ("history:clear", 0, none),
    ("lab:chooseAudio", 0, none),
    ("lab:inspectAudio", 1, path4096),
    ("lab:run", 1, |args| {
        let path = text_value(field(object(&args[0], "audio file request")?, "path"), 4096)?;
        Ok(vec![Value::Object(Object::from_iter([("path".to_owned(), path)]))])
    }),
    ("history:export", 2, |args| {
        let Value::String(format) = &args[1] else {
            return Err(plain_error("Expected export format text"));
        };
        let format = if matches!(format.as_str(), "txt" | "json" | "md") { format.as_str() } else { "txt" };
        Ok(vec![text_value(&args[0], 128)?, format.into()])
    }),
];

/// Every request channel name.
pub fn ipc_request_channels() -> impl Iterator<Item = &'static str> {
    SCHEMAS.iter().map(|(channel, _, _)| *channel)
}

pub fn is_ipc_request_channel(channel: &str) -> bool {
    SCHEMAS.iter().any(|(name, _, _)| *name == channel)
}

/// Channels the renderer sends without awaiting a result (`ipc_send`).
/// Electron's three (`recorder:level`, `voice:playback`, `listen:event`)
/// carried renderer capture and are gone, so none remain; the list stays
/// so the router keeps one source of truth.
pub const FIRE_AND_FORGET_CHANNELS: &[&str] = &[];

/// Validates a renderer request: unknown channels and wrong arity are
/// rejected; each argument is parsed with the TypeScript's limits.
pub fn parse_ipc_request(channel: &str, args: Vec<Value>) -> Result<Vec<Value>, DomainError> {
    let Some((_, count, parse)) = SCHEMAS.iter().find(|(name, _, _)| *name == channel) else {
        return Err(plain_error(format!("Unknown IPC request: {channel}")));
    };
    if args.len() != *count {
        return Err(plain_error(format!("Expected {count} request arguments")));
    }
    parse(&args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(channel: &str, args: Value) -> Result<Vec<Value>, String> {
        parse_ipc_request(channel, args.as_array().unwrap().clone()).map_err(|error| error.message)
    }

    #[test]
    fn channels_and_arity_are_exact() {
        assert_eq!(parse("recorder:level", json!([0.5])).unwrap_err(), "Unknown IPC request: recorder:level");
        assert_eq!(parse("settings:get", json!([1])).unwrap_err(), "Expected 0 request arguments");
        assert_eq!(parse("audio:inputs", json!([])).unwrap(), Vec::<Value>::new());
        let error = parse_ipc_request("nope", vec![]).unwrap_err();
        assert_eq!(error.code, delulu_core::DomainErrorCode::OperationFailed);
        assert_eq!(error.cause.unwrap().name, "Error");
        let unique: HashSet<_> = ipc_request_channels().collect();
        assert_eq!(unique.len(), SCHEMAS.len());
    }

    #[test]
    fn text_is_truncated_in_utf16_units_and_lists_are_bounded() {
        assert_eq!(parse("history:delete", json!(["x".repeat(200)])).unwrap(), [json!("x".repeat(128))]);
        assert_eq!(parse("history:setTitle", json!(["id", null])).unwrap(), [json!("id"), json!(null)]);
        assert_eq!(parse("history:stageDeletion", json!([["a", "a"]])).unwrap_err(), "Duplicate selection entries");
        let paths: Vec<String> = (0..=MAX_AUDIO_BATCH_FILES).map(|i| format!("/a/{i}.wav")).collect();
        assert_eq!(parse("lab:resolveAudioPaths", json!([paths])).unwrap_err(), "Invalid selection list");
        assert_eq!(parse("lab:resolveAudioPaths", json!([["/a.wav"]])).unwrap(), [json!(["/a.wav"])]);
        assert_eq!(parse("lab:queueMove", json!(["id", 2])).unwrap_err(), "Expected move direction");
        assert_eq!(parse("history:export", json!(["id", "pdf"])).unwrap(), [json!("id"), json!("txt")]);
        let mut deep = json!(1);
        for _ in 0..66 {
            deep = json!([deep]);
        }
        assert_eq!(parse("history:retentionPreview", json!([deep])).unwrap_err(), "Request nesting is too deep");
        assert_eq!(parse("history:retentionPreview", json!([vec![0; 1001]])).unwrap_err(), "Request list is too long");
    }

    #[test]
    fn settings_patches_accept_known_keys_with_default_types() {
        assert_eq!(parse("settings:update", json!([{"bogus": 1}])).unwrap_err(), "Unknown setting: bogus");
        assert_eq!(parse("settings:update", json!([{"autoPaste": "yes"}])).unwrap_err(), "Expected autoPaste boolean");
        assert_eq!(parse("settings:update", json!([{"voiceSpeed": "1"}])).unwrap_err(), "Expected a finite voiceSpeed");
        assert_eq!(parse("settings:update", json!([{"workflowVersion": 2}])).unwrap_err(), "Unsupported workflow version");
        let patch = parse(
            "settings:update",
            json!([{"historyRetention": null, "customWords": [{"id": " a ", "term": " T ", "replacement": " r ", "x": [1]}]}]),
        )
        .unwrap();
        assert_eq!(
            patch[0],
            json!({"historyRetention": null, "customWords": [{"id": "a", "term": "T", "replacement": " r ", "x": [1]}]})
        );
    }

    #[test]
    fn magic_rewrite_and_speak_requests_follow_the_typescript() {
        let request = parse("magic:rewrite", json!([{"text": "hi", "preset": "bogus", "instructions": " be brief "}])).unwrap();
        assert_eq!(request[0], json!({"text": "hi", "preset": "polish", "instructions": "be brief", "allowInferences": false}));
        assert_eq!(parse("magic:rewrite", json!([{"text": "  "}])).unwrap_err(), "Add a transcript or draft before using Magic");
        let rewrite = parse(
            "history:setRewrite",
            json!(["id", {"text": "new", "model": "qwen35Small", "processingTimeMs": -5, "inputCharacters": 3, "timings": {"rewritingMs": 1.234}}, "old", null]),
        )
        .unwrap();
        assert_eq!(
            rewrite[1],
            json!({"text": "new", "model": "qwen35Small", "includedInferences": false, "processingTimeMs": 0, "timings": {"rewritingMs": 1.23}})
        );
        assert_eq!(rewrite[3], json!(null));
        assert_eq!(parse("history:setRewrite", json!(["id", {"text": "x"}, "old", "2"])).unwrap_err(), "Expected a finite source revision");
        let speak = parse("voice:speak", json!([{"text": "Hello", "interrupt": true}])).unwrap();
        assert_eq!(speak[0], json!({"text": "Hello", "source": "app", "interrupt": true}));
        assert_eq!(parse("voice:speak", json!([{"text": "x", "source": "agent"}])).unwrap_err(), "Expected an app or clipboard speech source");
    }
}
