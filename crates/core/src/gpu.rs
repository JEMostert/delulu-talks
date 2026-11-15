//! First GPU lease model: one holder at a time, priority classes, and
//! preemption requests (architecture §3.8).
//!
//! This is policy only. The daemon asks for a lease before a worker issues GPU
//! work, and acts on the returned [`LeaseEvent`]s: it starts work on `Granted`
//! and tells the holder to pause or unload on `PreemptRequested`. The holder
//! yields by releasing its lease. VRAM admission and timeouts come later (D1).

/// Priority classes, highest first. `Dictation` must never wait behind a lower class
/// without a preemption request going out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    /// P0: speech-to-text and the cleanup lane.
    Dictation,
    /// P1: an open voice conversation.
    Conversation,
    /// P2: spoken agent reports.
    Reports,
    /// P3: radio writing, music and the radio host voice.
    Radio,
}

impl Priority {
    pub const ALL: [Priority; 4] = [
        Priority::Dictation,
        Priority::Conversation,
        Priority::Reports,
        Priority::Radio,
    ];
    pub fn outranks(self, other: Priority) -> bool {
        self < other
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LeaseId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub id: LeaseId,
    pub priority: Priority,
    /// Who asked, for logs and the UI ("stt", "radio music", …).
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseEvent {
    /// `id` now holds the GPU.
    Granted { id: LeaseId },
    /// The holder should yield (pause, checkpoint, release) because `by` outranks it.
    /// Sent at most once per holder.
    PreemptRequested { holder: LeaseId, by: LeaseId },
}

#[derive(Debug, Default)]
pub struct GpuLeases {
    next: u64,
    holder: Option<Lease>,
    /// Waiting leases in arrival order.
    waiting: Vec<Lease>,
    /// The holder a preemption request already went out for.
    preempting: Option<LeaseId>,
}

impl GpuLeases {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn holder(&self) -> Option<&Lease> {
        self.holder.as_ref()
    }
    /// Waiting leases in the order they will be granted.
    pub fn waiting(&self) -> Vec<&Lease> {
        let mut waiting: Vec<_> = self.waiting.iter().collect();
        waiting.sort_by_key(|l| (l.priority, l.id));
        waiting
    }
    /// The holder has been asked to yield.
    pub fn preempting(&self) -> Option<LeaseId> {
        self.preempting
    }

    /// Asks for the GPU. The lease is granted at once when the GPU is free;
    /// otherwise it waits, and a preemption request goes out when it outranks the holder.
    pub fn request(
        &mut self,
        priority: Priority,
        label: impl Into<String>,
    ) -> (LeaseId, Vec<LeaseEvent>) {
        self.next += 1;
        let id = LeaseId(self.next);
        let lease = Lease {
            id,
            priority,
            label: label.into(),
        };
        let mut events = Vec::new();
        match &self.holder {
            None => {
                self.holder = Some(lease);
                events.push(LeaseEvent::Granted { id });
            }
            Some(holder) => {
                let holder_id = holder.id;
                let outranks = priority.outranks(holder.priority);
                self.waiting.push(lease);
                if outranks && self.preempting != Some(holder_id) {
                    self.preempting = Some(holder_id);
                    events.push(LeaseEvent::PreemptRequested {
                        holder: holder_id,
                        by: id,
                    });
                }
            }
        }
        (id, events)
    }

    /// Gives a lease back: the holder finished or yielded, or a waiter gave up.
    /// Unknown ids are ignored, so a double release is harmless.
    pub fn release(&mut self, id: LeaseId) -> Vec<LeaseEvent> {
        if self.holder.as_ref().is_some_and(|h| h.id == id) {
            self.holder = None;
            self.preempting = None;
            return self.grant_next();
        }
        self.waiting.retain(|l| l.id != id);
        Vec::new()
    }

    fn grant_next(&mut self) -> Vec<LeaseEvent> {
        let Some(index) = self
            .waiting
            .iter()
            .enumerate()
            .min_by_key(|(_, l)| (l.priority, l.id))
            .map(|(i, _)| i)
        else {
            return Vec::new();
        };
        let lease = self.waiting.remove(index);
        let id = lease.id;
        self.holder = Some(lease);
        // The best waiter was granted, so nobody left outranks the new holder.
        vec![LeaseEvent::Granted { id }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn free_gpu_is_granted_at_once() {
        let mut gpu = GpuLeases::new();
        let (id, events) = gpu.request(Priority::Radio, "music");
        assert_eq!(events, [LeaseEvent::Granted { id }]);
        assert_eq!(gpu.holder().map(|l| l.id), Some(id));
    }

    #[test]
    fn dictation_preempts_radio_once_and_goes_first() {
        let mut gpu = GpuLeases::new();
        let (radio, _) = gpu.request(Priority::Radio, "music");
        let (report, events) = gpu.request(Priority::Reports, "tts");
        // A report outranks radio too, so it asks first.
        assert_eq!(
            events,
            [LeaseEvent::PreemptRequested {
                holder: radio,
                by: report
            }]
        );
        let (stt, events) = gpu.request(Priority::Dictation, "stt");
        assert!(events.is_empty(), "one request per holder");
        assert_eq!(gpu.preempting(), Some(radio));
        // Radio yields; dictation jumps the earlier report.
        assert_eq!(gpu.release(radio), [LeaseEvent::Granted { id: stt }]);
        assert_eq!(gpu.release(stt), [LeaseEvent::Granted { id: report }]);
    }

    #[test]
    fn equal_or_lower_classes_wait_without_preempting() {
        let mut gpu = GpuLeases::new();
        let (a, _) = gpu.request(Priority::Conversation, "chat");
        let (_, e1) = gpu.request(Priority::Conversation, "chat 2");
        let (_, e2) = gpu.request(Priority::Radio, "music");
        assert!(e1.is_empty() && e2.is_empty());
        assert_eq!(gpu.preempting(), None);
        assert_eq!(gpu.holder().map(|l| l.id), Some(a));
    }

    #[test]
    fn a_waiter_can_withdraw_and_double_release_is_harmless() {
        let mut gpu = GpuLeases::new();
        let (a, _) = gpu.request(Priority::Radio, "a");
        let (b, _) = gpu.request(Priority::Radio, "b");
        let (c, _) = gpu.request(Priority::Radio, "c");
        assert!(gpu.release(b).is_empty());
        assert_eq!(gpu.release(a), [LeaseEvent::Granted { id: c }]);
        assert!(gpu.release(a).is_empty());
        assert_eq!(gpu.holder().map(|l| l.id), Some(c));
    }

    #[test]
    fn a_new_holder_gets_its_own_preemption_request() {
        let mut gpu = GpuLeases::new();
        let (radio, _) = gpu.request(Priority::Radio, "music");
        let (report, _) = gpu.request(Priority::Reports, "tts");
        gpu.release(radio);
        let (stt, events) = gpu.request(Priority::Dictation, "stt");
        assert_eq!(
            events,
            [LeaseEvent::PreemptRequested {
                holder: report,
                by: stt
            }]
        );
    }

    /// Random request/release sequences: at most one holder, no idle GPU with
    /// waiters, grants in priority-then-arrival order, every lease granted at most
    /// once, and a holder outranked by a waiter always has a preemption request out.
    #[test]
    fn random_sequences_keep_invariants() {
        for seed in 0..500 {
            let mut rng = Rng::new(seed);
            let mut gpu = GpuLeases::new();
            let mut priority: HashMap<LeaseId, Priority> = HashMap::new();
            let mut granted: HashSet<LeaseId> = HashSet::new();
            let mut asked_to_yield: HashSet<LeaseId> = HashSet::new();
            let mut ids: Vec<LeaseId> = Vec::new();
            for _ in 0..300 {
                let waiting_before: Vec<(Priority, LeaseId)> =
                    gpu.waiting().iter().map(|l| (l.priority, l.id)).collect();
                let events = if ids.is_empty() || rng.below(2) == 0 {
                    let p = Priority::ALL[rng.below(4) as usize];
                    let (id, events) = gpu.request(p, "x");
                    priority.insert(id, p);
                    ids.push(id);
                    events
                } else if rng.below(4) == 0 {
                    // A release of an id that may be unknown or already gone.
                    gpu.release(LeaseId(rng.below(gpu.next + 2)))
                } else {
                    let index = rng.below(ids.len() as u64) as usize;
                    gpu.release(ids[index])
                };
                for event in &events {
                    match event {
                        LeaseEvent::Granted { id } => {
                            assert!(granted.insert(*id), "seed {seed}: granted twice");
                            assert_eq!(gpu.holder().map(|l| l.id), Some(*id));
                            // A new request is granted only on a free GPU; otherwise the
                            // grant goes to the best waiting lease.
                            match waiting_before.first() {
                                None => {}
                                Some(best) => {
                                    assert_eq!(best.1, *id, "seed {seed}: grant out of order")
                                }
                            }
                        }
                        LeaseEvent::PreemptRequested { holder, by } => {
                            assert_eq!(gpu.holder().map(|l| l.id), Some(*holder));
                            assert!(priority[by].outranks(priority[holder]));
                            assert!(
                                asked_to_yield.insert(*holder),
                                "seed {seed}: second preemption request"
                            );
                        }
                    }
                }
                match gpu.holder() {
                    None => assert!(gpu.waiting().is_empty(), "seed {seed}: idle with waiters"),
                    Some(holder) => {
                        assert!(gpu.waiting().iter().all(|l| l.id != holder.id));
                        if gpu
                            .waiting()
                            .iter()
                            .any(|l| l.priority.outranks(holder.priority))
                        {
                            assert!(
                                asked_to_yield.contains(&holder.id),
                                "seed {seed}: outranked holder never asked to yield"
                            );
                        }
                    }
                }
            }
        }
    }
}
