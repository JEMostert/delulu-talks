//! Native audio for Delulu Talks: microphone capture for dictation and
//! listening sessions, 16 kHz resampling and WAV encoding, trailing-silence
//! auto-stop, capture cues, utterance segmentation with barge-in, and voice
//! playback. Ported from the Electron renderer (`src/recorder.ts`,
//! `src/listenCapture.ts`, `src/voicePlayer.ts` and their helpers).
//!
//! Every cpal stream lives on a dedicated thread (streams are not `Send` on
//! every platform); the handles here are thread-safe and talk to those
//! threads over channels. Real-time callbacks only copy samples.

// `DomainError` is the workspace's shared (frozen) error contract.
#![allow(clippy::result_large_err)]

mod capture_stats;
mod cues;
mod devices;
mod input;
mod listen;
mod output;
mod player;
mod recorder;
mod resample;
mod vad;
mod wav;

pub use capture_stats::{
    audible_level, CaptureDiagnostics, CaptureStats, SilenceUpdate, TrailingSilenceStop, CLIPPING_THRESHOLD,
    MAX_CAPTURE_DURATION_MS, MAX_CAPTURE_PCM_BYTES, MAX_CAPTURE_SAMPLES, TOO_SHORT,
};
pub use cues::{cue_samples, Cue, Cues};
pub use devices::{
    host_name, inputs, microphone_selection, outputs, DeviceLists, DeviceWatcher, MicrophoneDevice,
    MicrophoneSelection, SelectionState, DEFAULT_DEVICE_ID,
};
pub use listen::{
    ListenCapture, ListenConfig, ListenEvent, ListenState, PlaybackReference, LEVEL_RATE, MAX_UTTERANCE_WAV_BYTES,
};
pub use player::{PlaybackChunk, PlaybackEvent, PlaybackEventKind, Player};
pub use recorder::{Recorder, RecorderEvent, RecorderOptions, Recording, TrailingSilence};
pub use resample::{resample, Resampler};
pub use vad::{FrameContext, SegmenterConfig, SegmenterEvent, UtteranceSegmenter};
pub use wav::{pcm16le_to_f32, wav, SPEECH_SAMPLE_RATE};
