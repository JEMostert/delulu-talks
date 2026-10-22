//! Dictation capture (`src/recorder.ts`, `src/captureInput.ts`): one capture
//! at a time on a dedicated thread that owns the microphone stream.
//!
//! Limit, trailing-silence and lost-input stops only stop accepting audio and
//! report an event; the dictation service then calls [`Recorder::stop`] (as
//! the Electron main process did) to receive the retained audio.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use delulu_core::{DomainError, DomainResult};
use parking_lot::Mutex;

use crate::capture_stats::{
    audible_level, rms, CaptureDiagnostics, CaptureStats, TrailingSilenceStop, MAX_CAPTURE_DURATION_MS,
    MAX_CAPTURE_SAMPLES, TOO_SHORT,
};
use crate::cues::{Cue, Cues};
use crate::devices;
use crate::input::Input;
use crate::resample::Resampler;
use crate::wav::{wav, SPEECH_SAMPLE_RATE};

/// Samples per analysis block, like the capture worklet's messages.
const BLOCK_SAMPLES: usize = 2048;
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
const POLL: Duration = Duration::from_millis(10);
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_millis(1500);
/// No audio for this long means the input is gone.
const STALL_LIMIT: Duration = Duration::from_secs(3);
const PAUSE_ACK_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrailingSilence {
    pub seconds: f64,
    pub threshold_db: f64,
}

#[derive(Debug, Clone)]
pub struct RecorderOptions {
    /// Identifies the capture in events and commands.
    pub session_id: String,
    /// `default` or a device ID from [`crate::inputs`].
    pub device_id: String,
    pub trailing_silence: Option<TrailingSilence>,
    /// Wall-clock limit; `None` (or anything longer) means 10 minutes.
    pub max_duration: Option<Duration>,
    /// Start/stop cue volume (0–1); `None` when capture sounds are muted.
    pub cue_volume: Option<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecorderEvent {
    /// The microphone is open (`recorder:started`).
    Started,
    /// Meter level 0–1, about 20 Hz (`recorder:level`).
    Level(f32),
    /// Trailing-silence countdown; `stop` asks the service to stop.
    Silence { remaining_seconds: Option<u32>, stop: bool },
    /// The 10-minute or sample cap was reached; call `stop`.
    LimitReached,
    /// `input_lost`: capture stopped accepting audio; call `stop` to keep it.
    InputChanged { message: String, input_lost: bool },
    /// The capture could not start or broke down; nothing to stop.
    Failed(String),
    PauseChanged(bool),
}

/// A finished capture: 16 kHz mono 16-bit PCM WAV.
#[derive(Debug, Clone)]
pub struct Recording {
    pub session_id: String,
    pub wav: Vec<u8>,
    /// Retained audio, excluding paused time.
    pub duration_ms: u64,
    pub diagnostics: CaptureDiagnostics,
    /// From the stop request until the microphone was released.
    pub capture_end_ms: f64,
    /// Resampling and encoding.
    pub preprocessing_ms: f64,
}

pub type RecorderCallback = Arc<dyn Fn(&str, RecorderEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Limit,
    Silence,
    InputLost,
}

/// Capture bookkeeping, independent of the device so it can be tested.
pub(crate) struct CaptureSession {
    sample_rate: u32,
    sample_limit: u64,
    stats: CaptureStats,
    chunks: Vec<Vec<f32>>,
    current: Vec<f32>,
    block: Vec<f32>,
    silence: Option<TrailingSilenceStop>,
    last_countdown: Option<u32>,
    paused: bool,
    stop_reason: Option<StopReason>,
    last_level_at: Option<Instant>,
}

impl CaptureSession {
    pub fn new(sample_rate: u32, trailing_silence: Option<TrailingSilence>, max_duration: Duration) -> Self {
        let max_ms = (max_duration.as_millis() as u64).min(MAX_CAPTURE_DURATION_MS);
        Self {
            sample_rate,
            sample_limit: MAX_CAPTURE_SAMPLES.min(sample_rate as u64 * max_ms / 1000),
            stats: CaptureStats::default(),
            chunks: Vec::new(),
            current: Vec::with_capacity(sample_rate as usize),
            block: Vec::with_capacity(BLOCK_SAMPLES),
            silence: trailing_silence.map(|t| TrailingSilenceStop::new(t.seconds, t.threshold_db)),
            last_countdown: None,
            paused: false,
            stop_reason: None,
            last_level_at: None,
        }
    }

    pub fn ingest(&mut self, mut samples: &[f32], now: Instant, events: &mut Vec<RecorderEvent>) {
        if self.paused || self.stop_reason.is_some() {
            return;
        }
        while !samples.is_empty() {
            let take = (BLOCK_SAMPLES - self.block.len()).min(samples.len());
            self.block.extend_from_slice(&samples[..take]);
            samples = &samples[take..];
            if self.block.len() == BLOCK_SAMPLES {
                self.process_block(now, events);
            }
        }
    }

    /// Processes a partial block (pause or stop boundary).
    pub fn flush(&mut self, now: Instant, events: &mut Vec<RecorderEvent>) {
        if !self.block.is_empty() {
            self.process_block(now, events);
        }
    }

    fn process_block(&mut self, now: Instant, events: &mut Vec<RecorderEvent>) {
        let block = std::mem::replace(&mut self.block, Vec::with_capacity(BLOCK_SAMPLES));
        if self.stop_reason.is_some() {
            return;
        }
        let accepted = (block.len() as u64).min(self.sample_limit.saturating_sub(self.stats.sample_count)) as usize;
        if accepted == 0 {
            return;
        }
        let samples = &block[..accepted];
        self.retain(samples);
        if self.stats.sample_count >= self.sample_limit {
            self.request_stop(StopReason::Limit, events);
        }
        if self.stop_reason.is_none() {
            if let Some(silence) = self.silence.as_mut() {
                let update = silence.update(samples, self.sample_rate as f64);
                if update.should_stop {
                    self.request_stop(StopReason::Silence, events);
                } else if update.remaining_seconds != self.last_countdown {
                    self.last_countdown = update.remaining_seconds;
                    events.push(RecorderEvent::Silence { remaining_seconds: update.remaining_seconds, stop: false });
                }
            }
        }
        if self.last_level_at.is_none_or(|at| now.duration_since(at) >= LEVEL_INTERVAL) {
            self.last_level_at = Some(now);
            events.push(RecorderEvent::Level(audible_level(rms(samples))));
        }
    }

    fn retain(&mut self, samples: &[f32]) {
        self.stats.add(samples);
        let mut rest = samples;
        while !rest.is_empty() {
            let room = self.current.capacity().max(1) - self.current.len();
            if room == 0 {
                let full = std::mem::replace(&mut self.current, Vec::with_capacity(self.sample_rate.max(1) as usize));
                self.chunks.push(full);
                continue;
            }
            let take = room.min(rest.len());
            self.current.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
    }

    fn request_stop(&mut self, reason: StopReason, events: &mut Vec<RecorderEvent>) {
        if self.stop_reason.is_some() {
            return;
        }
        self.stop_reason = Some(reason);
        events.push(match reason {
            StopReason::Silence => RecorderEvent::Silence { remaining_seconds: Some(0), stop: true },
            StopReason::Limit => RecorderEvent::LimitReached,
            StopReason::InputLost => return,
        });
    }

    pub fn set_paused(&mut self, paused: bool, now: Instant, events: &mut Vec<RecorderEvent>) -> bool {
        if self.paused == paused || self.stop_reason.is_some() {
            return false;
        }
        if paused {
            // Everything captured before the pause is kept.
            self.flush(now, events);
        }
        self.paused = paused;
        if let Some(silence) = self.silence.as_mut() {
            silence.reset();
        }
        self.last_countdown = None;
        events.push(RecorderEvent::Silence { remaining_seconds: None, stop: false });
        events.push(RecorderEvent::Level(0.0));
        events.push(RecorderEvent::PauseChanged(paused));
        true
    }

    fn into_audio(mut self) -> (Vec<Vec<f32>>, CaptureStats, u32) {
        if !self.current.is_empty() {
            self.chunks.push(std::mem::take(&mut self.current));
        }
        (self.chunks, self.stats, self.sample_rate)
    }
}

enum Command {
    Pause(bool, Sender<()>),
    Stop(Sender<Captured>),
    Cancel,
}

struct Captured {
    chunks: Vec<Vec<f32>>,
    stats: CaptureStats,
    sample_rate: u32,
    capturing_for: Duration,
    released_at: Instant,
}

struct Active {
    session_id: String,
    commands: Sender<Command>,
    cancelled: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    /// A stopped capture still being encoded, so cancel can reach it.
    encoding: Option<(String, Arc<AtomicBool>)>,
}

/// Thread-safe dictation recorder; clones share one recorder.
#[derive(Clone)]
pub struct Recorder {
    inner: Arc<RecorderInner>,
}

struct RecorderInner {
    on_event: RecorderCallback,
    cues: Cues,
    state: Mutex<State>,
}

impl Recorder {
    /// `on_event(session_id, event)` runs on the capture thread; keep it quick.
    pub fn new(on_event: impl Fn(&str, RecorderEvent) + Send + Sync + 'static) -> Self {
        Self { inner: Arc::new(RecorderInner { on_event: Arc::new(on_event), cues: Cues::new(), state: Mutex::default() }) }
    }

    /// The cue player used for start/stop tones (also for `audio:testCue`).
    pub fn cues(&self) -> &Cues {
        &self.inner.cues
    }

    /// The capture currently owning the microphone.
    pub fn active_session(&self) -> Option<String> {
        let state = self.inner.state.lock();
        state.active.as_ref().filter(|a| !a.thread.is_finished()).map(|a| a.session_id.clone())
    }

    /// Opens the microphone on a capture thread and returns at once; the
    /// thread reports `Started` or `Failed`.
    pub fn start(&self, options: RecorderOptions) -> DomainResult<()> {
        let mut state = self.inner.state.lock();
        if state.active.as_ref().is_some_and(|active| !active.thread.is_finished()) {
            return Err(DomainError::busy("A recording is already in progress"));
        }
        let (commands, receiver) = crossbeam_channel::unbounded();
        let cancelled = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        let context = CaptureContext {
            session_id: options.session_id.clone(),
            on_event: self.inner.on_event.clone(),
            cancelled: cancelled.clone(),
            failure: failure.clone(),
            cues: self.inner.cues.clone(),
        };
        let session_id = options.session_id.clone();
        let thread = std::thread::Builder::new()
            .name("delulu-audio-recorder".into())
            .spawn(move || run_capture(options, receiver, context))
            .map_err(|error| DomainError::failed(format!("Microphone unavailable: {error}")))?;
        state.active = Some(Active { session_id, commands, cancelled, failure, thread });
        Ok(())
    }

    pub fn pause(&self, session_id: &str) -> DomainResult<()> {
        self.change_pause(session_id, true)
    }

    pub fn resume(&self, session_id: &str) -> DomainResult<()> {
        self.change_pause(session_id, false)
    }

    fn change_pause(&self, session_id: &str, paused: bool) -> DomainResult<()> {
        let commands = self.commands_for(session_id)?;
        let (reply, acknowledged) = crossbeam_channel::bounded(1);
        commands.send(Command::Pause(paused, reply)).map_err(|_| not_recording())?;
        acknowledged
            .recv_timeout(PAUSE_ACK_TIMEOUT)
            .map_err(|_| DomainError::failed("Pause/resume acknowledgement timed out"))
    }

    fn commands_for(&self, session_id: &str) -> DomainResult<Sender<Command>> {
        let state = self.inner.state.lock();
        state
            .active
            .as_ref()
            .filter(|active| active.session_id == session_id)
            .map(|active| active.commands.clone())
            .ok_or_else(not_recording)
    }

    /// Releases the microphone and encodes the retained audio (blocking; run
    /// it off async executors). A capture that recorded nothing fails with a
    /// message starting with [`TOO_SHORT`] (a tap) or a no-audio message.
    pub fn stop(&self, session_id: &str) -> DomainResult<Recording> {
        let requested_at = Instant::now();
        let active = {
            let mut state = self.inner.state.lock();
            if state.active.as_ref().is_none_or(|active| active.session_id != session_id) {
                return Err(not_recording());
            }
            let active = state.active.take().expect("active capture");
            state.encoding = Some((active.session_id.clone(), active.cancelled.clone()));
            active
        };
        let result = self.finish(active, requested_at);
        let mut state = self.inner.state.lock();
        if state.encoding.as_ref().is_some_and(|(id, _)| id == session_id) {
            state.encoding = None;
        }
        result
    }

    fn finish(&self, active: Active, requested_at: Instant) -> DomainResult<Recording> {
        let failed = |active: &Active| {
            if active.cancelled.load(Ordering::Acquire) {
                return DomainError::cancelled("Recording cancelled");
            }
            let message = active.failure.lock().clone();
            DomainError::failed(message.unwrap_or_else(|| "The recording did not finish. Please dictate again.".into()))
        };
        let (reply, captured) = crossbeam_channel::bounded(1);
        if active.commands.send(Command::Stop(reply)).is_err() {
            return Err(failed(&active));
        }
        let captured = captured.recv_timeout(STOP_TIMEOUT).map_err(|_| failed(&active))?;
        let capture_end_ms = captured.released_at.duration_since(requested_at).as_secs_f64() * 1000.0;
        let Some(diagnostics) = captured.stats.diagnostics(captured.sample_rate) else {
            let message = if captured.capturing_for < Duration::from_millis(600) {
                format!("{TOO_SHORT} — nothing was recorded.")
            } else {
                "The microphone did not produce audio. Try another input.".to_owned()
            };
            return Err(DomainError::failed(message));
        };
        let encoding_started = Instant::now();
        let duration_ms = (diagnostics.sample_count as f64 / captured.sample_rate as f64 * 1000.0).round() as u64;
        let wav = encode(captured.chunks, captured.sample_rate, &active.cancelled)
            .ok_or_else(|| DomainError::cancelled("Recording cancelled"))?;
        Ok(Recording {
            session_id: active.session_id,
            wav,
            duration_ms,
            diagnostics,
            capture_end_ms,
            preprocessing_ms: encoding_started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Discards the capture (or the encoding in progress) without a result.
    /// `None` cancels whatever is active.
    pub fn cancel(&self, session_id: Option<&str>) {
        let matches = |id: &str| session_id.is_none_or(|wanted| wanted == id);
        let mut state = self.inner.state.lock();
        if state.active.as_ref().is_some_and(|active| matches(&active.session_id)) {
            let active = state.active.take().expect("active capture");
            active.cancelled.store(true, Ordering::Release);
            let _ = active.commands.send(Command::Cancel);
        }
        if state.encoding.as_ref().is_some_and(|(id, _)| matches(id)) {
            if let Some((_, cancelled)) = state.encoding.take() {
                cancelled.store(true, Ordering::Release);
            }
        }
        drop(state);
        self.inner.cues.cancel();
    }
}

fn not_recording() -> DomainError {
    DomainError::invalid("No matching recording is in progress")
}

/// Resamples to 16 kHz and encodes, checking for cancellation between chunks.
fn encode(chunks: Vec<Vec<f32>>, sample_rate: u32, cancelled: &AtomicBool) -> Option<Vec<u8>> {
    let total: usize = chunks.iter().map(Vec::len).sum();
    let mut resampler = Resampler::new(sample_rate, SPEECH_SAMPLE_RATE);
    let mut output = Vec::with_capacity(total * SPEECH_SAMPLE_RATE as usize / sample_rate.max(1) as usize + 1);
    for chunk in chunks {
        if cancelled.load(Ordering::Acquire) {
            return None;
        }
        resampler.process(&chunk, &mut output);
    }
    resampler.finish(&mut output);
    if cancelled.load(Ordering::Acquire) {
        return None;
    }
    Some(wav(&output, SPEECH_SAMPLE_RATE))
}

struct CaptureContext {
    session_id: String,
    on_event: RecorderCallback,
    cancelled: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
    cues: Cues,
}

impl CaptureContext {
    fn emit(&self, event: RecorderEvent) {
        if !self.cancelled.load(Ordering::Acquire) {
            (self.on_event)(&self.session_id, event);
        }
    }

    fn emit_all(&self, events: &mut Vec<RecorderEvent>) {
        for event in events.drain(..) {
            self.emit(event);
        }
    }
}

fn run_capture(options: RecorderOptions, commands: Receiver<Command>, context: CaptureContext) {
    let mut input = match Input::open(&options.device_id) {
        Ok(input) => input,
        Err(error) => {
            let message = format!("Microphone unavailable: {}", error.message);
            *context.failure.lock() = Some(message.clone());
            context.emit(RecorderEvent::Failed(message));
            return;
        }
    };
    if context.cancelled.load(Ordering::Acquire) {
        return;
    }
    let max_duration = options
        .max_duration
        .unwrap_or(Duration::from_millis(MAX_CAPTURE_DURATION_MS))
        .min(Duration::from_millis(MAX_CAPTURE_DURATION_MS));
    let mut session = CaptureSession::new(input.sample_rate, options.trailing_silence, max_duration);
    let label = input.label.clone();
    let started_at = Instant::now();
    context.emit(RecorderEvent::Started);
    if let Some(volume) = options.cue_volume {
        context.cues.play(Cue::Start, volume);
    }
    let mut events = Vec::new();
    let mut buffer = Vec::new();
    let mut lost = false;
    let mut last_default = input.initial_default.clone();
    let mut last_check = Instant::now();

    loop {
        match commands.recv_timeout(POLL) {
            Ok(Command::Pause(paused, reply)) => {
                buffer.clear();
                input.drain(&mut buffer);
                let now = Instant::now();
                session.ingest(&buffer, now, &mut events);
                session.set_paused(paused, now, &mut events);
                context.emit_all(&mut events);
                let _ = reply.send(());
                continue;
            }
            Ok(Command::Stop(reply)) => {
                buffer.clear();
                input.drain(&mut buffer);
                let now = Instant::now();
                session.ingest(&buffer, now, &mut events);
                session.flush(now, &mut events);
                let dropped = input.dropped_samples();
                if dropped > 0 {
                    log::warn!("capture dropped {dropped} samples while the recorder thread was busy");
                }
                drop(input);
                events.clear();
                if let Some(volume) = options.cue_volume {
                    context.cues.play(Cue::Stop, volume);
                }
                let capturing_for = started_at.elapsed();
                let (chunks, stats, sample_rate) = session.into_audio();
                let _ = reply.send(Captured { chunks, stats, sample_rate, capturing_for, released_at: Instant::now() });
                return;
            }
            Ok(Command::Cancel) | Err(RecvTimeoutError::Disconnected) => {
                context.cues.cancel();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        buffer.clear();
        input.drain(&mut buffer);
        let now = Instant::now();
        session.ingest(&buffer, now, &mut events);
        if started_at.elapsed() >= max_duration {
            session.request_stop(StopReason::Limit, &mut events);
        }
        context.emit_all(&mut events);

        if lost || session.stop_reason.is_some() {
            continue;
        }
        let mut gone = input.failure().is_some() || input.stalled_for() >= STALL_LIMIT;
        if !gone && last_check.elapsed() >= DEVICE_CHECK_INTERVAL {
            last_check = Instant::now();
            gone = input.present() == Some(false);
            if !gone && input.uses_default {
                // Unknown identity is not evidence of a change.
                if let Some(current) = devices::default_device_id(devices::Direction::Input) {
                    if last_default.as_ref().is_some_and(|previous| *previous != current) {
                        context.emit(RecorderEvent::InputChanged {
                            message: format!("The system default microphone changed. Recording continues with {label}; the new default applies to the next recording."),
                            input_lost: false,
                        });
                    }
                    last_default = Some(current);
                }
            }
        }
        if gone {
            lost = true;
            session.request_stop(StopReason::InputLost, &mut events);
            context.emit(RecorderEvent::InputChanged {
                message: format!("The recording microphone ({label}) is no longer available. Capture stopped; audio already recorded is being kept for transcription. Reconnect it or choose another input."),
                input_lost: true,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(silence: Option<TrailingSilence>, limit: Duration) -> CaptureSession {
        CaptureSession::new(48_000, silence, limit)
    }

    #[test]
    fn blocks_feed_levels_diagnostics_and_retained_audio() {
        let mut session = session(None, Duration::from_secs(600));
        let mut events = vec![];
        let start = Instant::now();
        session.ingest(&vec![0.1; 3000], start, &mut events);
        // One full 2048-sample block so far; the rest waits for the next block.
        assert_eq!(events, vec![RecorderEvent::Level(audible_level(0.1f32 as f64))]);
        session.ingest(&vec![0.1; 2000], start + Duration::from_millis(10), &mut events);
        assert_eq!(events.len(), 1, "levels are throttled to 50 ms");
        session.flush(start + Duration::from_millis(100), &mut events);
        assert_eq!(events.len(), 2);
        let (chunks, stats, rate) = session.into_audio();
        assert_eq!(rate, 48_000);
        assert_eq!(chunks.iter().map(Vec::len).sum::<usize>(), 5000);
        assert_eq!(stats.diagnostics(rate).unwrap().sample_count, 5000);
    }

    #[test]
    fn the_sample_cap_stops_once_and_truncates() {
        let mut session = session(None, Duration::from_millis(100));
        let mut events = vec![];
        let now = Instant::now();
        session.ingest(&vec![0.0; 10_000], now, &mut events);
        assert!(events.contains(&RecorderEvent::LimitReached));
        session.ingest(&vec![0.0; 10_000], now, &mut events);
        assert_eq!(events.iter().filter(|e| **e == RecorderEvent::LimitReached).count(), 1);
        let (_, stats, _) = session.into_audio();
        assert_eq!(stats.sample_count, 4800);
    }

    #[test]
    fn trailing_silence_counts_down_then_requests_stop() {
        let mut session = session(Some(TrailingSilence { seconds: 2.0, threshold_db: -45.0 }), Duration::from_secs(600));
        let mut events = vec![];
        let now = Instant::now();
        session.ingest(&vec![0.2; 48_000 / 4], now, &mut events);
        session.ingest(&vec![0.0; 48_000 * 3], now, &mut events);
        let silence: Vec<_> = events.iter().filter(|e| matches!(e, RecorderEvent::Silence { .. })).cloned().collect();
        assert_eq!(
            silence,
            vec![
                RecorderEvent::Silence { remaining_seconds: Some(2), stop: false },
                RecorderEvent::Silence { remaining_seconds: Some(1), stop: false },
                RecorderEvent::Silence { remaining_seconds: Some(0), stop: true },
            ]
        );
        // Audio after the stop request is not retained.
        let (_, stats, _) = session.into_audio();
        assert!(stats.sample_count < 48_000 / 4 + 48_000 * 2 + 2048 * 2);
    }

    #[test]
    fn pausing_keeps_earlier_audio_resets_silence_and_ignores_paused_audio() {
        let mut session = session(Some(TrailingSilence { seconds: 5.0, threshold_db: -45.0 }), Duration::from_secs(600));
        let mut events = vec![];
        let now = Instant::now();
        session.ingest(&vec![0.2; 1000], now, &mut events);
        assert!(session.set_paused(true, now, &mut events));
        assert!(!session.set_paused(true, now, &mut events));
        assert_eq!(
            events[events.len() - 3..],
            [
                RecorderEvent::Silence { remaining_seconds: None, stop: false },
                RecorderEvent::Level(0.0),
                RecorderEvent::PauseChanged(true)
            ]
        );
        session.ingest(&vec![0.2; 5000], now, &mut events);
        assert!(session.set_paused(false, now, &mut events));
        assert_eq!(events.last(), Some(&RecorderEvent::PauseChanged(false)));
        let (_, stats, _) = session.into_audio();
        assert_eq!(stats.sample_count, 1000);
    }

    #[test]
    fn encoding_produces_16_khz_wav_and_honours_cancellation() {
        let chunks = vec![vec![0.0f32; 48_000], vec![0.0; 24_000]];
        let bytes = encode(chunks.clone(), 48_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(bytes.len(), 44 + 24_000 * 2);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
        assert!(encode(chunks, 48_000, &AtomicBool::new(true)).is_none());
    }
}
