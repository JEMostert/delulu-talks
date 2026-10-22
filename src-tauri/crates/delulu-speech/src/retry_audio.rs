//! Session-memory audio of a failed dictation (`retryAudio.ts`). Owns only
//! memory; callers own the temporary inference files.

use delulu_domain::{CaptureDiagnostics, PipelineTimings, RetryAudioPhase, RetryAudioState};

/// Audio handed to the pipeline (the old `RecordingSubmission`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Submission {
    pub wav: Vec<u8>,
    pub duration_ms: f64,
    pub timings: Option<PipelineTimings>,
    pub capture_diagnostics: Option<CaptureDiagnostics>,
}

struct Lease {
    id: u64,
    recording: Submission,
    discarded: bool,
}

#[derive(Default)]
pub struct RetryAudioStore {
    pending: Option<Submission>,
    active: Option<Lease>,
    discarded: bool,
    disposed: bool,
    next_lease: u64,
}

fn wipe(recording: &mut Submission) {
    recording.wav.fill(0);
    recording.wav = Vec::new();
}

impl RetryAudioStore {
    pub fn available(&self) -> bool {
        self.pending.is_some()
    }

    pub fn state(&self) -> RetryAudioState {
        let recording = self
            .active
            .as_ref()
            .map(|lease| &lease.recording)
            .or(self.pending.as_ref());
        RetryAudioState {
            phase: if self.active.is_some() {
                RetryAudioPhase::Retrying
            } else if self.pending.is_some() {
                RetryAudioPhase::Available
            } else {
                RetryAudioPhase::Empty
            },
            byte_length: recording.map_or(0, |r| r.wav.len() as u64),
            duration_ms: recording.map(|r| r.duration_ms),
            discarded: self
                .active
                .as_ref()
                .map_or(self.discarded, |lease| lease.discarded),
            session_only: true,
        }
    }

    /// Keeps an owned copy for retry.
    pub fn retain(&mut self, recording: &Submission) -> bool {
        if self.disposed
            || recording.wav.is_empty()
            || !recording.duration_ms.is_finite()
            || recording.duration_ms < 0.0
        {
            return false;
        }
        self.clear_available();
        self.pending = Some(recording.clone());
        self.discarded = false;
        true
    }

    /// Moves the pending recording into a retry; returns the lease id and audio.
    pub fn begin_retry(&mut self) -> Option<(u64, Submission)> {
        if self.disposed || self.active.is_some() {
            return None;
        }
        let recording = self.pending.take()?;
        self.next_lease += 1;
        let id = self.next_lease;
        self.active = Some(Lease {
            id,
            recording: recording.clone(),
            discarded: false,
        });
        Some((id, recording))
    }

    pub fn finish_retry(&mut self, lease: u64, failed: bool) {
        if self.disposed || self.active.as_ref().is_none_or(|active| active.id != lease) {
            return;
        }
        let mut active = self.active.take().expect("active lease");
        if failed && !active.discarded && self.pending.is_none() {
            self.pending = Some(active.recording);
            self.discarded = false;
            return;
        }
        wipe(&mut active.recording);
        if self.pending.is_none() {
            self.discarded = active.discarded;
        }
    }

    pub fn clear_available(&mut self) {
        if let Some(mut pending) = self.pending.take() {
            wipe(&mut pending);
        }
    }

    pub fn discard(&mut self) {
        self.clear_available();
        if let Some(active) = self.active.as_mut() {
            active.discarded = true;
            wipe(&mut active.recording);
        }
        self.discarded = true;
    }

    pub fn dispose(&mut self) {
        self.discard();
        self.active = None;
        self.disposed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio() -> Submission {
        Submission {
            wav: vec![9; 64],
            duration_ms: 1200.0,
            ..Submission::default()
        }
    }

    #[test]
    fn a_failed_retry_keeps_audio_unless_discarded_meanwhile() {
        let mut store = RetryAudioStore::default();
        assert!(store.retain(&audio()));
        let (lease, recording) = store.begin_retry().unwrap();
        assert_eq!(recording.wav, vec![9; 64]);
        assert_eq!(store.state().phase, RetryAudioPhase::Retrying);
        store.finish_retry(lease, true);
        assert!(store.available());
        let (lease, _) = store.begin_retry().unwrap();
        store.discard();
        store.finish_retry(lease, true);
        assert!(!store.available());
        assert!(store.state().discarded);
        store.dispose();
        assert!(!store.retain(&audio()));
    }
}
