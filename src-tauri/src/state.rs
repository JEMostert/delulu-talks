//! Application state shared by IPC handlers, the tray and lifecycle hooks.
//! Built once in the setup hook (see `services.rs`) and managed by Tauri as
//! `Arc<AppState>`; callbacks created before it exists reach it through
//! [`AppState::get`].

use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use delulu_audio::{Cues, DeviceWatcher};
use delulu_core::{AppPaths, DomainError, DomainResult, SharedSink};
use delulu_data::history_batch::HistoryBatchDeletion;
use delulu_data::model_cache::ModelCacheService;
use delulu_data::rule_usage::RuleUsageService;
use delulu_data::StorageService;
use delulu_desktop::{PasteService, PillService, ShortcutService};
use delulu_domain::{HistoryBatchSnapshot, HistoryDeletionState, HistoryRetentionPreview, TranscriptRecord};
use delulu_runtime::setup_snapshot::SetupSnapshots;
use delulu_runtime::SerialQueue;
use delulu_speech::Speech;
use delulu_voice::VoiceSystem;
use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::ipc::Router;
use crate::lab::Lab;
use crate::shell::Shell;
use crate::tray::TrayController;
use crate::updates::UpdateService;

/// A retention preview kept until it is applied (`history:retentionPreview`).
pub struct RetentionPreview {
    pub preview: HistoryRetentionPreview,
    pub saved_fingerprint: String,
    pub full_fingerprint: String,
}

pub struct AppState {
    pub app: AppHandle,
    pub paths: AppPaths,
    pub router: Arc<Router<AppState>>,
    pub sink: SharedSink,
    pub storage: Arc<StorageService>,
    pub speech: Arc<Speech>,
    pub voice: VoiceSystem,
    pub paste: PasteService,
    pub pill: PillService,
    pub shortcut: ShortcutService,
    pub rule_usage: Arc<RuleUsageService>,
    pub model_cache: ModelCacheService,
    pub deletion: HistoryBatchDeletion,
    pub settings_queue: SerialQueue,
    pub updates: UpdateService,
    pub lab: Lab,
    pub shell: Shell,
    pub tray: TrayController,
    pub setup_snapshots: SetupSnapshots,
    pub cues: Cues,
    pub retention_preview: Mutex<Option<RetentionPreview>>,
    pub encrypted_history_busy: AtomicBool,
    pub device_watcher: Mutex<Option<DeviceWatcher>>,
}

/// A plain `Error` thrown by the TypeScript (`OPERATION_FAILED`, cause `Error`).
pub fn plain(message: impl Into<String>) -> DomainError {
    DomainError::failed(message).with_cause("Error", None)
}

impl AppState {
    /// The managed state, once setup has finished.
    pub fn get(app: &AppHandle) -> Option<Arc<AppState>> {
        app.try_state::<Arc<AppState>>().map(|state| Arc::clone(&state))
    }

    pub fn emit<T: serde::Serialize + ?Sized>(&self, channel: &str, payload: &T) {
        delulu_core::emit(self.sink.as_ref(), channel, payload);
    }

    /// `storage.findHistory(id) ?? sessionTranscripts.get(id)`.
    pub fn lookup(&self, id: &str) -> Option<TranscriptRecord> {
        self.speech.transcripts.lookup(id)
    }

    /// The saved record as persisted, or the session record as JSON.
    pub fn lookup_json(&self, id: &str) -> Option<Value> {
        self.storage
            .find_history_json(id)
            .or_else(|| self.speech.transcripts.session(id).and_then(|record| serde_json::to_value(record).ok()))
    }

    /// Saved records plus unsaved session records, minus pending deletions,
    /// newest first (`visibleHistory`).
    pub fn visible_history(&self) -> Vec<TranscriptRecord> {
        let mut records = self.storage.get_history();
        let saved: HashSet<String> = records.iter().map(|record| record.id.clone()).collect();
        // Saved records are authoritative on disk; the session map only adds unsaved ones.
        for record in self.speech.transcripts.session_records() {
            if record.session_only == Some(true) && !saved.contains(&record.id) {
                records.push(record);
            }
        }
        records.retain(|record| !self.deletion.hidden(&record.id));
        records.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        records
    }

    pub fn history_batch_snapshot(&self, deletion: Option<HistoryDeletionState>) -> HistoryBatchSnapshot {
        HistoryBatchSnapshot { deletion, records: self.visible_history() }
    }

    pub fn assert_visible(&self, id: &str) -> DomainResult<()> {
        if self.deletion.hidden(id) {
            return Err(plain("Undo deletion before using this transcript."));
        }
        Ok(())
    }

    /// `selectedHistory`: every id must be visible and still exist.
    pub fn selected_history(&self, ids: &[String]) -> DomainResult<Vec<TranscriptRecord>> {
        ids.iter()
            .map(|id| {
                self.assert_visible(id)?;
                self.lookup(id)
                    .ok_or_else(|| plain("A selected transcript is no longer available. Select the records again."))
            })
            .collect()
    }

    /// The selection as JSON, for exports and fingerprints.
    pub fn selected_history_json(&self, ids: &[String]) -> DomainResult<Vec<Value>> {
        self.selected_history(ids)?;
        ids.iter()
            .map(|id| {
                self.lookup_json(id)
                    .ok_or_else(|| plain("A selected transcript is no longer available. Select the records again."))
            })
            .collect()
    }

    /// Something the tray shows changed.
    pub fn rebuild_tray(&self) {
        self.tray.rebuild(&self.app);
    }

    /// `notify`: a silent desktop notification.
    pub fn notify(&self, body: &str) {
        crate::shell::notify(&self.app, body);
    }
}
