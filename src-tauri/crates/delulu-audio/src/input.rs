//! A microphone stream owned by one capture thread.
//!
//! The real-time callback only downmixes to mono f32 (in a stack buffer) and
//! pushes into a lock-free ring; the owning thread drains it. The stream is
//! pinned to the physical device resolved at open time, like the renderer
//! version, so a system default change never moves a running capture.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::devices::{self, Direction, DEFAULT_DEVICE_ID};

/// Seconds of audio the ring holds between drains.
const RING_SECONDS: usize = 4;
const SCRATCH: usize = 512;
/// Callback period where the host needs one (PulseAudio).
const INPUT_PERIOD_MS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenErrorKind {
    /// The selected device is not listed.
    Missing,
    /// No default input exists.
    NoDevice,
    Denied,
    Busy,
    Other,
}

#[derive(Debug, Clone)]
pub(crate) struct OpenError {
    pub kind: OpenErrorKind,
    pub message: String,
}

impl OpenError {
    fn from_cpal(error: cpal::Error) -> Self {
        devices::reset_host_after(&error);
        let kind = match error.kind() {
            cpal::ErrorKind::PermissionDenied => OpenErrorKind::Denied,
            cpal::ErrorKind::DeviceBusy => OpenErrorKind::Busy,
            cpal::ErrorKind::DeviceNotAvailable => OpenErrorKind::Missing,
            _ => OpenErrorKind::Other,
        };
        Self { kind, message: error.to_string() }
    }
}

/// Shared between the stream callbacks and the owner.
#[derive(Default)]
struct Status {
    callbacks: AtomicU64,
    dropped: AtomicU64,
    failed: AtomicBool,
    failure: Mutex<Option<String>>,
}

pub(crate) struct Input {
    _stream: cpal::Stream,
    consumer: HeapCons<f32>,
    status: Arc<Status>,
    pub sample_rate: u32,
    pub device_id: String,
    pub label: String,
    pub uses_default: bool,
    /// Default input ID when the capture began, for change notices.
    pub initial_default: Option<String>,
    seen_callbacks: u64,
    last_progress: Instant,
}

impl Input {
    pub fn open(requested: &str) -> Result<Input, OpenError> {
        let uses_default = requested.is_empty() || requested == DEFAULT_DEVICE_ID;
        let default_id = devices::default_device_id(Direction::Input);
        let device = if uses_default {
            devices::default_device(Direction::Input).ok_or(OpenError {
                kind: OpenErrorKind::NoDevice,
                message: "No microphone was found. Connect one or choose another input in Settings.".into(),
            })?
        } else {
            let listed = devices::physical_devices(Direction::Input).map_err(OpenError::from_cpal)?;
            listed.into_iter().find(|(id, _)| id == requested).map(|(_, device)| device).ok_or(OpenError {
                kind: OpenErrorKind::Missing,
                message: "The selected microphone is unavailable. Choose an available input in Settings and try again."
                    .into(),
            })?
        };
        let device_id = devices::device_id(&device).unwrap_or_else(|| requested.to_owned());
        let label = devices::device_label(&device).unwrap_or_else(|| "Microphone".into());

        let default = device.default_input_config().map_err(OpenError::from_cpal)?;
        let channels = default.channels().max(1);
        let sample_rate = default.sample_rate();
        // Prefer f32 at the device's own rate and layout; Pulse, CoreAudio and
        // WASAPI shared mode all offer it. Otherwise convert from the default.
        let supports_f32 = device.supported_input_configs().is_ok_and(|mut ranges| {
            ranges.any(|range| {
                range.sample_format() == cpal::SampleFormat::F32
                    && range.channels() == channels
                    && range.try_with_sample_rate(sample_rate).is_some()
            })
        });
        let format = if supports_f32 { cpal::SampleFormat::F32 } else { default.sample_format() };
        let buffer_size = devices::buffer_size(default.buffer_size(), sample_rate, INPUT_PERIOD_MS);
        let config = cpal::StreamConfig { channels, sample_rate, buffer_size };

        let ring = HeapRb::<f32>::new(sample_rate as usize * RING_SECONDS);
        let (producer, consumer) = ring.split();
        let status = Arc::new(Status::default());
        let stream = match format {
            cpal::SampleFormat::F32 => build::<f32>(&device, config, producer, status.clone()),
            cpal::SampleFormat::I16 => build::<i16>(&device, config, producer, status.clone()),
            cpal::SampleFormat::I32 => build::<i32>(&device, config, producer, status.clone()),
            cpal::SampleFormat::I24 => build::<cpal::I24>(&device, config, producer, status.clone()),
            cpal::SampleFormat::U16 => build::<u16>(&device, config, producer, status.clone()),
            cpal::SampleFormat::U8 => build::<u8>(&device, config, producer, status.clone()),
            cpal::SampleFormat::I8 => build::<i8>(&device, config, producer, status.clone()),
            cpal::SampleFormat::F64 => build::<f64>(&device, config, producer, status.clone()),
            other => {
                return Err(OpenError {
                    kind: OpenErrorKind::Other,
                    message: format!("The microphone uses an unsupported sample format ({other})."),
                })
            }
        }
        .map_err(OpenError::from_cpal)?;
        stream.play().map_err(OpenError::from_cpal)?;
        let now = Instant::now();
        Ok(Input {
            _stream: stream,
            consumer,
            status,
            sample_rate,
            initial_default: default_id.or_else(|| uses_default.then(|| device_id.clone())),
            device_id,
            label,
            uses_default,
            seen_callbacks: 0,
            last_progress: now,
        })
    }

    /// Appends everything captured since the last drain.
    pub fn drain(&mut self, out: &mut Vec<f32>) {
        let available = self.consumer.occupied_len();
        if available == 0 {
            return;
        }
        let start = out.len();
        out.resize(start + available, 0.0);
        let read = self.consumer.pop_slice(&mut out[start..]);
        out.truncate(start + read);
    }

    /// A fatal stream error message, once reported by the backend.
    pub fn failure(&self) -> Option<String> {
        if !self.status.failed.load(Ordering::Acquire) {
            return None;
        }
        Some(self.status.failure.lock().clone().unwrap_or_else(|| "The audio stream failed".into()))
    }

    /// Time since the callback last delivered audio (or since opening).
    pub fn stalled_for(&mut self) -> std::time::Duration {
        let callbacks = self.status.callbacks.load(Ordering::Relaxed);
        if callbacks != self.seen_callbacks {
            self.seen_callbacks = callbacks;
            self.last_progress = Instant::now();
        }
        self.last_progress.elapsed()
    }

    pub fn dropped_samples(&self) -> u64 {
        self.status.dropped.load(Ordering::Relaxed)
    }

    /// Whether the pinned device is still listed; `None` when enumeration
    /// failed, which proves nothing.
    pub fn present(&self) -> Option<bool> {
        let listed = devices::physical_devices(Direction::Input).ok()?;
        Some(listed.iter().any(|(id, _)| *id == self.device_id))
    }
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut producer: HeapProd<f32>,
    status: Arc<Status>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let scale = 1.0 / channels as f32;
    let data_status = status.clone();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Downmix to mono like a channelCount: 1 getUserMedia track.
            let mut scratch = [0.0f32; SCRATCH];
            for frames in data.chunks(SCRATCH * channels) {
                let count = frames.len() / channels;
                for (slot, frame) in scratch.iter_mut().zip(frames.chunks_exact(channels)) {
                    let mut sum = 0.0f32;
                    for sample in frame {
                        sum += sample.to_sample::<f32>();
                    }
                    *slot = sum * scale;
                }
                let pushed = producer.push_slice(&scratch[..count]);
                if pushed < count {
                    data_status.dropped.fetch_add((count - pushed) as u64, Ordering::Relaxed);
                }
            }
            data_status.callbacks.fetch_add(1, Ordering::Relaxed);
        },
        move |error: cpal::Error| {
            if is_fatal(&error) {
                *status.failure.lock() = Some(error.to_string());
                status.failed.store(true, Ordering::Release);
            } else {
                log::debug!("audio input: {error}");
            }
        },
        None,
    )
}

/// Underruns, refused real-time scheduling and automatic reroutes keep the
/// stream running; everything else ends it.
pub(crate) fn is_fatal(error: &cpal::Error) -> bool {
    !matches!(error.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied | cpal::ErrorKind::DeviceChanged)
}

