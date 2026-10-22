//! Latest transcript, session-only transcripts and paste recovery, which
//! `electron/main.ts` kept as module state (`lastTranscript`,
//! `sessionTranscripts`, `pasteRecovery`, `recordDelivery`, the dictation
//! `broadcastTranscript` callback and `reportPasteFailure`).
//!
//! History IPC handlers in the app crate use [`Transcripts::lookup`],
//! [`Transcripts::remember`], [`Transcripts::forget`] and
//! [`Transcripts::clear`] where the TypeScript touched these maps.

use std::sync::Arc;

use delulu_core::{emit, DomainResult, SharedSink};
use delulu_domain::pipeline_timings::normalize_timings;
use delulu_domain::text::{delivered_text, remember_session_transcript};
use delulu_domain::{
    DeliveryState, PasteRecovery, PipelineTimings, TranscriptDelivery, TranscriptRecord,
};
use parking_lot::Mutex;
use serde_json::Value;

use crate::channels;
use crate::profile::Profile;

pub(crate) type Changed = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct State {
    last: Option<TranscriptRecord>,
    /// Insertion-ordered session records keyed by id.
    session: Vec<TranscriptRecord>,
    recovery: Option<PasteRecovery>,
}

pub struct Transcripts {
    profile: Arc<dyn Profile>,
    sink: SharedSink,
    changed: Changed,
    state: Mutex<State>,
}

/// `{ state, updatedAt: Date.now(), detail, method }`.
pub(crate) fn delivery(
    state: DeliveryState,
    detail: Option<String>,
    method: Option<String>,
) -> TranscriptDelivery {
    TranscriptDelivery {
        state,
        updated_at: delulu_core::now_ms(),
        method,
        detail,
    }
}

/// `normalizeTimings({ ...base, clipboardMs?, pasteMs? })`.
pub(crate) fn with_delivery_timings(
    base: Option<&PipelineTimings>,
    from: Option<&PipelineTimings>,
) -> Option<PipelineTimings> {
    let mut timings = base.cloned().unwrap_or_default();
    if let Some(from) = from {
        if from.clipboard_ms.is_some() {
            timings.clipboard_ms = from.clipboard_ms;
        }
        if from.paste_ms.is_some() {
            timings.paste_ms = from.paste_ms;
        }
    }
    normalize_timings(&serde_json::to_value(timings).unwrap_or(Value::Null))
}

impl Transcripts {
    /// `changed` rebuilds the tray menu (`rebuildTrayMenu`).
    pub fn new(
        profile: Arc<dyn Profile>,
        sink: SharedSink,
        changed: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            profile,
            sink,
            changed: Arc::new(changed),
            state: Mutex::new(State::default()),
        }
    }

    pub fn last(&self) -> Option<TranscriptRecord> {
        self.state.lock().last.clone()
    }

    pub fn set_last(&self, record: Option<TranscriptRecord>) {
        self.state.lock().last = record;
    }

    /// `sessionTranscripts.get(id)`.
    pub fn session(&self, id: &str) -> Option<TranscriptRecord> {
        self.state
            .lock()
            .session
            .iter()
            .find(|record| record.id == id)
            .cloned()
    }

    /// `[...sessionTranscripts.values()]`, for `visibleHistory` and exports.
    pub fn session_records(&self) -> Vec<TranscriptRecord> {
        self.state.lock().session.clone()
    }

    /// `storage.findHistory(id) ?? sessionTranscripts.get(id)`.
    pub fn lookup(&self, id: &str) -> Option<TranscriptRecord> {
        self.profile.find_history(id).or_else(|| self.session(id))
    }

    /// `rememberSessionTranscript(...)` plus `if (lastTranscript?.id === id) lastTranscript = record`,
    /// as history edits did; rebuilds the tray.
    pub fn remember(&self, record: TranscriptRecord) {
        self.store(record, false);
        (self.changed)();
    }

    fn store(&self, record: TranscriptRecord, make_last: bool) {
        let pinned = self.profile.pinned_history_ids();
        let mut state = self.state.lock();
        if make_last || state.last.as_ref().is_some_and(|last| last.id == record.id) {
            state.last = Some(record.clone());
        }
        remember_session_transcript(&mut state.session, record, &pinned);
    }

    /// Deleted records: drops session copies and any latest/paste-recovery
    /// reference to them.
    pub fn forget(&self, ids: &[String]) {
        let cleared_recovery = {
            let mut state = self.state.lock();
            state.session.retain(|record| !ids.contains(&record.id));
            if state
                .last
                .as_ref()
                .is_some_and(|last| ids.contains(&last.id))
            {
                state.last = None;
            }
            let matches = state
                .recovery
                .as_ref()
                .is_some_and(|recovery| ids.contains(&recovery.transcript_id));
            if matches {
                state.recovery = None;
            }
            matches
        };
        if cleared_recovery {
            emit(&*self.sink, channels::PASTE_RECOVERY, &Value::Null);
        }
        (self.changed)();
    }

    /// `history:clear`: every session record, the latest and paste recovery.
    pub fn clear(&self) {
        {
            let mut state = self.state.lock();
            state.session.clear();
            state.last = None;
            state.recovery = None;
        }
        emit(&*self.sink, channels::PASTE_RECOVERY, &Value::Null);
        (self.changed)();
    }

    /// The dictation `broadcastTranscript` callback: publishes a new or
    /// updated transcript as the latest. Delivery measurements may arrive
    /// after a user changed the transcript; those are dropped.
    pub fn broadcast(&self, mut record: TranscriptRecord) {
        let saved = self.profile.find_history(&record.id);
        let from_session = saved.is_none();
        if let Some(current) = saved.or_else(|| self.session(&record.id)) {
            if delivered_text(&current) != delivered_text(&record) {
                return;
            }
            let timings = with_delivery_timings(current.timings.as_ref(), record.timings.as_ref());
            // A session copy predates this update; keep the newer delivery state.
            let delivery = if from_session {
                record.delivery.take().or(current.delivery.clone())
            } else {
                current.delivery.clone()
            };
            record = TranscriptRecord {
                timings,
                delivery,
                ..current
            };
        }
        self.store(record.clone(), true);
        emit(&*self.sink, channels::HISTORY_ADDED, &record);
        (self.changed)();
    }

    /// `recordDelivery` in main.ts (tray copy, paste-last). Missing records are ignored.
    pub fn record_delivery(
        &self,
        id: &str,
        state: DeliveryState,
        detail: Option<String>,
        method: Option<String>,
    ) -> DomainResult<()> {
        let saved = self.profile.find_history(id);
        let Some(current) = saved.clone().or_else(|| self.session(id)) else {
            return Ok(());
        };
        let updated = TranscriptRecord {
            delivery: Some(delivery(state, detail, method)),
            ..current
        };
        if saved.is_some() {
            self.profile.replace_history(&updated)?;
        }
        self.store(updated.clone(), false);
        emit(&*self.sink, channels::HISTORY_ADDED, &updated);
        (self.changed)();
        Ok(())
    }

    /// `reportPasteFailure`: offers "Copy instead" for a retained transcript.
    pub fn report_paste_failure(&self, id: &str, detail: &str) {
        if self.lookup(id).is_some() {
            self.set_paste_recovery(Some(PasteRecovery {
                transcript_id: id.to_owned(),
                detail: detail.to_owned(),
            }));
        }
    }

    /// `paste:recovery`.
    pub fn paste_recovery(&self) -> Option<PasteRecovery> {
        self.state.lock().recovery.clone()
    }

    /// `setPasteRecovery`: stores and emits `paste:recoveryChanged`.
    pub fn set_paste_recovery(&self, recovery: Option<PasteRecovery>) {
        self.state.lock().recovery = recovery.clone();
        emit(&*self.sink, channels::PASTE_RECOVERY, &recovery);
    }

    /// `paste:dismissRecovery`.
    pub fn dismiss_recovery(&self, id: &str) {
        if self
            .paste_recovery()
            .is_some_and(|recovery| recovery.transcript_id == id)
        {
            self.set_paste_recovery(None);
        }
    }
}
