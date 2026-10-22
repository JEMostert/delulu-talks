//! Audio host selection and device listing.
//!
//! Linux uses cpal's PulseAudio host (pipewire-pulse on PipeWire systems) and
//! falls back to ALSA when no Pulse server answers within cpal's 2 s
//! handshake timeout; macOS and Windows use CoreAudio and WASAPI. Device IDs
//! are cpal's stable `DeviceId` strings (`pulseaudio:<source name>`,
//! `coreaudio:<uid>`, `wasapi:<endpoint id>`); [`DEFAULT_DEVICE_ID`] follows
//! the system default.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const DEFAULT_DEVICE_ID: &str = "default";
const DEFAULT_LABEL: &str = "System default";
const LABEL_LIMIT: usize = 160;

/// One selectable input or output. Same shape as the TypeScript
/// `MicrophoneDevice`; native labels are always known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDevice {
    pub device_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label_known: Option<bool>,
}

static HOST: Mutex<Option<Arc<cpal::Host>>> = Mutex::new(None);

/// The shared audio host, created on first use.
pub(crate) fn host() -> Arc<cpal::Host> {
    let mut slot = HOST.lock();
    if let Some(host) = slot.as_ref() {
        return host.clone();
    }
    let host = Arc::new(cpal::default_host());
    log::info!("audio host: {}", host.id().name());
    *slot = Some(host.clone());
    host
}

/// Drops the shared host after a host-level failure (for example the Pulse
/// server restarted) so the next operation reconnects.
pub(crate) fn reset_host_after(error: &cpal::Error) {
    if matches!(error.kind(), cpal::ErrorKind::HostUnavailable | cpal::ErrorKind::StreamInvalidated) {
        *HOST.lock() = None;
    }
}

/// Callback period for a stream. PulseAudio needs an explicit size: with the
/// server defaults a record stream delivers its first fragment after ~2 s
/// and a playback stream buffers ~2 s ahead (so stopping speech would lag).
/// Other hosts keep their own defaults.
pub(crate) fn buffer_size(supported: &cpal::SupportedBufferSize, sample_rate: u32, millis: u32) -> cpal::BufferSize {
    if host().id().name() != "PulseAudio" {
        return cpal::BufferSize::Default;
    }
    let frames = (sample_rate as u64 * millis as u64 / 1000).max(1) as u32;
    match supported {
        cpal::SupportedBufferSize::Range { min, max } => cpal::BufferSize::Fixed(frames.clamp(*min, *max)),
        cpal::SupportedBufferSize::Unknown => cpal::BufferSize::Fixed(frames),
    }
}

/// Name of the audio host in use (`PulseAudio`, `ALSA`, `CoreAudio`, `WASAPI`).
pub fn host_name() -> &'static str {
    host().id().name()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Input,
    Output,
}

pub(crate) fn device_id(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.to_string())
}

pub(crate) fn bounded_label(label: &str) -> String {
    let cleaned: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    delulu_core::util::truncate_utf16(cleaned.trim(), LABEL_LIMIT).to_owned()
}

pub(crate) fn device_label(device: &cpal::Device) -> Option<String> {
    let label = bounded_label(device.description().ok()?.name());
    (!label.is_empty()).then_some(label)
}

/// PulseAudio lists a monitor source for every sink; it records what is
/// playing, never a microphone.
fn is_monitor(id: &str) -> bool {
    id.starts_with("pulseaudio:") && id.ends_with(".monitor")
}

/// Physical devices as `(id, device)`, or an error when the host could not
/// enumerate (which is not evidence that a device vanished).
pub(crate) fn physical_devices(direction: Direction) -> Result<Vec<(String, cpal::Device)>, cpal::Error> {
    let host = host();
    let devices = match direction {
        Direction::Input => host.input_devices(),
        Direction::Output => host.output_devices(),
    };
    let devices = devices.inspect_err(reset_host_after)?;
    Ok(devices
        .filter_map(|device| {
            let id = device_id(&device)?;
            (!(direction == Direction::Input && is_monitor(&id))).then_some((id, device))
        })
        .collect())
}

pub(crate) fn default_device(direction: Direction) -> Option<cpal::Device> {
    let host = host();
    match direction {
        Direction::Input => host.default_input_device(),
        Direction::Output => host.default_output_device(),
    }
}

pub(crate) fn default_device_id(direction: Direction) -> Option<String> {
    default_device(direction).as_ref().and_then(device_id)
}

fn list(direction: Direction) -> Vec<MicrophoneDevice> {
    let mut devices = vec![MicrophoneDevice {
        device_id: DEFAULT_DEVICE_ID.to_owned(),
        label: DEFAULT_LABEL.to_owned(),
        label_known: Some(true),
    }];
    let fallback = match direction {
        Direction::Input => "Microphone",
        Direction::Output => "Speaker",
    };
    for (index, (id, device)) in physical_devices(direction).unwrap_or_default().into_iter().enumerate() {
        if id == DEFAULT_DEVICE_ID || devices.iter().any(|known| known.device_id == id) {
            continue;
        }
        devices.push(MicrophoneDevice {
            label: device_label(&device).unwrap_or_else(|| format!("{fallback} {}", index + 1)),
            device_id: id,
            label_known: Some(true),
        });
    }
    devices
}

/// Microphones; the first entry is `{ deviceId: "default", label: "System default" }`.
pub fn inputs() -> Vec<MicrophoneDevice> {
    list(Direction::Input)
}

/// Speakers for voice output, same shape as [`inputs`].
pub fn outputs() -> Vec<MicrophoneDevice> {
    list(Direction::Output)
}

/// Device lists after a change seen by [`DeviceWatcher`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLists {
    pub inputs: Vec<MicrophoneDevice>,
    pub outputs: Vec<MicrophoneDevice>,
}

/// Polls the device lists and reports changes (for `audio:inputsChanged`).
/// The first poll only records a baseline. Dropping it stops polling.
pub struct DeviceWatcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl DeviceWatcher {
    pub fn spawn(interval: Duration, on_change: impl Fn(DeviceLists) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("delulu-audio-devices".into())
            .spawn(move || {
                let mut last: Option<DeviceLists> = None;
                let step = Duration::from_millis(100);
                while !flag.load(Ordering::Relaxed) {
                    let current = DeviceLists { inputs: inputs(), outputs: outputs() };
                    if last.as_ref().is_some_and(|last| *last != current) {
                        on_change(current.clone());
                    }
                    last = Some(current);
                    let mut waited = Duration::ZERO;
                    while waited < interval && !flag.load(Ordering::Relaxed) {
                        std::thread::sleep(step);
                        waited += step;
                    }
                }
            })
            .ok();
        Self { stop, thread }
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectionState {
    Available,
    Unknown,
    Missing,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MicrophoneSelection {
    pub state: SelectionState,
    pub message: Option<String>,
}

/// Whether the configured microphone is present (`src/microphoneSelection.ts`).
pub fn microphone_selection(
    input_device_id: &str,
    input_device_label: &str,
    devices: &[MicrophoneDevice],
) -> MicrophoneSelection {
    let available = MicrophoneSelection { state: SelectionState::Available, message: None };
    if input_device_id.is_empty() || input_device_id == DEFAULT_DEVICE_ID {
        return available;
    }
    if let Some(selected) = devices.iter().find(|device| device.device_id == input_device_id) {
        if selected.label_known != Some(false) && selected.label != input_device_label {
            return MicrophoneSelection {
                state: SelectionState::Renamed,
                message: Some(format!(
                    "“{input_device_label}” is now named “{}”. The selected input is unchanged.",
                    selected.label
                )),
            };
        }
        return available;
    }
    let known = devices.iter().any(|device| {
        device.label_known == Some(true)
            || (device.device_id != DEFAULT_DEVICE_ID && !device.device_id.is_empty() && device.label_known != Some(false))
    });
    if known {
        MicrophoneSelection {
            state: SelectionState::Missing,
            message: Some(format!(
                "“{input_device_label}” is unavailable. Reconnect it or select another microphone before recording."
            )),
        }
    } else {
        MicrophoneSelection {
            state: SelectionState::Unknown,
            message: Some(format!("“{input_device_label}” is not currently listed. Microphone permission may be hiding device details; recording will check the selected input.")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, label: &str) -> MicrophoneDevice {
        MicrophoneDevice { device_id: id.into(), label: label.into(), label_known: Some(true) }
    }

    #[test]
    fn selection_reports_renamed_and_missing_inputs() {
        let devices = vec![device("default", "System default"), device("pulseaudio:usb", "USB Mic")];
        assert_eq!(microphone_selection("default", "", &devices).state, SelectionState::Available);
        assert_eq!(microphone_selection("pulseaudio:usb", "USB Mic", &devices).state, SelectionState::Available);
        let renamed = microphone_selection("pulseaudio:usb", "Old Mic", &devices);
        assert_eq!(renamed.state, SelectionState::Renamed);
        assert_eq!(
            renamed.message.as_deref(),
            Some("“Old Mic” is now named “USB Mic”. The selected input is unchanged.")
        );
        assert_eq!(microphone_selection("pulseaudio:gone", "Gone", &devices).state, SelectionState::Missing);
    }

    #[test]
    fn wire_shape_and_labels() {
        let json = serde_json::to_value(device("default", "System default")).unwrap();
        assert_eq!(json, serde_json::json!({"deviceId": "default", "label": "System default", "labelKnown": true}));
        assert_eq!(bounded_label("  Mic\u{7}\nOne  "), "Mic  One");
        assert_eq!(bounded_label(&"x".repeat(200)).len(), 160);
        assert!(is_monitor("pulseaudio:alsa_output.pci.analog-stereo.monitor"));
        assert!(!is_monitor("pulseaudio:alsa_input.pci.analog-stereo"));
    }
}
