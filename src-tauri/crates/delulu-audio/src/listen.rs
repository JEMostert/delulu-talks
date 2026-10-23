//! Microphone capture for listening sessions (`src/listenCapture.ts`). Unlike
//! dictation it runs across many conversational turns: the stream is
//! resampled to 16 kHz and fed to the utterance segmenter, which reports
//! onsets, barge-ins and finished utterances. Delulu's playback level is the
//! echo reference. The raw input level is reported for a level meter.
//!
//! There is no WebRTC echo canceller or noise suppressor here; the segmenter's
//! playback-reference echo gate and adaptive noise floor do that work alone.

use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use serde::{Deserialize, Serialize};

use crate::input::{Input, OpenError, OpenErrorKind};
use crate::player::Player;
use crate::resample::Resampler;
use crate::vad::{FrameContext, SegmenterConfig, SegmenterEvent, UtteranceSegmenter, SAMPLE_RATE};
use crate::wav::{wav, WAV_HEADER_BYTES};

/// Largest utterance WAV main accepts (`ipcRequests.ts`).
pub const MAX_UTTERANCE_WAV_BYTES: usize = 8 * 1024 * 1024;
const MAX_UTTERANCE_SAMPLES: usize = (MAX_UTTERANCE_WAV_BYTES - WAV_HEADER_BYTES) / 2;
const POLL: Duration = Duration::from_millis(10);
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(2);
const STALL_LIMIT: Duration = Duration::from_secs(3);
const DISCONNECTED: &str = "The microphone was disconnected. Start listening again.";
/// Input level reports per second, at most.
pub const LEVEL_RATE: u32 = 15;
const SILENT_DB: f64 = -100.0;

/// Capture tuning (the TypeScript `ListenCaptureConfig`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenConfig {
    pub device_id: String,
    /// 0 (only clear, loud speech) … 1 (picks up quiet speech).
    pub sensitivity: f64,
    /// Quiet pause that ends an utterance.
    pub silence_ms: u32,
    /// Sustained speech needed before an utterance starts.
    pub min_speech_ms: u32,
    /// Audio kept from before speech onset so first words are not clipped.
    pub pre_roll_ms: u32,
    /// Interrupt Delulu's speech when the user talks over it.
    pub barge_in: bool,
    /// Sustained speech over playback needed to interrupt.
    pub barge_in_ms: u32,
    pub max_utterance_ms: u32,
}

impl ListenConfig {
    fn segmenter(&self) -> SegmenterConfig {
        let max_ms = (MAX_UTTERANCE_SAMPLES as u64 * 1000 / SAMPLE_RATE as u64) as u32;
        SegmenterConfig {
            sensitivity: self.sensitivity,
            silence_ms: self.silence_ms,
            min_speech_ms: self.min_speech_ms,
            pre_roll_ms: self.pre_roll_ms,
            barge_in_ms: self.barge_in_ms,
            max_utterance_ms: self.max_utterance_ms.min(max_ms),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenState {
    Listening,
    Failed,
    Stopped,
}

/// What the capture reports (the TypeScript `ListenCaptureEvent` without the
/// session ID, which the callback receives separately).
#[derive(Debug, Clone, PartialEq)]
pub enum ListenEvent {
    State { state: ListenState, message: Option<String> },
    /// Sustained speech began; `during_playback` when Delulu was talking.
    SpeechStart { during_playback: bool },
    /// Sustained speech over playback; playback was already stopped.
    BargeIn { utterance_ids: Vec<String> },
    /// Speech-like sound that was too short to be an utterance.
    Discarded { reason: String },
    Utterance {
        /// 16 kHz mono 16-bit WAV including the pre-roll, at most 8 MiB.
        wav: Vec<u8>,
        duration_ms: u64,
        speech_ms: u32,
        /// Some of it was captured while Delulu was speaking.
        overlapped_playback: bool,
    },
    /// Raw microphone level in dBFS (RMS), at most [`LEVEL_RATE`] times a second.
    Level { db: f64 },
}

/// RMS level of the raw input over windows of `rate / LEVEL_RATE` samples.
pub(crate) struct LevelMeter {
    window: usize,
    sum: f64,
    count: usize,
}

impl LevelMeter {
    pub fn new(sample_rate: u32) -> Self {
        Self { window: (sample_rate / LEVEL_RATE).max(1) as usize, sum: 0.0, count: 0 }
    }

    /// Adds samples; returns the level once a full window was seen.
    pub fn push(&mut self, samples: &[f32]) -> Option<f64> {
        for sample in samples {
            self.sum += f64::from(*sample) * f64::from(*sample);
        }
        self.count += samples.len();
        if self.count < self.window {
            return None;
        }
        let rms = (self.sum / self.count as f64).sqrt();
        self.sum = 0.0;
        self.count = 0;
        let db = if rms > 0.0 { (20.0 * rms.log10()).max(SILENT_DB) } else { SILENT_DB };
        Some((db.min(0.0) * 10.0).round() / 10.0)
    }
}

/// What the listener needs from playback: the echo reference and barge-in.
pub trait PlaybackReference {
    fn is_playing(&self) -> bool;
    fn output_level_db(&self) -> f64;
    /// Stops all playback now and returns the utterances cut off.
    fn interrupt(&self) -> Vec<String>;
}

impl PlaybackReference for Player {
    fn is_playing(&self) -> bool {
        Player::is_playing(self)
    }
    fn output_level_db(&self) -> f64 {
        Player::output_level_db(self)
    }
    fn interrupt(&self) -> Vec<String> {
        Player::interrupt(self)
    }
}

/// Segmentation and event mapping, independent of the microphone.
pub(crate) struct Listener {
    config: ListenConfig,
    segmenter: UtteranceSegmenter,
    paused: bool,
}

impl Listener {
    pub fn new(config: ListenConfig) -> Self {
        Self { segmenter: UtteranceSegmenter::new(config.segmenter()), config, paused: false }
    }

    pub fn configure(&mut self, config: ListenConfig) {
        self.segmenter.configure(config.segmenter());
        self.config = config;
    }

    /// Dictation owns the microphone: drop any partial utterance and ignore audio.
    pub fn pause(&mut self) {
        self.paused = true;
        self.segmenter.reset();
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    /// A new microphone: start over with a fresh noise floor.
    pub fn restart(&mut self) {
        self.segmenter.reset();
    }

    /// Feeds 16 kHz samples.
    pub fn ingest(&mut self, samples: &[f32], player: Option<&dyn PlaybackReference>, events: &mut Vec<ListenEvent>) {
        if self.paused || samples.is_empty() {
            return;
        }
        let playing = player.is_some_and(|player| player.is_playing());
        let context = FrameContext {
            playing,
            playback_db: if playing { player.map_or(-120.0, |p| p.output_level_db()) } else { -120.0 },
        };
        for event in self.segmenter.push_samples(samples, context) {
            match event {
                SegmenterEvent::SpeechStart { during_playback } => events.push(ListenEvent::SpeechStart { during_playback }),
                SegmenterEvent::BargeIn => {
                    if !self.config.barge_in {
                        continue;
                    }
                    // Stop talking now; main learns which replies were cut off.
                    let utterance_ids = player.map(|player| player.interrupt()).unwrap_or_default();
                    events.push(ListenEvent::BargeIn { utterance_ids });
                }
                SegmenterEvent::Discarded { reason } => events.push(ListenEvent::Discarded { reason }),
                SegmenterEvent::Utterance { mut samples, speech_ms, overlapped_playback, .. } => {
                    samples.truncate(MAX_UTTERANCE_SAMPLES);
                    events.push(ListenEvent::Utterance {
                        duration_ms: (samples.len() as f64 * 1000.0 / SAMPLE_RATE as f64).round() as u64,
                        wav: wav(&samples, SAMPLE_RATE),
                        speech_ms,
                        overlapped_playback,
                    });
                }
            }
        }
    }
}

enum Command {
    Configure(ListenConfig),
    Pause,
    Resume,
    Stop,
    Shutdown,
}

pub type ListenCallback = Box<dyn Fn(&str, ListenEvent) + Send>;

/// A running listening capture. Dropping it releases the microphone without
/// a `stopped` event.
pub struct ListenCapture {
    session_id: String,
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

impl ListenCapture {
    /// Opens the microphone on its own thread; reports `State { Listening }`
    /// or `State { Failed }`. `on_event(session_id, event)` runs on that
    /// thread. `player` is the echo reference and is interrupted on barge-in.
    pub fn start(
        session_id: impl Into<String>,
        config: ListenConfig,
        player: Option<Player>,
        on_event: impl Fn(&str, ListenEvent) + Send + 'static,
    ) -> Self {
        let session_id = session_id.into();
        let (commands, receiver) = crossbeam_channel::unbounded();
        let id = session_id.clone();
        let callback: ListenCallback = Box::new(on_event);
        let thread = std::thread::Builder::new()
            .name("delulu-audio-listen".into())
            .spawn(move || run_listen(id, config, player, receiver, callback));
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(error) => {
                log::error!("could not start listening thread: {error}");
                None
            }
        };
        Self { session_id, commands, thread }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// New tuning; a different `device_id` reopens the microphone (or fails).
    pub fn configure(&self, config: ListenConfig) {
        let _ = self.commands.send(Command::Configure(config));
    }

    pub fn pause(&self) {
        let _ = self.commands.send(Command::Pause);
    }

    pub fn resume(&self) {
        let _ = self.commands.send(Command::Resume);
    }

    /// Stops capturing and reports `stopped`. An utterance in progress is dropped.
    pub fn stop(mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    /// Whether the capture thread has ended (stopped or failed).
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
}

impl Drop for ListenCapture {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

fn open_failure(error: &OpenError) -> String {
    match error.kind {
        OpenErrorKind::Denied => {
            "Microphone access was denied. Allow it in your system settings, then start listening again.".into()
        }
        OpenErrorKind::Missing | OpenErrorKind::NoDevice => {
            "The selected microphone is not available. Choose another input in Settings.".into()
        }
        OpenErrorKind::Busy => {
            "The microphone is busy or unavailable. Close other apps using it and try again.".into()
        }
        OpenErrorKind::Other => format!("Could not start listening: {}", error.message),
    }
}

fn run_listen(
    session_id: String,
    config: ListenConfig,
    player: Option<Player>,
    commands: Receiver<Command>,
    on_event: ListenCallback,
) {
    let emit = |event: ListenEvent| on_event(&session_id, event);
    let failed = |error: &OpenError| {
        emit(ListenEvent::State { state: ListenState::Failed, message: Some(open_failure(error)) });
    };
    let mut device_id = config.device_id.clone();
    let mut input = match Input::open(&device_id) {
        Ok(input) => input,
        Err(error) => return failed(&error),
    };
    let mut listener = Listener::new(config);
    let mut resampler = Resampler::new(input.sample_rate, SAMPLE_RATE);
    let mut level = LevelMeter::new(input.sample_rate);
    emit(ListenEvent::State { state: ListenState::Listening, message: None });
    let reference = player.as_ref().map(|player| player as &dyn PlaybackReference);
    let mut raw = Vec::new();
    let mut converted = Vec::new();
    let mut events = Vec::new();
    let mut last_check = Instant::now();
    loop {
        match commands.recv_timeout(POLL) {
            Ok(Command::Configure(config)) => {
                if config.device_id != device_id {
                    // Release the old stream first; some backends refuse a second open.
                    drop(input);
                    device_id = config.device_id.clone();
                    input = match Input::open(&device_id) {
                        Ok(input) => input,
                        Err(error) => return failed(&error),
                    };
                    resampler = Resampler::new(input.sample_rate, SAMPLE_RATE);
                    level = LevelMeter::new(input.sample_rate);
                    listener.restart();
                }
                listener.configure(config);
            }
            Ok(Command::Pause) => listener.pause(),
            Ok(Command::Resume) => {
                listener.resume();
                resampler = Resampler::new(input.sample_rate, SAMPLE_RATE);
            }
            Ok(Command::Stop) => {
                drop(input);
                emit(ListenEvent::State { state: ListenState::Stopped, message: None });
                return;
            }
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        raw.clear();
        input.drain(&mut raw);
        if !listener.paused && !raw.is_empty() {
            if let Some(db) = level.push(&raw) {
                emit(ListenEvent::Level { db });
            }
            converted.clear();
            resampler.process(&raw, &mut converted);
            listener.ingest(&converted, reference, &mut events);
            for event in events.drain(..) {
                emit(event);
            }
        }
        let mut gone = input.failure().is_some() || input.stalled_for() >= STALL_LIMIT;
        if !gone && last_check.elapsed() >= DEVICE_CHECK_INTERVAL {
            last_check = Instant::now();
            gone = input.present() == Some(false);
        }
        if gone {
            drop(input);
            emit(ListenEvent::State { state: ListenState::Failed, message: Some(DISCONNECTED.into()) });
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;
    use crate::vad::tests::question;

    struct FakePlayer {
        playing: Cell<bool>,
        interrupted: RefCell<Vec<Vec<String>>>,
    }

    impl PlaybackReference for FakePlayer {
        fn is_playing(&self) -> bool {
            self.playing.get()
        }
        fn output_level_db(&self) -> f64 {
            -60.0
        }
        fn interrupt(&self) -> Vec<String> {
            self.playing.set(false);
            self.interrupted.borrow_mut().push(vec!["reply-1".into()]);
            vec!["reply-1".into()]
        }
    }

    fn config(barge_in: bool) -> ListenConfig {
        ListenConfig {
            device_id: "default".into(),
            sensitivity: 0.5,
            silence_ms: 900,
            min_speech_ms: 200,
            pre_roll_ms: 500,
            barge_in,
            barge_in_ms: 300,
            max_utterance_ms: 60_000,
        }
    }

    fn feed(listener: &mut Listener, player: &FakePlayer) -> Vec<ListenEvent> {
        let question = question();
        let mut audio = vec![0.0f32; 16_000 + question.len() + 32_000];
        audio[16_000..16_000 + question.len()].copy_from_slice(&question);
        let mut events = vec![];
        for piece in audio.chunks(320) {
            listener.ingest(piece, Some(player), &mut events);
        }
        events
    }

    #[test]
    fn talking_over_playback_stops_the_player_at_once_and_reports_the_cut_off_reply() {
        let player = FakePlayer { playing: Cell::new(true), interrupted: RefCell::default() };
        let mut listener = Listener::new(config(true));
        let events = feed(&mut listener, &player);
        assert_eq!(player.interrupted.borrow().len(), 1);
        let barge_in = events.iter().position(|e| matches!(e, ListenEvent::BargeIn { .. })).expect("barge-in");
        let utterance = events.iter().position(|e| matches!(e, ListenEvent::Utterance { .. })).expect("utterance");
        // Playback stops before the transcript-bearing utterance exists.
        assert!(barge_in < utterance);
        assert_eq!(events[barge_in], ListenEvent::BargeIn { utterance_ids: vec!["reply-1".into()] });
        let ListenEvent::Utterance { wav, overlapped_playback, duration_ms, .. } = &events[utterance] else {
            unreachable!()
        };
        assert!(*overlapped_playback);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(*duration_ms as usize, (wav.len() - 44) / 32);
    }

    #[test]
    fn barge_in_off_never_interrupts_and_pause_drops_audio() {
        let player = FakePlayer { playing: Cell::new(true), interrupted: RefCell::default() };
        let mut listener = Listener::new(config(false));
        let events = feed(&mut listener, &player);
        assert!(player.interrupted.borrow().is_empty());
        assert!(!events.iter().any(|e| matches!(e, ListenEvent::BargeIn { .. })));
        assert!(events.iter().any(|e| matches!(e, ListenEvent::Utterance { .. })));
        let mut paused = Listener::new(config(true));
        paused.pause();
        assert!(feed(&mut paused, &player).is_empty());
    }

    #[test]
    fn the_level_meter_reports_dbfs_once_per_window() {
        let mut meter = LevelMeter::new(48_000);
        // 3200 samples per report at 48 kHz is 15 reports a second.
        assert_eq!(meter.push(&vec![0.5; 3_199]), None);
        assert_eq!(meter.push(&[0.5]), Some(-6.0));
        assert_eq!(meter.push(&vec![0.0; 3_200]), Some(SILENT_DB));
        assert_eq!(meter.push(&vec![1.0; 6_400]), Some(0.0));
    }

    #[test]
    fn config_uses_the_typescript_wire_shape() {
        let json = serde_json::to_value(config(true)).unwrap();
        assert_eq!(json["deviceId"], "default");
        assert_eq!(json["bargeInMs"], 300);
        let parsed: ListenConfig = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, config(true));
        let mut long = config(true);
        long.max_utterance_ms = 3_600_000;
        assert!(long.segmenter().max_utterance_ms as usize * 16 * 2 <= MAX_UTTERANCE_WAV_BYTES);
    }
}
