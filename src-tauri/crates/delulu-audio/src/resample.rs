//! Windowed-sinc (Kaiser) resampling, ported from `src/captureResample.ts`.
//!
//! The low-pass sits below the lower Nyquist rate, so speech harmonics above
//! it are removed instead of aliasing into the band the speech model hears.
//! [`Resampler`] streams: feeding the input in any number of pieces and then
//! calling [`Resampler::finish`] yields exactly what [`resample`] returns for
//! the concatenated input.

const STOPBAND_DB: f64 = 70.0;
const KAISER_BETA: f64 = 0.1102 * (STOPBAND_DB - 8.7);
const MAX_PHASES: u64 = 4096;

fn bessel_i0(value: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = value / 2.0;
    for k in 1..64 {
        let k = k as f64;
        term *= (half / k) * (half / k);
        sum += term;
        if term < sum * 1e-12 {
            break;
        }
    }
    sum
}

fn gcd(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

/// Streaming mono resampler. Output sample `i` is centred on input position
/// `i * source_rate / target_rate`; the recording edges are zero padded.
pub struct Resampler {
    passthrough: bool,
    ratio: f64,
    half: usize,
    width: usize,
    phases: u64,
    /// Input samples per output sample in phase units; 0 when the ratio is not
    /// an exact fraction with at most [`MAX_PHASES`] phases.
    step: u64,
    kernel: Vec<f32>,
    /// Retained input, starting at absolute input index `buffer_start`.
    buffer: Vec<f32>,
    buffer_start: u64,
    input_len: u64,
    next_out: u64,
    finished: bool,
}

impl Resampler {
    pub fn new(source_rate: u32, target_rate: u32) -> Self {
        let source = source_rate.max(1) as f64;
        let target = target_rate.max(1) as f64;
        let passthrough = source_rate == target_rate;
        let ratio = source / target;
        let nyquist = source.min(target) / 2.0;
        // Pass up to 0.75 x Nyquist (6 kHz for 16 kHz output); stop from 1.05 x,
        // so anything that folds back lands above the passband.
        let cutoff = (0.9 * nyquist) / source;
        let transition = (0.3 * nyquist) / source;
        let taps = ((STOPBAND_DB - 8.0) / (2.285 * 2.0 * std::f64::consts::PI * transition)).ceil();
        let half = ((taps / 2.0).ceil() as usize).max(2);
        let width = half * 2;

        let exact = gcd(source_rate.max(1) as u64, target_rate.max(1) as u64);
        let exact_phases = target_rate.max(1) as u64 / exact;
        let (phases, step) = if exact_phases <= MAX_PHASES {
            (exact_phases, source_rate.max(1) as u64 / exact)
        } else {
            (MAX_PHASES, 0)
        };

        let mut kernel = Vec::new();
        if !passthrough {
            kernel = vec![0.0f32; phases as usize * width];
            let normalizer = bessel_i0(KAISER_BETA);
            let mut values = vec![0.0f64; width];
            for phase in 0..phases as usize {
                let fraction = phase as f64 / phases as f64;
                let mut sum = 0.0;
                for (tap, slot) in values.iter_mut().enumerate() {
                    // Tap `tap` reads input[base - half + 1 + tap].
                    let distance = fraction - (tap as f64 - half as f64 + 1.0);
                    let x = 2.0 * cutoff * distance;
                    let sinc = if x == 0.0 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    let position = distance / half as f64;
                    let window = if position.abs() >= 1.0 {
                        0.0
                    } else {
                        bessel_i0(KAISER_BETA * (1.0 - position * position).sqrt()) / normalizer
                    };
                    *slot = sinc * window;
                    sum += *slot;
                }
                // Unity DC gain per phase keeps quantized phases from adding ripple.
                for (tap, value) in values.iter().enumerate() {
                    kernel[phase * width + tap] = (value / sum) as f32;
                }
            }
        }
        Self {
            passthrough,
            ratio,
            half,
            width,
            phases,
            step,
            kernel,
            buffer: Vec::new(),
            buffer_start: 0,
            input_len: 0,
            next_out: 0,
            finished: false,
        }
    }

    /// Output samples emitted so far.
    pub fn output_len(&self) -> u64 {
        self.next_out
    }

    /// Input samples consumed so far.
    pub fn input_len(&self) -> u64 {
        self.input_len
    }

    /// Whether input is held back waiting for more context.
    pub fn has_pending(&self) -> bool {
        !self.passthrough && !self.finished && self.input_len > 0 && self.next_out < self.final_len()
    }

    fn final_len(&self) -> u64 {
        if self.input_len == 0 {
            0
        } else {
            ((self.input_len as f64 / self.ratio).round() as u64).max(1)
        }
    }

    fn locate(&self, index: u64) -> (i64, usize) {
        if self.step != 0 {
            let numerator = index * self.step;
            let base = numerator / self.phases;
            ((base) as i64, (numerator - base * self.phases) as usize)
        } else {
            let position = index as f64 * self.ratio;
            let mut base = position.floor();
            let mut phase = ((position - base) * self.phases as f64).round() as u64;
            if phase == self.phases {
                base += 1.0;
                phase = 0;
            }
            (base as i64, phase as usize)
        }
    }

    fn compute(&self, base: i64, phase: usize) -> f32 {
        let offset = phase * self.width;
        let kernel = &self.kernel[offset..offset + self.width];
        let first = base - self.half as i64 + 1;
        let last = self.input_len as i64 - 1;
        let mut value = 0.0f64;
        if first >= self.buffer_start as i64 && first + self.width as i64 - 1 <= last {
            let start = (first - self.buffer_start as i64) as usize;
            for (sample, tap) in self.buffer[start..start + self.width].iter().zip(kernel) {
                value += *sample as f64 * *tap as f64;
            }
        } else {
            // Zero padding at the recording edges.
            for (tap, weight) in kernel.iter().enumerate() {
                let source = first + tap as i64;
                if source >= self.buffer_start as i64 && source <= last {
                    value += self.buffer[(source - self.buffer_start as i64) as usize] as f64 * *weight as f64;
                }
            }
        }
        value as f32
    }

    /// Feeds input and appends every output sample whose taps are available.
    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if self.finished || input.is_empty() {
            return;
        }
        self.input_len += input.len() as u64;
        if self.passthrough {
            output.extend_from_slice(input);
            self.next_out = self.input_len;
            return;
        }
        self.buffer.extend_from_slice(input);
        let available = self.final_len();
        while self.next_out < available {
            let (base, phase) = self.locate(self.next_out);
            let first = base - self.half as i64 + 1;
            if first + self.width as i64 > self.input_len as i64 {
                break;
            }
            output.push(self.compute(base, phase));
            self.next_out += 1;
        }
        self.trim();
    }

    /// Emits the remaining output with zero padding at the end.
    pub fn finish(&mut self, output: &mut Vec<f32>) {
        if self.finished {
            return;
        }
        self.finished = true;
        if self.passthrough {
            return;
        }
        let total = self.final_len();
        while self.next_out < total {
            let (base, phase) = self.locate(self.next_out);
            output.push(self.compute(base, phase));
            self.next_out += 1;
        }
        self.buffer = Vec::new();
    }

    fn trim(&mut self) {
        let (base, _) = self.locate(self.next_out);
        let needed = (base - self.half as i64 + 1).max(0) as u64;
        let dead = needed.saturating_sub(self.buffer_start) as usize;
        if dead >= 8192 && dead <= self.buffer.len() {
            self.buffer.drain(..dead);
            self.buffer_start += dead as u64;
        }
    }
}

/// Resamples mono PCM in one go. Returns the input unchanged when the rates
/// match, and nothing for empty input.
pub fn resample(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == target_rate {
        return input.to_vec();
    }
    let mut resampler = Resampler::new(source_rate, target_rate);
    let mut output = Vec::with_capacity((input.len() as f64 * target_rate as f64 / source_rate as f64) as usize + 1);
    resampler.process(input, &mut output);
    resampler.finish(&mut output);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frequency: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let count = (rate as f64 * seconds).round() as usize;
        (0..count)
            .map(|index| (2.0 * std::f64::consts::PI * frequency * index as f64 / rate as f64).sin() as f32)
            .collect()
    }

    /// RMS level in dB of the middle half, away from zero-padded edges.
    fn level(samples: &[f32]) -> f64 {
        let from = samples.len() / 4;
        let to = samples.len() * 3 / 4;
        let sum: f64 = samples[from..to].iter().map(|s| (*s as f64) * (*s as f64)).sum();
        10.0 * (sum / (to - from) as f64).log10()
    }

    #[test]
    fn keeps_speech_band_tones() {
        let reference = level(&tone(1000.0, 16_000, 0.5));
        for rate in [44_100, 48_000] {
            let output = resample(&tone(1000.0, rate, 0.5), rate, 16_000);
            assert_eq!(output.len(), 8000);
            assert!((level(&output) - reference).abs() < 1.0, "rate {rate}");
        }
    }

    #[test]
    fn removes_tones_that_would_alias_into_speech() {
        let reference = level(&tone(1000.0, 16_000, 0.5));
        for frequency in [9_000.0, 12_000.0, 20_000.0] {
            let output = resample(&tone(frequency, 48_000, 0.5), 48_000, 16_000);
            assert!(level(&output) - reference < -40.0, "{frequency} Hz");
        }
    }

    #[test]
    fn returns_the_input_when_no_conversion_is_needed() {
        let input = tone(440.0, 16_000, 0.1);
        assert_eq!(resample(&input, 16_000, 16_000), input);
        assert!(resample(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn streaming_matches_one_shot() {
        for (source, target) in [(48_000, 16_000), (44_100, 16_000), (24_000, 48_000), (47_999, 16_000)] {
            let input = tone(700.0, source, 0.37);
            let expected = resample(&input, source, target);
            let mut resampler = Resampler::new(source, target);
            let mut output = Vec::new();
            for piece in input.chunks(333) {
                resampler.process(piece, &mut output);
            }
            assert!(resampler.has_pending());
            resampler.finish(&mut output);
            assert_eq!(output, expected, "{source} -> {target}");
        }
    }

    /// Run with `--release --ignored`; the TypeScript bound was 15 s.
    #[test]
    #[ignore]
    fn handles_ten_minutes_of_48_khz_audio_quickly() {
        let started = std::time::Instant::now();
        let output = resample(&vec![0.0; 48_000 * 600], 48_000, 16_000);
        assert_eq!(output.len(), 16_000 * 600);
        let elapsed = started.elapsed();
        eprintln!("10 min of 48 kHz resampled in {elapsed:?}");
        assert!(elapsed.as_secs() < 15);
    }
}
