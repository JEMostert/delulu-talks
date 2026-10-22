//! Voice activity detection and utterance segmentation for listening sessions,
//! ported from `src/voiceActivity.ts`. Deterministic: it consumes 20 ms frames
//! of 16 kHz mono audio and reports when an utterance starts, when the user
//! talks over Delulu's own speech, and when an utterance is complete.
//!
//! A frame counts as speech when its speech-band (150–4000 Hz) energy clears
//! an adaptive noise floor by a sensitivity-dependent margin and most of its
//! energy lies in that band. While Delulu is playing, it must also clear an
//! estimate of the echo: the playback level plus a learned speaker-to-mic
//! coupling plus a safety margin.

use std::collections::VecDeque;

pub const SAMPLE_RATE: u32 = 16_000;
pub const FRAME_MS: u32 = 20;
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE * FRAME_MS / 1000) as usize;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmenterConfig {
    /// 0 hears only clear, loud speech; 1 also quiet speech.
    pub sensitivity: f64,
    pub silence_ms: u32,
    pub min_speech_ms: u32,
    pub pre_roll_ms: u32,
    pub barge_in_ms: u32,
    pub max_utterance_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameContext {
    /// Delulu is playing speech right now.
    pub playing: bool,
    /// Playback output level in dBFS (−120 when silent).
    pub playback_db: f64,
}

impl FrameContext {
    pub const SILENT: FrameContext = FrameContext { playing: false, playback_db: -120.0 };
}

#[derive(Debug, Clone, PartialEq)]
pub enum SegmenterEvent {
    SpeechStart { during_playback: bool },
    BargeIn,
    Utterance {
        samples: Vec<f32>,
        speech_ms: u32,
        overlapped_playback: bool,
        /// Absolute sample index of the first sample.
        start_sample: u64,
    },
    Discarded { reason: String },
}

/// Voiced audio an utterance needs; shorter sounds are dropped.
const MIN_VOICED_MS: u32 = 250;
/// Non-speech frames tolerated inside an onset run.
const ONSET_GAP_FRAMES: u32 = 3;
/// Treat the room as echoing for this long after playback stops.
const PLAYBACK_TAIL_FRAMES: u64 = 15;
/// Playback level is compared with the loudest of recent frames (echo delay).
const PLAYBACK_HISTORY_FRAMES: usize = 8;
const ECHO_MARGIN_DB: f64 = 6.0;
/// Until learned, assume echo arrives 6 dB below the output.
const INITIAL_COUPLING_DB: f64 = -6.0;
/// Opening frames of each reply used to calibrate the echo estimate (1.5 s).
const COUPLING_WINDOW_FRAMES: u32 = 75;
/// Calibration frames needed before the estimate replaces the cautious default.
const COUPLING_MIN_FRAMES: usize = 25;
/// Silence kept after the last word of an utterance.
const TRAILING_MS: u32 = 200;
/// Fraction of frame energy that must be in the speech band.
const MIN_BAND_RATIO: f64 = 0.15;

#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    /// RBJ cookbook high- or low-pass section.
    fn new(low: bool, frequency: f64) -> Self {
        let w = 2.0 * std::f64::consts::PI * frequency / SAMPLE_RATE as f64;
        let alpha = w.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        let b1 = if low { 1.0 - cos } else { -(1.0 + cos) };
        let b0 = if low { (1.0 - cos) / 2.0 } else { (1.0 + cos) / 2.0 };
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b0 / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn filter(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

fn db(energy: f64) -> f64 {
    10.0 * (energy + 1e-12).log10()
}

struct Active {
    frames: Vec<Vec<f32>>,
    start_frame: u64,
    speech_frames: u32,
    silence_frames: u32,
    last_speech_length: usize,
    overlapped: bool,
}

pub struct UtteranceSegmenter {
    config: SegmenterConfig,
    high: Biquad,
    low: Biquad,
    floor_db: Option<f64>,
    coupling_db: f64,
    echo_observations: VecDeque<f64>,
    playback_frames: u32,
    playback_history: VecDeque<f64>,
    frames_since_playing: u64,
    frame_index: u64,
    /// Recent frames for pre-roll; oldest first.
    ring: VecDeque<Vec<f32>>,
    ring_capacity: usize,
    /// Onset candidate (`run_start < 0` when none).
    run_start: i64,
    run_speech: u32,
    run_gap: u32,
    run_during_playback: bool,
    active: Option<Active>,
    pending: Vec<f32>,
}

impl UtteranceSegmenter {
    pub fn new(config: SegmenterConfig) -> Self {
        let mut segmenter = Self {
            config,
            high: Biquad::new(false, 150.0),
            low: Biquad::new(true, 4000.0),
            floor_db: None,
            coupling_db: INITIAL_COUPLING_DB,
            echo_observations: VecDeque::new(),
            playback_frames: 0,
            playback_history: VecDeque::new(),
            frames_since_playing: u64::MAX / 2,
            frame_index: 0,
            ring: VecDeque::new(),
            ring_capacity: 0,
            run_start: -1,
            run_speech: 0,
            run_gap: 0,
            run_during_playback: false,
            active: None,
            pending: Vec::with_capacity(FRAME_SAMPLES),
        };
        segmenter.resize();
        segmenter
    }

    pub fn configure(&mut self, config: SegmenterConfig) {
        self.config = config;
        self.resize();
    }

    fn resize(&mut self) {
        let span = self.config.pre_roll_ms + self.config.min_speech_ms.max(self.config.barge_in_ms);
        self.ring_capacity = span.div_ceil(FRAME_MS) as usize + 10;
        while self.ring.len() > self.ring_capacity {
            self.ring.pop_front();
        }
    }

    pub fn speaking(&self) -> bool {
        self.active.is_some()
    }

    /// Drops any partial utterance, e.g. while dictation owns the microphone.
    pub fn reset(&mut self) {
        self.active = None;
        self.run_start = -1;
        self.run_speech = 0;
        self.run_gap = 0;
        self.ring.clear();
    }

    /// Feeds any number of samples; they are split into 20 ms frames.
    pub fn push_samples(&mut self, samples: &[f32], context: FrameContext) -> Vec<SegmenterEvent> {
        let mut events = Vec::new();
        let mut offset = 0;
        while offset < samples.len() {
            let take = (FRAME_SAMPLES - self.pending.len()).min(samples.len() - offset);
            self.pending.extend_from_slice(&samples[offset..offset + take]);
            offset += take;
            if self.pending.len() == FRAME_SAMPLES {
                let frame = std::mem::replace(&mut self.pending, Vec::with_capacity(FRAME_SAMPLES));
                events.extend(self.push(frame, context));
            }
        }
        events
    }

    /// Feeds exactly one 20 ms frame.
    pub fn push(&mut self, frame: Vec<f32>, context: FrameContext) -> Vec<SegmenterEvent> {
        let mut events = Vec::new();
        let index = self.frame_index;
        self.frame_index += 1;

        let mut total = 0.0;
        let mut band = 0.0;
        for &sample in &frame {
            let x = sample as f64;
            total += x * x;
            let y = self.low.filter(self.high.filter(x));
            band += y * y;
        }
        total /= frame.len() as f64;
        band /= frame.len() as f64;
        let band_db = db(band);
        let ratio = band / (total + 1e-12);

        // Playback awareness, including the echo tail after it stops.
        if context.playing {
            // A new reply after a quiet spell recalibrates the echo estimate.
            if self.frames_since_playing > PLAYBACK_TAIL_FRAMES {
                self.playback_frames = 0;
                self.echo_observations.clear();
            }
            self.frames_since_playing = 0;
            self.playback_frames += 1;
        } else {
            self.frames_since_playing += 1;
        }
        let echoing = self.frames_since_playing <= PLAYBACK_TAIL_FRAMES;
        self.playback_history.push_back(if context.playing { context.playback_db } else { -120.0 });
        if self.playback_history.len() > PLAYBACK_HISTORY_FRAMES {
            self.playback_history.pop_front();
        }
        let playback_db = self.playback_history.iter().copied().fold(f64::NEG_INFINITY, f64::max);

        let sensitivity = self.config.sensitivity.clamp(0.0, 1.0);
        let threshold_db = 18.0 - 12.0 * sensitivity;
        let absolute_db = -50.0 - 15.0 * sensitivity;
        let floor_db = *self.floor_db.get_or_insert(band_db.max(-90.0));
        // Hysteresis: once speaking, quieter word endings still count.
        let relax = if self.active.is_some() { 3.0 } else { 0.0 };
        let mut speech =
            band_db > floor_db + threshold_db - relax && band_db > absolute_db - relax && ratio > MIN_BAND_RATIO;

        let mut echo_gated = false;
        if echoing && playback_db > -90.0 {
            let echo_db = playback_db + self.coupling_db;
            let clears = band_db > echo_db + ECHO_MARGIN_DB;
            if !clears && self.active.is_none() && self.run_start < 0 && self.playback_frames <= COUPLING_WINDOW_FRAMES
            {
                // Calibrate on the first moments of each reply, when the user is
                // almost always listening: the loudest echo relative to playback.
                // Later frames never raise it, so the user's voice cannot teach
                // the detector to ignore the user.
                self.echo_observations.push_back(band_db - playback_db);
                if self.echo_observations.len() > COUPLING_WINDOW_FRAMES as usize {
                    self.echo_observations.pop_front();
                }
                if self.echo_observations.len() >= COUPLING_MIN_FRAMES {
                    // A high percentile, not the maximum: a single loud echo frame
                    // would otherwise make the user inaudible over the whole reply.
                    let mut sorted: Vec<f64> = self.echo_observations.iter().copied().collect();
                    sorted.sort_by(|a, b| a.total_cmp(b));
                    self.coupling_db = sorted[(sorted.len() as f64 * 0.8).floor() as usize];
                }
            }
            echo_gated = !clears;
            speech = speech && clears;
        }

        // The noise floor rises slowly (1 dB/s) and falls quickly; never from
        // speech or from frames dominated by Delulu's own playback.
        if !speech && self.active.is_none() && !(echoing && echo_gated) {
            let floor = self.floor_db.as_mut().expect("floor initialized");
            if band_db < *floor {
                *floor = (*floor + (band_db - *floor) / 2.0).max(-90.0);
            } else {
                *floor = band_db.min(*floor + 0.02);
            }
        }

        self.ring.push_back(frame.clone());
        if self.ring.len() > self.ring_capacity {
            self.ring.pop_front();
        }

        if let Some(active) = self.active.as_mut() {
            active.frames.push(frame);
            if echoing {
                active.overlapped = true;
            }
            if speech {
                active.speech_frames += 1;
                active.silence_frames = 0;
                active.last_speech_length = active.frames.len();
            } else {
                active.silence_frames += 1;
            }
            let duration_ms = active.frames.len() as u32 * FRAME_MS;
            if active.silence_frames * FRAME_MS >= self.config.silence_ms || duration_ms >= self.config.max_utterance_ms
            {
                events.push(self.finish());
            }
            return events;
        }

        // Looking for an onset.
        if speech {
            if self.run_start < 0 {
                self.run_start = index as i64;
                self.run_speech = 0;
                self.run_during_playback = echoing;
            }
            if echoing {
                self.run_during_playback = true;
            }
            self.run_speech += 1;
            self.run_gap = 0;
        } else if self.run_start >= 0 {
            self.run_gap += 1;
            if self.run_gap > ONSET_GAP_FRAMES {
                self.run_start = -1;
                self.run_speech = 0;
                self.run_gap = 0;
            }
        }
        let needed = if self.run_during_playback { self.config.barge_in_ms } else { self.config.min_speech_ms };
        if self.run_start >= 0 && self.run_speech * FRAME_MS >= needed {
            let pre_roll_frames = self.config.pre_roll_ms.div_ceil(FRAME_MS) as i64;
            let first = (self.run_start - pre_roll_frames).max(index as i64 - self.ring.len() as i64 + 1);
            let count = (index as i64 - first + 1) as usize;
            let frames: Vec<Vec<f32>> = self.ring.iter().skip(self.ring.len() - count).cloned().collect();
            let length = frames.len();
            self.active = Some(Active {
                frames,
                start_frame: first as u64,
                speech_frames: self.run_speech,
                silence_frames: 0,
                last_speech_length: length,
                overlapped: echoing || self.run_during_playback,
            });
            let during_playback = self.run_during_playback;
            self.run_start = -1;
            self.run_speech = 0;
            self.run_gap = 0;
            events.push(SegmenterEvent::SpeechStart { during_playback });
            if during_playback {
                events.push(SegmenterEvent::BargeIn);
            }
        }
        events
    }

    /// Finalizes the active utterance now (session stop, forced end).
    pub fn flush(&mut self) -> Vec<SegmenterEvent> {
        if self.active.is_some() {
            vec![self.finish()]
        } else {
            vec![]
        }
    }

    fn finish(&mut self) -> SegmenterEvent {
        let active = self.active.take().expect("active utterance");
        let speech_ms = active.speech_frames * FRAME_MS;
        if speech_ms < MIN_VOICED_MS {
            return SegmenterEvent::Discarded { reason: format!("Only {speech_ms} ms of speech") };
        }
        let keep = active.frames.len().min(active.last_speech_length + TRAILING_MS.div_ceil(FRAME_MS) as usize);
        let mut samples = Vec::with_capacity(keep * FRAME_SAMPLES);
        for frame in &active.frames[..keep] {
            samples.extend_from_slice(frame);
        }
        SegmenterEvent::Utterance {
            samples,
            speech_ms,
            overlapped_playback: active.overlapped,
            start_sample: active.start_frame * FRAME_SAMPLES as u64,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::wav::wav_samples;

    // Speech fixtures were synthesized with the local Kokoro voice model: the
    // "user" is am_michael, Delulu is af_heart. Each starts at its first word.
    pub(crate) fn question() -> Vec<f32> {
        wav_samples(include_bytes!("../tests/fixtures/user-question.wav"))
    }
    fn followup() -> Vec<f32> {
        wav_samples(include_bytes!("../tests/fixtures/user-followup.wav"))
    }
    fn reply() -> Vec<f32> {
        wav_samples(include_bytes!("../tests/fixtures/delulu-reply.wav"))
    }

    pub(crate) const CONFIG: SegmenterConfig = SegmenterConfig {
        sensitivity: 0.5,
        silence_ms: 900,
        min_speech_ms: 200,
        pre_roll_ms: 500,
        barge_in_ms: 300,
        max_utterance_ms: 60_000,
    };

    pub(crate) fn ms(value: f64) -> usize {
        (value * SAMPLE_RATE as f64 / 1000.0).round() as usize
    }

    /// Seeded low-level room noise, about −60 dBFS.
    pub(crate) fn noise(length: usize) -> Vec<f32> {
        let mut state: u64 = 7;
        (0..length)
            .map(|_| {
                state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
                ((state as f64 / 2_147_483_648.0 - 0.5) * 0.0035) as f32
            })
            .collect()
    }

    pub(crate) fn add(target: &mut [f32], source: &[f32], at: usize) {
        for (i, sample) in source.iter().enumerate() {
            if at + i < target.len() {
                target[at + i] += sample;
            }
        }
    }

    /// What the microphone hears of the speakers: quieter, later, duller.
    fn echo_of(playback: &[f32]) -> Vec<f32> {
        let delay = ms(40.0);
        let mut output = vec![0.0; playback.len() + delay];
        let mut low = 0.0f32;
        for (i, sample) in playback.iter().enumerate() {
            low += 0.35 * (sample - low);
            output[i + delay] = low * 0.2;
        }
        output
    }

    fn frame_db(audio: &[f32], offset: usize) -> f64 {
        let energy: f64 =
            (0..FRAME_SAMPLES).map(|i| audio.get(offset + i).map_or(0.0, |s| *s as f64 * *s as f64)).sum();
        10.0 * (energy / FRAME_SAMPLES as f64 + 1e-12).log10()
    }

    /// Feeds mic audio frame by frame; `playback` plays from `play_at` until stopped.
    fn run(mic: &[f32], playback: Option<(&[f32], usize)>, stop_on_barge_in: bool) -> Vec<(SegmenterEvent, f64)> {
        let mut segmenter = UtteranceSegmenter::new(CONFIG);
        let mut events = vec![];
        let mut stopped_at = usize::MAX;
        let mut start = 0;
        while start + FRAME_SAMPLES <= mic.len() {
            let mut context = FrameContext::SILENT;
            if let Some((audio, play_at)) = playback {
                if start >= play_at && start < stopped_at && start - play_at < audio.len() {
                    context = FrameContext { playing: true, playback_db: frame_db(audio, start - play_at) };
                }
            }
            for event in segmenter.push(mic[start..start + FRAME_SAMPLES].to_vec(), context) {
                if event == SegmenterEvent::BargeIn && stop_on_barge_in {
                    stopped_at = start;
                }
                events.push((event, (start + FRAME_SAMPLES) as f64 * 1000.0 / SAMPLE_RATE as f64));
            }
            start += FRAME_SAMPLES;
        }
        for event in segmenter.flush() {
            events.push((event, mic.len() as f64 * 1000.0 / SAMPLE_RATE as f64));
        }
        events
    }

    fn utterances(events: &[(SegmenterEvent, f64)]) -> Vec<(Vec<f32>, bool, u64, f64)> {
        events
            .iter()
            .filter_map(|(event, at)| match event {
                SegmenterEvent::Utterance { samples, overlapped_playback, start_sample, .. } => {
                    Some((samples.clone(), *overlapped_playback, *start_sample, *at))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_quiet_pause_ends_an_utterance_and_keeps_its_first_word() {
        let question = question();
        let onset = ms(1500.0);
        let mut mic = noise(onset + question.len() + ms(2000.0));
        add(&mut mic, &question, onset);
        let found = utterances(&run(&mic, None, false));
        assert_eq!(found.len(), 1);
        let (samples, _, start, at) = &found[0];
        let start = *start as usize;
        assert!(start <= onset);
        assert!(onset - start <= ms(500.0));
        assert!(start + samples.len() >= onset + question.len() - ms(100.0));
        assert!(*at < (onset + question.len()) as f64 * 1000.0 / SAMPLE_RATE as f64 + 1300.0);
    }

    #[test]
    fn two_sentences_separated_by_a_long_pause_become_two_utterances() {
        let (question, followup) = (question(), followup());
        let mut mic = noise(ms(1000.0) + question.len() + ms(2500.0) + followup.len() + ms(2000.0));
        add(&mut mic, &question, ms(1000.0));
        add(&mut mic, &followup, ms(1000.0) + question.len() + ms(2500.0));
        assert_eq!(utterances(&run(&mic, None, false)).len(), 2);
    }

    #[test]
    fn silence_room_noise_and_brief_knocks_are_not_speech() {
        assert!(run(&noise(ms(6000.0)), None, false).is_empty());
        let mut mic = noise(ms(6000.0));
        for at in [800.0, 2200.0, 3900.0] {
            // ~120 ms knock: a decaying low thud with a sharp attack.
            let knock: Vec<f32> = (0..ms(120.0))
                .map(|i| {
                    let t = i as f64 / SAMPLE_RATE as f64;
                    ((-(i as f64) / ms(25.0) as f64).exp()
                        * (0.5 * (2.0 * std::f64::consts::PI * 180.0 * t).sin()
                            + 0.3 * (2.0 * std::f64::consts::PI * 900.0 * t).sin())) as f32
                })
                .collect();
            add(&mut mic, &knock, ms(at));
        }
        let events = run(&mic, None, false);
        assert!(events.iter().all(|(event, _)| matches!(event, SegmenterEvent::Discarded { .. })));
    }

    #[test]
    fn delulus_own_voice_through_the_speakers_never_interrupts_it() {
        let reply = reply();
        let play_at = ms(500.0);
        let mut mic = noise(play_at + reply.len() + ms(2000.0));
        add(&mut mic, &echo_of(&reply), play_at);
        let events = run(&mic, Some((&reply, play_at)), false);
        assert!(!events.iter().any(|(event, _)| *event == SegmenterEvent::BargeIn));
        assert!(utterances(&events).is_empty());
    }

    #[test]
    fn talking_over_delulu_interrupts_promptly_and_keeps_the_start_of_the_sentence() {
        let (question, reply) = (question(), reply());
        let play_at = ms(500.0);
        let user_at = play_at + ms(2000.0);
        let mut mic = noise(user_at + question.len() + ms(2000.0));
        add(&mut mic, &echo_of(&reply), play_at);
        add(&mut mic, &question, user_at);
        let events = run(&mic, Some((&reply, play_at)), true);
        let barge_in = events.iter().find(|(event, _)| *event == SegmenterEvent::BargeIn).expect("barge-in");
        let user_ms = user_at as f64 * 1000.0 / SAMPLE_RATE as f64;
        assert!(barge_in.1 - user_ms <= CONFIG.barge_in_ms as f64 + 150.0);
        let found = utterances(&events);
        assert_eq!(found.len(), 1);
        assert!(found[0].1, "overlapped playback");
        assert!(found[0].2 as usize <= user_at);
        assert!(user_at - found[0].2 as usize <= ms(500.0));
    }

    #[test]
    fn after_an_interruption_the_next_reply_plays_and_can_be_interrupted_again() {
        let (question, followup, reply) = (question(), followup(), reply());
        let first = ms(500.0);
        let first_user = first + ms(1500.0);
        let second = first_user + question.len() + ms(2500.0);
        let second_user = second + ms(1500.0);
        let mut mic = noise(second_user + followup.len() + ms(2000.0));
        let clip = &reply[..ms(1800.0)];
        add(&mut mic, &echo_of(clip), first);
        add(&mut mic, &question, first_user);
        add(&mut mic, &echo_of(clip), second);
        add(&mut mic, &followup, second_user);
        let mut segmenter = UtteranceSegmenter::new(CONFIG);
        let mut barge_ins = vec![];
        let mut plays = VecDeque::from([first, second]);
        let mut playing: Option<(usize, usize)> = None;
        let mut utterance_count = 0;
        let mut start = 0;
        while start + FRAME_SAMPLES <= mic.len() {
            if plays.front().is_some_and(|at| start >= *at) {
                playing = Some((plays.pop_front().unwrap(), usize::MAX));
            }
            let mut context = FrameContext::SILENT;
            if let Some((at, stopped)) = playing {
                if start < stopped && start - at < ms(1800.0) {
                    context = FrameContext { playing: true, playback_db: frame_db(&reply, start - at) };
                }
            }
            for event in segmenter.push(mic[start..start + FRAME_SAMPLES].to_vec(), context) {
                if event == SegmenterEvent::BargeIn {
                    barge_ins.push(start);
                    if let Some(playing) = playing.as_mut() {
                        playing.1 = start;
                    }
                }
                if matches!(event, SegmenterEvent::Utterance { .. }) {
                    utterance_count += 1;
                }
            }
            start += FRAME_SAMPLES;
        }
        assert_eq!(barge_ins.len(), 2);
        assert!(barge_ins[0] >= first_user);
        assert!(barge_ins[1] >= second_user);
        assert_eq!(utterance_count + segmenter.flush().len(), 2);
    }
}
