//! Restores the user's previous plain-text clipboard after a paste
//! (`electron/services/clipboardRestore.ts`).
//!
//! There is no portable clipboard change counter, so the contents are
//! compared throughout the grace period and our own writes invalidate the
//! restore. A replacement with identical contents between polls cannot be
//! distinguished.

use std::sync::Arc;
use std::time::Duration;

use delulu_core::DomainResult;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::clipboard::{ClipboardBackend, ClipboardSnapshot};

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const RESTORE_DELAY: Duration = Duration::from_millis(2000);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub type RestoreFn = Box<dyn FnOnce(String) -> BoxFuture<'static, DomainResult<()>> + Send>;

pub struct ClipboardRestore {
    clipboard: Arc<dyn ClipboardBackend>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    generation: u64,
    poller: Option<JoinHandle<()>>,
}

/// The previous text, captured before the transcript is published.
pub struct PendingRestore {
    owner: Arc<ClipboardRestore>,
    generation: u64,
    previous: String,
}

/// Polling for external changes; [`ArmedRestore::finish`] starts the delay.
pub struct ArmedRestore {
    deadline: Arc<Mutex<Option<Instant>>>,
}

impl ClipboardRestore {
    pub fn new(clipboard: Arc<dyn ClipboardBackend>) -> Arc<Self> {
        Arc::new(Self { clipboard, state: Mutex::new(State::default()) })
    }

    pub fn generation(&self) -> u64 {
        self.state.lock().generation
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock();
        state.generation += 1;
        if let Some(poller) = state.poller.take() {
            poller.abort();
        }
    }

    /// Cancels any pending restore and, when enabled, captures the current
    /// plain text. A rich clipboard, a clipboard without text or more than
    /// 1 MiB of text is never backed up.
    pub async fn begin(self: &Arc<Self>, enabled: bool) -> Option<PendingRestore> {
        self.cancel();
        if !enabled {
            return None;
        }
        let snapshot = read(&self.clipboard).await.ok()?;
        if snapshot.rich {
            return None;
        }
        let previous = snapshot.text?;
        if previous.len() > MAX_TEXT_BYTES {
            return None;
        }
        Some(PendingRestore { owner: self.clone(), generation: self.generation(), previous })
    }
}

impl PendingRestore {
    /// Snapshots the just-published transcript and starts watching for
    /// changes. Returns `None` when a newer write already invalidated it.
    pub async fn arm(self, restore: RestoreFn) -> Option<ArmedRestore> {
        let owner = self.owner.clone();
        if owner.generation() != self.generation {
            return None;
        }
        let expected = bounded(read(&owner.clipboard).await.ok()?)?;
        let deadline = Arc::new(Mutex::new(None::<Instant>));
        let generation = self.generation;
        let previous = self.previous;
        let poll_deadline = deadline.clone();
        let poll_owner = owner.clone();
        let mut restore = Some(restore);
        let mut state = owner.state.lock();
        if state.generation != generation {
            return None;
        }
        state.poller = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(Instant::now() + POLL_INTERVAL, POLL_INTERVAL);
            loop {
                interval.tick().await;
                if poll_owner.generation() != generation {
                    return;
                }
                let current = read(&poll_owner.clipboard).await.ok().and_then(bounded);
                if current.as_ref() != Some(&expected) {
                    poll_owner.cancel();
                    return;
                }
                let due = poll_deadline.lock().is_some_and(|deadline| Instant::now() >= deadline);
                if due {
                    // Invalidate without aborting this task, then restore.
                    {
                        let mut state = poll_owner.state.lock();
                        if state.generation != generation {
                            return;
                        }
                        state.generation += 1;
                        state.poller = None;
                    }
                    if let Some(restore) = restore.take() {
                        if let Err(error) = restore(previous).await {
                            eprintln!("[delulu] Could not restore the clipboard: {error}");
                        }
                    }
                    return;
                }
            }
        }));
        Some(ArmedRestore { deadline })
    }
}

impl ArmedRestore {
    /// Delivery succeeded: restore after the grace period.
    pub fn finish(self) {
        *self.deadline.lock() = Some(Instant::now() + RESTORE_DELAY);
    }
}

fn bounded(snapshot: ClipboardSnapshot) -> Option<ClipboardSnapshot> {
    let total = snapshot.text.as_ref().map_or(0, String::len) + snapshot.rich_fingerprint.len();
    (total <= MAX_TEXT_BYTES).then_some(snapshot)
}

async fn read(clipboard: &Arc<dyn ClipboardBackend>) -> Result<ClipboardSnapshot, String> {
    let clipboard = clipboard.clone();
    tokio::task::spawn_blocking(move || clipboard.read()).await.map_err(|e| e.to_string())?
}
