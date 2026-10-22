//! Voice playback (`src/voicePlayer.ts`). Synthesized PCM chunks arrive in
//! order and play back to back on one output stream, so an utterance plays
//! without gaps while its next chunk is still synthesizing.
//!
//! The output callback renders from a shared [`Queue`] (no allocation or
//! deallocation there); the player thread converts chunks to the device rate,
//! opens and reopens the stream, prunes played audio and reports events.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use serde::Serialize;

use crate::devices::DEFAULT_DEVICE_ID;
use crate::output::Output;
use crate::resample::Resampler;
use crate::wav::pcm16le_to_f32;

/// Stopped utterances remembered so their late chunks are dropped.
const REJECTED_LIMIT: usize = 200;
/// Release the output device after this much silence.
const IDLE_CLOSE: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_millis(10);

/// One synthesized chunk (the TypeScript `VoicePlaybackChunk`).
#[derive(Debug, Clone)]
pub struct PlaybackChunk {
    pub utterance_id: String,
    pub chunk: u32,
    pub last: bool,
    pub sample_rate: u32,
    /// 16-bit little-endian mono PCM.
    pub pcm: Vec<u8>,
    pub volume: f32,
    pub output_device_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackEventKind {
    Started,
    Ended,
    Failed,
}

/// Per-chunk progress (the TypeScript `VoicePlaybackEvent`). A chunk always
/// reports `started` before `ended`; stopped chunks report nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackEvent {
    pub utterance_id: String,
    pub chunk: u32,
    pub event: PlaybackEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PlaybackEvent {
    fn new(utterance_id: &str, chunk: u32, event: PlaybackEventKind) -> Self {
        Self { utterance_id: utterance_id.to_owned(), chunk, event, message: None }
    }
}

struct Segment {
    record: u64,
    samples: Vec<f32>,
    position: usize,
    volume: f32,
}

impl Segment {
    fn done(&self) -> bool {
        self.position >= self.samples.len()
    }
}

struct Record {
    serial: u64,
    utterance_id: Arc<str>,
    chunk: u32,
    /// All of its audio has been queued.
    complete: bool,
    started_reported: bool,
}

/// Scheduling state shared with the output callback.
#[derive(Default)]
pub(crate) struct Queue {
    segments: VecDeque<Segment>,
    records: Vec<Record>,
    next_serial: u64,
    rejected: VecDeque<String>,
    /// Mean square of the last rendered block, after volume.
    mean_square: f64,
    rendering: bool,
    /// Sample rate of the queued segments.
    rate: Option<u32>,
}

impl Queue {
    fn is_rejected(&self, utterance_id: &str) -> bool {
        self.rejected.iter().any(|id| id == utterance_id)
    }

    fn reject(&mut self, utterance_id: &str) {
        self.rejected.retain(|id| id != utterance_id);
        self.rejected.push_back(utterance_id.to_owned());
        while self.rejected.len() > REJECTED_LIMIT {
            self.rejected.pop_front();
        }
    }

    /// Registers a chunk as scheduled; `None` when its utterance was stopped.
    fn register(&mut self, utterance_id: &str, chunk: u32) -> Option<u64> {
        if self.is_rejected(utterance_id) {
            return None;
        }
        let serial = self.next_serial;
        self.next_serial += 1;
        self.records.push(Record {
            serial,
            utterance_id: Arc::from(utterance_id),
            chunk,
            complete: false,
            started_reported: false,
        });
        Some(serial)
    }

    fn has_record(&self, serial: u64) -> bool {
        self.records.iter().any(|record| record.serial == serial)
    }

    fn forget(&mut self, serial: u64) {
        self.records.retain(|record| record.serial != serial);
    }

    fn append(&mut self, serial: u64, samples: Vec<f32>, volume: f32, rate: u32) {
        if samples.is_empty() || !self.has_record(serial) {
            return;
        }
        self.rate = Some(rate);
        self.segments.push_back(Segment { record: serial, samples, position: 0, volume });
    }

    fn complete(&mut self, serial: u64) {
        if let Some(record) = self.records.iter_mut().find(|record| record.serial == serial) {
            record.complete = true;
        }
    }

    pub fn unplayed(&self) -> usize {
        self.segments.iter().map(|segment| segment.samples.len() - segment.position).sum()
    }

    /// The output callback: fills `out` with queued audio, silence after it.
    pub fn render(&mut self, out: &mut [f32]) {
        let mut index = 0;
        let mut energy = 0.0f64;
        let mut audible = false;
        for slot in out.iter_mut() {
            while index < self.segments.len() && self.segments[index].done() {
                index += 1;
            }
            let Some(segment) = self.segments.get_mut(index) else {
                *slot = 0.0;
                continue;
            };
            let value = segment.samples[segment.position] * segment.volume;
            segment.position += 1;
            *slot = value;
            energy += value as f64 * value as f64;
            audible = true;
        }
        self.rendering = audible;
        self.mean_square = if out.is_empty() { 0.0 } else { energy / out.len() as f64 };
    }

    /// Reports progress and returns played segments for dropping off-lock.
    fn collect(&mut self, events: &mut Vec<PlaybackEvent>) -> Vec<Segment> {
        let segments = &self.segments;
        self.records.retain_mut(|record| {
            let mine = || segments.iter().filter(|segment| segment.record == record.serial);
            let started = mine().any(|segment| segment.position > 0);
            let finished = record.complete && mine().all(Segment::done);
            if (started || finished) && !record.started_reported {
                record.started_reported = true;
                events.push(PlaybackEvent::new(&record.utterance_id, record.chunk, PlaybackEventKind::Started));
            }
            if finished {
                events.push(PlaybackEvent::new(&record.utterance_id, record.chunk, PlaybackEventKind::Ended));
            }
            !finished
        });
        let mut played = Vec::new();
        while self.segments.front().is_some_and(Segment::done) {
            played.extend(self.segments.pop_front());
        }
        if self.segments.is_empty() {
            self.rate = None;
        }
        played
    }

    /// Stops one utterance, or everything for `None`; returns removed audio.
    fn stop(&mut self, utterance_id: Option<&str>) -> Vec<Segment> {
        if let Some(id) = utterance_id {
            self.reject(id);
        }
        let mut removed_records = Vec::new();
        self.records.retain(|record| {
            let hit = utterance_id.is_none_or(|id| *record.utterance_id == *id);
            if hit {
                removed_records.push((record.serial, record.utterance_id.clone()));
            }
            !hit
        });
        for (_, id) in &removed_records {
            self.reject(id);
        }
        let mut removed = Vec::new();
        let mut kept = VecDeque::with_capacity(self.segments.len());
        for segment in self.segments.drain(..) {
            if removed_records.iter().any(|(serial, _)| *serial == segment.record) {
                removed.push(segment);
            } else {
                kept.push_back(segment);
            }
        }
        self.segments = kept;
        if self.segments.iter().all(Segment::done) {
            self.rendering = false;
        }
        removed
    }

    fn utterances(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for record in &self.records {
            if !ids.iter().any(|id| **id == *record.utterance_id) {
                ids.push(record.utterance_id.to_string());
            }
        }
        ids
    }

    fn is_playing(&self) -> bool {
        self.rendering && self.segments.iter().any(|segment| !segment.done())
    }

    fn level_db(&self) -> f64 {
        if self.records.is_empty() && self.segments.is_empty() {
            return -120.0;
        }
        (10.0 * (self.mean_square + 1e-12).log10()).max(-120.0)
    }

    fn records_pending(&self) -> Vec<(Arc<str>, u32)> {
        self.records.iter().map(|record| (record.utterance_id.clone(), record.chunk)).collect()
    }
}

/// Converts one utterance's chunks to the output rate, streaming across chunk
/// boundaries so they join without edge artifacts. Output sample `i` belongs
/// to the chunk whose input contains position `i * source / target`.
struct Converter {
    utterance_id: String,
    source_rate: u32,
    target_rate: u32,
    resampler: Resampler,
    /// `(record serial, exclusive output end)` for chunks not yet complete.
    boundaries: VecDeque<(u64, u64)>,
    volume: f32,
}

struct Converted {
    pieces: Vec<(u64, Vec<f32>)>,
    completed: Vec<u64>,
}

impl Converter {
    fn new(utterance_id: &str, source_rate: u32, target_rate: u32) -> Self {
        Self {
            utterance_id: utterance_id.to_owned(),
            source_rate,
            target_rate,
            resampler: Resampler::new(source_rate, target_rate),
            boundaries: VecDeque::new(),
            volume: 1.0,
        }
    }

    fn push(&mut self, serial: u64, samples: &[f32]) -> Converted {
        let input_end = self.resampler.input_len() + samples.len() as u64;
        let output_end =
            (input_end as u128 * self.target_rate as u128).div_ceil(self.source_rate as u128) as u64;
        self.boundaries.push_back((serial, output_end));
        let start = self.resampler.output_len();
        let mut output = Vec::new();
        self.resampler.process(samples, &mut output);
        self.split(start, output, false)
    }

    fn finish(&mut self) -> Converted {
        let start = self.resampler.output_len();
        let mut output = Vec::new();
        self.resampler.finish(&mut output);
        self.split(start, output, true)
    }

    fn split(&mut self, start: u64, output: Vec<f32>, finishing: bool) -> Converted {
        let mut pieces = Vec::new();
        let mut completed = Vec::new();
        let mut position = start;
        let mut offset = 0;
        while offset < output.len() {
            let Some(&(serial, end)) = self.boundaries.front() else { break };
            // The newest chunk takes whatever remains (rounding at the end).
            let last = self.boundaries.len() == 1;
            let remaining = output.len() - offset;
            let take = if last { remaining } else { (end.saturating_sub(position) as usize).min(remaining) };
            if take > 0 {
                pieces.push((serial, output[offset..offset + take].to_vec()));
                offset += take;
                position += take as u64;
            }
            if !last && position >= end {
                completed.push(serial);
                self.boundaries.pop_front();
            }
        }
        while self.boundaries.front().is_some_and(|(_, end)| *end <= self.resampler.output_len()) {
            completed.extend(self.boundaries.pop_front().map(|(serial, _)| serial));
        }
        if finishing {
            completed.extend(self.boundaries.drain(..).map(|(serial, _)| serial));
        }
        Converted { pieces, completed }
    }
}

enum Command {
    Play(PlaybackChunk, u64),
    Shutdown,
}

type EventCallback = Arc<dyn Fn(PlaybackEvent) + Send + Sync>;

/// Thread-safe handle; clones share one player. The last handle dropped
/// shuts it down.
#[derive(Clone)]
pub struct Player {
    inner: Arc<PlayerInner>,
}

struct PlayerInner {
    queue: Arc<Mutex<Queue>>,
    commands: Sender<Command>,
}

impl Drop for PlayerInner {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

impl Player {
    /// Starts the player thread; no device is opened until audio arrives.
    pub fn new(on_event: impl Fn(PlaybackEvent) + Send + Sync + 'static) -> Self {
        let queue = Arc::new(Mutex::new(Queue::default()));
        let (commands, receiver) = crossbeam_channel::unbounded();
        let thread_queue = queue.clone();
        let callback: EventCallback = Arc::new(on_event);
        std::thread::Builder::new()
            .name("delulu-audio-player".into())
            .spawn(move || PlayerThread::new(thread_queue, callback).run(receiver))
            .expect("spawn audio player thread");
        Self { inner: Arc::new(PlayerInner { queue, commands }) }
    }

    /// Queues a chunk after everything already scheduled. Chunks of a stopped
    /// or interrupted utterance are dropped.
    pub fn play(&self, chunk: PlaybackChunk) {
        let Some(serial) = self.inner.queue.lock().register(&chunk.utterance_id, chunk.chunk) else { return };
        let _ = self.inner.commands.send(Command::Play(chunk, serial));
    }

    /// Stops one utterance, or everything when `None`. Stopped chunks report
    /// nothing more; later utterances keep their place.
    pub fn stop(&self, utterance_id: Option<&str>) {
        let removed = self.inner.queue.lock().stop(utterance_id);
        drop(removed);
    }

    /// Barge-in: stops everything now and returns the utterances cut off.
    pub fn interrupt(&self) -> Vec<String> {
        let (ids, removed) = {
            let mut queue = self.inner.queue.lock();
            let ids = queue.utterances();
            (ids, queue.stop(None))
        };
        drop(removed);
        ids
    }

    /// Whether queued audio is being rendered right now.
    pub fn is_playing(&self) -> bool {
        self.inner.queue.lock().is_playing()
    }

    /// Current output level in dBFS after volume, −120 when silent.
    pub fn output_level_db(&self) -> f64 {
        self.inner.queue.lock().level_db()
    }
}

struct PlayerThread {
    queue: Arc<Mutex<Queue>>,
    on_event: EventCallback,
    output: Option<Output>,
    /// The device chunks asked for, and whether we fell back to the default.
    wanted: String,
    fell_back: bool,
    converter: Option<Converter>,
    idle_since: Option<Instant>,
}

impl PlayerThread {
    fn new(queue: Arc<Mutex<Queue>>, on_event: EventCallback) -> Self {
        Self {
            queue,
            on_event,
            output: None,
            wanted: DEFAULT_DEVICE_ID.to_owned(),
            fell_back: false,
            converter: None,
            idle_since: None,
        }
    }

    fn run(mut self, commands: Receiver<Command>) {
        loop {
            // Sleep until the next command once nothing is open or queued.
            let idle = self.output.is_none() && self.converter.is_none() && {
                let queue = self.queue.lock();
                queue.records.is_empty() && queue.segments.is_empty()
            };
            let command =
                if idle { commands.recv().map_err(|_| RecvTimeoutError::Disconnected) } else { commands.recv_timeout(TICK) };
            match command {
                Ok(Command::Play(chunk, serial)) => self.play(chunk, serial),
                Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.tick();
        }
        let removed = self.queue.lock().stop(None);
        drop(removed);
        if let Some(output) = self.output.take() {
            output.close();
        }
    }

    fn emit(&self, events: Vec<PlaybackEvent>) {
        for event in events {
            (self.on_event)(event);
        }
    }

    fn fail(&self, serial: u64, utterance_id: &str, chunk: u32, message: String) {
        let present = {
            let mut queue = self.queue.lock();
            let present = queue.has_record(serial);
            queue.forget(serial);
            present
        };
        if present {
            self.emit(vec![PlaybackEvent {
                utterance_id: utterance_id.to_owned(),
                chunk,
                event: PlaybackEventKind::Failed,
                message: Some(format!("Could not play speech: {message}")),
            }]);
        }
    }

    fn play(&mut self, chunk: PlaybackChunk, serial: u64) {
        if !self.queue.lock().has_record(serial) {
            return;
        }
        if !(3_000..=768_000).contains(&chunk.sample_rate) {
            self.fail(serial, &chunk.utterance_id, chunk.chunk, "Unsupported sample rate".into());
            return;
        }
        let samples = pcm16le_to_f32(&chunk.pcm);
        if samples.is_empty() {
            // Nothing to hear, but the utterance must still advance.
            let present = {
                let mut queue = self.queue.lock();
                let present = queue.has_record(serial);
                queue.forget(serial);
                present
            };
            if present {
                self.emit(vec![
                    PlaybackEvent::new(&chunk.utterance_id, chunk.chunk, PlaybackEventKind::Started),
                    PlaybackEvent::new(&chunk.utterance_id, chunk.chunk, PlaybackEventKind::Ended),
                ]);
            }
            return;
        }
        let target_rate = match self.ensure_output(&chunk.output_device_id, chunk.sample_rate) {
            Ok(rate) => rate,
            Err(message) => {
                self.fail(serial, &chunk.utterance_id, chunk.chunk, message);
                return;
            }
        };
        let reuse = self.converter.as_ref().is_some_and(|converter| {
            converter.utterance_id == chunk.utterance_id
                && converter.source_rate == chunk.sample_rate
                && converter.target_rate == target_rate
        });
        if !reuse {
            self.finish_converter();
            self.converter = Some(Converter::new(&chunk.utterance_id, chunk.sample_rate, target_rate));
        }
        let converter = self.converter.as_mut().expect("converter");
        converter.volume = if chunk.volume.is_finite() { chunk.volume.clamp(0.0, 1.0) } else { 0.0 };
        let volume = converter.volume;
        let converted = converter.push(serial, &samples);
        self.enqueue(converted, volume, target_rate);
        if chunk.last {
            self.finish_converter();
        }
        self.idle_since = None;
    }

    fn enqueue(&self, converted: Converted, volume: f32, rate: u32) {
        let mut queue = self.queue.lock();
        for (serial, samples) in converted.pieces {
            queue.append(serial, samples, volume, rate);
        }
        for serial in converted.completed {
            queue.complete(serial);
        }
    }

    fn finish_converter(&mut self) {
        if let Some(mut converter) = self.converter.take() {
            let rate = converter.target_rate;
            let volume = converter.volume;
            let converted = converter.finish();
            self.enqueue(converted, volume, rate);
        }
    }

    /// Opens or reuses the output for `device_id`; returns its sample rate.
    fn ensure_output(&mut self, device_id: &str, preferred_rate: u32) -> Result<u32, String> {
        let wanted = if device_id.is_empty() { DEFAULT_DEVICE_ID } else { device_id };
        if let Some(output) = &self.output {
            if self.wanted == wanted && output.failure().is_none() {
                return Ok(output.sample_rate);
            }
        }
        let preferred = self.queue.lock().rate.unwrap_or(preferred_rate);
        if let Some(output) = self.output.take() {
            output.close();
        }
        // The callback blocks on the queue lock only while the player thread
        // or a handle holds it for bookkeeping, never for conversion.
        let open = |id: &str| {
            let queue = self.queue.clone();
            Output::open(id, Some(preferred), move |out: &mut [f32]| queue.lock().render(out))
        };
        let (output, fell_back) = match open(wanted) {
            Ok(output) => (output, false),
            // A missing device must not silence speech: fall back to the default.
            Err(_) if wanted != DEFAULT_DEVICE_ID => match open(DEFAULT_DEVICE_ID) {
                Ok(output) => (output, true),
                Err(error) => return Err(error.message),
            },
            Err(error) => return Err(error.message),
        };
        if fell_back {
            log::warn!("voice output {wanted} unavailable; using the default output");
        }
        self.wanted = wanted.to_owned();
        self.fell_back = fell_back;
        let rate = output.sample_rate;
        self.output = Some(output);
        Ok(rate)
    }

    fn tick(&mut self) {
        // Drop conversion state for a stopped utterance.
        if let Some(converter) = &self.converter {
            if self.queue.lock().is_rejected(&converter.utterance_id) {
                self.converter = None;
            }
        }
        // Underrun: release the resampler's held-back tail rather than wait.
        let unplayed = self.queue.lock().unplayed();
        if unplayed == 0 && self.converter.as_ref().is_some_and(|c| c.resampler.has_pending()) {
            self.finish_converter();
        }
        // A lost device: reopen (falling back to the default) or fail what is queued.
        if let Some(failure) = self.output.as_ref().and_then(Output::failure) {
            log::warn!("voice output failed: {failure}");
            if let Some(output) = self.output.take() {
                output.close();
            }
            if self.queue.lock().unplayed() > 0 {
                let wanted = self.wanted.clone();
                let rate = self.queue.lock().rate.unwrap_or(24_000);
                if let Err(message) = self.ensure_output(&wanted, rate) {
                    let pending = self.queue.lock().records_pending();
                    let removed = self.queue.lock().stop(None);
                    drop(removed);
                    self.converter = None;
                    for (id, chunk) in pending {
                        self.emit(vec![PlaybackEvent {
                            utterance_id: id.to_string(),
                            chunk,
                            event: PlaybackEventKind::Failed,
                            message: Some(format!("Could not play speech: {message}")),
                        }]);
                    }
                }
            }
        }
        let mut events = Vec::new();
        let (played, idle) = {
            let mut queue = self.queue.lock();
            let played = queue.collect(&mut events);
            (played, queue.records.is_empty() && queue.segments.is_empty())
        };
        drop(played);
        self.emit(events);
        if idle && self.converter.is_none() {
            let since = *self.idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= IDLE_CLOSE {
                if let Some(output) = self.output.take() {
                    output.close();
                }
            }
        } else {
            self.idle_since = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(events: &[PlaybackEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| format!("{}:{}:{}", e.utterance_id, e.chunk, serde_json::to_value(e.event).unwrap().as_str().unwrap()))
            .collect()
    }

    /// Queues a chunk the way the player thread does, at the output rate.
    fn push(queue: &mut Queue, id: &str, chunk: u32, samples: usize, volume: f32) -> Option<u64> {
        let serial = queue.register(id, chunk)?;
        queue.append(serial, vec![0.5; samples], volume, 48_000);
        queue.complete(serial);
        Some(serial)
    }

    fn drive(queue: &mut Queue, samples: usize, events: &mut Vec<PlaybackEvent>) {
        let mut buffer = vec![0.0; samples];
        queue.render(&mut buffer);
        queue.collect(events);
    }

    #[test]
    fn chunks_play_back_to_back_and_report_start_then_end() {
        let mut queue = Queue::default();
        let mut events = vec![];
        push(&mut queue, "u1", 0, 1000, 0.5);
        push(&mut queue, "u1", 1, 1000, 0.5);
        let mut out = vec![0.0; 1500];
        queue.render(&mut out);
        // Gapless: the second chunk continues right where the first ended.
        assert!(out.iter().all(|s| *s == 0.25));
        assert!(queue.is_playing());
        assert!((queue.level_db() - 10.0 * (0.0625f64).log10()).abs() < 1e-6);
        queue.collect(&mut events);
        assert_eq!(summary(&events), ["u1:0:started", "u1:0:ended", "u1:1:started"]);
        drive(&mut queue, 600, &mut events);
        assert_eq!(summary(&events), ["u1:0:started", "u1:0:ended", "u1:1:started", "u1:1:ended"]);
        assert!(queue.segments.is_empty() && queue.records.is_empty());
        assert_eq!(queue.level_db(), -120.0);
    }

    #[test]
    fn an_incomplete_chunk_does_not_end_early() {
        let mut queue = Queue::default();
        let mut events = vec![];
        let serial = queue.register("u1", 0).unwrap();
        queue.append(serial, vec![0.1; 100], 1.0, 48_000);
        drive(&mut queue, 200, &mut events);
        assert_eq!(summary(&events), ["u1:0:started"]);
        queue.append(serial, vec![0.1; 100], 1.0, 48_000);
        queue.complete(serial);
        drive(&mut queue, 200, &mut events);
        assert_eq!(summary(&events), ["u1:0:started", "u1:0:ended"]);
    }

    #[test]
    fn stopping_an_utterance_silences_it_and_reports_nothing_more() {
        let mut queue = Queue::default();
        let mut events = vec![];
        push(&mut queue, "u1", 0, 1000, 1.0);
        push(&mut queue, "u1", 1, 1000, 1.0);
        push(&mut queue, "u2", 0, 1000, 1.0);
        drive(&mut queue, 10, &mut events);
        assert_eq!(summary(&events), ["u1:0:started"]);
        queue.stop(Some("u1"));
        // Later utterances keep their slot and start right away.
        drive(&mut queue, 10, &mut events);
        assert_eq!(summary(&events), ["u1:0:started", "u2:0:started"]);
        // Late chunks of a stopped utterance are dropped.
        assert!(push(&mut queue, "u1", 2, 1000, 1.0).is_none());
        queue.stop(None);
        assert!(!queue.is_playing());
        drive(&mut queue, 2000, &mut events);
        assert_eq!(events.len(), 2);
        // A fresh utterance plays at once rather than after the stopped queue.
        push(&mut queue, "u3", 0, 10, 1.0);
        let mut out = vec![0.0; 10];
        queue.render(&mut out);
        assert_eq!(out[0], 0.5);
    }

    #[test]
    fn barge_in_stops_everything_and_late_audio_from_that_reply_never_plays() {
        let mut queue = Queue::default();
        let mut events = vec![];
        push(&mut queue, "a", 0, 1000, 1.0);
        push(&mut queue, "a", 1, 1000, 1.0);
        drive(&mut queue, 100, &mut events);
        assert!(queue.is_playing());
        let ids = queue.utterances();
        queue.stop(None);
        assert_eq!(ids, ["a"]);
        assert!(!queue.is_playing());
        assert!(push(&mut queue, "a", 2, 1000, 1.0).is_none());
        push(&mut queue, "b", 0, 1000, 1.0).unwrap();
        assert_eq!(queue.utterances(), ["b"]);
        drive(&mut queue, 100, &mut events);
        assert!(summary(&events).iter().all(|line| !line.ends_with("ended")));
    }

    #[test]
    fn rejected_utterances_are_bounded() {
        let mut queue = Queue::default();
        for index in 0..250 {
            queue.stop(Some(&format!("u{index}")));
        }
        assert_eq!(queue.rejected.len(), REJECTED_LIMIT);
        assert!(queue.register("u0", 0).is_some());
        assert!(queue.register("u249", 0).is_none());
    }

    #[test]
    fn converter_streams_chunks_and_attributes_output() {
        let tone: Vec<f32> = (0..2400).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        let expected = crate::resample::resample(&tone, 24_000, 48_000);
        let mut converter = Converter::new("u", 24_000, 48_000);
        let mut all: Vec<(u64, Vec<f32>)> = vec![];
        let mut completed = vec![];
        for (serial, piece) in tone.chunks(1000).enumerate() {
            let converted = converter.push(serial as u64, piece);
            all.extend(converted.pieces);
            completed.extend(converted.completed);
        }
        // The held-back tail of each chunk completes it once the next arrives.
        assert_eq!(completed, [0, 1]);
        let converted = converter.finish();
        all.extend(converted.pieces);
        completed.extend(converted.completed);
        assert_eq!(completed, [0, 1, 2]);
        let joined: Vec<f32> = all.iter().flat_map(|(_, s)| s.iter().copied()).collect();
        assert_eq!(joined, expected);
        let per_chunk = |serial: u64| all.iter().filter(|(s, _)| *s == serial).map(|(_, v)| v.len()).sum::<usize>();
        assert_eq!((per_chunk(0), per_chunk(1), per_chunk(2)), (2000, 2000, 800));
    }

    #[test]
    fn events_serialize_like_voice_playback_events() {
        let event = PlaybackEvent {
            utterance_id: "u1".into(),
            chunk: 2,
            event: PlaybackEventKind::Failed,
            message: Some("Could not play speech: x".into()),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({"utteranceId": "u1", "chunk": 2, "event": "failed", "message": "Could not play speech: x"})
        );
    }
}
