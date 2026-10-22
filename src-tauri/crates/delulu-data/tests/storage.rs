#![allow(clippy::result_large_err)]

//! Port of `electron/services/storage.test.ts`, plus compatibility checks
//! against profiles written by the Electron app (see `fixtures/generate.ts`).

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use delulu_core::{AppPaths, DomainError};
use delulu_data::storage::{
    speech_model_for_platform, write_profile_json, write_profile_json_with, ProfileWriter, StorageService,
};
use delulu_data::{json as js, normalize_settings};
use delulu_domain::{ModelId, SpeechTier, TranscriptRecord, TranscriptSource, DEFAULT_SETTINGS_JSON};
use parking_lot::Mutex;
use serde_json::{json, Value};

fn profile() -> (tempfile::TempDir, AppPaths) {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::at(dir.path(), dir.path());
    (dir, paths)
}

fn transcript() -> TranscriptRecord {
    TranscriptRecord {
        id: "speech".into(),
        created_at: 1.0,
        text: "Original café 🎙️".into(),
        duration_ms: 1000.0,
        processing_time_ms: 10.0,
        model: ModelId::R2t2,
        language: "en".into(),
        source: TranscriptSource::Dictation,
        ..Default::default()
    }
}

fn transcript_json() -> Value {
    json!({"id": "speech", "createdAt": 1, "text": "Original café 🎙️", "durationMs": 1000,
        "processingTimeMs": 10, "model": "r2t2", "language": "en", "source": "dictation"})
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn defaults() -> Value {
    Value::Object(DEFAULT_SETTINGS_JSON.clone())
}

fn merge(base: Value, patch: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    for (key, value) in patch.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

#[test]
fn corrupt_or_future_profiles_fail_before_replacing_either_local_data_file() {
    let mut future_record = transcript_json();
    future_record["schemaVersion"] = json!(999);
    let failures = [
        ("settings.json", r#"{"interrupted":"#.to_owned()),
        ("settings.json", r#"{"workflowVersion":2}"#.to_owned()),
        ("settings.json", r#"{"schemaVersion":999}"#.to_owned()),
        ("settings.json", "null".to_owned()),
        ("history.json", r#"{"interrupted":"#.to_owned()),
        ("history.json", "null".to_owned()),
        ("history.json", js::stringify(&json!([future_record]))),
    ];
    for (filename, invalid) in failures {
        let (dir, paths) = profile();
        let settings = dir.path().join("settings.json");
        let history = dir.path().join("history.json");
        let saved_settings = r#"{"workflowVersion":1}"#;
        let saved_history = js::stringify(&json!([transcript_json()]));
        fs::write(&settings, saved_settings).unwrap();
        fs::write(&history, &saved_history).unwrap();
        fs::write(dir.path().join(filename), &invalid).unwrap();
        let error = StorageService::open(paths).err().expect("invalid profile must not open");
        assert!(error.message.contains("preserved"), "{}", error.message);
        assert_eq!(read(&settings), if filename == "settings.json" { invalid.as_str() } else { saved_settings });
        assert_eq!(read(&history), if filename == "history.json" { invalid.clone() } else { saved_history });
    }
}

#[test]
fn failed_atomic_publication_preserves_saved_bytes_and_removes_its_temporary_file() {
    let (dir, _) = profile();
    let path = dir.path().join("history.json");
    let original = js::stringify(&json!([transcript_json()]));
    fs::write(&path, &original).unwrap();
    let error = write_profile_json_with(&path, &json!([]), |_, _| Err(std::io::Error::other("Disk unavailable")))
        .unwrap_err();
    assert_eq!(error.message, "Disk unavailable");
    assert_eq!(read(&path), original);
    let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["history.json"]);
}

fn denying_writer(denied: Arc<Mutex<String>>) -> ProfileWriter {
    Arc::new(move |path: &Path, value: &Value| {
        let denied = denied.lock().clone();
        if !denied.is_empty() && path.to_string_lossy().ends_with(&denied) {
            return Err(DomainError::failed("Disk full"));
        }
        write_profile_json(path, value)
    })
}

#[test]
fn failed_settings_and_transcript_writes_leave_memory_consistent_with_disk_and_allow_retry() {
    let (dir, paths) = profile();
    let denied = Arc::new(Mutex::new(String::new()));
    let storage = StorageService::open_with_writer(paths.clone(), denying_writer(denied.clone())).unwrap();
    storage.add_history(&transcript()).unwrap();
    let settings = storage.get_settings();
    let history = storage.get_history();
    let auto = merge(storage.settings_json(), json!({"language": "auto"}));
    *denied.lock() = "settings.json".into();
    assert_eq!(storage.update_settings(&auto).unwrap_err().message, "Disk full");
    assert_eq!(storage.get_settings(), settings);
    *denied.lock() = "history.json".into();
    assert_eq!(storage.update_transcript("speech", Some("Edited")).unwrap_err().message, "Disk full");
    assert_eq!(storage.get_history(), history);
    denied.lock().clear();
    storage.update_settings(&auto).unwrap();
    storage.update_transcript("speech", Some("Edited")).unwrap();
    let reopened = StorageService::open(paths).unwrap();
    assert_eq!(reopened.get_settings().language, "auto");
    let record = reopened.find_history("speech").unwrap();
    assert_eq!(record.text, transcript().text);
    assert_eq!(record.edited_text, Some(Some("Edited".into())));
    let on_disk: Value = serde_json::from_str(&read(&dir.path().join("history.json"))).unwrap();
    assert_eq!(on_disk, Value::Array(reopened.history_json()));
}

#[test]
fn caller_mutations_cannot_silently_change_saved_history() {
    let (_dir, paths) = profile();
    let storage = StorageService::open(paths.clone()).unwrap();
    let mut record = transcript();
    storage.add_history(&record).unwrap();
    record.text = "Changed outside storage".into();
    storage.find_history(&record.id).unwrap().text = "Changed through lookup".into();
    assert_eq!(storage.find_history(&record.id).unwrap().text, transcript().text);
    let mut replacement = TranscriptRecord { edited_text: Some(Some("Intentional edit".into())), ..transcript() };
    storage.replace_history(&replacement).unwrap();
    replacement.edited_text = Some(Some("External change".into()));
    let reopened = StorageService::open(paths).unwrap();
    assert_eq!(reopened.find_history("speech").unwrap().edited_text, Some(Some("Intentional edit".into())));
    assert_eq!(storage.find_history("speech").unwrap().edited_text, Some(Some("Intentional edit".into())));
}

#[test]
fn private_results_never_become_saved_history_when_persistence_is_re_enabled() {
    let (dir, paths) = profile();
    let storage = StorageService::open(paths.clone()).unwrap();
    storage.add_history(&transcript()).unwrap();
    let original = read(&dir.path().join("history.json"));
    storage.patch_settings(&json!({"keepHistory": false})).unwrap();
    assert!(!storage.add_history(&TranscriptRecord { id: "private".into(), ..transcript() }).unwrap());
    storage.patch_settings(&json!({"keepHistory": true})).unwrap();
    let session = TranscriptRecord { id: "still-private".into(), session_only: Some(true), ..transcript() };
    assert!(!storage.add_history(&session).unwrap());
    assert_eq!(read(&dir.path().join("history.json")), original);
    let ids: Vec<_> = StorageService::open(paths).unwrap().get_history().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["speech"]);
}

fn counting_writer(writes: Arc<AtomicUsize>) -> ProfileWriter {
    Arc::new(move |path: &Path, value: &Value| {
        writes.fetch_add(1, Ordering::SeqCst);
        write_profile_json(path, value)
    })
}

#[test]
fn opening_an_unchanged_profile_avoids_redundant_durable_writes() {
    let (_dir, paths) = profile();
    StorageService::open(paths.clone()).unwrap();
    let writes = Arc::new(AtomicUsize::new(0));
    StorageService::open_with_writer(paths, counting_writer(writes.clone())).unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}

#[test]
fn reopening_a_v0_10_0_profile_preserves_explicit_settings_exact_rules_and_every_transcript_text_version() {
    let (dir, paths) = profile();
    let saved_settings = merge(
        defaults(),
        json!({
            "model": speech_model_for_platform().as_str(),
            "speechEngine": if delulu_data::storage::large_speech_supported() { "large" } else { "medium" },
            "language": "nl",
            "shortcut": "CommandOrControl+Shift+D",
            "keepHistory": false,
            "magicEnabled": true,
            "preloadMagicModel": true,
            "pastePortalToken": "saved-desktop-permission",
            "customWords": [{
                "schemaVersion": 1, "id": "signature", "kind": "shortcut", "term": "my signature",
                "language": "nl", "soundsLike": "mijn handtekening", "aliases": ["onderteken"],
                "replacement": "\tMet vriendelijke groet,\r\n  Boran  \r\n", "enabled": true,
            }],
        }),
    );
    let saved_history = json!([merge(
        transcript_json(),
        json!({
            "schemaVersion": 1, "text": "\tOriginal café 🎙️\r\n  exact spacing  ",
            "personalizedText": "Personalized result\r\n", "editedText": "User's correction\n",
            "magicText": "Accepted rewrite\r\n", "sourceRevision": 2, "rewriteSourceRevision": 2,
            "title": "Saved title", "magicModel": "qwen35Medium", "magicPreset": "polish",
        }),
    )]);
    let settings_bytes = js::stringify(&saved_settings);
    let history_bytes = js::stringify(&saved_history);
    fs::write(dir.path().join("settings.json"), &settings_bytes).unwrap();
    fs::write(dir.path().join("history.json"), &history_bytes).unwrap();
    let upgraded = StorageService::open(paths.clone()).unwrap();
    let reopened = StorageService::open(paths).unwrap();
    for storage in [upgraded, reopened] {
        assert_eq!(storage.settings_json(), saved_settings);
        assert_eq!(serde_json::to_value(storage.get_settings()).unwrap(), saved_settings);
        assert_eq!(Value::Array(storage.history_json()), saved_history);
    }
    assert_eq!(read(&dir.path().join("settings.json")), settings_bytes);
    assert_eq!(read(&dir.path().join("history.json")), history_bytes);
}

#[test]
fn history_keeps_only_the_newest_transcripts_up_to_the_chosen_limit() {
    let (_dir, paths) = profile();
    let storage = StorageService::open(paths.clone()).unwrap();
    for index in 0..30 {
        storage
            .add_history(&TranscriptRecord { id: format!("t{index}"), created_at: f64::from(index + 1), ..transcript() })
            .unwrap();
    }
    assert_eq!(storage.get_history().len(), 30);
    storage.pin_history(&["t0".into()]);
    storage.update_settings(&json!({"historyLimit": 25})).unwrap();
    let kept: Vec<_> = storage.get_history().into_iter().map(|r| r.id).collect();
    // Newest 25 plus a record held open by a pending undo.
    assert_eq!(kept.len(), 26);
    assert_eq!(kept[0], "t29");
    assert!(kept.contains(&"t0".to_owned()));
    assert!(!kept.contains(&"t1".to_owned()));
    assert_eq!(StorageService::open(paths).unwrap().get_history().len(), 26);
    // Unsupported limits fall back to the default rather than keeping everything.
    storage.update_settings(&json!({"historyLimit": 7})).unwrap();
    assert_eq!(storage.get_settings().history_limit, 50.0);
}

#[test]
fn removed_live_typing_code_mode_and_speech_device_settings_are_dropped() {
    let settings = normalize_settings(&json!({"liveTyping": true, "dictationMode": "code", "speechDevice": "cpu"})).unwrap();
    for key in ["liveTyping", "dictationMode", "speechDevice"] {
        assert!(!settings.extra.contains_key(key));
    }
}

fn tier(value: Value) -> SpeechTier {
    normalize_settings(&value).unwrap().speech_engine
}

fn large_or_medium() -> SpeechTier {
    if delulu_data::storage::large_speech_supported() {
        SpeechTier::Large
    } else {
        SpeechTier::Medium
    }
}

#[test]
fn earlier_speech_engines_map_onto_the_three_model_sizes() {
    assert_eq!(tier(json!({"speechEngine": "r2t2"})), large_or_medium());
    assert_eq!(tier(json!({"speechEngine": "nemotron"})), large_or_medium());
    assert_eq!(tier(json!({"speechEngine": "redux"})), SpeechTier::Medium);
    assert_eq!(tier(json!({"speechEngine": "small"})), SpeechTier::Small);
    assert_eq!(tier(json!({"speechEngine": "huge"})), SpeechTier::Medium);
    // New installs start on Medium; profiles from before the setting used R2T2.
    assert_eq!(tier(json!({})), SpeechTier::Medium);
    assert_eq!(tier(json!({"schemaVersion": 1})), large_or_medium());
}

fn language(value: Value) -> String {
    normalize_settings(&value).unwrap().language
}

#[test]
fn the_saved_language_must_suit_the_selected_model_size() {
    // Small takes four forced languages and cannot detect one.
    assert_eq!(language(json!({"speechEngine": "small", "language": "de"})), "de");
    assert_eq!(language(json!({"speechEngine": "small", "language": "nl"})), "en");
    assert_eq!(language(json!({"speechEngine": "small", "language": "auto"})), "en");
    // Medium is English or automatic detection across 25 languages.
    assert_eq!(language(json!({"speechEngine": "medium", "language": "nl"})), "auto");
    assert_eq!(language(json!({"speechEngine": "medium", "language": "en"})), "en");
    if delulu_data::storage::large_speech_supported() {
        assert_eq!(language(json!({"speechEngine": "large", "language": "nl"})), "nl");
    }
}

#[test]
fn history_records_with_removed_technical_fields_load_without_them_and_keep_their_text() {
    let (dir, paths) = profile();
    let history = dir.path().join("history.json");
    let legacy = merge(transcript_json(), json!({"id": "legacy", "technicalText": "const value = 1;", "dictationMode": "code"}));
    let current =
        merge(transcript_json(), json!({"id": "current", "schemaVersion": 1, "technicalText": "fn main() {}", "dictationMode": "command"}));
    fs::write(&history, js::stringify(&json!([legacy, current]))).unwrap();
    let storage = StorageService::open(paths).unwrap();
    for record in storage.history_json() {
        assert!(record.get("technicalText").is_none());
        assert!(record.get("dictationMode").is_none());
        assert_eq!(record["text"], transcript_json()["text"]);
    }
    let saved: Vec<Value> = serde_json::from_str(&read(&history)).unwrap();
    for record in saved {
        assert!(record.get("technicalText").is_none());
        assert!(record.get("dictationMode").is_none());
    }
}

#[test]
fn automatic_language_is_kept_where_the_speech_engine_detects_it_and_vocabulary_hints_default_on() {
    // Medium detects the language everywhere; R2T2 on MLX needs a selected one.
    let mut source = merge(defaults(), json!({"language": "AUTO"}));
    source.as_object_mut().unwrap().remove("vocabularyHints");
    let settings = normalize_settings(&source).unwrap();
    assert_eq!(settings.language, "auto");
    assert!(settings.vocabulary_hints);
    assert!(!normalize_settings(&merge(defaults(), json!({"vocabularyHints": false}))).unwrap().vocabulary_hints);
    assert_eq!(language(merge(defaults(), json!({"language": "klingon"}))), "en");
}

#[test]
fn word_packs_keep_known_ids_once_and_settings_from_removed_profiles_are_dropped() {
    let settings = normalize_settings(&merge(
        defaults(),
        json!({
            "wordPacks": ["gaming", "unknown", "gaming", 3, "programming"],
            "personalProfiles": {"schemaVersion": 1, "profiles": []},
            "activePersonalProfile": null,
        }),
    ))
    .unwrap();
    let packs: Vec<_> = settings.word_packs.iter().map(|p| p.as_str()).collect();
    assert_eq!(packs, ["gaming", "programming"]);
    assert!(!settings.extra.contains_key("personalProfiles"));
    assert!(!settings.extra.contains_key("activePersonalProfile"));
    assert!(normalize_settings(&merge(defaults(), json!({"wordPacks": "gaming"}))).unwrap().word_packs.is_empty());
}

#[test]
fn saved_settings_with_word_packs_reopen_unchanged() {
    let (_dir, paths) = profile();
    let storage = StorageService::open(paths.clone()).unwrap();
    storage.patch_settings(&json!({"wordPacks": ["gaming"]})).unwrap();
    let packs: Vec<_> = StorageService::open(paths).unwrap().get_settings().word_packs.iter().map(|p| p.as_str()).collect();
    assert_eq!(packs, ["gaming"]);
}

#[test]
fn deletion_revokes_backup_copies_and_retention_requires_a_current_preview() {
    let (dir, paths) = profile();
    // An unversioned profile migrates, which takes a raw backup first.
    fs::write(dir.path().join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
    fs::write(dir.path().join("history.json"), js::stringify(&json!([transcript_json()]))).unwrap();
    let storage = StorageService::open(paths).unwrap();
    let backups = dir.path().join("migration-backups");
    let snapshot = fs::read_dir(&backups).unwrap().next().unwrap().unwrap().path();
    assert!(snapshot.join("history.json").exists());
    storage.add_history(&TranscriptRecord { id: "second".into(), created_at: 2.0, ..transcript() }).unwrap();
    let fingerprint = storage.history_fingerprint();
    storage.add_history(&TranscriptRecord { id: "third".into(), created_at: 3.0, ..transcript() }).unwrap();
    assert!(storage.apply_history_retention(&fingerprint, &["speech".into()]).is_err());
    storage.apply_history_retention(&storage.history_fingerprint(), &["third".into()]).unwrap();
    storage.delete_history("speech").unwrap();
    assert!(!snapshot.join("history.json").exists());
    assert!(snapshot.join("settings.json").exists());
    let ids: Vec<_> = storage.get_history().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["second"]);
    storage.clear_history().unwrap();
    assert_eq!(read(&dir.path().join("history.json")), "[]\n");
}

#[test]
fn concurrent_patches_are_serialized() {
    let (_dir, paths) = profile();
    let storage = Arc::new(StorageService::open(paths.clone()).unwrap());
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let storage = storage.clone();
            std::thread::spawn(move || {
                let id = format!("w{index}");
                storage
                    .update_settings_with(|_, current| {
                        let mut next = current.clone();
                        let words = next["customWords"].as_array_mut().unwrap();
                        words.push(json!({"id": id, "term": id, "soundsLike": "", "replacement": "", "enabled": true}));
                        Ok(next)
                    })
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(StorageService::open(paths).unwrap().get_settings().custom_words.len(), 8);
}

/* Profiles written by the Electron app (fixtures/generate.ts). */

fn fixtures() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures"))
}

fn copy_profile(from: &Path, to: &Path) {
    for name in ["settings.json", "history.json"] {
        fs::copy(from.join(name), to.join(name)).unwrap();
    }
}

#[test]
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn an_electron_written_profile_reopens_byte_for_byte_without_writes() {
    let (dir, paths) = profile();
    copy_profile(&fixtures().join("current"), dir.path());
    let settings_bytes = read(&dir.path().join("settings.json"));
    let history_bytes = read(&dir.path().join("history.json"));
    let writes = Arc::new(AtomicUsize::new(0));
    let storage = StorageService::open_with_writer(paths.clone(), counting_writer(writes.clone())).unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 0);
    assert!(!dir.path().join("migration-backups").exists());
    // Every record is visible through the typed view, with unknown keys kept.
    let history = storage.get_history();
    assert_eq!(history.len(), 2);
    let full = storage.find_history("full").unwrap();
    assert_eq!(full.extra["pluginMetadata"], json!({"tags": ["private"], "score": 1e-7}));
    assert!(full.speech_execution.is_some() && full.capture_diagnostics.is_some() && full.delivery.is_some());
    let minimal = storage.find_history("minimal").unwrap();
    assert_eq!((minimal.title.clone(), minimal.source_name.clone()), (Some(None), Some(None)));
    assert_eq!(storage.get_settings().extra["pluginSetting"], json!({"nested": [1, 2.5, "x"]}));

    // Rewriting without a change produces the same bytes the Electron app wrote.
    storage.update_settings(&storage.settings_json()).unwrap();
    storage.replace_history(&full).unwrap();
    storage.replace_history(&minimal).unwrap();
    assert_eq!(read(&dir.path().join("settings.json")), settings_bytes);
    assert_eq!(read(&dir.path().join("history.json")), history_bytes);

    // A typed update keeps the saved key order of the record.
    storage.set_transcript_title("full", Some("Renamed")).unwrap();
    let expected = history_bytes.replacen("\"title\": \"Weekly notes\"", "\"title\": \"Renamed\"", 1);
    assert_eq!(read(&dir.path().join("history.json")), expected);
}

#[test]
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn a_legacy_profile_migrates_to_the_same_bytes_as_the_electron_app() {
    let (dir, paths) = profile();
    copy_profile(&fixtures().join("legacy/input"), dir.path());
    StorageService::open(paths).unwrap();
    // The rule without an id gets `word-<Date.now()>-<index>`.
    let generated = regex::Regex::new(r"word-\d+-1").unwrap();
    let settings = read(&dir.path().join("settings.json"));
    let expected = read(&fixtures().join("legacy/migrated/settings.json"));
    assert_eq!(generated.replace(&settings, "word-ID-1"), generated.replace(&expected, "word-ID-1"));
    assert_eq!(read(&dir.path().join("history.json")), read(&fixtures().join("legacy/migrated/history.json")));
    // The raw originals were backed up before the migration wrote anything.
    let snapshot = fs::read_dir(dir.path().join("migration-backups")).unwrap().next().unwrap().unwrap().path();
    assert_eq!(read(&snapshot.join("settings.json")), read(&fixtures().join("legacy/input/settings.json")));
    assert_eq!(read(&snapshot.join("history.json")), read(&fixtures().join("legacy/input/history.json")));
}
