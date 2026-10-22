//! Staged, undoable deletion of selected transcripts (`historyBatch.ts`).
//!
//! Staging only hides records. Originals remain in their existing store until
//! the undo window expires; quitting or crashing during the window cancels
//! the deletion of durable records. The expiry runs on a sleeping thread, so
//! this works with or without an async runtime.

use std::sync::{Arc, Weak};
use std::time::Duration;

use delulu_core::util::truncate_utf16;
use delulu_core::{now_ms, uuid, DomainResult};
use delulu_domain::{HistoryDeletionPhase, HistoryDeletionState};
use parking_lot::Mutex;
use serde_json::Value;

use crate::migration_backups::is_history_backup_cleanup_error;
use crate::plain_error;

pub const UNDO_WINDOW: Duration = Duration::from_secs(30);

/// Validates a renderer selection: 1–500 unique ids of at most 128 characters.
pub fn history_selection(value: &Value) -> DomainResult<Vec<String>> {
    let items = match value {
        Value::Array(items) if !items.is_empty() && items.len() <= 500 => items,
        _ => return Err(plain_error("Select between 1 and 500 transcripts.")),
    };
    let mut ids: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(id) if !id.is_empty() && delulu_core::util::utf16_len(id) <= 128 => ids.push(id.clone()),
            _ => return Err(plain_error("Invalid selected transcript.")),
        }
    }
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err(plain_error("Each transcript must be selected only once."));
    }
    Ok(ids)
}

type Commit = Box<dyn Fn(&[String]) -> DomainResult<()> + Send + Sync>;
/// Receives the state to broadcast (`history:batchChanged` carries
/// `{ deletion: state, records: visibleHistory() }`).
type Changed = Box<dyn Fn(Option<HistoryDeletionState>) + Send + Sync>;

struct Inner {
    state: Mutex<Option<HistoryDeletionState>>,
    commit: Commit,
    changed: Changed,
    window: Duration,
}

#[derive(Clone)]
pub struct HistoryBatchDeletion {
    inner: Arc<Inner>,
}

impl HistoryBatchDeletion {
    pub fn new(
        commit: impl Fn(&[String]) -> DomainResult<()> + Send + Sync + 'static,
        changed: impl Fn(Option<HistoryDeletionState>) + Send + Sync + 'static,
    ) -> Self {
        Self::with_window(UNDO_WINDOW, commit, changed)
    }

    pub fn with_window(
        window: Duration,
        commit: impl Fn(&[String]) -> DomainResult<()> + Send + Sync + 'static,
        changed: impl Fn(Option<HistoryDeletionState>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(None),
                commit: Box::new(commit),
                changed: Box::new(changed),
                window,
            }),
        }
    }

    pub fn get_state(&self) -> Option<HistoryDeletionState> {
        self.inner.state.lock().clone()
    }

    /// Whether a record is hidden by a pending deletion.
    pub fn hidden(&self, id: &str) -> bool {
        self.inner
            .state
            .lock()
            .as_ref()
            .is_some_and(|state| state.phase == HistoryDeletionPhase::Pending && state.ids.iter().any(|i| i == id))
    }

    pub fn pending_ids(&self) -> Vec<String> {
        match &*self.inner.state.lock() {
            Some(state) if state.phase == HistoryDeletionPhase::Pending => state.ids.clone(),
            _ => Vec::new(),
        }
    }

    pub fn assert_no_pending(&self) -> DomainResult<()> {
        if self.inner.state.lock().as_ref().is_some_and(|state| state.phase == HistoryDeletionPhase::Pending) {
            return Err(plain_error("Undo the pending deletion or wait for its window to finish first."));
        }
        Ok(())
    }

    pub fn stage(&self, ids: Vec<String>) -> DomainResult<HistoryDeletionState> {
        let staged = {
            let mut state = self.inner.state.lock();
            if state.as_ref().is_some_and(|state| state.phase == HistoryDeletionPhase::Pending) {
                return Err(plain_error("Undo the pending deletion or wait for its window to finish first."));
            }
            let staged = HistoryDeletionState {
                token: uuid(),
                ids,
                deadline: now_ms() + self.inner.window.as_millis() as u64,
                phase: HistoryDeletionPhase::Pending,
                error: None,
            };
            *state = Some(staged.clone());
            staged
        };
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let token = staged.token.clone();
        let window = self.inner.window;
        std::thread::Builder::new()
            .name("history-undo-window".into())
            .spawn(move || {
                std::thread::sleep(window);
                if let Some(inner) = weak.upgrade() {
                    finish(&inner, &token);
                }
            })
            .map_err(|error| plain_error(format!("Could not start the undo window: {error}")))?;
        (self.inner.changed)(Some(staged.clone()));
        Ok(staged)
    }

    pub fn undo(&self, token: &str) -> DomainResult<()> {
        {
            let mut state = self.inner.state.lock();
            match &*state {
                Some(pending) if pending.token == token && pending.phase == HistoryDeletionPhase::Pending => {
                    if now_ms() < pending.deadline {
                        *state = None;
                    } else {
                        drop(state);
                        finish(&self.inner, token);
                        return Err(plain_error("The undo window has finished."));
                    }
                }
                _ => return Err(plain_error("This deletion can no longer be undone.")),
            }
        }
        (self.inner.changed)(None);
        Ok(())
    }
}

fn finish(inner: &Inner, token: &str) {
    let report = {
        let mut state = inner.state.lock();
        let Some(pending) = state.clone() else { return };
        if pending.token != token || pending.phase != HistoryDeletionPhase::Pending {
            return;
        }
        // The lock is held while committing so an undo cannot race the write.
        match (inner.commit)(&pending.ids) {
            Ok(()) => {
                *state = None;
                None
            }
            Err(error) => {
                let detail = if is_history_backup_cleanup_error(&error) {
                    error.message.clone()
                } else {
                    format!("Deletion was not completed. {}", error.message)
                };
                // Report a failure once; later snapshots must not revive a stale error.
                *state = None;
                Some(HistoryDeletionState {
                    phase: HistoryDeletionPhase::Failed,
                    error: Some(truncate_utf16(&detail, 600).to_owned()),
                    ..pending
                })
            }
        }
    };
    (inner.changed)(report);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn staged_deletion_commits_after_the_window_unless_undone() {
        let committed = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let events = Arc::new(Mutex::new(Vec::<Option<HistoryDeletionPhase>>::new()));
        let (c, e) = (committed.clone(), events.clone());
        let batch = HistoryBatchDeletion::with_window(
            Duration::from_millis(50),
            move |ids| {
                c.lock().push(ids.to_vec());
                Ok(())
            },
            move |state| e.lock().push(state.map(|s| s.phase)),
        );
        let staged = batch.stage(vec!["a".into()]).unwrap();
        assert!(batch.hidden("a"));
        assert!(batch.stage(vec!["b".into()]).is_err());
        batch.undo(&staged.token).unwrap();
        assert!(!batch.hidden("a"));
        assert!(batch.undo(&staged.token).is_err());
        batch.stage(vec!["b".into()]).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(*committed.lock(), vec![vec!["b".to_owned()]]);
        assert!(batch.get_state().is_none());
        assert_eq!(*events.lock(), vec![Some(HistoryDeletionPhase::Pending), None, Some(HistoryDeletionPhase::Pending), None]);
    }

    #[test]
    fn failed_commit_is_reported_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e = events.clone();
        let batch = HistoryBatchDeletion::with_window(
            Duration::from_millis(10),
            |_| Err(plain_error("Disk full")),
            move |state| e.lock().push(state),
        );
        batch.stage(vec!["a".into()]).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        let events = events.lock();
        let failed = events.last().unwrap().as_ref().unwrap();
        assert_eq!(failed.phase, HistoryDeletionPhase::Failed);
        assert_eq!(failed.error.as_deref(), Some("Deletion was not completed. Disk full"));
        assert!(batch.get_state().is_none());
    }

    #[test]
    fn selections_are_bounded_and_unique() {
        assert_eq!(history_selection(&json!(["a", "b"])).unwrap(), ["a", "b"]);
        assert!(history_selection(&json!([])).is_err());
        assert!(history_selection(&json!(["a", "a"])).is_err());
        assert!(history_selection(&json!(["a", 1])).is_err());
    }
}
