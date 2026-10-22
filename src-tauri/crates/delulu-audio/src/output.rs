//! An output stream owned by one thread. The real-time callback asks a
//! render closure for mono f32 samples in a stack buffer and fans them out to
//! every channel in the device's sample format.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use parking_lot::Mutex;

use crate::devices::{self, Direction, DEFAULT_DEVICE_ID};
use crate::input::{is_fatal, OpenError, OpenErrorKind};

const SCRATCH: usize = 512;
/// Callback period where the host needs one (PulseAudio double-buffers it,
/// so about 60 ms of audio is queued in the server).
const OUTPUT_PERIOD_MS: u32 = 30;

pub(crate) struct Output {
    stream: cpal::Stream,
    pub sample_rate: u32,
    failed: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
}

impl Output {
    /// Opens `requested` (or the default output) at `preferred_rate` when the
    /// device accepts it, otherwise at the device rate.
    pub fn open<R>(requested: &str, preferred_rate: Option<u32>, render: R) -> Result<Output, OpenError>
    where
        R: FnMut(&mut [f32]) + Send + 'static,
    {
        let device = if requested.is_empty() || requested == DEFAULT_DEVICE_ID {
            devices::default_device(Direction::Output).ok_or(OpenError {
                kind: OpenErrorKind::NoDevice,
                message: "No audio output was found".into(),
            })?
        } else {
            devices::physical_devices(Direction::Output)
                .map_err(|error| OpenError { kind: OpenErrorKind::Other, message: error.to_string() })?
                .into_iter()
                .find(|(id, _)| id == requested)
                .map(|(_, device)| device)
                .ok_or(OpenError { kind: OpenErrorKind::Missing, message: "The selected output is unavailable".into() })?
        };
        let default = device
            .default_output_config()
            .map_err(|error| OpenError { kind: OpenErrorKind::Other, message: error.to_string() })?;
        let channels = default.channels().max(1);
        let ranges: Vec<cpal::SupportedStreamConfigRange> =
            device.supported_output_configs().map(|ranges| ranges.collect()).unwrap_or_default();
        let f32_at = |rate: u32| {
            ranges.iter().any(|range| {
                range.sample_format() == cpal::SampleFormat::F32
                    && range.channels() == channels
                    && range.try_with_sample_rate(rate).is_some()
            })
        };
        let (sample_rate, format) = match preferred_rate {
            Some(rate) if f32_at(rate) => (rate, cpal::SampleFormat::F32),
            _ if f32_at(default.sample_rate()) => (default.sample_rate(), cpal::SampleFormat::F32),
            _ => (default.sample_rate(), default.sample_format()),
        };
        let buffer_size = devices::buffer_size(default.buffer_size(), sample_rate, OUTPUT_PERIOD_MS);
        let config = cpal::StreamConfig { channels, sample_rate, buffer_size };
        let failed = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        let errors = (failed.clone(), failure.clone());
        let stream = match format {
            cpal::SampleFormat::F32 => build::<f32, R>(&device, config, render, errors),
            cpal::SampleFormat::I16 => build::<i16, R>(&device, config, render, errors),
            cpal::SampleFormat::I32 => build::<i32, R>(&device, config, render, errors),
            cpal::SampleFormat::I24 => build::<cpal::I24, R>(&device, config, render, errors),
            cpal::SampleFormat::U16 => build::<u16, R>(&device, config, render, errors),
            cpal::SampleFormat::U8 => build::<u8, R>(&device, config, render, errors),
            cpal::SampleFormat::F64 => build::<f64, R>(&device, config, render, errors),
            other => {
                return Err(OpenError {
                    kind: OpenErrorKind::Other,
                    message: format!("The output uses an unsupported sample format ({other})"),
                })
            }
        }
        .map_err(|error| {
            devices::reset_host_after(&error);
            OpenError { kind: OpenErrorKind::Other, message: error.to_string() }
        })?;
        stream.play().map_err(|error| OpenError { kind: OpenErrorKind::Other, message: error.to_string() })?;
        Ok(Output { stream, sample_rate, failed, failure })
    }

    pub fn failure(&self) -> Option<String> {
        if !self.failed.load(Ordering::Acquire) {
            return None;
        }
        Some(self.failure.lock().clone().unwrap_or_else(|| "The audio output failed".into()))
    }

    pub fn close(self) {
        let _ = self.stream.pause();
    }
}

fn build<T, R>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut render: R,
    (failed, failure): (Arc<AtomicBool>, Arc<Mutex<Option<String>>>),
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
    R: FnMut(&mut [f32]) + Send + 'static,
{
    let channels = config.channels.max(1) as usize;
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            let mut scratch = [0.0f32; SCRATCH];
            for frames in data.chunks_mut(SCRATCH * channels) {
                let count = frames.len() / channels;
                render(&mut scratch[..count]);
                for (frame, sample) in frames.chunks_exact_mut(channels).zip(&scratch[..count]) {
                    let value = T::from_sample(*sample);
                    for slot in frame {
                        *slot = value;
                    }
                }
            }
        },
        move |error: cpal::Error| {
            if is_fatal(&error) {
                *failure.lock() = Some(error.to_string());
                failed.store(true, Ordering::Release);
            } else {
                log::debug!("audio output: {error}");
            }
        },
        None,
    )
}
