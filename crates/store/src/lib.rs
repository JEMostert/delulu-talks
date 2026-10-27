use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
pub const APP_ID: &str = "com.joran.delulu-talks";
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
}
pub struct NewEntry {
    pub text: String,
    pub language: String,
    pub model: String,
    pub audio_ms: u64,
    pub stt_ms: u64,
    pub total_ms: u64,
}
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("store: {0}")]
    Io(String),
}
#[derive(Default)]
struct Data {
    settings: Settings,
    state: AppState,
    history: Vec<HistoryEntry>,
}
pub struct Store {
    dir: PathBuf,
    data: Mutex<Data>,
}
impl Store {
    pub fn open(_config_dir: &Path, data_dir: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            dir: data_dir.into(),
            data: Mutex::new(Data::default()),
        })
    }
    pub fn open_default() -> Result<Self, StoreError> {
        Self::open(
            Path::new(""),
            &dirs::data_dir().unwrap_or_default().join("delulu-talks"),
        )
    }
    pub fn data_dir(&self) -> &Path {
        &self.dir
    }
    pub fn models_dir(&self) -> PathBuf {
        self.dir.join("models")
    }
    pub fn settings(&self) -> Settings {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .settings
            .clone()
    }
    pub fn save_settings(&self, s: &Settings) -> Result<(), StoreError> {
        self.data.lock().unwrap_or_else(|e| e.into_inner()).settings = s.clone();
        Ok(())
    }
    pub fn state(&self) -> AppState {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state
            .clone()
    }
    pub fn save_state(&self, s: &AppState) -> Result<(), StoreError> {
        self.data.lock().unwrap_or_else(|e| e.into_inner()).state = s.clone();
        Ok(())
    }
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
        };
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .insert(0, entry.clone());
        Ok(entry)
    }
    pub fn history(&self, query: Option<&str>, limit: usize) -> Vec<HistoryEntry> {
        let q = query.unwrap_or("").to_lowercase();
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .iter()
            .filter(|e| e.text.to_lowercase().contains(&q))
            .take(limit)
            .cloned()
            .collect()
    }
    pub fn delete_history(&self, id: &str) -> Result<(), StoreError> {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .retain(|e| e.id != id);
        Ok(())
    }
    pub fn clear_history(&self) -> Result<(), StoreError> {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .clear();
        Ok(())
    }
}
