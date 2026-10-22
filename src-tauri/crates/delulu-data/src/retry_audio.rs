//! Session-memory audio of the last failed transcription (`retryAudio.ts`).
//!
//! Owns only in-memory audio, which is zeroed when released; callers own
//! any native inference file cleanup. `M` is caller metadata kept with the
//! recording (for example capture diagnostics).

use delulu_domain::{RetryAudioPhase, RetryAudioState};
use parking_lot::Mutex;
use zeroize::Zeroize;

#[derive(Debug, Clone)]
pub struct RetryRecording<M> {
    pub wav: Vec<u8>,
    pub duration_ms: f64,
    pub meta: M,
}

/// A retry in progress. `recording` is the caller's working copy; the store
/// zeroes its own copy when the lease finishes.
#[derive(Debug)]
pub struct RetryAudioLease<M> {
    id: u64,
    pub recording: RetryRecording<M>,
}

impl<M> Drop for RetryAudioLease<M> {
    fn drop(&mut self) {
        self.recording.wav.zeroize();
    }
}

struct Active<M> {
    id: u64,
    recording: RetryRecording<M>,
    discarded: bool,
}

struct State<M> {
    pending: Option<RetryRecording<M>>,
    active: Option<Active<M>>,
    discarded: bool,
    disposed: bool,
    next_id: u64,
}

pub struct RetryAudioStore<M> {
    state: Mutex<State<M>>,
}

impl<M: Clone> Default for RetryAudioStore<M> {
    fn default() -> Self {
        Self::new()
    }
}

fn wipe<M>(recording: &mut RetryRecording<M>) {
    recording.wav.zeroize();
    recording.wav = Vec::new();
}

impl<M: Clone> RetryAudioStore<M> {
    pub fn new() -> Self {
        Self { state: Mutex::new(State { pending: None, active: None, discarded: false, disposed: false, next_id: 0 }) }
    }

    pub fn available(&self) -> bool {
        self.state.lock().pending.is_some()
    }

    pub fn state(&self) -> RetryAudioState {
        let state = self.state.lock();
        let recording = state.active.as_ref().map(|a| &a.recording).or(state.pending.as_ref());
        RetryAudioState {
            phase: if state.active.is_some() {
                RetryAudioPhase::Retrying
            } else if state.pending.is_some() {
                RetryAudioPhase::Available
            } else {
                RetryAudioPhase::Empty
            },
            byte_length: recording.map_or(0, |r| r.wav.len() as u64),
            duration_ms: recording.map(|r| r.duration_ms),
            discarded: state.active.as_ref().map_or(state.discarded, |a| a.discarded),
            session_only: true,
        }
    }

    /// Keeps a copy of a failed recording for one retry. Returns false for
    /// empty or invalid audio, or after disposal.
    pub fn retain(&self, recording: RetryRecording<M>) -> bool {
        let mut state = self.state.lock();
        if state.disposed || recording.wav.is_empty() || !recording.duration_ms.is_finite() || recording.duration_ms < 0.0 {
            return false;
        }
        if let Some(mut old) = state.pending.take() {
            wipe(&mut old);
        }
        state.pending = Some(recording);
        state.discarded = false;
        true
    }

    pub fn begin_retry(&self) -> Option<RetryAudioLease<M>> {
        let mut state = self.state.lock();
        if state.disposed || state.active.is_some() {
            return None;
        }
        let recording = state.pending.take()?;
        state.next_id += 1;
        let id = state.next_id;
        let lease = RetryAudioLease { id, recording: recording.clone() };
        state.active = Some(Active { id, recording, discarded: false });
        Some(lease)
    }

    /// Whether the user discarded the audio while this lease was running.
    pub fn lease_discarded(&self, lease: &RetryAudioLease<M>) -> bool {
        self.state.lock().active.as_ref().is_some_and(|a| a.id == lease.id && a.discarded)
    }

    pub fn finish_retry(&self, lease: RetryAudioLease<M>, failed: bool) {
        let mut state = self.state.lock();
        if state.disposed || state.active.as_ref().is_none_or(|a| a.id != lease.id) {
            return;
        }
        let mut active = state.active.take().expect("active lease");
        if failed && !active.discarded && state.pending.is_none() {
            state.pending = Some(active.recording);
            state.discarded = false;
            return;
        }
        wipe(&mut active.recording);
        if state.pending.is_none() {
            state.discarded = active.discarded;
        }
    }

    pub fn clear_available(&self) {
        if let Some(mut pending) = self.state.lock().pending.take() {
            wipe(&mut pending);
        }
    }

    pub fn discard(&self) {
        let mut state = self.state.lock();
        if let Some(mut pending) = state.pending.take() {
            wipe(&mut pending);
        }
        if let Some(active) = state.active.as_mut() {
            active.discarded = true;
            wipe(&mut active.recording);
        }
        state.discarded = true;
    }

    pub fn dispose(&self) {
        self.discard();
        let mut state = self.state.lock();
        state.active = None;
        state.disposed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording() -> RetryRecording<()> {
        RetryRecording { wav: vec![1, 2, 3], duration_ms: 1000.0, meta: () }
    }

    #[test]
    fn failed_retry_keeps_audio_and_discard_wins() {
        let store = RetryAudioStore::new();
        assert!(store.retain(recording()));
        let lease = store.begin_retry().unwrap();
        assert_eq!(store.state().phase, RetryAudioPhase::Retrying);
        store.finish_retry(lease, true);
        assert_eq!(store.state().phase, RetryAudioPhase::Available);
        let lease = store.begin_retry().unwrap();
        store.discard();
        assert!(store.lease_discarded(&lease));
        store.finish_retry(lease, true);
        let state = store.state();
        assert_eq!((state.phase, state.discarded), (RetryAudioPhase::Empty, true));
        assert!(!store.retain(RetryRecording { wav: vec![], duration_ms: 1.0, meta: () }));
    }
}
