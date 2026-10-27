use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use handy_cpal as cpal;
use rubato::{FftFixedIn, Resampler};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub const SAMPLE_RATE: u32 = 16_000;
const MAX_SECONDS: usize = 300;
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
pub struct Clip {
    pub samples: Vec<f32>,
    pub rms: f32,
    pub peak: f32,
}
impl Clip {
    pub fn duration_ms(&self) -> u64 {
        self.samples.len() as u64 * 1000 / u64::from(SAMPLE_RATE)
    }
}
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("microphone not found: {0}")]
    NoDevice(String),
    #[error("audio stream failed: {0}")]
    Stream(String),
    #[error("not recording")]
    NotRecording,
}
fn stream_error(e: impl std::fmt::Display) -> AudioError {
    AudioError::Stream(e.to_string())
}
fn host() -> Result<cpal::Host, AudioError> {
    cpal::host_from_id(cpal::HostId::PulseAudio).map_err(stream_error)
}
fn id(device: &cpal::Device) -> Result<String, AudioError> {
    device.id().map(|id| id.to_string()).map_err(stream_error)
}
pub fn list_inputs() -> Result<Vec<InputDevice>, AudioError> {
    let host = host()?;
    let default = host.default_input_device().and_then(|d| id(&d).ok());
    let mut result = Vec::new();
    for device in host.input_devices().map_err(stream_error)? {
        let id = id(&device)?;
        let name = device
            .description()
            .map(|d| d.name().to_owned())
            .unwrap_or_else(|_| id.clone());
        result.push(InputDevice {
            is_default: default.as_ref() == Some(&id),
            id,
            name,
        });
    }
    Ok(result)
}
struct Session {
    command: mpsc::Sender<bool>,
    thread: JoinHandle<Result<Clip, AudioError>>,
    active: Arc<AtomicBool>,
}
#[derive(Default)]
pub struct Recorder {
    session: Mutex<Option<Session>>,
}
impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn start(
        &self,
        device_id: Option<&str>,
        level: Box<dyn Fn(f32) + Send>,
    ) -> Result<(), AudioError> {
        let mut slot = self.session.lock().map_err(stream_error)?;
        if slot.is_some() {
            return Err(AudioError::Stream(
                "already recording; stop or cancel first".into(),
            ));
        }
        let requested = device_id.map(str::to_owned);
        let (command, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let active = Arc::new(AtomicBool::new(true));
        let flag = active.clone();
        let thread = thread::Builder::new()
            .name("delulu-audio".into())
            .spawn(move || {
                let result = capture(requested.as_deref(), level, receiver, ready_tx, &flag);
                flag.store(false, Ordering::Release);
                result
            })
            .map_err(stream_error)?;
        match ready_rx.recv() {
            Ok(Ok(())) => {
                *slot = Some(Session {
                    command,
                    thread,
                    active,
                });
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(e) => {
                let _ = thread.join();
                Err(stream_error(e))
            }
        }
    }
    pub fn stop(&self) -> Result<Clip, AudioError> {
        let mut slot = self.session.lock().map_err(stream_error)?;
        let session = slot.take().ok_or(AudioError::NotRecording)?;
        let _ = session.command.send(true);
        session
            .thread
            .join()
            .map_err(|_| AudioError::Stream("capture thread panicked".into()))?
    }
    pub fn cancel(&self) {
        if let Ok(mut slot) = self.session.lock() {
            if let Some(session) = slot.take() {
                let _ = session.command.send(false);
                let _ = session.thread.join();
            }
        }
    }
    pub fn is_recording(&self) -> bool {
        self.session
            .lock()
            .ok()
            .and_then(|s| s.as_ref().map(|s| s.active.load(Ordering::Acquire)))
            .unwrap_or(false)
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn capture(
    requested: Option<&str>,
    level: Box<dyn Fn(f32) + Send>,
    receiver: mpsc::Receiver<bool>,
    ready: mpsc::SyncSender<Result<(), AudioError>>,
    active: &AtomicBool,
) -> Result<Clip, AudioError> {
    let opened = open(requested, level);
    let (stream, samples, failure, rate) = match opened {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return Err(AudioError::Stream("capture failed to start".into()));
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready.send(Err(stream_error(e)));
        return Err(AudioError::Stream("capture failed to start".into()));
    }
    let _ = ready.send(Ok(()));
    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(flush) => {
                if flush && active.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(100));
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if samples.lock().map_err(stream_error)?.len() >= rate as usize * MAX_SECONDS
                    || failure.lock().map_err(stream_error)?.is_some()
                {
                    break;
                }
            }
        }
    }
    drop(stream);
    active.store(false, Ordering::Release);
    if let Some(error) = failure.lock().map_err(stream_error)?.take() {
        return Err(AudioError::Stream(error));
    }
    let input = std::mem::take(&mut *samples.lock().map_err(stream_error)?);
    let samples = resample(&input, rate)?;
    let rms = rms(&samples);
    let peak = samples.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
    Ok(Clip { samples, rms, peak })
}
type Opened = (
    cpal::Stream,
    Arc<Mutex<Vec<f32>>>,
    Arc<Mutex<Option<String>>>,
    u32,
);
fn open(requested: Option<&str>, level: Box<dyn Fn(f32) + Send>) -> Result<Opened, AudioError> {
    let host = host()?;
    let device = match requested {
        Some(wanted) => host
            .input_devices()
            .map_err(stream_error)?
            .find(|d| id(d).is_ok_and(|id| id == wanted))
            .ok_or_else(|| AudioError::NoDevice(wanted.into()))?,
        None => host
            .default_input_device()
            .ok_or_else(|| AudioError::NoDevice("default".into()))?,
    };
    let config = device.default_input_config().map_err(stream_error)?;
    let rate = config.sample_rate();
    let frames = (rate / 50).max(1);
    let size = match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => frames.clamp(*min, *max),
        cpal::SupportedBufferSize::Unknown => frames,
    };
    let stream_config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: rate,
        buffer_size: cpal::BufferSize::Fixed(size),
    };
    let samples = Arc::new(Mutex::new(Vec::new()));
    let failure = Arc::new(Mutex::new(None));
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::I16 => build::<i16>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::I32 => build::<i32>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::U16 => build::<u16>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::U8 => build::<u8>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::I8 => build::<i8>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::I24 => build::<cpal::I24>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        cpal::SampleFormat::F64 => build::<f64>(
            &device,
            stream_config,
            samples.clone(),
            failure.clone(),
            level,
        ),
        format => {
            return Err(AudioError::Stream(format!(
                "unsupported sample format: {format}"
            )))
        }
    }
    .map_err(stream_error)?;
    Ok((stream, samples, failure, rate))
}
fn build<T: SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    failure: Arc<Mutex<Option<String>>>,
    level: Box<dyn Fn(f32) + Send>,
) -> Result<cpal::Stream, cpal::Error>
where
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let rate = config.sample_rate as usize;
    let mut sum = 0.0_f64;
    let mut count = 0;
    let mut first = true;
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if let Ok(mut samples) = samples.lock() {
                for frame in data.chunks_exact(channels) {
                    if samples.len() >= rate * MAX_SECONDS {
                        break;
                    }
                    let value = (frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>()
                        / channels as f32)
                        .clamp(-1.0, 1.0);
                    samples.push(value);
                    sum += f64::from(value) * f64::from(value);
                    count += 1;
                    if first || count >= rate / 20 {
                        first = false;
                        level(((sum / count as f64).sqrt() as f32).clamp(0.0, 1.0));
                        sum = 0.0;
                        count = 0;
                    }
                }
            }
        },
        move |e: cpal::Error| {
            if matches!(
                e.kind(),
                cpal::ErrorKind::Xrun
                    | cpal::ErrorKind::RealtimeDenied
                    | cpal::ErrorKind::DeviceChanged
            ) {
                log::debug!("audio input: {e}");
                return;
            }
            if let Ok(mut failure) = failure.lock() {
                *failure = Some(e.to_string());
            }
        },
        None,
    )
}
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        0.0
    } else {
        (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
            as f32
    }
}
fn resample(input: &[f32], rate: u32) -> Result<Vec<f32>, AudioError> {
    if input.is_empty() || rate == SAMPLE_RATE {
        return Ok(input.to_vec());
    }
    let mut r = FftFixedIn::<f32>::new(rate as usize, SAMPLE_RATE as usize, 1024, 2, 1)
        .map_err(stream_error)?;
    let delay = r.output_delay();
    let wanted = (input.len() as u64 * u64::from(SAMPLE_RATE) / u64::from(rate)) as usize;
    let mut output = Vec::new();
    for chunk in input.chunks(1024) {
        let mut block = vec![0.0; 1024];
        block[..chunk.len()].copy_from_slice(chunk);
        output.extend(r.process(&[block], None).map_err(stream_error)?.remove(0));
    }
    while output.len() < wanted + delay {
        output.extend(
            r.process(&[vec![0.0; 1024]], None)
                .map_err(stream_error)?
                .remove(0),
        );
    }
    Ok(output[delay..delay + wanted]
        .iter()
        .map(|s| s.clamp(-1.0, 1.0))
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn synthetic_stereo_sine() {
        let stereo: Vec<f32> = (0..48_000)
            .flat_map(|i| {
                let x = (std::f32::consts::TAU * 440.0 * i as f32 / 48_000.0).sin();
                [x, x * 0.5]
            })
            .collect();
        let mono: Vec<f32> = stereo
            .as_chunks::<2>()
            .0
            .iter()
            .map(|f| (f[0] + f[1]) / 2.0)
            .collect();
        let out = resample(&mono, 48_000).unwrap();
        assert_eq!(out.len(), 16_000);
        assert!((rms(&out) - 0.75 / 2.0_f32.sqrt()).abs() < 0.01);
        fn send_sync<T: Send + Sync>() {}
        send_sync::<Recorder>();
    }
}
