//! Native playback on the default output (PipeWire through its PulseAudio server).
//! It keeps playing with the window closed, fades on pause, holds silent while you
//! dictate, and moves to the preloaded next track without a gap. The output stream
//! is closed whenever nothing plays, so an idle station holds no audio device.
use crate::audio::{resample, Audio};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use handy_cpal as cpal;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A fade this long avoids clicks on pause, hold and skip.
const FADE_SECONDS: f32 = 0.04;
/// Close the stream after this much silence.
const IDLE_CLOSE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq)]
pub enum PlayerEvent {
    /// The track finished playing (not skipped).
    Ended(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Position {
    pub id: String,
    pub seconds: f64,
    pub total: f64,
}

struct Track {
    id: String,
    source: Arc<Audio>,
    /// Interleaved stereo at `rate`.
    samples: Vec<f32>,
    rate: u32,
    pos: usize,
}

impl Track {
    fn new(id: String, source: Arc<Audio>) -> Track {
        Track {
            id,
            rate: source.rate,
            samples: Vec::new(),
            source,
            pos: 0,
        }
    }
    /// Resample for the device; keeps the position in seconds.
    fn prepare(&mut self, rate: u32) -> Result<(), String> {
        if self.rate == rate && !self.samples.is_empty() {
            return Ok(());
        }
        let seconds = self.pos as f64 / 2.0 / self.rate.max(1) as f64;
        self.samples = resample(&self.source, rate).map_err(|e| e.to_string())?;
        self.rate = rate;
        self.pos = ((seconds * rate as f64) as usize * 2).min(self.samples.len());
        Ok(())
    }
}

struct Deck {
    current: Option<Track>,
    next: Option<Track>,
    playing: bool,
    hold: bool,
    volume: f32,
    gain: f32,
    /// The open stream's rate, 0 when closed.
    rate: u32,
    ended: Vec<String>,
}

impl Deck {
    fn target(&self) -> f32 {
        if self.playing && !self.hold && self.current.is_some() {
            self.volume
        } else {
            0.0
        }
    }
    fn audible(&self) -> bool {
        self.target() > 0.0 || self.gain > 0.0
    }
    /// One output frame.
    fn frame(&mut self, step: f32) -> (f32, f32) {
        let target = self.target();
        self.gain += (target - self.gain).clamp(-step, step);
        if self.gain <= 0.0 && target <= 0.0 {
            self.gain = 0.0;
            return (0.0, 0.0);
        }
        let Some(track) = self.current.as_mut() else {
            return (0.0, 0.0);
        };
        if track.pos + 1 >= track.samples.len() {
            self.ended.push(track.id.clone());
            self.current = self.next.take();
            return (0.0, 0.0);
        }
        let (l, r) = (track.samples[track.pos], track.samples[track.pos + 1]);
        track.pos += 2;
        (l * self.gain, r * self.gain)
    }
}

enum Command {
    Play(String, Arc<Audio>),
    Preload(String, Arc<Audio>),
    Resume,
    Pause,
    Hold(bool),
    Volume(f32),
    Stop,
}

pub struct Player {
    commands: Sender<Command>,
    deck: Arc<Mutex<Deck>>,
}

fn lock(deck: &Mutex<Deck>) -> MutexGuard<'_, Deck> {
    deck.lock().unwrap_or_else(|e| e.into_inner())
}

impl Player {
    pub fn new(on_event: impl Fn(PlayerEvent) + Send + 'static) -> Player {
        let deck = Arc::new(Mutex::new(Deck {
            current: None,
            next: None,
            playing: false,
            hold: false,
            volume: 0.8,
            gain: 0.0,
            rate: 0,
            ended: Vec::new(),
        }));
        let (commands, receiver) = mpsc::channel();
        let shared = deck.clone();
        std::thread::Builder::new()
            .name("radio-player".into())
            .spawn(move || audio_thread(shared, receiver, Box::new(on_event)))
            .expect("spawn player");
        Player { commands, deck }
    }

    /// Replace the current track and start playing it from the start.
    pub fn play(&self, id: &str, audio: Arc<Audio>) {
        let _ = self.commands.send(Command::Play(id.into(), audio));
    }
    /// The track to continue with when the current one ends.
    pub fn preload(&self, id: &str, audio: Arc<Audio>) {
        let _ = self.commands.send(Command::Preload(id.into(), audio));
    }
    pub fn resume(&self) {
        let _ = self.commands.send(Command::Resume);
    }
    pub fn pause(&self) {
        let _ = self.commands.send(Command::Pause);
    }
    /// Silence while the microphone is recording; playback resumes after.
    pub fn hold(&self, on: bool) {
        let _ = self.commands.send(Command::Hold(on));
    }
    pub fn set_volume(&self, volume: f32) {
        let _ = self.commands.send(Command::Volume(volume.clamp(0.0, 1.0)));
    }
    pub fn stop(&self) {
        let _ = self.commands.send(Command::Stop);
    }
    pub fn playing(&self) -> bool {
        let d = lock(&self.deck);
        d.playing && d.current.is_some()
    }
    pub fn held(&self) -> bool {
        lock(&self.deck).hold
    }
    /// What plays now and how far along it is.
    pub fn position(&self) -> Option<Position> {
        let d = lock(&self.deck);
        let t = d.current.as_ref()?;
        let rate = t.rate.max(1) as f64;
        let total = if t.samples.is_empty() {
            t.source.seconds()
        } else {
            t.samples.len() as f64 / 2.0 / rate
        };
        Some(Position {
            id: t.id.clone(),
            seconds: t.pos as f64 / 2.0 / rate,
            total,
        })
    }
    /// Id of the preloaded next track.
    pub fn preloaded(&self) -> Option<String> {
        lock(&self.deck).next.as_ref().map(|t| t.id.clone())
    }
}

fn audio_thread(
    deck: Arc<Mutex<Deck>>,
    commands: Receiver<Command>,
    on_event: Box<dyn Fn(PlayerEvent) + Send>,
) {
    let mut stream: Option<cpal::Stream> = None;
    let mut quiet_since: Option<Instant> = None;
    let failure = Arc::new(Mutex::new(None::<String>));
    loop {
        match commands.recv_timeout(Duration::from_millis(100)) {
            Ok(command) => {
                let mut d = lock(&deck);
                let rate = d.rate;
                let prepared = |id: String, audio: Arc<Audio>| -> Result<Track, String> {
                    let mut track = Track::new(id, audio);
                    if rate > 0 {
                        track.prepare(rate)?;
                    }
                    Ok(track)
                };
                let result = match command {
                    Command::Play(id, audio) => prepared(id, audio).map(|t| {
                        d.current = Some(t);
                        d.next = None;
                        d.playing = true;
                        d.gain = 0.0;
                    }),
                    Command::Preload(id, audio) => prepared(id, audio).map(|t| d.next = Some(t)),
                    Command::Resume => {
                        d.playing = true;
                        Ok(())
                    }
                    Command::Pause => {
                        d.playing = false;
                        Ok(())
                    }
                    Command::Hold(on) => {
                        d.hold = on;
                        Ok(())
                    }
                    Command::Volume(v) => {
                        d.volume = v;
                        Ok(())
                    }
                    Command::Stop => {
                        d.playing = false;
                        d.current = None;
                        d.next = None;
                        d.gain = 0.0;
                        Ok(())
                    }
                };
                drop(d);
                if let Err(e) = result {
                    on_event(PlayerEvent::Failed(e));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let ended: Vec<String> = std::mem::take(&mut lock(&deck).ended);
        for id in ended {
            on_event(PlayerEvent::Ended(id));
        }
        if let Some(message) = failure.lock().ok().and_then(|mut f| f.take()) {
            stream = None;
            lock(&deck).rate = 0;
            on_event(PlayerEvent::Failed(message));
        }
        let audible = lock(&deck).audible();
        if audible {
            quiet_since = None;
            if stream.is_none() {
                match open(deck.clone(), failure.clone()) {
                    Ok(s) => stream = Some(s),
                    Err(e) => {
                        // Stop retrying until the user presses play again.
                        lock(&deck).playing = false;
                        on_event(PlayerEvent::Failed(e));
                    }
                }
            }
        } else if stream.is_some() {
            let since = *quiet_since.get_or_insert_with(Instant::now);
            if since.elapsed() > IDLE_CLOSE {
                stream = None;
                lock(&deck).rate = 0;
                quiet_since = None;
            }
        }
    }
}

fn open(
    deck: Arc<Mutex<Deck>>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let host = cpal::host_from_id(cpal::HostId::PulseAudio).map_err(|e| e.to_string())?;
    let device = host
        .default_output_device()
        .ok_or("No audio output device")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = config.sample_rate();
    {
        let mut d = lock(&deck);
        let Deck { current, next, .. } = &mut *d;
        for track in [current.as_mut(), next.as_mut()].into_iter().flatten() {
            track.prepare(rate)?;
        }
        d.rate = rate;
    }
    // The server's default buffer is about two seconds, which would delay pause and
    // the dictation hold by as much; 50 ms keeps them prompt.
    let frames = (rate / 20).max(1);
    let size = match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => frames.clamp(*min, *max),
        cpal::SupportedBufferSize::Unknown => frames,
    };
    let stream_config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: rate,
        buffer_size: cpal::BufferSize::Fixed(size),
    };
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, stream_config, deck, failure),
        cpal::SampleFormat::I16 => build::<i16>(&device, stream_config, deck, failure),
        cpal::SampleFormat::I32 => build::<i32>(&device, stream_config, deck, failure),
        cpal::SampleFormat::U16 => build::<u16>(&device, stream_config, deck, failure),
        format => return Err(format!("unsupported output format: {format}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn build<T: SizedSample + FromSample<f32> + Send + 'static>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    deck: Arc<Mutex<Deck>>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, cpal::Error> {
    let channels = usize::from(config.channels).max(1);
    let step = 1.0 / (FADE_SECONDS * config.sample_rate as f32);
    device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let mut d = lock(&deck);
            for frame in data.chunks_mut(channels) {
                let (l, r) = d.frame(step);
                match frame {
                    [mono] => *mono = T::from_sample((l + r) * 0.5),
                    [a, b, rest @ ..] => {
                        *a = T::from_sample(l);
                        *b = T::from_sample(r);
                        for s in rest {
                            *s = T::from_sample(0.0f32);
                        }
                    }
                    [] => {}
                }
            }
        },
        move |e: cpal::Error| {
            if matches!(
                e.kind(),
                cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied
            ) {
                log::debug!("audio output: {e}");
                return;
            }
            if let Ok(mut f) = failure.lock() {
                *f = Some(e.to_string());
            }
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(samples: Vec<f32>) -> Deck {
        let source = Arc::new(Audio {
            rate: 10,
            samples: samples.clone(),
        });
        Deck {
            current: Some(Track {
                id: "a".into(),
                source,
                samples,
                rate: 10,
                pos: 0,
            }),
            next: None,
            playing: true,
            hold: false,
            volume: 1.0,
            gain: 1.0,
            rate: 10,
            ended: Vec::new(),
        }
    }

    #[test]
    fn plays_then_reports_the_end_and_moves_on() {
        let mut d = deck(vec![0.5, 0.5, 0.25, 0.25]);
        let source = Arc::new(Audio {
            rate: 10,
            samples: vec![0.1, 0.1],
        });
        d.next = Some(Track {
            id: "b".into(),
            source,
            samples: vec![0.1, 0.1],
            rate: 10,
            pos: 0,
        });
        assert_eq!(d.frame(1.0), (0.5, 0.5));
        assert_eq!(d.frame(1.0), (0.25, 0.25));
        assert_eq!(d.frame(1.0), (0.0, 0.0));
        assert_eq!(d.ended, ["a"]);
        assert_eq!(d.current.as_ref().unwrap().id, "b");
        assert_eq!(d.frame(1.0), (0.1, 0.1));
    }

    #[test]
    fn hold_fades_out_and_freezes_position() {
        let mut d = deck(vec![1.0; 40]);
        d.hold = true;
        let (l, _) = d.frame(0.5);
        assert_eq!(l, 0.5);
        assert_eq!(d.frame(0.5), (0.0, 0.0));
        let pos = d.current.as_ref().unwrap().pos;
        assert_eq!(d.frame(0.5), (0.0, 0.0));
        assert_eq!(d.current.as_ref().unwrap().pos, pos);
        assert!(!d.audible());
        d.hold = false;
        assert!(d.audible());
    }
}
