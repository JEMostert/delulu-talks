use std::sync::atomic::{AtomicBool, Ordering};
pub const SAMPLE_RATE: u32 = 16_000;
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
pub fn list_inputs() -> Result<Vec<InputDevice>, AudioError> {
    Ok(vec![InputDevice {
        id: "stub".into(),
        name: "Stub microphone".into(),
        is_default: true,
    }])
}
#[derive(Default)]
pub struct Recorder {
    recording: AtomicBool,
}
impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn start(
        &self,
        _device_id: Option<&str>,
        _level: Box<dyn Fn(f32) + Send>,
    ) -> Result<(), AudioError> {
        self.recording.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn stop(&self) -> Result<Clip, AudioError> {
        if !self.recording.swap(false, Ordering::SeqCst) {
            return Err(AudioError::NotRecording);
        }
        Ok(Clip {
            samples: vec![0.0; SAMPLE_RATE as usize],
            rms: 0.0,
            peak: 0.0,
        })
    }
    pub fn cancel(&self) {
        self.recording.store(false, Ordering::SeqCst);
    }
    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::SeqCst)
    }
}
