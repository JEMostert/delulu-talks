//! Settings and history storage (`electron/services/storage.ts`).
//!
//! Persisted data is held as JSON values with JavaScript object semantics:
//! normalization assigns keys like the TypeScript object spreads did (an
//! existing key keeps its position, new keys are appended), unknown keys are
//! preserved, and the decision to rewrite a file compares `JSON.stringify`
//! output exactly like the Electron app. A profile the Electron app wrote
//! therefore opens without a rewrite, and any rewrite produces the bytes the
//! Electron app would have produced.
//!
//! Every mutation validates and publishes the complete file first (staged
//! private temporary file, fsync, rename) and updates memory only after the
//! write succeeded. All methods take `&self`; one internal lock serializes
//! mutations, so concurrent IPC handlers cannot interleave writes.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use delulu_core::util::{publish, stage_private, truncate_utf16, utf16_len};
use delulu_core::{now_ms, AppPaths, DomainError, DomainResult};
use delulu_domain::js;
use delulu_domain::persisted_schema::{assert_persisted_schema, version_persisted_record, PersistedSchemaKind};
use delulu_domain::text::{normalize_aliases_value, normalize_language_metadata, normalize_reported_language};
use delulu_domain::text::normalize_transcript_title;
use delulu_domain::voice::{is_kokoro_voice, is_voice_engine_id};
use delulu_domain::word_packs::is_word_pack_id;
use delulu_domain::{
    is_magic_preset, AppSettings, MagicModelId, SpeechModelId, SpeechTier, TranscriptRecord, AUTO_LANGUAGE, DEFAULT_SETTINGS_JSON,
    LANGUAGES, LEGACY_DEFAULT_SHORTCUT, MAGIC_MODELS, MODELS,
};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::history_retention::{history_fingerprint_value, saved_retention_policy};
use crate::json::{self as jsj, assign, delete};
use crate::migration_backups::{backup_profile_migration, history_backup_cleanup_error, remove_migration_history_backups};
use crate::profile_write::{validate_profile_write, ProfileKind};
use crate::plain_error;

pub const SETTINGS_FILE: &str = "settings.json";
pub const HISTORY_FILE: &str = "history.json";
pub const MAX_HISTORY: usize = 500;

/* Platform */

/// `speechModelForPlatform()`: MLX on Apple Silicon, CUDA elsewhere.
pub fn speech_model_for_platform() -> SpeechModelId {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        SpeechModelId::R2t2Mlx
    } else {
        SpeechModelId::R2t2
    }
}

/// R2T2 (Large) needs CUDA on x64 Linux/Windows or MLX on Apple Silicon.
pub fn large_speech_supported() -> bool {
    cfg!(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(not(target_os = "macos"), target_arch = "x86_64")
    ))
}

/* JavaScript value helpers */

fn default(key: &str) -> Value {
    DEFAULT_SETTINGS_JSON.get(key).cloned().unwrap_or(Value::Null)
}

fn default_str(key: &str) -> String {
    default(key).as_str().unwrap_or_default().to_owned()
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `value ?? other`: `null` and `undefined` fall through.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| !matches!(value, None | Some(Value::Null))).flatten()
}

/// `safeString`: trimmed text bounded to `max` UTF-16 units, else `fallback`.
fn safe_string(value: Option<&Value>, fallback: &str, max: usize) -> String {
    match value {
        Some(Value::String(text)) => {
            let bounded = truncate_utf16(js::trim(text), max);
            if bounded.is_empty() { fallback.to_owned() } else { bounded.to_owned() }
        }
        _ => fallback.to_owned(),
    }
}

fn boolean(value: Option<&Value>, key: &str) -> Value {
    match value {
        Some(Value::Bool(flag)) => Value::Bool(*flag),
        _ => default(key),
    }
}

/// `boundedNumber`; an in-range number keeps its exact JSON representation.
fn bounded(value: Option<&Value>, key: &str, minimum: f64, maximum: f64) -> Value {
    match value {
        Some(original @ Value::Number(number)) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            if n >= minimum && n <= maximum {
                original.clone()
            } else {
                jsj::number(n.clamp(minimum, maximum))
            }
        }
        _ => default(key),
    }
}

fn one_of(value: Option<&Value>, allowed: &[f64], key: &str) -> Value {
    let number = jsj::to_number(value);
    if allowed.contains(&number) {
        match value {
            Some(original @ Value::Number(_)) => original.clone(),
            _ => jsj::number(number),
        }
    } else {
        default(key)
    }
}

fn string_value(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

fn is_valid_magic_model(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|id| MAGIC_MODELS.iter().any(|model| model.id.as_str() == id))
}

/// History keeps the name of a retired writing model; settings fall back to the default.
fn is_known_magic_model(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).and_then(MagicModelId::parse).is_some()
}

fn is_valid_history_model(value: &str) -> bool {
    value == "qwen3Asr" || MODELS.iter().any(|model| model.id.as_str() == value)
}

/* Settings normalization */

/// v0.16 replaced R2T2/Parakeet Redux with three sizes; earlier engines map onto them.
fn speech_tier(value: Option<&Value>, saved: bool) -> SpeechTier {
    // R2T2 and the removed Nemotron engine both ran on the GPU; Redux on the CPU.
    // Saved profiles from before the setting existed used R2T2.
    let text = value.and_then(Value::as_str);
    let tier = match text {
        Some("r2t2" | "nemotron") => SpeechTier::Large,
        None if value.is_none() && saved => SpeechTier::Large,
        Some("redux") => SpeechTier::Medium,
        Some(other) => SpeechTier::parse(other).unwrap_or(SpeechTier::Medium),
        None => SpeechTier::Medium,
    };
    if tier == SpeechTier::Large && !large_speech_supported() {
        SpeechTier::Medium
    } else {
        tier
    }
}

fn invalid_words(message: &str) -> DomainError {
    plain_error(message)
}

fn normalize_words(value: Option<&Value>) -> DomainResult<Value> {
    let Some(value) = value else { return Ok(json!([])) };
    let items = match value {
        Value::Array(items) if items.len() <= 500 => items,
        _ => return Err(invalid_words("Invalid or oversized vocabulary rules. Existing settings are preserved.")),
    };
    let mut rules = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let Value::Object(source) = item else {
            return Err(invalid_words("Invalid vocabulary rule. Existing settings are preserved."));
        };
        assert_persisted_schema(item, PersistedSchemaKind::Rule)?;
        let term = safe_string(source.get("term"), "", 256);
        if term.is_empty() {
            return Err(invalid_words("Vocabulary rule has no term. Existing settings are preserved."));
        }
        if let Some(Value::String(replacement)) = source.get("replacement") {
            if utf16_len(replacement) > 4096 {
                return Err(invalid_words(
                    "Vocabulary text block exceeds the supported limit. Existing settings are preserved.",
                ));
            }
        }
        // Preserve nonempty scopes, including unknown codes: never widen a saved rule.
        let language = match source.get("language") {
            Some(Value::String(text)) if !js::trim(text).is_empty() => {
                Some(truncate_utf16(&js::trim(text).to_lowercase(), 64).to_owned())
            }
            _ => None,
        };
        let kind = if source.get("kind").and_then(Value::as_str) == Some("shortcut")
            || (!truthy(source.get("kind")) && truthy(source.get("replacement")))
        {
            "shortcut"
        } else {
            "correction"
        };
        let mut rule = source.clone();
        assign(&mut rule, "schemaVersion", Some(json!(1)));
        assign(&mut rule, "kind", Some(json!(kind)));
        let fallback_id = format!("word-{}-{index}", now_ms());
        assign(&mut rule, "id", Some(string_value(safe_string(source.get("id"), &fallback_id, 128))));
        assign(&mut rule, "term", Some(string_value(term)));
        // An unscoped rule omits the key, keeping the saved key order otherwise.
        assign(&mut rule, "language", language.map(Value::String));
        assign(&mut rule, "soundsLike", Some(string_value(safe_string(source.get("soundsLike"), "", 1024))));
        if let Some(aliases) = source.get("aliases") {
            assign(&mut rule, "aliases", Some(json!(normalize_aliases_value(aliases))));
        }
        // Shortcut indentation and trailing whitespace are literal user text.
        let replacement = match source.get("replacement") {
            Some(Value::String(text)) if !js::trim(text).is_empty() => text.clone(),
            _ => String::new(),
        };
        assign(&mut rule, "replacement", Some(string_value(replacement)));
        let enabled = source.get("enabled") != Some(&Value::Bool(false))
            && matches!(source.get("language"), None | Some(Value::Null) | Some(Value::String(_)));
        assign(&mut rule, "enabled", Some(Value::Bool(enabled)));
        rules.push(Value::Object(rule));
    }
    Ok(Value::Array(rules))
}

fn voice_clone_pattern() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^[a-z0-9-]{1,64}\.(wav|flac|mp3|ogg)$").expect("valid regex"));
    &RE
}

/// `normalizeSettings` on raw JSON: the exact object the TypeScript returned.
pub fn normalize_settings_value(value: &Value) -> DomainResult<Value> {
    let mut source = value.as_object().cloned().unwrap_or_default();
    // Removed CPU device setting: never carried into normalized settings.
    for removed in ["speechDevice", "liveTyping", "dictationMode", "personalProfiles", "activePersonalProfile"] {
        delete(&mut source, removed);
    }
    let source_value = Value::Object(source);
    assert_persisted_schema(&source_value, PersistedSchemaKind::Settings)?;
    let Value::Object(source) = source_value else { unreachable!() };
    let get = |key: &str| source.get(key);

    let magic_model = if is_valid_magic_model(get("magicModel")) { get("magicModel").cloned() } else { None }
        .unwrap_or_else(|| default("magicModel"));
    let magic_preset = match get("magicPreset") {
        Some(Value::String(preset)) if is_magic_preset(preset) => Value::String(preset.clone()),
        _ => default("magicPreset"),
    };
    let requested_language = safe_string(get("language"), &default_str("language"), 12).to_lowercase();
    let speech_engine = speech_tier(get("speechEngine"), get("schemaVersion").is_some());
    let requested_shortcut = safe_string(get("shortcut"), &default_str("shortcut"), 96);
    let model = speech_model_for_platform();
    let valid_language =
        LANGUAGES.iter().any(|(code, _)| *code == requested_language) || requested_language == AUTO_LANGUAGE;
    let language = delulu_domain::speech_capabilities::supported_speech_language(
        speech_engine,
        model,
        if valid_language { &requested_language } else { DEFAULT_SETTINGS_JSON["language"].as_str().unwrap_or("en") },
    );
    let text = |key: &str| get(key).and_then(Value::as_str);
    let paste_delay = match get("pasteLastDelaySeconds") {
        Some(original @ Value::Number(number))
            if number.as_f64().is_some_and(|n| n.fract() == 0.0 && (1.0..=30.0).contains(&n)) =>
        {
            original.clone()
        }
        _ => default("pasteLastDelaySeconds"),
    };
    let capture_volume = bounded(get("captureSoundVolume"), "captureSoundVolume", 0.0, 1.0);
    let word_packs = match get("wordPacks") {
        Some(Value::Array(items)) => {
            let mut packs: Vec<Value> = Vec::new();
            for item in items {
                if item.as_str().is_some_and(is_word_pack_id) && !packs.contains(item) {
                    packs.push(item.clone());
                }
            }
            Value::Array(packs)
        }
        _ => json!([]),
    };
    let rounded = |key: &str, minimum: f64, maximum: f64| {
        let value = bounded(get(key), key, minimum, maximum);
        let n = value.as_f64().unwrap_or(0.0);
        if js::round(n) == n { value } else { jsj::number(js::round(n)) }
    };

    let entries: Vec<(&str, Value)> = vec![
        ("schemaVersion", json!(1)),
        ("workflowVersion", json!(1)),
        ("theme", json!(if matches!(text("theme"), Some("light" | "dark")) { text("theme") } else { Some("system") })),
        ("onboardingComplete", boolean(get("onboardingComplete"), "onboardingComplete")),
        (
            "shortcut",
            string_value(if requested_shortcut == LEGACY_DEFAULT_SHORTCUT { default_str("shortcut") } else { requested_shortcut }),
        ),
        ("shortcutMode", json!(if text("shortcutMode") == Some("toggle") { "toggle" } else { "hold" })),
        ("model", json!(model.as_str())),
        ("language", string_value(language)),
        ("dictationFormatting", json!(if text("dictationFormatting") == Some("spoken") { "spoken" } else { "preserve" })),
        ("pythonCommand", string_value(safe_string(get("pythonCommand"), &default_str("pythonCommand"), 512))),
        ("inputDeviceId", string_value(safe_string(get("inputDeviceId"), &default_str("inputDeviceId"), 512))),
        ("inputDeviceLabel", string_value(safe_string(get("inputDeviceLabel"), &default_str("inputDeviceLabel"), 512))),
        ("trailingSilenceStopEnabled", boolean(get("trailingSilenceStopEnabled"), "trailingSilenceStopEnabled")),
        ("trailingSilenceSeconds", bounded(get("trailingSilenceSeconds"), "trailingSilenceSeconds", 2.0, 30.0)),
        (
            "trailingSilenceThresholdDb",
            bounded(get("trailingSilenceThresholdDb"), "trailingSilenceThresholdDb", -60.0, -20.0),
        ),
        ("autoPaste", boolean(get("autoPaste"), "autoPaste")),
        ("pasteShortcut", if text("pasteShortcut") == Some("terminal") { json!("terminal") } else { default("pasteShortcut") }),
        ("pasteLastDelaySeconds", paste_delay),
        ("copyToClipboard", boolean(get("copyToClipboard"), "copyToClipboard")),
        ("restoreClipboardAfterPaste", boolean(get("restoreClipboardAfterPaste"), "restoreClipboardAfterPaste")),
        ("spokenFormattingCommands", boolean(get("spokenFormattingCommands"), "spokenFormattingCommands")),
        ("pastePortalToken", string_value(safe_string(get("pastePortalToken"), &default_str("pastePortalToken"), 4096))),
        ("keepHistory", boolean(get("keepHistory"), "keepHistory")),
        ("historyRetention", saved_retention_policy(get("historyRetention"))),
        ("showOverlay", boolean(get("showOverlay"), "showOverlay")),
        ("speechEngine", json!(speech_engine.as_str())),
        ("historyLimit", one_of(get("historyLimit"), &[25.0, 50.0, 100.0, 250.0, 500.0], "historyLimit")),
        ("captureSoundsMuted", boolean(get("captureSoundsMuted"), "captureSoundsMuted")),
        ("captureSoundVolume", capture_volume),
        ("preloadModel", boolean(get("preloadModel"), "preloadModel")),
        ("magicEnabled", boolean(get("magicEnabled"), "magicEnabled")),
        ("magicModel", magic_model),
        ("magicPreset", magic_preset),
        ("magicAllowInferences", boolean(get("magicAllowInferences"), "magicAllowInferences")),
        ("preloadMagicModel", boolean(get("preloadMagicModel"), "preloadMagicModel")),
        ("memoryPolicy", json!(if text("memoryPolicy") == Some("balanced") { "balanced" } else { "independent" })),
        ("modelIdleMinutes", one_of(get("modelIdleMinutes"), &[1.0, 5.0, 15.0, 30.0, 60.0], "modelIdleMinutes")),
        ("launchAtLogin", boolean(get("launchAtLogin"), "launchAtLogin")),
        ("menuBarOnly", boolean(get("menuBarOnly"), "menuBarOnly")),
        ("customWords", normalize_words(get("customWords"))?),
        ("wordPacks", word_packs),
        ("vocabularyHints", boolean(get("vocabularyHints"), "vocabularyHints")),
        ("voiceEnabled", boolean(get("voiceEnabled"), "voiceEnabled")),
        (
            "voiceEngine",
            match text("voiceEngine") {
                Some(engine) if is_voice_engine_id(engine) => json!(engine),
                _ => default("voiceEngine"),
            },
        ),
        (
            "voiceName",
            match text("voiceName") {
                Some(name) if is_kokoro_voice(name) => json!(name),
                _ => default("voiceName"),
            },
        ),
        // Only a bare file name inside the references directory, never a path.
        (
            "voiceClone",
            match text("voiceClone") {
                Some(clone) if voice_clone_pattern().is_match(clone) => json!(clone),
                _ => json!(""),
            },
        ),
        ("voiceSpeed", bounded(get("voiceSpeed"), "voiceSpeed", 0.5, 2.0)),
        ("voiceVolume", bounded(get("voiceVolume"), "voiceVolume", 0.0, 1.0)),
        (
            "voiceOutputDeviceId",
            string_value(safe_string(get("voiceOutputDeviceId"), &default_str("voiceOutputDeviceId"), 512)),
        ),
        ("voiceInterruptOnDictation", boolean(get("voiceInterruptOnDictation"), "voiceInterruptOnDictation")),
        ("voiceNormalizeText", boolean(get("voiceNormalizeText"), "voiceNormalizeText")),
        ("voiceKeepLoaded", boolean(get("voiceKeepLoaded"), "voiceKeepLoaded")),
        ("voiceAgentBridge", boolean(get("voiceAgentBridge"), "voiceAgentBridge")),
        ("voiceCoordinatorMode", json!(text("voiceCoordinatorMode")
            .and_then(delulu_domain::types::VoiceCoordinatorMode::parse)
            .unwrap_or_default().as_str())),
        ("listenSensitivity", bounded(get("listenSensitivity"), "listenSensitivity", 0.0, 1.0)),
        ("listenSilenceMs", rounded("listenSilenceMs", 300.0, 3000.0)),
        ("listenBargeIn", boolean(get("listenBargeIn"), "listenBargeIn")),
        ("listenBargeInMs", rounded("listenBargeInMs", 100.0, 1000.0)),
    ];
    let mut result = source.clone();
    for (key, value) in entries {
        // Missing optional coordinator settings mean Off without rewriting older profiles.
        if key == "voiceCoordinatorMode" && !source.contains_key(key) { continue; }
        assign(&mut result, key, Some(value));
    }
    Ok(Value::Object(result))
}

fn settings_from_value(value: &Value) -> DomainResult<AppSettings> {
    serde_json::from_value(value.clone())
        .map_err(|error| plain_error(format!("Settings could not be loaded: {error}. Existing settings are preserved.")))
}

/// `normalizeSettings`, typed.
pub fn normalize_settings(value: &Value) -> DomainResult<AppSettings> {
    settings_from_value(&normalize_settings_value(value)?)
}

/* Transcript migration */

fn migrate_delivery(value: Option<&Value>) -> Option<Value> {
    let source = value?.as_object()?;
    let state = source.get("state")?.as_str()?;
    if !["transcribed", "copied", "paste-attempted", "confirmed"].contains(&state) {
        return None;
    }
    let updated_at = source.get("updatedAt")?;
    if updated_at.as_f64()? < 0.0 {
        return None;
    }
    let optional = |key: &str| match source.get(key) {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    };
    let method = optional("method")?;
    let detail = optional("detail")?;
    let mut delivery = Map::new();
    delivery.insert("state".into(), json!(state));
    delivery.insert("updatedAt".into(), updated_at.clone());
    if let Some(method) = method {
        delivery.insert("method".into(), json!(truncate_utf16(&method, 128)));
    }
    if let Some(detail) = detail {
        delivery.insert("detail".into(), json!(truncate_utf16(&detail, 2_000)));
    }
    Some(Value::Object(delivery))
}

fn non_negative_revision(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_f64()?;
    (js::is_safe_integer(number) && number >= 0.0).then(|| value.cloned()).flatten()
}

fn non_negative_number(value: Option<&Value>) -> Value {
    let number = jsj::to_number(value);
    let number = if number.is_nan() || number == 0.0 { 0.0 } else { number.max(0.0) };
    match value {
        Some(original @ Value::Number(_)) if original.as_f64() == Some(number) => original.clone(),
        _ => jsj::number(number),
    }
}

fn optional_text(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        _ => Value::Null,
    }
}

/// `migrateRecord`: validates a saved transcript and upgrades a legacy one.
pub fn migrate_record(value: &Value) -> DomainResult<Value> {
    let Value::Object(source) = value else {
        return Err(plain_error("Invalid transcript record. History has been preserved."));
    };
    // Copy so removed keys are dropped from the saved file on the next rewrite.
    let mut source = source.clone();
    assert_persisted_schema(value, PersistedSchemaKind::Transcript)?;
    // Removed code/command modes and technical text: never carried into records.
    delete(&mut source, "technicalText");
    delete(&mut source, "dictationMode");
    let original = coalesce(&[source.get("text"), source.get("intendedText"), source.get("verbatimText")]);
    let text = original.and_then(Value::as_str).unwrap_or_default().to_owned();
    if js::trim(&text).is_empty() {
        return Err(plain_error(
            "Invalid transcript text. History has been preserved; repair or restore the file before migration.",
        ));
    }
    if source.get("schemaVersion").and_then(Value::as_f64) == Some(1.0) {
        return Ok(Value::Object(source));
    }
    let model = match source.get("model") {
        None => default("model").as_str().unwrap_or("r2t2").to_owned(),
        Some(Value::String(model)) if is_valid_history_model(model) => model.clone(),
        Some(_) => {
            return Err(plain_error(
                "Unknown historical speech model. History has been preserved; restore or repair the file before migration.",
            ))
        }
    };
    let delivery = migrate_delivery(source.get("delivery"));
    let title = source.get("title").map(|title| match normalize_transcript_title(title) {
        Ok(Some(title)) => Value::String(title),
        // Invalid optional metadata must not discard original transcript content.
        _ => Value::Null,
    });
    let execution = if model == "qwen3Asr" {
        None
    } else {
        source.get("speechExecution").and_then(delulu_domain::speech_models::normalize_speech_execution)
    };
    let created_at = {
        let number = jsj::to_number(source.get("createdAt"));
        if number.is_nan() || number == 0.0 {
            jsj::number(now_ms() as f64)
        } else {
            match source.get("createdAt") {
                Some(original @ Value::Number(_)) => original.clone(),
                _ => jsj::number(number),
            }
        }
    };
    let get = |key: &str| source.get(key);
    let edited = coalesce(&[get("editedText"), get("editedIntendedText")]);
    let mut result = source.clone();
    let mut set = |key: &str, value: Option<Value>| assign(&mut result, key, value);
    set("schemaVersion", Some(json!(1)));
    let fallback_id = format!("legacy-{}-{}", now_ms(), rand::random::<f64>());
    set("id", Some(string_value(safe_string(get("id"), &fallback_id, 128))));
    if let Some(title) = title {
        set("title", Some(title));
    }
    set("createdAt", Some(created_at));
    set("durationMs", Some(non_negative_number(get("durationMs"))));
    set("text", Some(string_value(text)));
    set("sourceRevision", Some(non_negative_revision(get("sourceRevision")).unwrap_or(json!(0))));
    set("rewriteSourceRevision", Some(non_negative_revision(get("rewriteSourceRevision")).unwrap_or(Value::Null)));
    set("personalizedText", Some(optional_text(get("personalizedText"))));
    set("editedText", Some(optional_text(edited)));
    set("magicText", Some(optional_text(get("magicText"))));
    set("magicModel", Some(if is_known_magic_model(get("magicModel")) { get("magicModel").cloned().unwrap() } else { Value::Null }));
    set(
        "magicPreset",
        Some(match get("magicPreset") {
            Some(Value::String(preset)) if is_magic_preset(preset) => Value::String(preset.clone()),
            _ => Value::Null,
        }),
    );
    set("magicIncludedInferences", Some(Value::Bool(get("magicIncludedInferences") == Some(&Value::Bool(true)))));
    set("magicProcessingTimeMs", Some(non_negative_number(get("magicProcessingTimeMs"))));
    set("model", Some(string_value(model)));
    if let Some(execution) = execution {
        set("speechExecution", serde_json::to_value(execution).ok());
    }
    set("language", Some(string_value(safe_string(get("language"), "en", 12))));
    if let Some(requested) = get("requestedLanguage") {
        set("requestedLanguage", Some(normalize_reported_language(requested).map_or(Value::Null, Value::String)));
    }
    if get("recognizedLanguage").is_some() || get("recognizedLanguages").is_some() || get("languageStatus").is_some() {
        let metadata = normalize_language_metadata(&Value::Object(source.clone()));
        if let Ok(Value::Object(fields)) = serde_json::to_value(metadata) {
            for (key, value) in fields {
                set(&key, Some(value));
            }
        }
    }
    set(
        "dictationFormatting",
        Some(json!(if get("dictationFormatting").and_then(Value::as_str) == Some("spoken") { "spoken" } else { "preserve" })),
    );
    set(
        "source",
        Some(match get("source").and_then(Value::as_str) {
            Some(kind @ ("dictation" | "file")) => json!(kind),
            _ => json!("dictation"),
        }),
    );
    set("sourceName", Some(optional_text(get("sourceName"))));
    set("processingTimeMs", Some(non_negative_number(get("processingTimeMs"))));
    if let Some(delivery) = delivery {
        set("delivery", Some(delivery));
    }
    set(
        "captureDiagnostics",
        get("captureDiagnostics")
            .and_then(delulu_domain::capture_diagnostics::normalize_capture_diagnostics)
            .and_then(|d| serde_json::to_value(d).ok()),
    );
    set(
        "timings",
        get("timings").and_then(delulu_domain::pipeline_timings::normalize_timings).and_then(|t| serde_json::to_value(t).ok()),
    );
    Ok(Value::Object(result))
}

/// `applyTranscriptEdit` on a persisted record value.
pub fn apply_transcript_edit_value(record: &Value, text: Option<&str>) -> DomainResult<Value> {
    let mut map = record.as_object().cloned().unwrap_or_default();
    let revision = match map.get("sourceRevision").and_then(Value::as_f64) {
        Some(revision) if js::is_safe_integer(revision) && revision >= 0.0 => revision,
        _ => 0.0,
    };
    if revision >= 9_007_199_254_740_991.0 {
        return Err(plain_error("This transcript has reached its revision limit"));
    }
    let timings = map
        .get("timings")
        .and_then(delulu_domain::pipeline_timings::without_rewrite_timings)
        .and_then(|t| serde_json::to_value(t).ok());
    assign(&mut map, "sourceRevision", Some(jsj::number(revision + 1.0)));
    assign(&mut map, "rewriteSourceRevision", Some(Value::Null));
    assign(&mut map, "magicText", Some(Value::Null));
    assign(&mut map, "magicModel", Some(Value::Null));
    assign(&mut map, "magicPreset", Some(Value::Null));
    assign(&mut map, "magicIncludedInferences", Some(Value::Bool(false)));
    assign(&mut map, "magicProcessingTimeMs", Some(json!(0)));
    assign(&mut map, "timings", timings);
    let normalized = text.map(js::trim);
    if matches!(normalized, Some("")) {
        return Err(plain_error("A transcript correction cannot be empty"));
    }
    let correction = match normalized {
        Some(text) if Some(text) != map.get("text").and_then(Value::as_str) => Value::String(text.to_owned()),
        _ => Value::Null,
    };
    assign(&mut map, "editedText", Some(correction));
    Ok(Value::Object(map))
}

/// `applyTranscriptEdit` for a typed (for example session-only) record.
pub fn apply_transcript_edit(record: &TranscriptRecord, text: Option<&str>) -> DomainResult<TranscriptRecord> {
    let value = serde_json::to_value(record).map_err(DomainError::from)?;
    record_from_value(&apply_transcript_edit_value(&value, text)?)
        .ok_or_else(|| plain_error("Transcript could not be updated"))
}

/// Optional record fields a typed view drops when their saved value cannot
/// be represented, rather than hiding the whole transcript.
const LENIENT_FIELDS: &[&str] = &[
    "title",
    "delivery",
    "speechExecution",
    "captureDiagnostics",
    "timings",
    "requestedLanguage",
    "recognizedLanguage",
    "recognizedLanguages",
    "languageStatus",
    "dictationFormatting",
    "sessionOnly",
    "sourceRevision",
    "rewriteSourceRevision",
    "personalizedText",
    "editedText",
    "magicText",
    "magicModel",
    "magicPreset",
    "magicIncludedInferences",
    "magicProcessingTimeMs",
    "sourceName",
    "schemaVersion",
];

/// The typed view of a persisted record and the keys it could not represent.
fn typed_record(value: &Value) -> Option<(TranscriptRecord, Vec<&'static str>)> {
    if let Ok(record) = serde_json::from_value::<TranscriptRecord>(value.clone()) {
        return Some((record, Vec::new()));
    }
    let mut map = value.as_object()?.clone();
    let mut dropped = Vec::new();
    for key in LENIENT_FIELDS {
        let Some(field) = map.get(*key) else { continue };
        let mut probe = Map::new();
        for required in ["id", "createdAt", "durationMs", "text", "model", "language", "source", "processingTimeMs"] {
            if let Some(v) = map.get(required) {
                probe.insert(required.into(), v.clone());
            }
        }
        probe.insert((*key).into(), field.clone());
        if serde_json::from_value::<TranscriptRecord>(Value::Object(probe)).is_err() {
            map.shift_remove(*key);
            dropped.push(*key);
        }
    }
    let record = serde_json::from_value(Value::Object(map)).ok()?;
    Some((record, dropped))
}

/// Converts a persisted record to the typed view, `None` if it has no valid
/// required fields.
pub fn record_from_value(value: &Value) -> Option<TranscriptRecord> {
    typed_record(value).map(|(record, _)| record)
}

/// Serializes a typed record over its saved form: saved keys keep their
/// order, and saved values the typed view could not represent survive.
fn merge_record(saved: Option<&Value>, record: &TranscriptRecord) -> DomainResult<Value> {
    let Value::Object(next) = serde_json::to_value(record).map_err(DomainError::from)? else {
        return Err(plain_error("Invalid transcript record"));
    };
    let Some(Value::Object(old)) = saved else { return Ok(Value::Object(next)) };
    let unrepresented = typed_record(saved.unwrap()).map(|(_, dropped)| dropped).unwrap_or_default();
    let mut merged = Map::new();
    for (key, value) in old {
        if let Some(new) = next.get(key) {
            merged.insert(key.clone(), new.clone());
        } else if unrepresented.contains(&key.as_str()) {
            merged.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in next {
        if !merged.contains_key(&key) {
            merged.insert(key, value);
        }
    }
    Ok(Value::Object(merged))
}

/* Profile files */

fn read_error(path: &Path) -> DomainError {
    plain_error(format!(
        "Could not read local data at {}. The file has been preserved. Restore a valid backup or repair the JSON before reopening Delulu Talks.",
        path.display()
    ))
}

fn read_json(path: &Path) -> DomainResult<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            serde_json::from_str(&text).map(Some).map_err(|_| read_error(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(read_error(path)),
    }
}

/// Only a missing file is a first-run profile; invalid data must survive startup.
fn read_profile_json(path: &Path, legacy: Option<&Path>, kind: ProfileKind) -> DomainResult<Option<Value>> {
    let mut source_path = path.to_path_buf();
    let mut value = read_json(path)?;
    if value.is_none() {
        if let Some(legacy) = legacy {
            source_path = legacy.to_path_buf();
            value = read_json(legacy)?;
        }
    }
    let Some(value) = value else { return Ok(None) };
    let problem = match kind {
        ProfileKind::History if !value.is_array() => Some("expected a JSON array of transcripts".to_owned()),
        ProfileKind::History => None,
        ProfileKind::Settings => match &value {
            Value::Object(map) => match map.get("workflowVersion") {
                // Unversioned profiles are the supported legacy format. Never downgrade a
                // newer or malformed version by normalizing it into workflowVersion 1.
                Some(version) if version.as_f64() != Some(1.0) => Some(format!(
                    "unsupported workflowVersion {}; supported formats are an unversioned legacy object or workflowVersion 1",
                    jsj::stringify(version)
                )),
                _ => None,
            },
            _ => Some("expected a JSON object of settings".to_owned()),
        },
    };
    if let Some(problem) = problem {
        return Err(plain_error(format!(
            "Unsupported local data at {}: {problem}. The file has been preserved. Restore a compatible backup or use an app version that supports this format.",
            source_path.display()
        )));
    }
    match kind {
        ProfileKind::Settings => {
            assert_persisted_schema(&value, PersistedSchemaKind::Settings)?;
            if let Some(Value::Array(rules)) = value.get("customWords") {
                for rule in rules {
                    assert_persisted_schema(rule, PersistedSchemaKind::Rule)?;
                }
            }
        }
        ProfileKind::History => {
            for record in value.as_array().into_iter().flatten() {
                assert_persisted_schema(record, PersistedSchemaKind::Transcript)?;
            }
        }
    }
    Ok(Some(value))
}

fn kind_for(path: &Path) -> ProfileKind {
    if path.file_name().is_some_and(|name| name == SETTINGS_FILE) {
        ProfileKind::Settings
    } else {
        ProfileKind::History
    }
}

/// Validates the value and the exact bytes that will become durable, then
/// writes them to a private (0600) temporary file beside `path`.
fn stage_json(path: &Path, value: &Value) -> DomainResult<PathBuf> {
    let kind = kind_for(path);
    validate_profile_write(kind, value)?;
    let serialized = jsj::profile_bytes(value);
    // Validate the exact JSON bytes that will become durable, not just the
    // in-memory value, before creating or replacing any profile file.
    let reparsed: Value = serde_json::from_str(&serialized).map_err(DomainError::from)?;
    validate_profile_write(kind, &reparsed)?;
    Ok(stage_private(path, serialized.as_bytes())?)
}

/// Atomically replaces a profile file with validated JSON.
pub fn write_profile_json(path: &Path, value: &Value) -> DomainResult<()> {
    write_profile_json_with(path, value, |from, to| fs::rename(from, to))
}

/// [`write_profile_json`] with an injectable publish step (for tests).
pub fn write_profile_json_with(
    path: &Path,
    value: &Value,
    publish_step: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> DomainResult<()> {
    let temporary = stage_json(path, value)?;
    publish_step(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        DomainError::from(error)
    })
}

/// Writes one profile file; injectable so tests can simulate failures.
pub type ProfileWriter = Arc<dyn Fn(&Path, &Value) -> DomainResult<()> + Send + Sync>;

struct State {
    settings_value: Value,
    settings: AppSettings,
    history: Vec<Value>,
    pins: HashSet<String>,
}

pub struct StorageService {
    paths: AppPaths,
    writer: ProfileWriter,
    state: Mutex<State>,
}

impl StorageService {
    /// Opens the profile: validates both files before any write, migrates
    /// legacy data (with a raw backup first) and writes only what changed.
    pub fn open(paths: AppPaths) -> DomainResult<Self> {
        Self::open_with_writer(paths, Arc::new(|path: &Path, value: &Value| write_profile_json(path, value)))
    }

    pub fn open_with_writer(paths: AppPaths, writer: ProfileWriter) -> DomainResult<Self> {
        let data = paths.data.clone();
        fs::create_dir_all(&data)?;
        fs::create_dir_all(paths.audio_cache())?;
        fs::create_dir_all(paths.models())?;
        let settings_path = data.join(SETTINGS_FILE);
        let history_path = data.join(HISTORY_FILE);
        let legacy = paths.legacy_profile_candidates().into_iter().find(|dir| dir.join(SETTINGS_FILE).exists());
        let legacy_settings = legacy.as_ref().map(|dir| dir.join(SETTINGS_FILE));
        let legacy_history = legacy.as_ref().map(|dir| dir.join(HISTORY_FILE));
        // Validate both files before any migration writes. JSON null is invalid,
        // not a signal to fall back to an older profile or default settings.
        let raw_settings = read_profile_json(&settings_path, legacy_settings.as_deref(), ProfileKind::Settings)?;
        let raw_history = read_profile_json(&history_path, legacy_history.as_deref(), ProfileKind::History)?;
        // Old releases enabled rewriting by default, so that setting did not record opt-in.
        // Migrate once; subsequent explicit choices persist with the workflow version.
        let mut prior = raw_settings.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
        if prior.get("workflowVersion").and_then(Value::as_f64) != Some(1.0) {
            assign(&mut prior, "magicEnabled", Some(Value::Bool(false)));
            assign(&mut prior, "preloadMagicModel", Some(Value::Bool(false)));
        }
        let settings_value = normalize_settings_value(&Value::Object(prior))?;
        let settings = settings_from_value(&settings_value)?;
        let history: Vec<Value> = match &raw_history {
            Some(Value::Array(items)) => items.iter().map(migrate_record).collect::<DomainResult<_>>()?,
            _ => Vec::new(),
        };
        let history_value = Value::Array(history.clone());
        let settings_changed = raw_settings.as_ref().is_some_and(|raw| !jsj::same(raw, &settings_value));
        let history_changed = raw_history
            .as_ref()
            .is_some_and(|raw| !jsj::same(raw, &history_value) || !history_path.exists());
        if settings_changed || history_changed || (raw_settings.is_some() && !settings_path.exists()) {
            let source = |current: &Path, legacy: &Option<PathBuf>| {
                if current.exists() { Some(current.to_path_buf()) } else { legacy.clone() }
            };
            backup_profile_migration(
                &data,
                &[
                    (SETTINGS_FILE, source(&settings_path, &legacy_settings)),
                    (HISTORY_FILE, source(&history_path, &legacy_history)),
                ],
            )?;
        }
        if !history_path.exists() && !history.is_empty() {
            // Stage both migration outputs before replacing either destination.
            // Publish the previously absent history first: if the settings rename
            // fails, remove only the history created by this attempt. Existing
            // settings and both legacy source files remain untouched.
            let staged_settings = stage_json(&settings_path, &settings_value)?;
            let result = (|| -> DomainResult<()> {
                let staged_history = stage_json(&history_path, &history_value)?;
                publish(&staged_history, &history_path)?;
                if let Err(error) = publish(&staged_settings, &settings_path) {
                    if let Err(rollback) = fs::remove_file(&history_path) {
                        return Err(plain_error(format!(
                            "Profile migration failed and its newly created history could not be rolled back. Existing settings and legacy source files were preserved. ({error}; {rollback})"
                        )));
                    }
                    return Err(error.into());
                }
                Ok(())
            })();
            let _ = fs::remove_file(&staged_settings);
            result?;
        } else {
            if history_changed {
                writer(&history_path, &history_value)?;
            }
            if settings_changed || !settings_path.exists() {
                writer(&settings_path, &settings_value)?;
            }
        }
        Ok(Self {
            paths,
            writer,
            state: Mutex::new(State { settings_value, settings, history, pins: HashSet::new() }),
        })
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }
    pub fn data_directory(&self) -> &Path {
        &self.paths.data
    }
    fn settings_path(&self) -> PathBuf {
        self.paths.data.join(SETTINGS_FILE)
    }
    fn history_path(&self) -> PathBuf {
        self.paths.data.join(HISTORY_FILE)
    }

    pub fn get_settings(&self) -> AppSettings {
        self.state.lock().settings.clone()
    }

    /// The saved settings object exactly as persisted (including unknown keys).
    pub fn settings_json(&self) -> Value {
        self.state.lock().settings_value.clone()
    }

    /// `updateSettings`: normalizes `value` as the complete settings object
    /// (keys it omits fall back to defaults), saves it and applies the
    /// history limit. Memory changes only after the write succeeded.
    pub fn update_settings(&self, value: &Value) -> DomainResult<AppSettings> {
        let source = if value.is_object() { value.clone() } else { json!({}) };
        let mut state = self.state.lock();
        self.save_settings(&mut state, &source)?;
        Ok(state.settings.clone())
    }

    /// Merges `patch` over the current settings (`{ ...previous, ...patch }`),
    /// normalizes and saves atomically. Returns `(previous, saved)`.
    pub fn patch_settings(&self, patch: &Value) -> DomainResult<(AppSettings, AppSettings)> {
        let Some(patch) = patch.as_object() else {
            return Err(plain_error("Expected a settings object"));
        };
        self.update_settings_with(|_, current| {
            let mut next = current.as_object().cloned().unwrap_or_default();
            for (key, value) in patch {
                assign(&mut next, key, Some(value.clone()));
            }
            Ok(Value::Object(next))
        })
    }

    /// Runs `next` under the storage lock with the current settings (typed and
    /// as saved JSON) and saves the complete settings object it returns. The
    /// read-modify-write is atomic with respect to every other storage call.
    /// `next` must not call back into this service.
    pub fn update_settings_with(
        &self,
        next: impl FnOnce(&AppSettings, &Value) -> DomainResult<Value>,
    ) -> DomainResult<(AppSettings, AppSettings)> {
        let mut state = self.state.lock();
        let previous = state.settings.clone();
        let value = next(&previous, &state.settings_value)?;
        self.save_settings(&mut state, &value)?;
        Ok((previous, state.settings.clone()))
    }

    fn save_settings(&self, state: &mut State, value: &Value) -> DomainResult<()> {
        let normalized = normalize_settings_value(value)?;
        let typed = settings_from_value(&normalized)?;
        (self.writer)(&self.settings_path(), &normalized)?;
        state.settings_value = normalized;
        state.settings = typed;
        self.enforce_limit(state)
    }

    /// Keep only the newest `historyLimit` saved transcripts (pinned undo records stay).
    pub fn enforce_history_limit(&self) -> DomainResult<()> {
        let mut state = self.state.lock();
        self.enforce_limit(&mut state)
    }

    fn enforce_limit(&self, state: &mut State) -> DomainResult<()> {
        let next = Self::limited(state, state.history.clone());
        if next.len() == state.history.len() {
            return Ok(());
        }
        self.write_history(state, next)
    }

    fn limited(state: &State, ordered: Vec<Value>) -> Vec<Value> {
        // A pending undo window must survive eviction; ordinary limits resume after it.
        let limit = (state.settings.history_limit.max(0.0) as usize).min(MAX_HISTORY);
        ordered
            .into_iter()
            .enumerate()
            .filter(|(index, item)| *index < limit || item.get("id").and_then(Value::as_str).is_some_and(|id| state.pins.contains(id)))
            .map(|(_, item)| item)
            .collect()
    }

    fn write_history(&self, state: &mut State, next: Vec<Value>) -> DomainResult<()> {
        let value = Value::Array(next);
        (self.writer)(&self.history_path(), &value)?;
        let Value::Array(next) = value else { unreachable!() };
        state.history = next;
        Ok(())
    }

    /// Saved transcripts, newest first. A record whose required fields cannot
    /// be represented is omitted here but kept on disk.
    pub fn get_history(&self) -> Vec<TranscriptRecord> {
        self.state.lock().history.iter().filter_map(record_from_value).collect()
    }

    /// Saved transcripts exactly as persisted.
    pub fn history_json(&self) -> Vec<Value> {
        self.state.lock().history.clone()
    }

    /// `historyFingerprint(storage.getHistory())`, for retention previews.
    pub fn history_fingerprint(&self) -> String {
        history_fingerprint_value(&Value::Array(self.state.lock().history.clone()))
    }

    /// Saves a new transcript unless history is off or the record is
    /// session-only. Returns whether it was saved.
    pub fn add_history(&self, record: &TranscriptRecord) -> DomainResult<bool> {
        let value = serde_json::to_value(record).map_err(DomainError::from)?;
        let value = version_persisted_record(&value, PersistedSchemaKind::Transcript)?;
        let mut state = self.state.lock();
        if !state.settings.keep_history || record.session_only == Some(true) {
            return Ok(false);
        }
        let mut ordered = vec![value];
        ordered.extend(state.history.iter().filter(|item| item.get("id").and_then(Value::as_str) != Some(&record.id)).cloned());
        let next = Self::limited(&state, ordered);
        self.write_history(&mut state, next)?;
        Ok(true)
    }

    /// Records held open by a pending undo window survive the history limit.
    pub fn pin_history(&self, ids: &[String]) {
        self.state.lock().pins = ids.iter().cloned().collect();
    }

    pub fn find_history(&self, id: &str) -> Option<TranscriptRecord> {
        let state = self.state.lock();
        state.history.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)).and_then(record_from_value)
    }

    /// A saved transcript exactly as persisted (for JSON exports).
    pub fn find_history_json(&self, id: &str) -> Option<Value> {
        self.state.lock().history.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(id)).cloned()
    }

    pub fn contains_history(&self, id: &str) -> bool {
        self.state.lock().history.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(id))
    }

    fn update_record(&self, id: &str, change: impl FnOnce(&Value) -> DomainResult<Value>) -> DomainResult<TranscriptRecord> {
        let mut state = self.state.lock();
        let index = state
            .history
            .iter()
            .position(|item| item.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| plain_error("Transcript not found"))?;
        let updated = change(&state.history[index])?;
        let typed = record_from_value(&updated).ok_or_else(|| plain_error("Transcript not found"))?;
        let mut next = state.history.clone();
        next[index] = updated;
        self.write_history(&mut state, next)?;
        Ok(typed)
    }

    /// Saves a correction (`None` clears it) and invalidates the rewrite.
    pub fn update_transcript(&self, id: &str, text: Option<&str>) -> DomainResult<TranscriptRecord> {
        self.update_record(id, |record| apply_transcript_edit_value(record, text))
    }

    pub fn set_transcript_title(&self, id: &str, title: Option<&str>) -> DomainResult<TranscriptRecord> {
        let title = normalize_transcript_title(&title.map_or(Value::Null, |t| Value::String(t.to_owned())))?;
        self.update_record(id, |record| {
            let mut map = record.as_object().cloned().unwrap_or_default();
            assign(&mut map, "title", Some(title.map_or(Value::Null, Value::String)));
            Ok(Value::Object(map))
        })
    }

    /// Replaces a saved transcript with an updated version of itself.
    pub fn replace_history(&self, record: &TranscriptRecord) -> DomainResult<()> {
        let mut state = self.state.lock();
        let index = state
            .history
            .iter()
            .position(|item| item.get("id").and_then(Value::as_str) == Some(&record.id))
            .ok_or_else(|| plain_error("Transcript not found"))?;
        let merged = merge_record(Some(&state.history[index]), record)?;
        let merged = version_persisted_record(&merged, PersistedSchemaKind::Transcript)?;
        let mut next = state.history.clone();
        next[index] = merged;
        self.write_history(&mut state, next)
    }

    /// Deletes one transcript, then revokes migration-backup copies. A
    /// cleanup failure is reported as a `HistoryBackupCleanupError` after
    /// the deletion was saved (see `is_history_backup_cleanup_error`).
    pub fn delete_history(&self, id: &str) -> DomainResult<()> {
        self.delete_history_selection(&[id.to_owned()])
    }

    pub fn delete_history_selection(&self, ids: &[String]) -> DomainResult<()> {
        let mut state = self.state.lock();
        let next = state
            .history
            .iter()
            .filter(|item| !item.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|i| i == id)))
            .cloned()
            .collect();
        self.write_history(&mut state, next)?;
        drop(state);
        self.revoke_history_backups()
    }

    /// Runs after memory matches the published file, so a cleanup failure can
    /// never resurrect deleted records on the next history write.
    fn revoke_history_backups(&self) -> DomainResult<()> {
        remove_migration_history_backups(&self.paths.data).map_err(|error| history_backup_cleanup_error(&error.to_string()))
    }

    pub fn apply_history_retention(&self, expected_fingerprint: &str, ids: &[String]) -> DomainResult<()> {
        let mut state = self.state.lock();
        if history_fingerprint_value(&Value::Array(state.history.clone())) != expected_fingerprint {
            return Err(plain_error("History changed. Preview the affected records again before applying retention."));
        }
        let removed: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let next = state
            .history
            .iter()
            .filter(|item| !item.get("id").and_then(Value::as_str).is_some_and(|id| removed.contains(id)))
            .cloned()
            .collect();
        // Publish the complete filtered snapshot before changing memory; retained records are untouched.
        self.write_history(&mut state, next)
    }

    pub fn clear_history(&self) -> DomainResult<()> {
        let mut state = self.state.lock();
        self.write_history(&mut state, Vec::new())?;
        drop(state);
        self.revoke_history_backups()
    }
}
