//! Speech detection: is anyone speaking in this recording, and for how long.
//!
//! Whisper writes text for breathing, typing and mouse clicks ("*Sigh*", "Okay.",
//! "Thank you."), and its own no-speech probability is no help: whisper.cpp reads it at
//! a position where large-v3-turbo never predicts it. So a separate voice-activity
//! detector decides: Silero VAD v6.2.0 (MIT, Silero Team; `assets/LICENSE.silero-vad`),
//! as converted for whisper.cpp by ggml-org (huggingface.co/ggml-org/whisper-vad). It is
//! 885 KB, built into the binary, and runs on the CPU in about 2 ms per second of audio,
//! alongside Whisper on the GPU. Unlike a level or spectrum gate it tells whispering
//! from breathing, and short words from clicks.
use super::SttError;
use std::ffi::{c_char, c_void, CStr};
use std::io::Write;
use std::ops::Range;
use std::ptr::NonNull;
use whisper_rs_sys as sys;

static MODEL: &[u8] = include_bytes!("../../assets/ggml-silero-v6.2.0.bin");

pub(crate) struct Vad {
    ctx: NonNull<sys::whisper_vad_context>,
}

// The context is only ever used through `&mut self`.
unsafe impl Send for Vad {}

struct Reader {
    data: &'static [u8],
    at: usize,
}

unsafe extern "C" fn read(ctx: *mut c_void, output: *mut c_void, size: usize) -> usize {
    let reader = unsafe { &mut *(ctx as *mut Reader) };
    let n = size.min(reader.data.len() - reader.at);
    unsafe {
        std::ptr::copy_nonoverlapping(reader.data.as_ptr().add(reader.at), output as *mut u8, n)
    };
    reader.at += n;
    n
}

unsafe extern "C" fn eof(ctx: *mut c_void) -> bool {
    let reader = unsafe { &*(ctx as *const Reader) };
    reader.at >= reader.data.len()
}

unsafe extern "C" fn close(_: *mut c_void) {}

/// whisper.cpp's log, as its default writes it, without the detector's progress lines:
/// it reports every call (about ten lines per dictation), which would fill the journal.
unsafe extern "C" fn log(level: sys::ggml_log_level, text: *const c_char, _: *mut c_void) {
    if text.is_null() {
        return;
    }
    let text = unsafe { CStr::from_ptr(text) }.to_bytes();
    if level == sys::ggml_log_level_GGML_LOG_LEVEL_INFO && text.starts_with(b"whisper_vad") {
        return;
    }
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(text);
    let _ = stderr.flush();
}

impl Vad {
    pub(crate) fn load() -> Result<Self, SttError> {
        static QUIET: std::sync::Once = std::sync::Once::new();
        QUIET.call_once(|| unsafe { sys::whisper_log_set(Some(log), std::ptr::null_mut()) });
        let mut reader = Reader { data: MODEL, at: 0 };
        let mut loader = sys::whisper_model_loader {
            context: &mut reader as *mut Reader as *mut c_void,
            read: Some(read),
            eof: Some(eof),
            close: Some(close),
        };
        let mut params = unsafe { sys::whisper_vad_default_context_params() };
        // Two threads: Whisper keeps the rest of the CPU for its own work.
        params.n_threads = 2;
        params.use_gpu = false;
        // The loader and the reader only need to live for this call.
        let ctx = unsafe { sys::whisper_vad_init_with_params(&mut loader, params) };
        NonNull::new(ctx)
            .map(|ctx| Self { ctx })
            .ok_or_else(|| SttError::Model("the speech detector did not load".into()))
    }

    /// The stretches of speech in `samples` (16 kHz mono), in seconds. A stretch is at
    /// least 200 ms long: a clipped "ja" or "stop" still is one, and no click or breath
    /// in the test sets was (at 150 ms, two breaths were).
    pub(crate) fn speech(&mut self, samples: &[f32]) -> Result<Vec<Range<f32>>, SttError> {
        let failed = || SttError::Inference("speech detection failed".into());
        let n = i32::try_from(samples.len()).map_err(|_| failed())?;
        unsafe {
            if !sys::whisper_vad_detect_speech(self.ctx.as_ptr(), samples.as_ptr(), n) {
                return Err(failed());
            }
            let mut params = sys::whisper_vad_default_params();
            params.min_speech_duration_ms = 200;
            let segments = sys::whisper_vad_segments_from_probs(self.ctx.as_ptr(), params);
            if segments.is_null() {
                return Err(failed());
            }
            // whisper.cpp gives the times in hundredths of a second.
            let stretches = (0..sys::whisper_vad_segments_n_segments(segments))
                .map(|i| {
                    sys::whisper_vad_segments_get_segment_t0(segments, i) / 100.0
                        ..sys::whisper_vad_segments_get_segment_t1(segments, i) / 100.0
                })
                .collect();
            sys::whisper_vad_free_segments(segments);
            Ok(stretches)
        }
    }
}

impl Drop for Vad {
    fn drop(&mut self) {
        unsafe { sys::whisper_vad_free(self.ctx.as_ptr()) }
    }
}

/// Seconds of speech within `within` (seconds), given the stretches found.
pub(crate) fn speech_within(stretches: &[Range<f32>], within: Range<f32>) -> f32 {
    stretches
        .iter()
        .map(|s| (s.end.min(within.end) - s.start.max(within.start)).max(0.0))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 16_000.0;

    /// White noise at about -30 dBFS: hiss, a fan, breath noise.
    fn noise(seconds: f32) -> Vec<f32> {
        let mut seed = 7u32;
        (0..(seconds * RATE) as usize)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.1
            })
            .collect()
    }

    /// Clicks: 5 ms bursts four times a second, silence between them.
    fn clicks(seconds: f32) -> Vec<f32> {
        let noise = noise(seconds);
        noise
            .iter()
            .enumerate()
            .map(|(i, x)| if i % 4000 < 80 { x * 8.0 } else { 0.0 })
            .collect()
    }

    /// Something shaped like speech: a voice whose pitch glides between 100 and 160 Hz,
    /// shaped by two vowel formants that move, in syllables of 200 ms with short gaps.
    fn speech_like(seconds: f32) -> Vec<f32> {
        let n = (seconds * RATE) as usize;
        let (mut phase, mut out) = (0.0f32, Vec::with_capacity(n));
        // Two resonators (formants) fed by a pulse train (the vocal folds).
        let (mut y1, mut y2, mut z1, mut z2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for i in 0..n {
            let t = i as f32 / RATE;
            let pitch = 130.0 + 30.0 * (t * 2.0 * std::f32::consts::PI * 0.7).sin();
            phase += pitch / RATE;
            let pulse = if phase >= 1.0 {
                phase -= 1.0;
                1.0
            } else {
                0.0
            };
            let syllable = (t * 4.0).fract();
            let vowel = (t * 4.0) as usize % 3;
            let (f1, f2) = [(700.0, 1200.0), (300.0, 2300.0), (500.0, 900.0)][vowel];
            let resonate = |x: f32, y1: &mut f32, y2: &mut f32, f: f32| {
                let r = 0.97f32;
                let w = 2.0 * std::f32::consts::PI * f / RATE;
                let y = x + 2.0 * r * w.cos() * *y1 - r * r * *y2;
                *y2 = *y1;
                *y1 = y;
                y
            };
            let a = resonate(pulse, &mut y1, &mut y2, f1);
            let b = resonate(pulse, &mut z1, &mut z2, f2);
            let envelope = if syllable < 0.8 {
                (syllable / 0.8 * std::f32::consts::PI).sin()
            } else {
                0.0
            };
            out.push((a + 0.6 * b) * envelope * 0.02);
        }
        out
    }

    fn seconds_of_speech(samples: &[f32]) -> f32 {
        let stretches = Vad::load().unwrap().speech(samples).unwrap();
        stretches.iter().map(|s| s.end - s.start).sum()
    }

    #[test]
    fn noise_and_clicks_hold_no_speech() {
        assert_eq!(seconds_of_speech(&noise(3.0)), 0.0);
        assert_eq!(seconds_of_speech(&clicks(3.0)), 0.0);
        assert_eq!(seconds_of_speech(&vec![0.0; 48_000]), 0.0);
    }

    #[test]
    fn a_speech_like_signal_is_speech() {
        let mut samples = vec![0.0; 8_000];
        samples.extend(speech_like(2.0));
        samples.extend(vec![0.0; 8_000]);
        let speech = seconds_of_speech(&samples);
        // The detector is cautious with a synthetic voice; any of it is speech.
        assert!(speech > 0.5, "{speech} s of speech");
    }

    #[test]
    fn speech_is_counted_within_a_range() {
        let stretches = [1.0..2.0, 3.0..5.0];
        assert_eq!(speech_within(&stretches, 0.0..10.0), 3.0);
        assert_eq!(speech_within(&stretches, 1.5..4.0), 1.5);
        assert_eq!(speech_within(&stretches, 5.0..9.0), 0.0);
    }
}
