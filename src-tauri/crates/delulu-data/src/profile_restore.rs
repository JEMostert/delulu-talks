//! Isolated restore of a migration backup (`profileRestore.ts`).
//!
//! [`validate_profile_backup`] is a dry run: it validates source bytes,
//! schema, completeness and isolation and writes nothing.
//! [`restore_profile_backup`] revalidates and writes the exact validated
//! bytes into an exclusively created new profile directory.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use delulu_core::util::{create_private, utf16_len};
use delulu_core::{DomainError, DomainResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::audio_jobs::absolute;
use crate::migration_backups::sha256_hex;
use crate::{json as js, plain_error, time};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRestoreRequest {
    pub backup_directory: PathBuf,
    pub target_directory: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile_directory: Option<PathBuf>,
    #[serde(default)]
    pub allow_settings_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettingsFormat {
    #[serde(rename = "workflow-1")]
    Workflow1,
    #[serde(rename = "legacy")]
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRestorePlan {
    pub backup_directory: PathBuf,
    pub source_profile_directory: PathBuf,
    pub target_directory: PathBuf,
    pub settings_format: SettingsFormat,
    pub history_records: u64,
    pub files: Vec<RestoreFile>,
    pub warnings: Vec<String>,
}

fn bounded_file(path: &Path, maximum: u64) -> DomainResult<Vec<u8>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() {
        return Err(plain_error(format!("Expected a regular backup file at {}", path.display())));
    }
    if info.len() > maximum {
        return Err(plain_error(format!(
            "Backup file exceeds the bounded restore limit at {}; source files remain unchanged",
            path.display()
        )));
    }
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > maximum {
        return Err(plain_error(format!("Backup file grew beyond the restore limit at {}", path.display())));
    }
    Ok(bytes)
}

fn parse(path: &Path, bytes: &[u8]) -> DomainResult<Value> {
    serde_json::from_slice(bytes)
        .map_err(|error| plain_error(format!("Could not parse backup JSON at {}: {error}", path.display())))
}

fn optional_string(source: &Map<String, Value>, key: &str, maximum: usize, nullable: bool) -> Result<(), String> {
    match source.get(key) {
        None => Ok(()),
        Some(Value::Null) if nullable => Ok(()),
        Some(Value::String(text)) if utf16_len(text) <= maximum => Ok(()),
        _ => Err(format!("Unsupported {key}: expected a string of at most {maximum} characters")),
    }
}

fn settings_schema(value: &Value) -> Result<SettingsFormat, String> {
    let Some(source) = value.as_object() else { return Err("Settings backup must contain a JSON object".into()) };
    let workflow = source.get("workflowVersion");
    if workflow.is_some_and(|v| v.as_f64() != Some(1.0)) {
        return Err(format!(
            "Unsupported settings workflowVersion {}; use a compatible application before restoring",
            js::stringify(workflow.unwrap())
        ));
    }
    for key in [
        "shortcut",
        "pythonCommand",
        "inputDeviceId",
        "inputDeviceLabel",
        "pastePortalToken",
        "language",
        "model",
        "magicModel",
        "magicPreset",
        "theme",
        "shortcutMode",
    ] {
        optional_string(source, key, if key == "pastePortalToken" { 4096 } else { 512 }, false)?;
    }
    for key in [
        "onboardingComplete",
        "autoPaste",
        "copyToClipboard",
        "keepHistory",
        "showOverlay",
        "preloadModel",
        "magicEnabled",
        "magicAllowInferences",
        "preloadMagicModel",
        "launchAtLogin",
    ] {
        if source.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("Unsupported settings {key}: expected a boolean"));
        }
    }
    if source.get("modelIdleMinutes").is_some_and(|v| !v.as_f64().is_some_and(|n| n >= 0.0)) {
        return Err("Unsupported settings modelIdleMinutes".into());
    }
    let versioned = workflow.is_some();
    let text = |key: &str| source.get(key).map(js_string);
    if versioned && text("model").is_some_and(|m| m != "r2t2" && m != "r2t2Mlx") {
        return Err(
            "Versioned settings must select an R2T2 speech model; historical Qwen attribution remains valid only in history"
                .into(),
        );
    }
    let allowed: [(&str, &[&str]); 3] = [
        ("theme", &["system", "light", "dark"]),
        ("shortcutMode", &["hold", "toggle"]),
        (
            "magicPreset",
            &["spoken-corrections", "polish", "concise", "structured", "prompt", "bullet-points", "professional-message"],
        ),
    ];
    for (key, values) in allowed {
        if text(key).is_some_and(|v| !values.contains(&v.as_str())) {
            return Err(format!("Unsupported settings {key}"));
        }
    }
    if let Some(words) = source.get("customWords") {
        let Some(words) = words.as_array().filter(|w| w.len() <= 500) else {
            return Err("Vocabulary backup must be an array of at most 500 rules".into());
        };
        for rule in words {
            let rule = rule
                .as_object()
                .filter(|r| r.get("term").and_then(Value::as_str).is_some_and(|t| !delulu_domain::js::trim(t).is_empty()))
                .ok_or("Vocabulary rule is missing its term")?;
            optional_string(rule, "term", 256, false)?;
            optional_string(rule, "id", 128, false)?;
            optional_string(rule, "soundsLike", 1024, false)?;
            optional_string(rule, "replacement", 4096, false)?;
            optional_string(rule, "language", 64, false)?;
            if rule.get("enabled").is_some_and(|v| !v.is_boolean()) {
                return Err("Vocabulary enabled must be boolean".into());
            }
            if rule.get("kind").map(js_string).is_some_and(|k| k != "correction" && k != "shortcut") {
                return Err("Unsupported vocabulary kind".into());
            }
        }
    }
    Ok(if versioned { SettingsFormat::Workflow1 } else { SettingsFormat::Legacy })
}

fn js_string(value: &Value) -> String {
    delulu_domain::js::value_to_string(value)
}

fn history_schema(value: &Value) -> Result<u64, String> {
    let Some(records) = value.as_array().filter(|r| r.len() <= 500) else {
        return Err("History backup must contain at most 500 transcripts; restore never truncates records".into());
    };
    for record in records {
        let Some(record) = record.as_object() else {
            return Err("History backup contains a non-object transcript".into());
        };
        let text = [record.get("text"), record.get("intendedText"), record.get("verbatimText")]
            .into_iter()
            .flatten()
            .find(|v| !v.is_null());
        if !text.and_then(Value::as_str).is_some_and(|t| !delulu_domain::js::trim(t).is_empty() && utf16_len(t) <= 250_000) {
            return Err("History transcript has missing or unsupported original speech".into());
        }
        for key in ["personalizedText", "editedText", "editedIntendedText", "magicText"] {
            optional_string(record, key, 500_000, true)?;
        }
        optional_string(record, "id", 128, false)?;
        optional_string(record, "language", 64, false)?;
        optional_string(record, "sourceName", 4096, true)?;
        if record.get("model").map(js_string).is_some_and(|m| !["r2t2", "r2t2Mlx", "qwen3Asr"].contains(&m.as_str())) {
            return Err(
                "History model attribution is unsupported; it cannot be silently relabeled during restore".into()
            );
        }
        if record.get("source").map(js_string).is_some_and(|s| s != "dictation" && s != "file") {
            return Err("Unsupported transcript source".into());
        }
        for key in ["createdAt", "durationMs", "processingTimeMs", "magicProcessingTimeMs"] {
            if record.get(key).is_some_and(|v| !v.as_f64().is_some_and(|n| n >= 0.0)) {
                return Err(format!("Unsupported transcript {key}"));
            }
        }
        for key in ["sourceRevision", "rewriteSourceRevision"] {
            match record.get(key) {
                None | Some(Value::Null) => {}
                Some(v) if v.as_f64().is_some_and(|n| delulu_domain::js::is_safe_integer(n) && n >= 0.0) => {}
                Some(_) => return Err(format!("Unsupported transcript {key}")),
            }
        }
    }
    Ok(records.len() as u64)
}

fn canonical(path: &Path) -> DomainResult<PathBuf> {
    Ok(fs::canonicalize(absolute(path))?)
}

type Contents = Vec<(String, Vec<u8>)>;

fn validate(request: &ProfileRestoreRequest) -> DomainResult<(ProfileRestorePlan, Contents)> {
    let backup_directory = canonical(&request.backup_directory)?;
    let base = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if base(&backup_directory).starts_with(".pending-") {
        return Err(plain_error("An interrupted pending snapshot cannot be restored"));
    }
    if !fs::symlink_metadata(&backup_directory)?.is_dir() {
        return Err(plain_error("Backup source must be a directory"));
    }
    let inferred = backup_directory
        .parent()
        .filter(|parent| base(parent) == crate::migration_backups::BACKUP_DIRECTORY)
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    let source = request.source_profile_directory.clone().or(inferred).ok_or_else(|| {
        plain_error("Provide the original source profile path when restoring a copied snapshot")
    })?;
    let source_profile_directory = canonical(&source)?;
    let requested = absolute(&request.target_directory);
    let parent = requested.parent().unwrap_or(Path::new("/"));
    let target_directory = fs::canonicalize(parent)?.join(requested.file_name().unwrap_or_default());
    for protected in [&backup_directory, &source_profile_directory] {
        if target_directory.starts_with(protected) || protected.starts_with(&target_directory) {
            return Err(plain_error(
                "Restore target must be separate from the source profile and backup, not a parent or child",
            ));
        }
    }
    match fs::symlink_metadata(&target_directory) {
        Ok(_) => return Err(plain_error("Restore target already exists; select a new isolated profile directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let manifest_path = backup_directory.join("manifest.json");
    let manifest = parse(&manifest_path, &bounded_file(&manifest_path, 64_000)?)?;
    let files = manifest.get("files").and_then(Value::as_object);
    let (true, Some(files)) = (
        manifest.get("owner").and_then(Value::as_str) == Some("delulu-profile-migration")
            && manifest.get("version").and_then(Value::as_f64) == Some(1.0),
        files,
    ) else {
        return Err(plain_error(format!("Unsupported migration backup manifest at {}", manifest_path.display())));
    };
    if !files.contains_key("settings.json") || files.keys().any(|n| n != "settings.json" && n != "history.json") {
        return Err(plain_error("Backup manifest must include settings.json and only supported profile files"));
    }
    if !files.contains_key("history.json") && !request.allow_settings_only {
        return Err(plain_error(
            "Backup has no history payload. Use explicit settings-only restore to initialize empty history",
        ));
    }
    let mut contents: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, expected) in files {
        let expected = expected
            .as_str()
            .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .ok_or_else(|| plain_error(format!("Invalid hash for {name} in backup manifest")))?;
        let path = backup_directory.join(name);
        let limit = if name == "settings.json" { 8 * 1024 * 1024 } else { 256 * 1024 * 1024 };
        let bytes = bounded_file(&path, limit)?;
        if sha256_hex(&bytes) != expected {
            return Err(plain_error(format!("Backup checksum mismatch at {}; nothing was restored", path.display())));
        }
        contents.push((name.clone(), bytes));
    }
    let bytes_of = |name: &str| contents.iter().find(|(n, _)| n == name).map(|(_, b)| b.as_slice());
    let settings_path = backup_directory.join("settings.json");
    let settings_format = parse(&settings_path, bytes_of("settings.json").unwrap_or_default())
        .and_then(|value| settings_schema(&value).map_err(plain_error))
        .map_err(|cause| {
            plain_error(format!("Settings schema validation failed at {}: {}", settings_path.display(), cause.message))
        })?;
    let history_path = backup_directory.join("history.json");
    let mut history_records = 0;
    if let Some(bytes) = bytes_of("history.json") {
        history_records = parse(&history_path, bytes)
            .and_then(|value| history_schema(&value).map_err(plain_error))
            .map_err(|cause| {
                plain_error(format!("History schema validation failed at {}: {}", history_path.display(), cause.message))
            })?;
    }
    let mut warnings = Vec::new();
    if settings_format == SettingsFormat::Legacy {
        warnings.push(
            "Unversioned settings are preserved; the app will migrate them when the isolated profile is opened".to_owned(),
        );
    }
    if bytes_of("history.json").is_none() {
        contents.push(("history.json".into(), b"[]\n".to_vec()));
        warnings.push(
            "History payload is absent; explicitly requested settings-only restore initializes empty history".to_owned(),
        );
    }
    let plan = ProfileRestorePlan {
        backup_directory,
        source_profile_directory,
        target_directory,
        settings_format,
        history_records,
        files: contents
            .iter()
            .map(|(name, bytes)| RestoreFile { name: name.clone(), bytes: bytes.len() as u64, sha256: sha256_hex(bytes) })
            .collect(),
        warnings,
    };
    Ok((plan, contents))
}

pub fn validate_profile_backup(request: &ProfileRestoreRequest) -> DomainResult<ProfileRestorePlan> {
    validate(request).map(|(plan, _)| plan)
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = create_private(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub fn restore_profile_backup(request: &ProfileRestoreRequest) -> DomainResult<ProfileRestorePlan> {
    let (plan, contents) = validate(request)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&plan.target_directory)?;
    let result = (|| -> std::io::Result<()> {
        for (name, bytes) in &contents {
            write_new(&plan.target_directory.join(name), bytes)?;
        }
        let mut provenance = json!({"version": 1, "restoredAt": time::now_iso()});
        if let (Some(map), Ok(Value::Object(fields))) = (provenance.as_object_mut(), serde_json::to_value(&plan)) {
            map.extend(fields);
        }
        write_new(&plan.target_directory.join("restore-provenance.json"), js::profile_bytes(&provenance).as_bytes())
    })();
    if let Err(error) = result {
        if let Err(cleanup) = fs::remove_dir_all(&plan.target_directory) {
            return Err(plain_error(format!(
                "Isolated restore failed and its new target could not be removed ({error}; {cleanup})"
            )));
        }
        let mut failure = plain_error("Isolated restore failed; original profile and backup files remain unchanged");
        failure.cause = DomainError::from(error).cause;
        return Err(failure);
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration_backups::backup_profile_migration;

    #[test]
    fn dry_run_then_restore_into_an_isolated_profile() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().join("profile");
        fs::create_dir(&profile).unwrap();
        fs::write(profile.join("settings.json"), r#"{"language":"nl"}"#).unwrap();
        fs::write(profile.join("history.json"), r#"[{"id":"a","text":"Hallo","createdAt":1}]"#).unwrap();
        backup_profile_migration(
            &profile,
            &[("settings.json", Some(profile.join("settings.json"))), ("history.json", Some(profile.join("history.json")))],
        )
        .unwrap();
        let snapshot = fs::read_dir(profile.join("migration-backups")).unwrap().next().unwrap().unwrap().path();
        let request = ProfileRestoreRequest {
            backup_directory: snapshot.clone(),
            target_directory: dir.path().join("restored"),
            ..Default::default()
        };
        let plan = validate_profile_backup(&request).unwrap();
        assert_eq!((plan.settings_format, plan.history_records), (SettingsFormat::Legacy, 1));
        assert!(!dir.path().join("restored").exists());
        restore_profile_backup(&request).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("restored/settings.json")).unwrap(), r#"{"language":"nl"}"#);
        assert!(dir.path().join("restored/restore-provenance.json").exists());
        // The target now exists; and a target inside the source profile is refused.
        assert!(validate_profile_backup(&request).is_err());
        let nested = ProfileRestoreRequest { target_directory: profile.join("nested"), ..request.clone() };
        assert!(validate_profile_backup(&nested).unwrap_err().message.contains("separate from the source profile"));
        fs::write(snapshot.join("history.json"), "[]").unwrap();
        let tampered = ProfileRestoreRequest { target_directory: dir.path().join("other"), ..request };
        assert!(validate_profile_backup(&tampered).unwrap_err().message.contains("checksum mismatch"));
    }
}
