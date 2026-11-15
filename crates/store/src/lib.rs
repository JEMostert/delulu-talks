use rusqlite::Connection;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

mod db;
mod migrate;
mod vocabulary;
pub use vocabulary::{
    split_terms, Preset, Shelf, Vocabulary, MAX_SHELF_NAME_CHARS, MAX_SHELF_TERMS, MAX_SHELVES,
    MAX_TERM_CHARS, PRESETS,
};

pub const APP_ID: &str = "com.joran.delulu-talks";

const SETTINGS_FILE: &str = "settings.json";
const STATE_FILE: &str = "state.json";
/// Version 1 files, imported into the database once (see `migrate`).
const HISTORY_FILE: &str = "history.jsonl";
const VOCABULARY_FILE: &str = "vocabulary.json";

/// The settings.json format. 2 added `historyRetentionDays`.
pub const SETTINGS_VERSION: u32 = 2;

/// The History page offers these; 0 keeps everything.
pub const RETENTION_CHOICES: [u32; 4] = [0, 90, 30, 7];

/// How often a running app prunes history by its retention setting.
const PRUNE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

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
    /// The languages automatic detection may pick from; unused for a fixed language.
    pub allowed_languages: Vec<String>,
    pub insert: InsertMode,
    pub theme: Theme,
    /// Show the recording pill while dictating.
    pub overlay: bool,
    /// Clean up transcripts with the local language model.
    pub cleanup: bool,
    /// Smart context management: carry what recent dictations were about to the next
    /// one, so Whisper gets names right. Memory only; forgotten on restart.
    pub smart_context: bool,
    /// The user has accepted the cleanup model download, so it may start on
    /// its own. Internal; not a toggle.
    pub cleanup_model_ok: bool,
    /// Show the optional Delulu FM radio.
    pub radio: bool,
    /// Delete transcripts older than this many days; 0 keeps them forever.
    pub history_retention_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            microphone: None,
            start_at_login: true,
            model: "large-v3-turbo-q5_0".into(),
            language: "auto".into(),
            allowed_languages: default_allowed_languages(),
            insert: InsertMode::default(),
            theme: Theme::default(),
            overlay: true,
            cleanup: true,
            smart_context: true,
            cleanup_model_ok: false,
            radio: false,
            history_retention_days: 0,
        }
    }
}

/// Dutch and English: what the owner speaks, and what cleanup supports.
fn default_allowed_languages() -> Vec<String> {
    vec!["nl".into(), "en".into()]
}

impl Settings {
    /// An empty allowed set (hand-edited or from an old bug) means the default.
    fn normalized(mut self) -> Self {
        if self.allowed_languages.is_empty() {
            self.allowed_languages = default_allowed_languages();
        }
        self
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
    /// What cleanup thought the dictation was about, like "programming".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
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
    pub topic: Option<String>,
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

struct Data {
    settings: Settings,
    state: AppState,
    vocabulary: Vocabulary,
    db: Connection,
    /// When history was last pruned by its retention setting.
    pruned_at: Option<SystemTime>,
}

pub struct Store {
    config_dir: PathBuf,
    data_dir: PathBuf,
    data: Mutex<Data>,
}

impl Store {
    /// `config_dir` holds `settings.json` and `state.json`; `data_dir` holds the
    /// database (history and vocabulary) and `models/`. Both are app-specific
    /// directories. The first open imports the version 1 `history.jsonl` and
    /// `vocabulary.json`, keeping them as `*.v1.bak`.
    pub fn open(config_dir: &Path, data_dir: &Path) -> Result<Store, StoreError> {
        let settings_path = config_dir.join(SETTINGS_FILE);
        let mut settings = load_or_default::<Settings>(&settings_path, "settings").normalized();
        if settings.version < SETTINGS_VERSION && settings_path.exists() {
            settings.version = SETTINGS_VERSION;
            // In place: unknown keys of version 1 were already dropped by parsing,
            // and every new key has its default. Failing here only means trying again.
            if let Err(e) = write_json(&settings_path, &settings) {
                log::warn!("could not update settings to version {SETTINGS_VERSION}: {e}");
            }
        }
        settings.version = SETTINGS_VERSION;
        let state = load_or_default(&config_dir.join(STATE_FILE), "state");
        let mut db = db::open(&data_dir.join(db::DB_FILE))?;
        migrate::import_v1(&mut db, config_dir, data_dir)?;
        let vocabulary = db::load_vocabulary(&db)?;
        let store = Store {
            config_dir: config_dir.into(),
            data_dir: data_dir.into(),
            data: Mutex::new(Data {
                settings,
                state,
                vocabulary,
                db,
                pruned_at: None,
            }),
        };
        if let Err(e) = store.prune_history() {
            log::warn!("history: pruning failed: {e}");
        }
        Ok(store)
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

    /// Writes to disk first; the in-memory copy only changes on success. A shorter
    /// history retention prunes right away.
    pub fn save_settings(&self, s: &Settings) -> Result<(), StoreError> {
        if s.allowed_languages.is_empty() {
            return Err(StoreError::Invalid(
                "Keep at least one language for automatic detection.".into(),
            ));
        }
        let s = Settings {
            version: SETTINGS_VERSION,
            ..s.clone()
        };
        let retention_changed = {
            let mut data = self.lock();
            write_json(&self.config_dir.join(SETTINGS_FILE), &s)?;
            let changed = data.settings.history_retention_days != s.history_retention_days;
            data.settings = s;
            changed
        };
        if retention_changed {
            self.prune_history()?;
        }
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

    /// Apply `change` to a copy, save it, then keep it in memory. A rule error or a
    /// failed save leaves both untouched.
    pub fn update_vocabulary<R>(
        &self,
        change: impl FnOnce(&mut Vocabulary) -> Result<R, StoreError>,
    ) -> Result<(R, Vocabulary), StoreError> {
        let mut data = self.lock();
        let mut vocabulary = data.vocabulary.clone();
        let result = change(&mut vocabulary)?;
        if vocabulary != data.vocabulary {
            let tx = data.db.transaction().map_err(db::sql_error)?;
            db::save_vocabulary(&tx, &vocabulary)?;
            tx.commit().map_err(db::sql_error)?;
            data.vocabulary = vocabulary.clone();
        }
        Ok((result, vocabulary))
    }

    /// Saves a new entry; it is only returned once it is on disk.
    pub fn add_history(&self, e: NewEntry) -> Result<HistoryEntry, StoreError> {
        let entry = HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_ms(),
            text: e.text,
            language: e.language,
            model: e.model,
            audio_ms: e.audio_ms,
            stt_ms: e.stt_ms,
            total_ms: e.total_ms,
            raw: e.raw,
            cleanup_ms: e.cleanup_ms,
            topic: e.topic,
        };
        db::insert_entry(&self.lock().db, &entry)?;
        Ok(entry)
    }

    /// Newest first. Every word of `query` must occur in the text (anywhere in a
    /// word), ignoring case, and diacritics for words of three or more characters.
    pub fn history(&self, query: Option<&str>, limit: usize) -> Vec<HistoryEntry> {
        db::search(&self.lock().db, query, limit).unwrap_or_else(|e| {
            log::warn!("history: {e}");
            Vec::new()
        })
    }

    pub fn history_entry(&self, id: &str) -> Option<HistoryEntry> {
        db::entry(&self.lock().db, id).unwrap_or_else(|e| {
            log::warn!("history: {e}");
            None
        })
    }

    /// Persist the completed delivery timing.
    pub fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, StoreError> {
        db::set_total_ms(&self.lock().db, id, total_ms)?
            .ok_or_else(|| StoreError::Io(format!("history entry not found: {id}")))
    }

    /// Removes the entry and its text from the pre-database backups
    /// (`history.jsonl.v1.bak`), then from the database file and search index. In
    /// that order, a failure or a kill halfway leaves the entry in History, so
    /// deleting it again finishes the job.
    pub fn delete_history(&self, id: &str) -> Result<(), StoreError> {
        let data = self.lock();
        let Some(entry) = db::entry(&data.db, id)? else {
            return Ok(());
        };
        for path in migrate::history_backups(&self.data_dir) {
            if path.extension().is_none_or(|e| e != "rejected") {
                migrate::remove_from_backup(&path, &entry)?;
            }
        }
        db::delete_entry(&data.db, id)
    }

    /// Removes the pre-database history backups with their text, then every entry;
    /// a failure or a kill halfway leaves History to clear again.
    pub fn clear_history(&self) -> Result<(), StoreError> {
        let data = self.lock();
        for path in migrate::history_backups(&self.data_dir) {
            fs::remove_file(&path).map_err(|e| io_error(&path, e))?;
            log::info!("history: removed {}", path.display());
        }
        db::clear(&data.db)
    }

    /// Deletes entries older than the retention setting, from the database and from
    /// the pre-database backups. Returns how many database entries went.
    pub fn prune_history(&self) -> Result<usize, StoreError> {
        let mut data = self.lock();
        data.pruned_at = Some(SystemTime::now());
        let days = data.settings.history_retention_days;
        if days == 0 {
            return Ok(0);
        }
        let limit = Duration::from_secs(u64::from(days) * 24 * 60 * 60);
        let before = now_ms().saturating_sub(limit.as_millis() as i64);
        let removed = db::prune(&data.db, before)?;
        if removed > 0 {
            log::info!("history: removed {removed} entries older than {days} days");
        }
        // Backups lose their expired lines too. The rejected file has no readable
        // times; its mtime is its last write, so all of it is at least that old.
        for path in migrate::history_backups(&self.data_dir) {
            if path.extension().is_some_and(|e| e == "rejected") {
                let old = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .is_some_and(|age| age > limit);
                if old {
                    remove_file_logged(&path);
                }
            } else if let Err(e) = migrate::prune_backup(&path, before) {
                log::warn!("history: could not prune {}: {e}", path.display());
            }
        }
        Ok(removed)
    }

    /// Prunes history once a day for as long as `store` lives. Checks hourly against
    /// the wall clock, so a suspended laptop still prunes soon after waking.
    pub fn start_daily_pruning(store: &Arc<Store>) {
        let store = Arc::downgrade(store);
        let spawned = std::thread::Builder::new()
            .name("history-retention".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60 * 60));
                let Some(store) = store.upgrade() else {
                    return;
                };
                if let Err(e) = store.prune_history_if_due() {
                    log::warn!("history: pruning failed: {e}");
                }
            });
        if let Err(e) = spawned {
            log::warn!("history: no daily pruning: {e}");
        }
    }

    /// Prunes when the last prune is a day old.
    fn prune_history_if_due(&self) -> Result<usize, StoreError> {
        let due = self.lock().pruned_at.is_none_or(|at| {
            SystemTime::now()
                .duration_since(at)
                .map_or(true, |age| age >= PRUNE_EVERY)
        });
        if due {
            self.prune_history()
        } else {
            Ok(0)
        }
    }
}

fn remove_file_logged(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => log::info!("history: removed {}", path.display()),
        Err(e) => log::warn!("history: could not remove {}: {e}", path.display()),
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
        Err(e) => quarantine(path, what, &json_error(&e)),
    }
}

/// A parse error without the offending value: serde quotes strings it rejects, and
/// these files hold dictated text and vocabulary.
fn json_error(e: &serde_json::Error) -> String {
    format!(
        "{:?} error at line {} column {}",
        e.classify(),
        e.line(),
        e.column()
    )
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
pub(crate) mod test_support {
    use std::{fs, path::PathBuf};

    /// Unique temp directory under the system temp dir, removed on drop.
    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            let path = std::env::temp_dir().join(format!("delulu-store-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        pub(crate) fn config(&self) -> PathBuf {
            self.0.join("config")
        }

        pub(crate) fn data(&self) -> PathBuf {
            self.0.join("data")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::TempDir;

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
            topic: None,
        }
    }

    #[test]
    fn every_setting_survives_reopen() {
        let t = TempDir::new();
        let store = open(&t);
        assert_eq!(store.settings(), Settings::default());

        // Every field differs from its default, so one that isn't saved shows up.
        let custom = Settings {
            version: SETTINGS_VERSION,
            microphone: Some("alsa_input.usb".into()),
            start_at_login: false,
            model: "small".into(),
            language: "nl".into(),
            allowed_languages: vec!["en".into(), "de".into()],
            insert: InsertMode::CtrlShiftV,
            theme: Theme::Dark,
            overlay: false,
            cleanup: false,
            smart_context: false,
            cleanup_model_ok: true,
            radio: true,
            history_retention_days: 30,
        };
        store.save_settings(&custom).unwrap();
        drop(store);

        assert_eq!(open(&t).settings(), custom);
    }

    #[test]
    fn allowed_languages_never_empty() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        fs::write(
            t.config().join(SETTINGS_FILE),
            r#"{"language":"auto","allowedLanguages":[],"theme":"dark"}"#,
        )
        .unwrap();
        let store = open(&t);
        let s = store.settings();
        assert_eq!(s.allowed_languages, ["nl", "en"]);
        assert_eq!(s.theme, Theme::Dark);

        let empty = Settings {
            allowed_languages: vec![],
            ..s.clone()
        };
        assert!(matches!(
            store.save_settings(&empty),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(store.settings(), s);
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
    fn older_settings_files_keep_their_values_and_default_the_rest() {
        let defaults = Settings::default();
        for (file, expected) in [
            // Before cleanup and the pill existed: both start on.
            (
                r#"{"version":1,"theme":"dark"}"#,
                Settings {
                    theme: Theme::Dark,
                    ..defaults.clone()
                },
            ),
            // Unknown keys from removed settings are ignored.
            (
                r#"{"theme":"light","hotkey":"Super+Z"}"#,
                Settings {
                    theme: Theme::Light,
                    ..defaults.clone()
                },
            ),
            // The on-disk names existing files use.
            (
                r#"{"startAtLogin":false,"insert":"ctrl-shift-v","cleanup":false,"cleanupModelOk":true,"overlay":false,"smartContext":false}"#,
                Settings {
                    start_at_login: false,
                    insert: InsertMode::CtrlShiftV,
                    cleanup: false,
                    cleanup_model_ok: true,
                    overlay: false,
                    smart_context: false,
                    ..defaults.clone()
                },
            ),
        ] {
            let t = TempDir::new();
            fs::create_dir_all(t.config()).unwrap();
            fs::write(t.config().join(SETTINGS_FILE), file).unwrap();
            assert_eq!(open(&t).settings(), expected, "{file}");
        }
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
    fn cleanup_fields_round_trip_and_survive_timing_update() {
        let t = TempDir::new();
        let store = open(&t);
        let cleaned = store
            .add_history(NewEntry {
                raw: Some("eh hello".into()),
                cleanup_ms: Some(412),
                topic: Some("everyday".into()),
                ..entry("Hello.")
            })
            .unwrap();
        let plain = store.add_history(entry("plain")).unwrap();
        assert_eq!(cleaned.raw.as_deref(), Some("eh hello"));

        let updated = store.set_total_ms(&cleaned.id, 900).unwrap();
        assert_eq!(updated.raw.as_deref(), Some("eh hello"));
        assert_eq!(updated.cleanup_ms, Some(412));
        assert_eq!(updated.topic.as_deref(), Some("everyday"));
        drop(store);

        let entries = open(&t).history(None, 10);
        assert_eq!(entries[0], plain);
        assert_eq!(entries[1].total_ms, 900);
        assert_eq!(entries[1].raw.as_deref(), Some("eh hello"));
        assert_eq!(entries[1].cleanup_ms, Some(412));
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

    #[test]
    fn version_1_settings_file_is_rewritten_as_version_2() {
        let t = TempDir::new();
        fs::create_dir_all(t.config()).unwrap();
        let v1 = r#"{"version":1,"language":"nl","theme":"dark","cleanupModelOk":true}"#;
        fs::write(t.config().join(SETTINGS_FILE), v1).unwrap();

        drop(open(&t));
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(t.config().join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        assert_eq!(saved["historyRetentionDays"], 0);
        assert_eq!(saved["language"], "nl");
        assert_eq!(saved["cleanupModelOk"], true);
    }

    fn search(store: &Store, query: &str) -> Vec<String> {
        let mut texts: Vec<_> = store
            .history(Some(query), 100)
            .into_iter()
            .map(|e| e.text)
            .collect();
        texts.sort();
        texts
    }

    #[test]
    fn search_finds_words_parts_and_diacritics() {
        let t = TempDir::new();
        let store = open(&t);
        let dutch = "Morgen naar de tandarts voor een controle";
        let accents = "Één café met naïeve ober";
        let english = "Deploy the Rust build tonight";
        for text in [dutch, accents, english] {
            store.add_history(entry(text)).unwrap();
        }
        assert_eq!(search(&store, "TANDARTS"), [dutch]);
        assert_eq!(search(&store, "tand"), [dutch], "prefix");
        assert_eq!(search(&store, "arts"), [dutch], "inside a compound");
        assert_eq!(search(&store, "cafe"), [accents], "without the accent");
        assert_eq!(search(&store, "naïeve"), [accents]);
        assert_eq!(search(&store, "één"), [dutch, accents], "een and Één");
        assert_eq!(
            search(&store, "rust deploy"),
            [english],
            "every word, any order"
        );
        assert!(search(&store, "rust tandarts").is_empty());
        assert_eq!(
            search(&store, "de"),
            [english, dutch],
            "short words match too"
        );
        assert_eq!(search(&store, "build to"), [english]);
        assert!(
            search(&store, "\"rust OR").is_empty(),
            "operators are literal"
        );
        assert_eq!(store.history(Some("  "), 100).len(), 3);
    }

    fn file_bytes(t: &TempDir) -> Vec<u8> {
        let mut bytes = Vec::new();
        for name in [
            db::DB_FILE,
            "delulu.db-wal",
            "delulu.db-shm",
            "delulu.db-journal",
        ] {
            if let Ok(b) = fs::read(t.data().join(name)) {
                bytes.extend(b);
            }
        }
        bytes
    }

    fn holds(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|w| w == needle.as_bytes())
    }

    #[test]
    fn deleted_text_leaves_the_database_file() {
        let t = TempDir::new();
        let store = open(&t);
        let secret = store
            .add_history(NewEntry {
                raw: Some("eh rawsecretquokka".into()),
                ..entry("Cleanedsecretquokka moved")
            })
            .unwrap();
        for i in 0..20 {
            store
                .add_history(entry(&format!("filler note {i}")))
                .unwrap();
        }
        let kept = store.add_history(entry("Keptmarkerwombat")).unwrap();
        let bytes = file_bytes(&t);
        assert!(holds(&bytes, "Cleanedsecretquokka") && holds(&bytes, "rawsecretquokka"));

        store.delete_history(&secret.id).unwrap();
        let bytes = file_bytes(&t);
        assert!(
            !holds(&bytes, "secretquokka"),
            "deleted text is still in the file"
        );
        assert!(holds(&bytes, "Keptmarkerwombat"));
        assert!(store.history(Some("quokka"), 10).is_empty());

        store.clear_history().unwrap();
        assert!(!holds(&file_bytes(&t), "Keptmarkerwombat"));
        assert!(store.history_entry(&kept.id).is_none());
    }

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    fn insert_aged(t: &TempDir, text: &str, age_ms: i64) {
        let conn = db::open(&t.data().join(db::DB_FILE)).unwrap();
        let mut e = open_entry(text);
        e.created_at = now_ms() - age_ms;
        assert!(db::insert_entry(&conn, &e).unwrap());
    }

    fn open_entry(text: &str) -> HistoryEntry {
        HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: 0,
            text: text.into(),
            language: "en".into(),
            model: "m".into(),
            audio_ms: 1,
            stt_ms: 1,
            total_ms: 1,
            raw: None,
            cleanup_ms: None,
            topic: None,
        }
    }

    fn texts(store: &Store) -> Vec<String> {
        store
            .history(None, 100)
            .into_iter()
            .map(|e| e.text)
            .collect()
    }

    #[test]
    fn retention_prunes_only_older_entries() {
        let t = TempDir::new();
        drop(open(&t));
        insert_aged(&t, "31 days", 31 * DAY_MS);
        insert_aged(&t, "29 days", 29 * DAY_MS);
        insert_aged(&t, "8 days", 8 * DAY_MS);
        insert_aged(&t, "today", 0);
        let store = open(&t);
        assert_eq!(texts(&store).len(), 4, "Forever keeps everything");

        let thirty = Settings {
            history_retention_days: 30,
            ..store.settings()
        };
        store.save_settings(&thirty).unwrap();
        assert_eq!(texts(&store), ["today", "8 days", "29 days"]);
        drop(store);

        // Pruning also runs at start.
        insert_aged(&t, "45 days", 45 * DAY_MS);
        let store = open(&t);
        assert_eq!(texts(&store), ["today", "8 days", "29 days"]);
        let week = Settings {
            history_retention_days: 7,
            ..store.settings()
        };
        store.save_settings(&week).unwrap();
        assert_eq!(texts(&store), ["today"]);
    }

    #[test]
    fn retention_and_clear_reach_the_history_backups() {
        let t = TempDir::new();
        let store = open(&t);
        let line = |text: &str, age_ms: i64| {
            let mut e = open_entry(text);
            e.created_at = now_ms() - age_ms;
            serde_json::to_string(&e).unwrap()
        };
        // Written today (a fresh mtime), yet holding old transcripts.
        let backup = t.data().join("history.jsonl.v1.bak");
        let content = format!(
            "{}\nno time here\n{}\n",
            line("forty days", 40 * DAY_MS),
            line("ten days", 10 * DAY_MS)
        );
        fs::write(&backup, content).unwrap();
        let all_old = t.data().join("history.jsonl.v1.bak.2");
        fs::write(&all_old, line("fifty days", 50 * DAY_MS)).unwrap();
        let rejected = t.data().join("history.jsonl.rejected");
        fs::write(&rejected, "{\"broken\n").unwrap();
        File::options()
            .write(true)
            .open(&rejected)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(40 * 24 * 60 * 60))
            .unwrap();
        let unrelated = t.data().join("vocabulary.json.v1.bak");
        fs::write(&unrelated, "{}").unwrap();

        store
            .save_settings(&Settings {
                history_retention_days: 30,
                ..store.settings()
            })
            .unwrap();
        let kept = fs::read_to_string(&backup).unwrap();
        assert!(!kept.contains("forty days"), "{kept}");
        assert!(
            kept.contains("ten days") && kept.contains("no time here"),
            "{kept}"
        );
        assert!(!all_old.exists() && !rejected.exists());

        store.clear_history().unwrap();
        assert!(!backup.exists());
        assert!(unrelated.exists());
    }
}
