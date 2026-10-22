//! Start/stop capture tones (`src/captureCues.ts`). Optional feedback:
//! recording never depends on cue playback, and failures are ignored.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;

use crate::devices::DEFAULT_DEVICE_ID;
use crate::output::Output;

const DURATION_SECONDS: f64 = 0.12;
const MAX_GAIN: f64 = 0.08;
/// A blocked device must not retain resources.
const DEADLINE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    Start,
    Stop,
}

/// The cue as mono samples: a 120 ms sine sweeping 520→780 Hz (start) or
/// 780→520 Hz (stop) exponentially, with a 15 ms attack and 35 ms release.
pub fn cue_samples(cue: Cue, volume: f32, sample_rate: u32) -> Vec<f32> {
    let level = if volume.is_finite() { volume.clamp(0.0, 1.0) as f64 } else { 0.0 };
    let (from, to) = match cue {
        Cue::Start => (520.0f64, 780.0f64),
        Cue::Stop => (780.0, 520.0),
    };
    let rate = sample_rate.max(1) as f64;
    let count = (DURATION_SECONDS * rate).round() as usize;
    let growth = (to / from).ln();
    let peak = MAX_GAIN * level;
    (0..count)
        .map(|index| {
            let t = index as f64 / rate;
            // Phase of f(t) = from * (to/from)^(t/T), integrated.
            let phase = 2.0 * std::f64::consts::PI * from * DURATION_SECONDS / growth
                * ((growth * t / DURATION_SECONDS).exp() - 1.0);
            let gain = if t < 0.015 {
                peak * t / 0.015
            } else if t < DURATION_SECONDS - 0.035 {
                peak
            } else {
                peak * ((DURATION_SECONDS - t) / 0.035).max(0.0)
            };
            (phase.sin() * gain) as f32
        })
        .collect()
}

enum Command {
    Play(Cue, f32),
    Cancel,
}

/// Plays cues on the default output from its own thread. A new cue cancels
/// the one still playing. Cheap to clone.
#[derive(Clone)]
pub struct Cues {
    inner: Arc<CuesInner>,
}

struct CuesInner {
    commands: Mutex<Option<Sender<Command>>>,
}

impl Default for Cues {
    fn default() -> Self {
        Self::new()
    }
}

impl Cues {
    pub fn new() -> Self {
        Self { inner: Arc::new(CuesInner { commands: Mutex::new(None) }) }
    }

    /// Plays `cue` at `volume` (0–1); 0 plays nothing but still cancels.
    pub fn play(&self, cue: Cue, volume: f32) {
        self.send(Command::Play(cue, volume));
    }

    pub fn cancel(&self) {
        let commands = self.inner.commands.lock();
        if let Some(sender) = commands.as_ref() {
            let _ = sender.send(Command::Cancel);
        }
    }

    fn send(&self, command: Command) {
        let mut commands = self.inner.commands.lock();
        if commands.is_none() {
            let (sender, receiver) = crossbeam_channel::unbounded();
            if std::thread::Builder::new().name("delulu-audio-cues".into()).spawn(move || run(receiver)).is_err() {
                return;
            }
            *commands = Some(sender);
        }
        if let Some(sender) = commands.as_ref() {
            let _ = sender.send(command);
        }
    }
}

fn run(commands: Receiver<Command>) {
    let mut next = None;
    loop {
        let command = match next.take() {
            Some(command) => command,
            None => match commands.recv() {
                Ok(command) => command,
                Err(_) => return,
            },
        };
        let Command::Play(cue, volume) = command else { continue };
        if !(volume.is_finite() && volume > 0.0) {
            continue;
        }
        let done = Arc::new(AtomicBool::new(false));
        let samples: Arc<Mutex<Option<Vec<f32>>>> = Arc::new(Mutex::new(None));
        let position = Arc::new(AtomicUsize::new(0));
        let render = {
            let (done, samples, position) = (done.clone(), samples.clone(), position.clone());
            move |out: &mut [f32]| {
                let Some(guard) = samples.try_lock() else {
                    out.fill(0.0);
                    return;
                };
                let Some(audio) = guard.as_ref() else {
                    out.fill(0.0);
                    return;
                };
                let start = position.load(Ordering::Relaxed);
                for (index, slot) in out.iter_mut().enumerate() {
                    *slot = audio.get(start + index).copied().unwrap_or(0.0);
                }
                let end = (start + out.len()).min(audio.len());
                position.store(end, Ordering::Relaxed);
                if end >= audio.len() {
                    done.store(true, Ordering::Release);
                }
            }
        };
        let output = match Output::open(DEFAULT_DEVICE_ID, None, render) {
            Ok(output) => output,
            Err(error) => {
                log::debug!("capture cue unavailable: {}", error.message);
                continue;
            }
        };
        *samples.lock() = Some(cue_samples(cue, volume, output.sample_rate));
        let started = Instant::now();
        // Let the device drain the tail before closing.
        let mut drained_at: Option<Instant> = None;
        while started.elapsed() < DEADLINE {
            match commands.recv_timeout(Duration::from_millis(10)) {
                Ok(command) => {
                    next = Some(command);
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if output.failure().is_some() {
                break;
            }
            if done.load(Ordering::Acquire) {
                let at = *drained_at.get_or_insert_with(Instant::now);
                if at.elapsed() >= Duration::from_millis(150) {
                    break;
                }
            }
        }
        if matches!(next, Some(Command::Cancel)) {
            next = None;
        }
        output.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cues_are_short_quiet_sweeps() {
        let start = cue_samples(Cue::Start, 1.0, 48_000);
        assert_eq!(start.len(), 5760);
        let peak = start.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
        assert!(peak <= 0.08 + 1e-6 && peak > 0.07);
        assert_eq!(start[0], 0.0);
        assert!(start.last().unwrap().abs() < 1e-3);
        // Zero crossings: ~650 Hz average over 120 ms is ~156 crossings.
        let crossings = start.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!((140..170).contains(&crossings), "{crossings}");
        let half = cue_samples(Cue::Stop, 0.5, 48_000);
        let peak = half.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
        assert!(peak <= 0.04 + 1e-6);
        assert!(cue_samples(Cue::Start, f32::NAN, 48_000).iter().all(|s| *s == 0.0));
    }
}
