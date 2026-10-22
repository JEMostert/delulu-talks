//! A failed operation cannot poison later work (`serialQueue.ts`).
//!
//! Operations run one at a time in the order [`SerialQueue::run`] was
//! *called* (a ticket is taken eagerly, like the TypeScript promise chain), and
//! `busy` counts queued plus running work. Dropping a queued or running future
//! releases its turn, so cancellation cannot stall the queue either.

use std::collections::BTreeSet;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Notify;

#[derive(Default)]
struct Turns {
    next: u64,
    serving: u64,
    abandoned: BTreeSet<u64>,
}

#[derive(Default)]
struct Shared {
    turns: Mutex<Turns>,
    notify: Notify,
    count: AtomicUsize,
}

#[derive(Clone, Default)]
pub struct SerialQueue {
    shared: Arc<Shared>,
}

struct Ticket {
    shared: Arc<Shared>,
    number: u64,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut turns = self.shared.turns.lock();
        if turns.serving == self.number {
            turns.serving += 1;
            loop {
                let next = turns.serving;
                if !turns.abandoned.remove(&next) {
                    break;
                }
                turns.serving += 1;
            }
        } else {
            turns.abandoned.insert(self.number);
        }
        drop(turns);
        self.shared.count.fetch_sub(1, Ordering::SeqCst);
        self.shared.notify.notify_waiters();
    }
}

impl SerialQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queued or running operations exist.
    pub fn busy(&self) -> bool {
        self.shared.count.load(Ordering::SeqCst) > 0
    }

    /// Queues `operation`; its future starts only after earlier work settles.
    pub fn run<F, Fut, T>(&self, operation: F) -> impl Future<Output = T> + Send + 'static
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let shared = self.shared.clone();
        shared.count.fetch_add(1, Ordering::SeqCst);
        let number = {
            let mut turns = shared.turns.lock();
            turns.next += 1;
            turns.next - 1
        };
        let ticket = Ticket { shared, number };
        async move {
            loop {
                let notified = ticket.shared.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if ticket.shared.turns.lock().serving == ticket.number {
                    break;
                }
                notified.await;
            }
            let result = operation().await;
            drop(ticket);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn operations_stay_ordered_after_a_rejection_and_release_busy_state() {
        let queue = SerialQueue::new();
        let calls = Arc::new(Mutex::new(Vec::<&str>::new()));
        let (release, gate) = oneshot::channel::<()>();
        let log = calls.clone();
        let failed = queue.run(move || async move {
            log.lock().push("load");
            let _ = gate.await;
            Err::<&str, &str>("Load failed")
        });
        let log = calls.clone();
        let retry = queue.run(move || async move {
            log.lock().push("retry");
            Ok::<&str, &str>("ready")
        });
        // Poll the retry first: call order, not poll order, decides.
        let retry = tokio::spawn(retry);
        let failed = tokio::spawn(failed);
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(*calls.lock(), vec!["load"]);
        assert!(queue.busy());
        release.send(()).unwrap();
        assert_eq!(failed.await.unwrap(), Err("Load failed"));
        assert_eq!(retry.await.unwrap(), Ok("ready"));
        assert_eq!(*calls.lock(), vec!["load", "retry"]);
        assert!(!queue.busy());
    }

    #[tokio::test]
    async fn dropped_operations_release_their_turn() {
        let queue = SerialQueue::new();
        let first = queue.run(std::future::pending::<()>);
        let second = queue.run(|| async { 2 });
        let third = queue.run(|| async { 3 });
        drop(second);
        let first = tokio::spawn(first);
        tokio::task::yield_now().await;
        first.abort();
        assert_eq!(third.await, 3);
        assert!(!queue.busy());
    }
}
