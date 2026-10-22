//! The audio import queue (`importQueue.ts`).
//!
//! In-memory metadata queue. One runner remains active until it fully
//! settles. Every change bumps the snapshot version, is persisted first (a
//! failed persist rolls back to the last durable snapshot) and is then
//! reported through `changed` — the app broadcasts it as `lab:queueChanged`
//! (see [`ImportQueue::sink_listener`]).

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use delulu_core::util::truncate_utf16;
use delulu_core::{uuid, DomainError, DomainResult, SharedSink};
use delulu_domain::{AudioFileSelection, ImportJobState, ImportQueueJob, ImportQueueSnapshot};
use delulu_domain::import_queue::IMPORT_QUEUE_LIMIT;
use parking_lot::Mutex;
use tokio::sync::Notify;

use crate::plain_error;

pub const QUEUE_CHANGED: &str = "lab:queueChanged";

/// Cancellation for one running import, like an `AbortSignal`.
#[derive(Clone, Default)]
pub struct AbortSignal(Arc<SignalInner>);

#[derive(Default)]
struct SignalInner {
    aborted: AtomicBool,
    notify: Notify,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn is_aborted(&self) -> bool {
        self.0.aborted.load(Ordering::SeqCst)
    }
    pub fn abort(&self) {
        self.0.aborted.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }
    /// Resolves once aborted.
    pub async fn aborted(&self) {
        loop {
            let notified = self.0.notify.notified();
            if self.is_aborted() {
                return;
            }
            notified.await;
        }
    }
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Transcribes one source path and returns the transcript id.
pub type ImportRunner = Arc<dyn Fn(String, AbortSignal) -> BoxFuture<DomainResult<String>> + Send + Sync>;
pub type QueueListener = Arc<dyn Fn(&ImportQueueSnapshot) + Send + Sync>;
pub type QueuePersist = Arc<dyn Fn(&ImportQueueSnapshot) -> DomainResult<()> + Send + Sync>;

struct State {
    jobs: Vec<ImportQueueJob>,
    paused: bool,
    version: u64,
    closed: bool,
    durable: ImportQueueSnapshot,
    active: Option<(String, AbortSignal)>,
}

impl State {
    fn snapshot(&self) -> ImportQueueSnapshot {
        ImportQueueSnapshot { version: self.version, paused: self.paused, jobs: self.jobs.clone() }
    }
}

struct Inner {
    state: Mutex<State>,
    runner: ImportRunner,
    changed: QueueListener,
    persist: Option<QueuePersist>,
    runtime: tokio::runtime::Handle,
}

#[derive(Clone)]
pub struct ImportQueue {
    inner: Arc<Inner>,
}

impl ImportQueue {
    /// `changed` and `persist` run while the queue is locked and must not
    /// call back into the queue.
    pub fn new(
        runtime: tokio::runtime::Handle,
        runner: ImportRunner,
        changed: QueueListener,
        persist: Option<QueuePersist>,
        initial: Vec<ImportQueueJob>,
    ) -> Self {
        let mut state = State {
            jobs: initial,
            paused: true,
            version: 0,
            closed: false,
            durable: ImportQueueSnapshot::default(),
            active: None,
        };
        state.durable = state.snapshot();
        Self { inner: Arc::new(Inner { state: Mutex::new(state), runner, changed, persist, runtime }) }
    }

    /// A listener that emits `lab:queueChanged` with the snapshot.
    pub fn sink_listener(sink: SharedSink) -> QueueListener {
        Arc::new(move |snapshot| delulu_core::emit(sink.as_ref(), QUEUE_CHANGED, snapshot))
    }

    pub fn get(&self) -> ImportQueueSnapshot {
        self.inner.state.lock().snapshot()
    }

    pub fn has_active_job(&self) -> bool {
        self.inner
            .state
            .lock()
            .jobs
            .iter()
            .any(|job| matches!(job.state, ImportJobState::Running | ImportJobState::Cancelling))
    }

    pub fn replace(&self, jobs: Vec<ImportQueueJob>) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        require_open(&state)?;
        if state.active.is_some() {
            return Err(plain_error("Wait for the current import before replacing or relinking jobs"));
        }
        state.paused = true;
        state.jobs = jobs;
        self.inner.emit(&mut state)?;
        Ok(state.snapshot())
    }

    pub fn enqueue(&self, file: &AudioFileSelection) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        require_open(&state)?;
        if state.jobs.len() >= IMPORT_QUEUE_LIMIT {
            return Err(plain_error(format!(
                "The import queue is full ({IMPORT_QUEUE_LIMIT} jobs). Clear finished jobs first."
            )));
        }
        if delulu_domain::js::trim(&file.path).is_empty() || delulu_domain::js::trim(&file.name).is_empty() {
            return Err(plain_error("Invalid selected import file."));
        }
        if state.jobs.iter().any(|job| job.path == file.path) {
            return Err(plain_error("This source already has a job; retry or relink it instead"));
        }
        state.jobs.push(ImportQueueJob {
            id: uuid(),
            path: file.path.clone(),
            name: file.name.clone(),
            size: file.size,
            source_mtime_ms: file.source_mtime_ms,
            state: ImportJobState::Queued,
            error: None,
            transcript_id: None,
        });
        self.inner.emit(&mut state)?;
        Inner::pump(&self.inner, &mut state)?;
        Ok(state.snapshot())
    }

    pub fn set_paused(&self, paused: bool) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        require_open(&state)?;
        if state.paused != paused {
            state.paused = paused;
            self.inner.emit(&mut state)?;
        }
        Inner::pump(&self.inner, &mut state)?;
        Ok(state.snapshot())
    }

    /// Moves a queued job one place among the queued jobs (`direction` is -1 or 1).
    pub fn move_job(&self, id: &str, direction: i8) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        if state.closed || (direction != -1 && direction != 1) {
            return Ok(state.snapshot());
        }
        let queued: Vec<usize> =
            state.jobs.iter().enumerate().filter(|(_, job)| job.state == ImportJobState::Queued).map(|(i, _)| i).collect();
        let Some(position) = queued.iter().position(|&index| state.jobs[index].id == id) else {
            return Ok(state.snapshot());
        };
        let other = position as isize + isize::from(direction);
        if other < 0 || other as usize >= queued.len() {
            return Ok(state.snapshot());
        }
        state.jobs.swap(queued[position], queued[other as usize]);
        self.inner.emit(&mut state)?;
        Ok(state.snapshot())
    }

    pub fn cancel(&self, id: &str) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Ok(state.snapshot());
        };
        match state.jobs[index].state {
            ImportJobState::Queued => {
                state.jobs[index].state = ImportJobState::Cancelled;
                self.inner.emit(&mut state)?;
            }
            ImportJobState::Running => {
                if let Some((active, signal)) = state.active.clone() {
                    if active == id {
                        state.jobs[index].state = ImportJobState::Cancelling;
                        self.inner.emit(&mut state)?;
                        signal.abort();
                    }
                }
            }
            _ => {}
        }
        Ok(state.snapshot())
    }

    pub fn retry(&self, id: &str) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        require_open(&state)?;
        let Some(index) = state.jobs.iter().position(|job| job.id == id) else {
            return Ok(state.snapshot());
        };
        if state.active.as_ref().is_some_and(|(active, _)| active == id)
            || !matches!(state.jobs[index].state, ImportJobState::Failed | ImportJobState::Cancelled)
        {
            return Ok(state.snapshot());
        }
        let mut job = state.jobs.remove(index);
        job.state = ImportJobState::Queued;
        job.error = None;
        job.transcript_id = None;
        state.jobs.push(job);
        self.inner.emit(&mut state)?;
        Inner::pump(&self.inner, &mut state)?;
        Ok(state.snapshot())
    }

    pub fn clear_finished(&self) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        let before = state.jobs.len();
        state.jobs.retain(|job| {
            !matches!(job.state, ImportJobState::Completed | ImportJobState::Failed | ImportJobState::Cancelled)
        });
        if state.jobs.len() != before {
            self.inner.emit(&mut state)?;
        }
        Ok(state.snapshot())
    }

    /// Stops accepting work and cancels the running import.
    pub fn shutdown(&self) -> DomainResult<ImportQueueSnapshot> {
        let mut state = self.inner.state.lock();
        if state.closed {
            return Ok(state.snapshot());
        }
        state.closed = true;
        state.paused = true;
        for job in &mut state.jobs {
            if job.state == ImportJobState::Running {
                job.state = ImportJobState::Cancelling;
            }
        }
        let signal = state.active.as_ref().map(|(_, signal)| signal.clone());
        let result = self.inner.emit(&mut state);
        if let Some(signal) = signal {
            signal.abort();
        }
        result?;
        Ok(state.snapshot())
    }
}

fn require_open(state: &State) -> DomainResult<()> {
    if state.closed {
        return Err(plain_error("The import queue has shut down."));
    }
    Ok(())
}

impl Inner {
    fn emit(&self, state: &mut State) -> DomainResult<()> {
        state.version += 1;
        if let Some(persist) = &self.persist {
            if let Err(error) = persist(&state.snapshot()) {
                state.jobs = state.durable.jobs.clone();
                state.paused = true;
                return Err(error);
            }
        }
        state.durable = state.snapshot();
        // A detached subscriber cannot interrupt cancellation; it receives a clone.
        (self.changed)(&state.snapshot());
        Ok(())
    }

    fn pump(this: &Arc<Inner>, state: &mut State) -> DomainResult<()> {
        if state.closed || state.paused || state.active.is_some() {
            return Ok(());
        }
        let Some(index) = state.jobs.iter().position(|job| job.state == ImportJobState::Queued) else {
            return Ok(());
        };
        let signal = AbortSignal::new();
        let (id, path) = (state.jobs[index].id.clone(), state.jobs[index].path.clone());
        state.active = Some((id.clone(), signal.clone()));
        state.jobs[index].state = ImportJobState::Running;
        if let Err(error) = this.emit(state) {
            state.active = None;
            return Err(error);
        }
        let inner = this.clone();
        this.runtime.spawn(async move { inner.run(id, path, signal).await });
        Ok(())
    }

    async fn run(self: Arc<Self>, id: String, path: String, signal: AbortSignal) {
        // Cancellation in a synchronous subscriber can happen before invocation.
        let result = if signal.is_aborted() { None } else { Some((self.runner)(path, signal.clone()).await) };
        let mut state = self.state.lock();
        let aborted = signal.is_aborted();
        if let Some(job) = state.jobs.iter_mut().find(|job| job.id == id) {
            if aborted {
                job.state = ImportJobState::Cancelled;
                job.error = None;
                job.transcript_id = None;
            } else {
                match result {
                    Some(Ok(transcript)) if !transcript.is_empty() => {
                        job.state = ImportJobState::Completed;
                        job.transcript_id = Some(transcript);
                        job.error = None;
                    }
                    Some(outcome) => {
                        let message = match outcome {
                            Ok(_) => "The import runner returned no transcript identifier.".to_owned(),
                            Err(error) => error.message,
                        };
                        job.state = ImportJobState::Failed;
                        job.error = Some(truncate_utf16(&message, 500).to_owned());
                    }
                    None => {}
                }
            }
        }
        if !aborted && matches!(state.jobs.iter().find(|job| job.id == id).map(|j| j.state), Some(ImportJobState::Failed)) {
            state.paused = true;
        }
        // Release ownership only after the runner future settled.
        state.active = None;
        let outcome = self.emit(&mut state).and_then(|()| Inner::pump(&self, &mut state));
        if let Err(error) = outcome {
            fail_after_settle(&self, &mut state, &id, &error);
        }
    }
}

fn fail_after_settle(inner: &Inner, state: &mut State, id: &str, error: &DomainError) {
    state.paused = true;
    if let Some(job) = state.jobs.iter_mut().find(|job| job.id == id) {
        job.state = ImportJobState::Failed;
        job.error = Some(format!("Job metadata could not be saved. Check History before retrying: {}", error.message));
    }
    state.version += 1;
    (inner.changed)(&state.snapshot());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn file(path: &str) -> AudioFileSelection {
        AudioFileSelection { source_mtime_ms: None, path: path.into(), name: path.trim_start_matches('/').into(), size: 1 }
    }

    async fn settle(queue: &ImportQueue) {
        for _ in 0..200 {
            if !queue.has_active_job() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("queue did not settle");
    }

    #[tokio::test]
    async fn runs_jobs_one_at_a_time_and_cancels_the_active_one() {
        let snapshots = Arc::new(Mutex::new(Vec::<ImportQueueSnapshot>::new()));
        let recorded = snapshots.clone();
        let runner: ImportRunner = Arc::new(|path, signal| {
            Box::pin(async move {
                if path == "/slow.wav" {
                    signal.aborted().await;
                    return Err(plain_error("aborted"));
                }
                if path == "/bad.wav" {
                    return Err(plain_error("Unreadable audio"));
                }
                Ok(format!("t-{path}"))
            })
        });
        let queue = ImportQueue::new(
            tokio::runtime::Handle::current(),
            runner,
            Arc::new(move |snapshot| recorded.lock().push(snapshot.clone())),
            None,
            Vec::new(),
        );
        queue.enqueue(&file("/a.wav")).unwrap();
        queue.enqueue(&file("/b.wav")).unwrap();
        assert!(queue.enqueue(&file("/a.wav")).is_err());
        assert_eq!(queue.get().jobs[0].state, ImportJobState::Queued, "starts paused");
        queue.set_paused(false).unwrap();
        settle(&queue).await;
        let jobs = queue.get().jobs;
        assert_eq!(jobs.iter().map(|j| j.state).collect::<Vec<_>>(), [ImportJobState::Completed; 2]);
        assert_eq!(jobs[0].transcript_id.as_deref(), Some("t-/a.wav"));

        queue.enqueue(&file("/slow.wav")).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let slow = queue.get().jobs[2].clone();
        assert_eq!(slow.state, ImportJobState::Running);
        queue.cancel(&slow.id).unwrap();
        settle(&queue).await;
        assert_eq!(queue.get().jobs[2].state, ImportJobState::Cancelled);

        queue.enqueue(&file("/bad.wav")).unwrap();
        settle(&queue).await;
        let snapshot = queue.get();
        assert!(snapshot.paused, "a failure pauses the queue");
        assert_eq!(snapshot.jobs[3].error.as_deref(), Some("Unreadable audio"));
        let versions: Vec<u64> = snapshots.lock().iter().map(|s| s.version).collect();
        assert!(versions.windows(2).all(|w| w[0] < w[1]));
        queue.shutdown().unwrap();
        assert!(queue.enqueue(&file("/c.wav")).is_err());
    }

    #[tokio::test]
    async fn a_failed_persist_rolls_back_to_the_durable_snapshot() {
        let fail = Arc::new(AtomicBool::new(false));
        let failing = fail.clone();
        let runner: ImportRunner = Arc::new(|_, _| Box::pin(async { Ok("t".to_owned()) }));
        let queue = ImportQueue::new(
            tokio::runtime::Handle::current(),
            runner,
            Arc::new(|_| {}),
            Some(Arc::new(move |_| if failing.load(Ordering::SeqCst) { Err(plain_error("Disk full")) } else { Ok(()) })),
            Vec::new(),
        );
        queue.enqueue(&file("/a.wav")).unwrap();
        fail.store(true, Ordering::SeqCst);
        assert!(queue.enqueue(&file("/b.wav")).is_err());
        assert_eq!(queue.get().jobs.len(), 1);
    }
}
