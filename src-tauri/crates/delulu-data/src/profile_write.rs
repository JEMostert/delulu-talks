//! Validation of every settings/history write (`profileWriteValidation.ts`).
//!
//! Validates the value before serialization; never normalizes user text.

use delulu_core::util::utf16_len;
use delulu_core::DomainError;
use delulu_domain::word_packs::WORD_PACKS;
use delulu_domain::{setting_languages, DEFAULT_SETTINGS_JSON, MAGIC_MODELS, MODELS, REWRITE_PRESETS};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileKind {
    Settings,
    History,
}

impl ProfileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProfileKind::Settings => "settings",
            ProfileKind::History => "history",
        }
    }
}

type Check = Result<(), DomainError>;

struct Validator {
    kind: ProfileKind,
}

impl Validator {
    fn fail(&self, path: &str, expectation: &str) -> DomainError {
        DomainError::failed(format!(
            "Cannot save {}: {path} {expectation}. Fix this value and try again. The write was cancelled; the existing file has been preserved.",
            self.kind.as_str()
        ))
        .with_cause("Error", None)
    }

    fn object<'a>(&self, item: Option<&'a Value>, path: &str) -> Result<&'a Map<String, Value>, DomainError> {
        match item {
            Some(Value::Object(map)) => Ok(map),
            _ => Err(self.fail(path, "must be a plain object")),
        }
    }

    fn string(&self, item: Option<&Value>, path: &str, max: usize, nonblank: bool) -> Check {
        match item {
            Some(Value::String(text))
                if utf16_len(text) <= max && (!nonblank || !delulu_domain::js::trim(text).is_empty()) =>
            {
                Ok(())
            }
            _ => Err(self.fail(
                path,
                &format!("must be {} string of at most {max} characters", if nonblank { "a nonblank" } else { "a" }),
            )),
        }
    }

    fn boolean(&self, item: Option<&Value>, path: &str) -> Check {
        match item {
            Some(Value::Bool(_)) => Ok(()),
            _ => Err(self.fail(path, "must be a boolean")),
        }
    }

    fn nonnegative(&self, item: Option<&Value>, path: &str) -> Check {
        match item.and_then(Value::as_f64) {
            Some(number) if number >= 0.0 => Ok(()),
            _ => Err(self.fail(path, "must be a finite nonnegative number")),
        }
    }

    fn enumeration(&self, item: Option<&Value>, path: &str, allowed: &[&str]) -> Check {
        match item {
            Some(Value::String(text)) if allowed.contains(&text.as_str()) => Ok(()),
            _ => Err(self.fail(path, &format!("must be one of {}", allowed.join(", ")))),
        }
    }

    fn array<'a>(&self, item: Option<&'a Value>, path: &str) -> Result<&'a Vec<Value>, DomainError> {
        let limit = if path == "history" { 1000 } else { 500 };
        match item {
            Some(Value::Array(items)) if items.len() <= limit => Ok(items),
            _ => Err(self.fail(path, "exceeds the supported record limit")),
        }
    }

    fn json_value(&self, item: &Value, path: &str, depth: usize) -> Check {
        match item {
            Value::Array(items) => {
                if depth > 100 {
                    return Err(self.fail(path, "is too deeply nested to save safely"));
                }
                for (index, child) in items.iter().enumerate() {
                    self.json_value(child, &format!("{path}[{index}]"), depth + 1)?;
                }
                Ok(())
            }
            Value::Object(map) => {
                if depth > 100 {
                    return Err(self.fail(path, "is too deeply nested to save safely"));
                }
                // Unknown extension keys can themselves contain private user text.
                let field = format!("{path}.[extension]");
                for child in map.values() {
                    self.json_value(child, &field, depth + 1)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn model_ids() -> Vec<&'static str> {
    MODELS.iter().map(|model| model.id.as_str()).collect()
}

fn magic_model_ids() -> Vec<&'static str> {
    MAGIC_MODELS.iter().map(|model| model.id.as_str()).collect()
}

fn presets() -> Vec<&'static str> {
    REWRITE_PRESETS.iter().map(|preset| preset.id.as_str()).collect()
}

/// Rejects a settings object or history array that the app must not persist.
pub fn validate_profile_write(kind: ProfileKind, value: &Value) -> Check {
    let v = Validator { kind };
    v.json_value(value, kind.as_str(), 0)?;

    if kind == ProfileKind::Settings {
        let settings = v.object(Some(value), "settings")?;
        for (key, default) in DEFAULT_SETTINGS_JSON.iter() {
            let path = format!("settings.{key}");
            if key == "voiceCoordinatorMode" && !settings.contains_key(key) { continue; }
            if !settings.contains_key(key) {
                return Err(v.fail(&path, "is required"));
            }
            if default.is_boolean() {
                v.boolean(settings.get(key), &path)?;
            }
        }
        if settings.get("workflowVersion").and_then(Value::as_f64) != Some(1.0) {
            return Err(v.fail("settings.workflowVersion", "must be the supported version 1"));
        }
        if settings.contains_key("voiceCoordinatorMode") {
            v.enumeration(settings.get("voiceCoordinatorMode"), "settings.voiceCoordinatorMode", &["off", "lightweight", "conversational"])?;
        }
        v.enumeration(settings.get("theme"), "settings.theme", &["system", "light", "dark"])?;
        v.enumeration(settings.get("shortcutMode"), "settings.shortcutMode", &["hold", "toggle"])?;
        v.enumeration(settings.get("model"), "settings.model", &model_ids())?;
        v.enumeration(settings.get("magicModel"), "settings.magicModel", &magic_model_ids())?;
        v.enumeration(settings.get("magicPreset"), "settings.magicPreset", &presets())?;
        let languages: Vec<&str> = setting_languages().map(|(code, _)| code).collect();
        v.enumeration(settings.get("language"), "settings.language", &languages)?;
        for (key, max, nonblank) in [
            ("shortcut", 96, true),
            ("pythonCommand", 512, true),
            ("inputDeviceId", 512, true),
            ("inputDeviceLabel", 512, true),
            ("pastePortalToken", 4096, false),
        ] {
            v.string(settings.get(key), &format!("settings.{key}"), max, nonblank)?;
        }
        v.nonnegative(settings.get("modelIdleMinutes"), "settings.modelIdleMinutes")?;
        match settings.get("pasteLastDelaySeconds").and_then(Value::as_f64) {
            Some(delay) if delay.fract() == 0.0 && (1.0..=30.0).contains(&delay) => {}
            _ => return Err(v.fail("settings.pasteLastDelaySeconds", "must be an integer from 1 through 30")),
        }
        let packs: Vec<&str> = WORD_PACKS.iter().map(|pack| pack.id.as_str()).collect();
        for (index, pack) in v.array(settings.get("wordPacks"), "settings.wordPacks")?.iter().enumerate() {
            v.enumeration(Some(pack), &format!("settings.wordPacks[{index}]"), &packs)?;
        }
        let mut ids: Vec<&Value> = Vec::new();
        for (index, item) in v.array(settings.get("customWords"), "settings.customWords")?.iter().enumerate() {
            let path = format!("settings.customWords[{index}]");
            let word = v.object(Some(item), &path)?;
            v.string(word.get("id"), &format!("{path}.id"), 128, true)?;
            let id = &word["id"];
            if ids.contains(&id) {
                return Err(v.fail(&format!("{path}.id"), "must be unique"));
            }
            ids.push(id);
            v.string(word.get("term"), &format!("{path}.term"), 256, true)?;
            v.string(word.get("soundsLike"), &format!("{path}.soundsLike"), 1024, false)?;
            v.string(word.get("replacement"), &format!("{path}.replacement"), 4096, false)?;
            v.boolean(word.get("enabled"), &format!("{path}.enabled"))?;
            if word.contains_key("kind") {
                v.enumeration(word.get("kind"), &format!("{path}.kind"), &["correction", "shortcut"])?;
            }
        }
        return Ok(());
    }

    let mut history_models = model_ids();
    history_models.push("qwen3Asr");
    let mut ids = std::collections::HashSet::new();
    for (index, item) in v.array(Some(value), "history")?.iter().enumerate() {
        let path = format!("history[{index}]");
        let record = v.object(Some(item), &path)?;
        v.string(record.get("id"), &format!("{path}.id"), 128, true)?;
        if !ids.insert(record["id"].as_str().unwrap_or_default().to_owned()) {
            return Err(v.fail(&format!("{path}.id"), "must be unique"));
        }
        v.string(record.get("text"), &format!("{path}.text"), 250_000, true)?;
        v.string(record.get("language"), &format!("{path}.language"), 12, true)?;
        v.enumeration(record.get("model"), &format!("{path}.model"), &history_models)?;
        v.enumeration(record.get("source"), &format!("{path}.source"), &["file", "dictation"])?;
        match record.get("createdAt").and_then(Value::as_f64) {
            // `new Date(createdAt)` is valid up to 8.64e15 ms.
            Some(created) if created > 0.0 && created <= 8.64e15 => {}
            _ => return Err(v.fail(&format!("{path}.createdAt"), "must be a finite positive valid timestamp")),
        }
        v.nonnegative(record.get("durationMs"), &format!("{path}.durationMs"))?;
        v.nonnegative(record.get("processingTimeMs"), &format!("{path}.processingTimeMs"))?;
        if record.contains_key("magicProcessingTimeMs") {
            v.nonnegative(record.get("magicProcessingTimeMs"), &format!("{path}.magicProcessingTimeMs"))?;
        }
        if record.contains_key("magicIncludedInferences") {
            v.boolean(record.get("magicIncludedInferences"), &format!("{path}.magicIncludedInferences"))?;
        }
        for key in ["personalizedText", "editedText", "magicText"] {
            if !matches!(record.get(key), None | Some(Value::Null)) {
                v.string(record.get(key), &format!("{path}.{key}"), 500_000, false)?;
            }
        }
        if !matches!(record.get("sourceName"), None | Some(Value::Null)) {
            v.string(record.get("sourceName"), &format!("{path}.sourceName"), 4096, false)?;
        }
        if !matches!(record.get("magicModel"), None | Some(Value::Null)) {
            v.enumeration(record.get("magicModel"), &format!("{path}.magicModel"), &magic_model_ids())?;
        }
        if !matches!(record.get("magicPreset"), None | Some(Value::Null)) {
            v.enumeration(record.get("magicPreset"), &format!("{path}.magicPreset"), &presets())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_missing_settings_and_duplicate_history_ids() {
        let error = validate_profile_write(ProfileKind::Settings, &json!({})).unwrap_err();
        assert!(error.message.starts_with("Cannot save settings: settings."));
        assert!(error.message.ends_with("the existing file has been preserved."));
        let defaults = Value::Object(DEFAULT_SETTINGS_JSON.clone());
        validate_profile_write(ProfileKind::Settings, &defaults).unwrap();
        let record = json!({"id": "a", "text": "t", "language": "en", "model": "r2t2", "source": "dictation",
            "createdAt": 1, "durationMs": 0, "processingTimeMs": 0});
        validate_profile_write(ProfileKind::History, &json!([record.clone()])).unwrap();
        let error = validate_profile_write(ProfileKind::History, &json!([record.clone(), record])).unwrap_err();
        assert!(error.message.contains("history[1].id must be unique"));
    }
}
