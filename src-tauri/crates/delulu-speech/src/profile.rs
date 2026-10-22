//! What the speech services need from storage. The app crate implements
//! this over delulu-data's `StorageService` (and its history batch deletion).
//! Directories come from [`delulu_core::AppPaths`], not from here.

use std::collections::BTreeMap;

use delulu_core::DomainResult;
use delulu_domain::{AppSettings, TranscriptRecord};

pub trait Profile: Send + Sync {
    /// Current saved settings snapshot. Replaces `storage.getSettings()`.
    fn settings(&self) -> AppSettings;

    /// Persists the Wayland paste portal restore token and broadcasts
    /// `settings:changed`. Replaces `storage.updateSettings({...storage.getSettings(), pastePortalToken})`
    /// followed by `broadcast("settings:changed", saved)` in `createPasteAdapter`'s callback.
    fn set_paste_portal_token(&self, token: String);

    /// Appends a new transcript; storage keeps `sessionOnly` records out of
    /// the persisted file. Replaces `storage.addHistory(record)`.
    fn add_history(&self, record: &TranscriptRecord) -> DomainResult<()>;

    /// A saved (persisted) record. Replaces `storage.findHistory(id)`.
    fn find_history(&self, id: &str) -> Option<TranscriptRecord>;

    /// Replaces a saved record. Replaces `storage.replaceHistory(record)`.
    fn replace_history(&self, record: &TranscriptRecord) -> DomainResult<()>;

    /// The newest saved record. Replaces `storage.getHistory()[0]`.
    fn latest_history(&self) -> Option<TranscriptRecord>;

    /// Record ids pinned by a pending batch deletion, which the session cache
    /// must not evict. Replaces `historyDeletion.getState()?.ids ?? []`.
    fn pinned_history_ids(&self) -> Vec<String>;

    /// Counts personalization rule matches. Replaces
    /// `ruleUsage.record(counts, storage.getSettings().customWords.map((rule) => rule.id))`.
    fn record_rule_usage(&self, counts: &BTreeMap<String, u64>);
}
