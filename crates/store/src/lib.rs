use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

mod vocabulary;
pub use vocabulary::{
    split_terms, Preset, Shelf, Vocabulary, MAX_SHELF_NAME_CHARS, MAX_SHELF_TERMS, MAX_SHELVES,
    MAX_TERM_CHARS, PRESETS,
};

pub const APP_ID: &str = "com.joran.delulu-talks";

const SETTINGS_FILE: &str = "settings.json";
const STATE_FILE: &str = "state.json";
const HISTORY_FILE: &str = "history.jsonl";
const VOCABULARY_FILE: &str = "vocabulary.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum InsertMode {
    #[default]
    ShiftInsert,
    CtrlV,
    CtrlShiftV,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub microphone: Option<String>,
    pub start_at_login: bool,
    pub model: String,
    pub language: String,
    pub insert: InsertMode,
    pub theme: Theme,
    /// Show the recording pill while dictating.
    pub overlay: bool,
    /// Clean up transcripts with the local language model.
    pub cleanup: bool,
    /// The user has accepted the cleanup model download, so it may start on
    /// its own. Internal; not a toggle.
    pub cleanup_model_ok: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            microphone: None,
            start_at_login: true,
            model: "large-v3-turbo-q5_0".into(),
            language: "auto".into(),
            insert: InsertMode::default(),
            theme: Theme::default(),
            overlay: true,
            cleanup: true,
            cleanup_model_ok: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub first_run_done: bool,
    pub remote_desktop_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: i64,
    pub text: String,
    pub language: String,
    pub model: String,
    pub audio_ms: u64,
    pub stt_ms: u64,
    pub total_ms: u64,
    /// The raw transcript, kept only when cleanup changed `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_ms: Option<u64>,
}

pub struct NewEntry {
    pub text: String,
    pub language: String,
    pub model: String,
    pub audio_ms: u64,
    pub stt_ms: u64,
    pub total_ms: u64,
    pub raw: Option<String>,
    pub cleanup_ms: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("store: {0}")]
    Io(String),
    /// A change the user asked for breaks a rule; the message is for the user.
    #[error("{0}")]
    Invalid(String),
}

fn io_error(path: &Path, e: io::Error) -> StoreError {
    StoreError::Io(format!("{}: {e}", path.display()))
}

struct Data {
    settings: Settings,
    state: AppState,
    vocabulary: Vocabulary,
    /// Oldest first, the same order as the lines in `history.jsonl`.
    history: Vec<HistoryEntry>,
    /// The history file ends without a newline (torn write or hand edit), so
    /// the next append must start a fresh line or it would glue onto that one.
    history_needs_newline: bool,
}

pub struct Store {
    config_dir: PathBuf,
    data_dir: PathBuf,
    data: Mutex<Data>,
}

impl Store {
    /// `config_dir` holds `settings.json`, `state.json` and `vocabulary.json`; `data_dir` holds
    /// `history.jsonl` and `models/`. Both are app-specific directories.
    pub fn open(config_dir: &Path, data_dir: &Path) -> Result<Store, StoreError> {
        let settings = load_or_default(&config_dir.join(SETTINGS_FILE), "settings");
        let state = load_or_default(&config_dir.join(STATE_FILE), "state");
        let vocabulary =
            load_or_default::<Vocabulary>(&config_dir.join(VOCABULARY_FILE), "vocabulary")
                .normalized();
        let (history, history_needs_newline) = load_history(&data_dir.join(HISTORY_FILE))?;
        Ok(Store {
            config_dir: config_dir.into(),
            data_dir: data_dir.into(),
            data: Mutex::new(Data {
                settings,
                state,
                vocabulary,
                history,
                history_needs_newline,
            }),
        })
    }

    /// Uses `$XDG_CONFIG_HOME/delulu-talks` and `$XDG_DATA_HOME/delulu-talks`.
    pub fn open_default() -> Result<Store, StoreError> {
        let config = dirs::config_dir()
            .ok_or_else(|| StoreError::Io("no XDG config directory".into()))?
            .join("delulu-talks");
        let data = dirs::data_dir()
            .ok_or_else(|| StoreError::Io("no XDG data directory".into()))?
            .join("delulu-talks");
        Self::open(&config, &data)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn models_dir(&self) -> PathBuf {
        self.data_dir.join("models")
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn settings(&self) -> Settings {
        self.lock().settings.clone()
    }

    /// Writes to disk first; the in-memory copy only changes on success.
    pub fn save_settings(&self, s: &Settings) -> Result<(), StoreError> {
        let mut data = self.lock();
        write_json(&self.config_dir.join(SETTINGS_FILE), s)?;
        data.settings = s.clone();
        Ok(())
    }

    pub fn state(&self) -> AppState {
        self.lock().state.clone()
    }

    /// Writes to disk first; the in-memory copy only changes on success.
    pub fn save_state(&self, s: &AppState) -> Result<(), StoreError> {
        let mut data = self.lock();
        write_json(&self.config_dir.join(STATE_FILE), s)?;
        data.state = s.clone();
        Ok(())
    }

    pub fn vocabulary(&self) -> Vocabulary {
        self.lock().vocabulary.clone()
    }

    /// Apply `change` to a copy, write it to disk, then keep it in memory. A rule
    /// error or a failed write leaves both untouched.
    pub fn update_vocabulary<R>(
        &self,
        change: impl FnOnce(&mut Vocabulary) -> Result<R, StoreError>,
    ) -> Result<(R, Vocabulary), StoreError> {
        let mut data = self.lock();
        let mut vocabulary = data.vocabulary.clone();
        let result = change(&mut vocabulary)?;
        if vocabulary != data.vocabulary {
            write_json(&self.config_dir.join(VOCABULARY_FILE), &vocabulary)?;
            data.vocabulary = vocabulary.clone();
        }
        Ok((result, vocabulary))
    }

    /// Appends one line to `history.jsonl`. The entry is only kept in memory
    /// if the append succeeded.
    pub fn add_history(&self, e: NewEntry) -> Result<HistoryEntry, StoreError> {
        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            text: e.text,
            language: e.language,
            model: e.model,
            audio_ms: e.audio_ms,
            stt_ms: e.stt_ms,
            total_ms: e.total_ms,
            raw: e.raw,
            cleanup_ms: e.cleanup_ms,
        };
        let line = serde_json::to_string(&entry)
            .map_err(|e| StoreError::Io(format!("history entry: {e}")))?;
        let mut data = self.lock();
        let path = self.data_dir.join(HISTORY_FILE);
        match append_line(&path, &line, data.history_needs_newline) {
            Ok(()) => data.history_needs_newline = false,
            Err(e) => {
                // Unknown how much of the line reached the file, so assume a
                // partial line and start the next append on a new line.
                data.history_needs_newline = true;
                return Err(e);
            }
        }
        data.history.push(entry.clone());
        Ok(entry)
    }

    /// Newest first; case-insensitive substring match on text.
    pub fn history(&self, query: Option<&str>, limit: usize) -> Vec<HistoryEntry> {
        let q = query.unwrap_or("").to_lowercase();
        self.lock()
            .history
            .iter()
            .rev()
            .filter(|e| e.text.to_lowercase().contains(&q))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Atomically persist the completed delivery timing before updating memory.
    pub fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, StoreError> {
        let mut data = self.lock();
        let mut history = data.history.clone();
        let entry = history
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| StoreError::Io(format!("history entry not found: {id}")))?;
        entry.total_ms = total_ms;
        let updated = entry.clone();
        let mut out = Vec::new();
        for entry in &history {
            serde_json::to_writer(&mut out, entry)
                .map_err(|e| StoreError::Io(format!("history entry: {e}")))?;
            out.push(b'\n');
        }
        write_atomic(&self.data_dir.join(HISTORY_FILE), &out)?;
        data.history = history;
        data.history_needs_newline = false;
        Ok(updated)
    }

    pub fn delete_history(&self, id: &str) -> Result<(), StoreError> {
        let mut data = self.lock();
        if !data.history.iter().any(|e| e.id == id) {
            return Ok(());
        }
        self.rewrite_history(&mut data, |e| e.id != id)
    }

    pub fn clear_history(&self) -> Result<(), StoreError> {
        let mut data = self.lock();
        self.rewrite_history(&mut data, |_| false)
    }

    /// Writes the kept entries to a temp file and renames it over
    /// `history.jsonl`, then updates memory to match.
    fn rewrite_history(
        &self,
        data: &mut Data,
        keep: impl Fn(&HistoryEntry) -> bool,
    ) -> Result<(), StoreError> {
        let mut out = Vec::new();
        for e in data.history.iter().filter(|e| keep(e)) {
            let line = serde_json::to_string(e)
                .map_err(|e| StoreError::Io(format!("history entry: {e}")))?;
            out.extend_from_slice(line.as_bytes());
            out.push(b'\n');
        }
        write_atomic(&self.data_dir.join(HISTORY_FILE), &out)?;
        data.history.retain(|e| keep(e));
        data.history_needs_newline = false;
        Ok(())
    }
}

/// A missing file is silently defaulted. A file that cannot be read or parsed
/// is logged, moved to `<name>.bad`, and defaulted.
fn load_or_default<T: DeserializeOwned + Default>(path: &Path, what: &str) -> T {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return T::default(),
        Err(e) => return quarantine(path, what, &e.to_string()),
    };
    match serde_json::from_slice::<T>(&bytes) {
        Ok(value) => value,
        Err(e) => quarantine(path, what, &e.to_string()),
    }
}

fn quarantine<T: Default>(path: &Path, what: &str, reason: &str) -> T {
    let mut bad = path.as_os_str().to_owned();
    bad.push(".bad");
    let bad = PathBuf::from(bad);
    log::warn!(
        "{what} file {} is unreadable ({reason}); using defaults",
        path.display()
    );
    if let Err(e) = fs::rename(path, &bad) {
        log::warn!(
            "could not keep {} as {}: {e}",
            path.display(),
            bad.display()
        );
    }
    T::default()
}

/// Bad lines are logged and skipped. Only an I/O failure other than "not
/// found" is an error, because continuing could later rewrite the file from
/// an empty list.
fn load_history(path: &Path) -> Result<(Vec<HistoryEntry>, bool), StoreError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
        Err(e) => return Err(io_error(path, e)),
    };
    let mut entries = Vec::new();
    for (i, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<HistoryEntry>(line) {
            Ok(entry) => entries.push(entry),
            Err(e) => log::warn!(
                "skipping bad history line {} in {}: {e}",
                i + 1,
                path.display()
            ),
        }
    }
    let needs_newline = bytes.last().is_some_and(|b| *b != b'\n');
    Ok((entries, needs_newline))
}

fn append_line(path: &Path, line: &str, needs_newline: bool) -> Result<(), StoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_error(dir, e))?;
    }
    let mut buf = String::with_capacity(line.len() + 2);
    if needs_newline {
        buf.push('\n');
    }
    buf.push_str(line);
    buf.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| io_error(path, e))?;
    file.write_all(buf.as_bytes())
        .and_then(|()| file.sync_data())
        .map_err(|e| io_error(path, e))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let mut json = serde_json::to_string_pretty(value)
        .map_err(|e| StoreError::Io(format!("{}: {e}", path.display())))?;
    json.push('\n');
    write_atomic(path, json.as_bytes())
}

/// Writes `bytes` to `<path>.tmp` in the same directory, then renames it over
/// `path`, so readers see either the old or the new file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| io_error(dir, e))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written = File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    match written.and_then(|()| fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(io_error(path, e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("delulu-store-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn config(&self) -> PathBuf {
            self.0.join("config")
        }

        fn data(&self) -> PathBuf {
            self.0.join("data")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open(t: &TempDir) -> Store {
        Store::open(&t.config(), &t.data()).unwrap()
    }

    fn entry(text: &str) -> NewEntry {
        NewEntry {
            text: text.into(),
            language: "en".into(),
            model: "m".into(),
            audio_ms: 1000,
            stt_ms: 200,
            total_ms: 300,
            raw: None,
            cleanup_ms: None,
        }
    }

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn store_is_send_and_sync() {
        assert_send_sync::<Store>();
    }

    #[test]
    fn app_id_is_stable() {
        assert_eq!(APP_ID, "com.joran.delulu-talks");
    }

    #[test]
    fn settings_round_trip() {
        let t = TempDir::new();
        let store = open(&t);
        assert_eq!(store.settings(), Settings::default());

        let custom = Settings {
            microphone: Some("alsa_input.usb".into()),
            start_at_login: false,
            model: "small".into(),
            language: "nl".into(),
            insert: InsertMode::CtrlShiftV,
            theme: Theme::Dark,
            ..Settings::default()
        };
        store.save_settings(&custom).unwrap();
        drop(store);

        assert_eq!(open(&t).settings(), custom);
    }

    #[test]
    fn state_round_trip() {
        let t = TempDir::new();
        let state = AppState {
            first_run_done: true,
            remote_desktop_token: Some("token".into()),
        };
        open(&t).save_state(&state).unwrap();
        assert_eq!(open(&t).state(), state);
    }

    #[test]
    fn settings_missing_fields_use_defaults() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(
            t.config().join(SETTINGS_FILE),
            r#"{"theme":"light","hotkey":"Super+Z"}"#,
        )
        .unwrap();

        let s = open(&t).settings();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(
            Settings {
                theme: Theme::default(),
                ..s
            },
            Settings::default()
        );
    }

    #[test]
    fn cleanup_settings_default_and_round_trip() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(
            t.config().join(SETTINGS_FILE),
            r#"{"version":1,"theme":"dark"}"#,
        )
        .unwrap();
        let store = open(&t);
        assert!(store.settings().cleanup);
        assert!(!store.settings().cleanup_model_ok);

        let off = Settings {
            cleanup: false,
            cleanup_model_ok: true,
            ..store.settings()
        };
        store.save_settings(&off).unwrap();
        let saved = fs::read_to_string(t.config().join(SETTINGS_FILE)).unwrap();
        assert!(saved.contains(r#""cleanup": false"#), "{saved}");
        assert!(saved.contains(r#""cleanupModelOk": true"#), "{saved}");
        drop(store);
        let reloaded = open(&t).settings();
        assert!(!reloaded.cleanup);
        assert!(reloaded.cleanup_model_ok);
    }

    #[test]
    fn overlay_defaults_on_and_round_trips() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(
            t.config().join(SETTINGS_FILE),
            r#"{"version":1,"theme":"dark"}"#,
        )
        .unwrap();
        let store = open(&t);
        assert!(store.settings().overlay);

        let off = Settings {
            overlay: false,
            ..store.settings()
        };
        store.save_settings(&off).unwrap();
        let saved = fs::read_to_string(t.config().join(SETTINGS_FILE)).unwrap();
        assert!(saved.contains(r#""overlay": false"#), "{saved}");
        drop(store);
        assert!(!open(&t).settings().overlay);
    }

    #[test]
    fn unreadable_settings_fall_back_and_are_kept() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        let path = t.config().join(SETTINGS_FILE);
        fs::write(&path, "{not json").unwrap();

        let store = open(&t);
        assert_eq!(store.settings(), Settings::default());
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(t.config().join("settings.json.bad")).unwrap(),
            "{not json"
        );
    }

    #[test]
    fn unreadable_state_falls_back_and_is_kept() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(t.config().join(STATE_FILE), "42").unwrap();

        assert_eq!(open(&t).state(), AppState::default());
        assert!(t.config().join("state.json.bad").exists());
    }

    #[test]
    fn history_add_search_delete_clear() {
        let t = TempDir::new();
        let store = open(&t);
        let first = store.add_history(entry("Hello world")).unwrap();
        store.add_history(entry("second note")).unwrap();
        let third = store.add_history(entry("HELLO again")).unwrap();

        let texts = |v: Vec<HistoryEntry>| v.into_iter().map(|e| e.text).collect::<Vec<_>>();
        assert_eq!(
            texts(store.history(None, 10)),
            ["HELLO again", "second note", "Hello world"]
        );
        assert_eq!(
            texts(store.history(Some("hello"), 10)),
            ["HELLO again", "Hello world"]
        );
        assert_eq!(texts(store.history(Some("hello"), 1)), ["HELLO again"]);

        store.delete_history(&first.id).unwrap();
        store.delete_history("no-such-id").unwrap();
        assert_eq!(
            texts(store.history(None, 10)),
            ["HELLO again", "second note"]
        );

        drop(store);
        let store = open(&t);
        assert_eq!(store.history(None, 10)[0].id, third.id);
        assert_eq!(store.history(None, 10).len(), 2);

        store.clear_history().unwrap();
        assert!(store.history(None, 10).is_empty());
        drop(store);
        assert!(open(&t).history(None, 10).is_empty());
    }

    #[test]
    fn delivery_timing_survives_reopen() {
        let t = TempDir::new();
        let store = open(&t);
        let first = store.add_history(entry("first")).unwrap();
        let second = store.add_history(entry("second")).unwrap();
        assert_eq!(store.set_total_ms(&first.id, 987).unwrap().total_ms, 987);
        assert!(store.set_total_ms("missing", 1).is_err());
        assert_eq!(store.history(None, 10)[1].total_ms, 987);
        drop(store);
        let entries = open(&t).history(None, 10);
        assert_eq!(entries[0], second);
        assert_eq!(entries[1].total_ms, 987);
    }

    #[test]
    fn history_survives_reopen_and_keeps_appending() {
        let t = TempDir::new();
        let store = open(&t);
        store.add_history(entry("one")).unwrap();
        drop(store);

        let store = open(&t);
        store.add_history(entry("two")).unwrap();
        drop(store);

        let texts: Vec<_> = open(&t)
            .history(None, 10)
            .into_iter()
            .map(|e| e.text)
            .collect();
        assert_eq!(texts, ["two", "one"]);
    }

    #[test]
    fn bad_history_line_is_skipped() {
        let t = TempDir::new();
        fs::create_dir_all(t.data()).unwrap();
        let good = |text: &str| {
            format!(
                r#"{{"id":"{text}","createdAt":1,"text":"{text}","language":"en","model":"m","audioMs":1,"sttMs":1,"totalMs":1}}"#
            )
        };
        let content = format!("{}\n{{\"id\":\nnot json\n{}\n", good("a"), good("b"));
        fs::write(t.data().join(HISTORY_FILE), content).unwrap();

        let store = open(&t);
        let texts: Vec<_> = store
            .history(None, 10)
            .into_iter()
            .map(|e| e.text)
            .collect();
        assert_eq!(texts, ["b", "a"]);
    }

    #[test]
    fn cleanup_fields_round_trip_and_survive_timing_update() {
        let t = TempDir::new();
        let store = open(&t);
        let cleaned = store
            .add_history(NewEntry {
                raw: Some("eh hello".into()),
                cleanup_ms: Some(412),
                ..entry("Hello.")
            })
            .unwrap();
        let plain = store.add_history(entry("plain")).unwrap();
        assert_eq!(cleaned.raw.as_deref(), Some("eh hello"));

        let updated = store.set_total_ms(&cleaned.id, 900).unwrap();
        assert_eq!(updated.raw.as_deref(), Some("eh hello"));
        assert_eq!(updated.cleanup_ms, Some(412));
        drop(store);

        let entries = open(&t).history(None, 10);
        assert_eq!(entries[0], plain);
        assert_eq!(entries[1].total_ms, 900);
        assert_eq!(entries[1].raw.as_deref(), Some("eh hello"));
        assert_eq!(entries[1].cleanup_ms, Some(412));
        let lines = fs::read_to_string(t.data().join(HISTORY_FILE)).unwrap();
        assert!(lines.contains(r#""cleanupMs":412"#), "{lines}");
        assert!(!lines.contains(r#""raw":null"#), "{lines}");
        // The file is oldest first: the cleaned entry is line 1, the plain one line 2.
        let mut file_lines = lines.lines();
        assert!(file_lines.next().unwrap().contains(r#""raw":"eh hello""#));
        assert!(!file_lines.next().unwrap().contains("raw"));
    }

    #[test]
    fn old_history_line_without_cleanup_fields_loads() {
        let t = TempDir::new();
        fs::create_dir_all(t.data()).unwrap();
        let old = r#"{"id":"a","createdAt":1,"text":"a","language":"en","model":"m","audioMs":1,"sttMs":1,"totalMs":1}"#;
        fs::write(t.data().join(HISTORY_FILE), format!("{old}\n")).unwrap();

        let store = open(&t);
        let entries = store.history(None, 10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].raw, None);
        assert_eq!(entries[0].cleanup_ms, None);
    }

    #[test]
    fn append_after_torn_line_starts_a_new_line() {
        let t = TempDir::new();
        fs::create_dir_all(t.data()).unwrap();
        let good = r#"{"id":"a","createdAt":1,"text":"a","language":"en","model":"m","audioMs":1,"sttMs":1,"totalMs":1}"#;
        fs::write(
            t.data().join(HISTORY_FILE),
            format!("{good}\n{{\"id\":\"tor"),
        )
        .unwrap();

        let store = open(&t);
        store.add_history(entry("new")).unwrap();
        drop(store);

        let texts: Vec<_> = open(&t)
            .history(None, 10)
            .into_iter()
            .map(|e| e.text)
            .collect();
        assert_eq!(texts, ["new", "a"]);
    }

    fn shelf_id(store: &Store, name: &str) -> String {
        store
            .update_vocabulary(|v| v.add_shelf(name).map(|s| s.id.clone()))
            .unwrap()
            .0
    }

    fn invalid<R: std::fmt::Debug>(result: Result<R, StoreError>) -> String {
        match result {
            Err(StoreError::Invalid(message)) => message,
            other => panic!("expected a rule error, got {other:?}"),
        }
    }

    #[test]
    fn starter_shelves_add_once_with_all_terms() {
        let t = TempDir::new();
        let store = open(&t);
        assert_eq!(store.vocabulary().available_presets().len(), PRESETS.len());
        for preset in PRESETS {
            let (_, v) = store
                .update_vocabulary(|v| v.add_preset(preset.key).map(|_| ()))
                .unwrap();
            let shelf = v.shelves.last().unwrap();
            assert_eq!(shelf.name, preset.name);
            assert_eq!(shelf.terms.len(), preset.terms.len(), "{}", preset.name);
            assert!(shelf.enabled);
        }
        assert!(store.vocabulary().available_presets().is_empty());
        let again = store.update_vocabulary(|v| v.add_preset("programming").map(|_| ()));
        assert!(again.is_err(), "a shelf with that name already exists");
        assert!(store
            .update_vocabulary(|v| v.add_preset("nope").map(|_| ()))
            .is_err());
        assert_eq!(open(&t).vocabulary().shelves.len(), PRESETS.len());
    }

    #[test]
    fn vocabulary_shelf_crud_survives_reopen() {
        let t = TempDir::new();
        let store = open(&t);
        assert_eq!(store.vocabulary(), Vocabulary::default());

        let code = shelf_id(&store, "  Programming ");
        let food = shelf_id(&store, "Food");
        store
            .update_vocabulary(|v| v.add_terms(&code, "T3 Code"))
            .unwrap();
        let (added, _) = store
            .update_vocabulary(|v| {
                v.add_terms(&code, "Tauri, claude   code\n t3 code,,\nClaude Code")
            })
            .unwrap();
        assert_eq!(added, 2);
        store
            .update_vocabulary(|v| v.rename_shelf(&code, "Code"))
            .unwrap();
        store
            .update_vocabulary(|v| v.add_terms(&food, "Stroopwafel"))
            .unwrap();
        store
            .update_vocabulary(|v| v.set_enabled(&food, false))
            .unwrap();
        store
            .update_vocabulary(|v| v.remove_term(&code, "TAURI"))
            .unwrap();
        drop(store);

        let store = open(&t);
        let v = store.vocabulary();
        assert_eq!(v.shelves.len(), 2);
        assert_eq!(v.shelves[0].name, "Code");
        assert_eq!(v.shelves[0].terms, ["T3 Code", "claude code"]);
        assert!(v.shelves[0].enabled);
        assert!(!v.shelves[1].enabled);
        assert_eq!(v.active_terms(), ["T3 Code", "claude code"]);

        store
            .update_vocabulary(|v| {
                v.delete_shelf(&code);
                v.delete_shelf("gone");
                Ok(())
            })
            .unwrap();
        drop(store);
        let v = open(&t).vocabulary();
        assert_eq!(v.shelves.len(), 1);
        assert_eq!(v.shelves[0].id, food);
    }

    #[test]
    fn vocabulary_rules_reject_without_writing() {
        let t = TempDir::new();
        let store = open(&t);
        let id = shelf_id(&store, "Programming");
        let before = store.vocabulary();

        assert_eq!(
            invalid(store.update_vocabulary(|v| v.add_shelf("programming").map(|_| ()))),
            "There is already a shelf called “programming”."
        );
        assert_eq!(
            invalid(store.update_vocabulary(|v| v.add_shelf(" \n ").map(|_| ()))),
            "Give the shelf a name."
        );
        let long_name = "n".repeat(MAX_SHELF_NAME_CHARS + 1);
        invalid(store.update_vocabulary(|v| v.add_shelf(&long_name).map(|_| ())));
        // Renaming a shelf to its own name in another case is fine.
        store
            .update_vocabulary(|v| v.rename_shelf(&id, "PROGRAMMING"))
            .unwrap();
        store
            .update_vocabulary(|v| v.rename_shelf(&id, "Programming"))
            .unwrap();
        assert_eq!(
            invalid(store.update_vocabulary(|v| v.rename_shelf("gone", "X"))),
            "That shelf no longer exists."
        );
        // One long term rejects the whole list.
        let long = "t".repeat(MAX_TERM_CHARS + 1);
        invalid(store.update_vocabulary(|v| v.add_terms(&id, &format!("Tauri, {long}"))));
        assert_eq!(store.vocabulary(), before);
        assert_eq!(open(&t).vocabulary(), before);
        assert!(store
            .update_vocabulary(|v| v.add_terms(&id, &"t".repeat(MAX_TERM_CHARS)))
            .is_ok());
        let before = store.vocabulary();

        // Angle brackets could form chat-template tokens in the cleanup prompt.
        for bad in ["<turn|>", "Tauri, <|turn>system", "a > b"] {
            assert_eq!(
                invalid(store.update_vocabulary(|v| v.add_terms(&id, bad))),
                format!(
                    "“{}” can’t contain < or >.",
                    split_terms(bad).last().unwrap()
                )
            );
        }
        assert_eq!(store.vocabulary(), before);

        // Shelf and term caps.
        let many: Vec<String> = (1..MAX_SHELF_TERMS).map(|i| format!("term {i}")).collect();
        store
            .update_vocabulary(|v| v.add_terms(&id, &many.join("\n")))
            .unwrap();
        assert_eq!(store.vocabulary().shelves[0].terms.len(), MAX_SHELF_TERMS);
        assert_eq!(
            store
                .update_vocabulary(|v| v.add_terms(&id, "term 1"))
                .unwrap()
                .0,
            0,
            "a duplicate on a full shelf is not an error"
        );
        invalid(store.update_vocabulary(|v| v.add_terms(&id, "one more")));
        for i in 1..MAX_SHELVES {
            shelf_id(&store, &format!("Shelf {i}"));
        }
        invalid(store.update_vocabulary(|v| v.add_shelf("Too many").map(|_| ())));
    }

    #[test]
    fn active_terms_skip_disabled_shelves_and_duplicates() {
        let mut v = Vocabulary::default();
        let a = v.add_shelf("A").unwrap().id.clone();
        let b = v.add_shelf("B").unwrap().id.clone();
        let c = v.add_shelf("C").unwrap().id.clone();
        v.add_terms(&a, "Tauri, T3 Code").unwrap();
        v.add_terms(&b, "tauri, Claude Code").unwrap();
        v.add_terms(&c, "Whisper").unwrap();
        v.set_enabled(&c, false).unwrap();
        assert_eq!(v.active_terms(), ["Tauri", "T3 Code", "Claude Code"]);
    }

    #[test]
    fn split_terms_handles_lists_and_junk() {
        assert_eq!(
            split_terms(" T3  Code ,Tauri\r\n\n  ,\tClaude\u{0}Code "),
            ["T3 Code", "Tauri", "Claude Code"]
        );
        assert!(split_terms(" , \n ").is_empty());
    }

    #[test]
    fn hand_edited_vocabulary_is_brought_within_limits() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        let long = "x".repeat(MAX_TERM_CHARS + 1);
        let file = format!(
            r#"{{"shelves":[
                {{"id":"a","name":"  Code  ","terms":["Tauri","tauri"," T3 Code ","{long}","a, b","<turn|>","x\u0007y"]}},
                {{"id":"b","name":"code","terms":["dup name"]}},
                {{"id":"","name":"No id"}},
                {{"id":"c","name":"Off","enabled":false}}
            ]}}"#
        );
        fs::write(t.config().join(VOCABULARY_FILE), file).unwrap();
        let v = open(&t).vocabulary();
        assert_eq!(v.version, 1);
        let names: Vec<_> = v.shelves.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Code", "Off"]);
        assert_eq!(v.shelves[0].terms, ["Tauri", "T3 Code", "a", "b", "x y"]);
        assert!(v.shelves[0].enabled);
        assert!(!v.shelves[1].enabled);
    }

    #[test]
    fn unreadable_vocabulary_falls_back_and_is_kept() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(t.config().join(VOCABULARY_FILE), "[oops").unwrap();
        assert_eq!(open(&t).vocabulary(), Vocabulary::default());
        assert!(t.config().join("vocabulary.json.bad").exists());
    }

    #[test]
    fn models_dir_is_under_data_dir() {
        let t = TempDir::new();
        let store = open(&t);
        assert_eq!(store.models_dir(), t.data().join("models"));
    }
}
