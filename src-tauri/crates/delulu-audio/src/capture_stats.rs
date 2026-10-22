//! Capture limits (`src/captureLimits.ts`), diagnostics
//! (`src/captureDiagnostics.ts`), the meter level (`src/recorder.ts`) and
//! trailing-silence auto-stop (`src/trailingSilence.ts`).

use serde::{Deserialize, Serialize};

/// Live microphone capture bounds, independent of import size.
pub const MAX_CAPTURE_DURATION_MS: u64 = 10 * 60 * 1000;
pub const MAX_CAPTURE_PCM_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_CAPTURE_SAMPLES: u64 = MAX_CAPTURE_PCM_BYTES / 4;
/// Prefix for a capture that ended before any audio: a tap, not a failure.
pub const TOO_SHORT: &str = "Recording too short";

/// Samples at or above 99.9% of digital full scale may indicate input
/// clipping. This cannot establish whether the microphone or upstream
/// hardware clipped.
pub const CLIPPING_THRESHOLD: f64 = 0.999;

/// Diagnostics of captured mono PCM before resampling/encoding, not hardware
/// gain. Same shape as the TypeScript `CaptureDiagnostics`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    pub sample_count: u64,
    pub sample_rate: u32,
    pub peak_amplitude: f64,
    pub rms_amplitude: f64,
    pub clipped_sample_count: u64,
    pub clipping_threshold: f64,
}

/// Accumulates [`CaptureDiagnostics`] over retained samples.
#[derive(Debug, Default, Clone)]
pub struct CaptureStats {
    pub sample_count: u64,
    peak: f64,
    sum_squares: f64,
    clipped: u64,
}

impl CaptureStats {
    pub fn add(&mut self, samples: &[f32]) {
        for &sample in samples {
            let magnitude = (sample as f64).abs();
            if magnitude > self.peak {
                self.peak = magnitude;
            }
            self.sum_squares += sample as f64 * sample as f64;
            if magnitude >= CLIPPING_THRESHOLD {
                self.clipped += 1;
            }
        }
        self.sample_count += samples.len() as u64;
    }

    /// `None` when nothing was captured.
    pub fn diagnostics(&self, sample_rate: u32) -> Option<CaptureDiagnostics> {
        if self.sample_count == 0 {
            return None;
        }
        Some(CaptureDiagnostics {
            sample_count: self.sample_count,
            sample_rate,
            peak_amplitude: self.peak,
            rms_amplitude: self.peak.min((self.sum_squares / self.sample_count as f64).sqrt()),
            clipped_sample_count: self.clipped,
            clipping_threshold: CLIPPING_THRESHOLD,
        })
    }
}

pub fn rms(samples: &[f32]) -> f64 {
    let sum: f64 = samples.iter().map(|s| *s as f64 * *s as f64).sum();
    (sum / samples.len().max(1) as f64).sqrt()
}

/// Meter value (0–1) for `recorder:level`.
pub fn audible_level(rms: f64) -> f32 {
    (rms * 4.2).clamp(0.0, 1.0) as f32
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SilenceUpdate {
    /// Whole seconds until auto-stop, `None` while not counting down.
    pub remaining_seconds: Option<u32>,
    pub should_stop: bool,
}

/// Packet energy heuristic, not calibrated speech detection. It reads raw PCM
/// without altering it and measures elapsed audio rather than wall time.
#[derive(Debug, Clone)]
pub struct TrailingSilenceStop {
    seconds: f64,
    threshold: f64,
    armed: bool,
    activity_ms: f64,
    quiet_ms: f64,
    stopped: bool,
    remaining_seconds: Option<u32>,
}

impl TrailingSilenceStop {
    pub fn new(seconds: f64, threshold_db: f64) -> Self {
        let seconds = if seconds.is_finite() { seconds } else { 5.0 }.clamp(2.0, 30.0);
        let db = if threshold_db.is_finite() { threshold_db } else { -45.0 }.clamp(-60.0, -20.0);
        Self {
            seconds,
            threshold: 10f64.powf(db / 20.0),
            armed: false,
            activity_ms: 0.0,
            quiet_ms: 0.0,
            stopped: false,
            remaining_seconds: None,
        }
    }

    pub fn reset(&mut self) {
        self.armed = false;
        self.activity_ms = 0.0;
        self.quiet_ms = 0.0;
        self.stopped = false;
        self.remaining_seconds = None;
    }

    pub fn update(&mut self, samples: &[f32], sample_rate: f64) -> SilenceUpdate {
        let idle = |remaining| SilenceUpdate { remaining_seconds: remaining, should_stop: false };
        if self.stopped {
            return idle(Some(0));
        }
        if samples.is_empty() || !sample_rate.is_finite() || sample_rate <= 0.0 {
            return idle(self.remaining_seconds);
        }
        let duration_ms = samples.len() as f64 / sample_rate * 1000.0;
        if !duration_ms.is_finite() {
            return idle(self.remaining_seconds);
        }
        let mut energy = 0.0;
        for &sample in samples {
            if !sample.is_finite() {
                // Unknown input is neither silence nor evidence for arming.
                self.activity_ms = 0.0;
                self.quiet_ms = 0.0;
                self.remaining_seconds = None;
                return idle(None);
            }
            energy += sample as f64 * sample as f64;
        }
        let rms = (energy / samples.len() as f64).sqrt();
        if rms > self.threshold {
            self.activity_ms += duration_ms;
            if self.activity_ms >= 150.0 {
                self.armed = true;
            }
            self.quiet_ms = 0.0;
            self.remaining_seconds = None;
            return idle(None);
        }
        self.activity_ms = 0.0;
        if !self.armed {
            return idle(None);
        }
        self.quiet_ms += duration_ms;
        if self.quiet_ms >= self.seconds * 1000.0 {
            self.stopped = true;
            self.remaining_seconds = Some(0);
            return SilenceUpdate { remaining_seconds: Some(0), should_stop: true };
        }
        let remaining = (self.seconds - self.quiet_ms / 1000.0).ceil() as u32;
        self.remaining_seconds = Some(remaining);
        idle(Some(remaining))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_report_peak_rms_and_clipping() {
        let mut stats = CaptureStats::default();
        assert!(stats.diagnostics(48_000).is_none());
        stats.add(&[0.5, -0.5, 1.0, -0.9995]);
        let d = stats.diagnostics(48_000).unwrap();
        assert_eq!(d.sample_count, 4);
        assert_eq!(d.peak_amplitude, 1.0);
        assert_eq!(d.clipped_sample_count, 2);
        let expected = ((0.25 + 0.25 + 1.0 + 0.9995f32 as f64 * 0.9995f32 as f64) / 4.0).sqrt();
        assert!((d.rms_amplitude - expected).abs() < 1e-9);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["clippingThreshold"], 0.999);
        assert_eq!(json["clippedSampleCount"], 2);
        assert_eq!(json["sampleRate"], 48_000);
    }

    #[test]
    fn level_is_scaled_and_bounded() {
        assert_eq!(audible_level(0.0), 0.0);
        assert!((audible_level(0.1) - 0.42).abs() < 1e-6);
        assert_eq!(audible_level(1.0), 1.0);
        assert!((rms(&[0.5, -0.5]) - 0.5).abs() < 1e-12);
    }

    /// 2048-sample blocks at 48 kHz, like the capture worklet delivered.
    fn block(value: f32) -> Vec<f32> {
        vec![value; 2048]
    }

    #[test]
    fn trailing_silence_arms_on_speech_then_counts_down_and_stops() {
        let mut stop = TrailingSilenceStop::new(2.0, -45.0);
        // Silence before any speech never counts down.
        for _ in 0..100 {
            assert_eq!(stop.update(&block(0.0), 48_000.0), SilenceUpdate { remaining_seconds: None, should_stop: false });
        }
        // ~42.7 ms per block: four blocks of speech (>= 150 ms) arm it.
        for _ in 0..4 {
            assert_eq!(stop.update(&block(0.1), 48_000.0).remaining_seconds, None);
        }
        let first = stop.update(&block(0.0), 48_000.0);
        assert_eq!(first, SilenceUpdate { remaining_seconds: Some(2), should_stop: false });
        let mut updates = vec![];
        loop {
            let update = stop.update(&block(0.0), 48_000.0);
            updates.push(update);
            if update.should_stop {
                break;
            }
            assert!(updates.len() < 100);
        }
        // 2 s of quiet = 47 blocks; the countdown passes through 1.
        assert_eq!(updates.len() + 1, 47);
        assert!(updates.iter().any(|u| u.remaining_seconds == Some(1)));
        assert_eq!(updates.last().unwrap().remaining_seconds, Some(0));
        // After stopping it stays at zero without asking to stop again.
        assert_eq!(stop.update(&block(0.1), 48_000.0), SilenceUpdate { remaining_seconds: Some(0), should_stop: false });
    }

    #[test]
    fn trailing_silence_resets_on_speech_and_non_finite_input() {
        let mut stop = TrailingSilenceStop::new(5.0, -45.0);
        for _ in 0..4 {
            stop.update(&block(0.1), 48_000.0);
        }
        assert_eq!(stop.update(&block(0.0), 48_000.0).remaining_seconds, Some(5));
        assert_eq!(stop.update(&block(0.1), 48_000.0).remaining_seconds, None);
        assert_eq!(stop.update(&block(0.0), 48_000.0).remaining_seconds, Some(5));
        let mut broken = block(0.0);
        broken[3] = f32::NAN;
        assert_eq!(stop.update(&broken, 48_000.0).remaining_seconds, None);
        // Out-of-range settings clamp: 0.5 s becomes 2 s, -10 dB becomes -20 dB.
        let mut clamped = TrailingSilenceStop::new(0.5, -10.0);
        for _ in 0..4 {
            clamped.update(&block(0.2), 48_000.0);
        }
        assert_eq!(clamped.update(&block(0.05), 48_000.0).remaining_seconds, Some(2));
        stop.reset();
        assert_eq!(stop.update(&block(0.0), 48_000.0).remaining_seconds, None);
    }
}
