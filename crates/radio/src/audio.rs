//! Decoding, checks and storage for station audio. Everything is kept as
//! interleaved stereo f32 at the source rate; the player resamples once per track.
use crate::RadioError;
use rubato::{FftFixedIn, Resampler};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub rate: u32,
    /// Interleaved left/right.
    pub samples: Vec<f32>,
}

impl Audio {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / self.rate.max(1) as f64
    }
    fn peak(&self) -> f32 {
        self.samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }
}

/// Signal checks a track must pass before it may air. They prove the file is
/// playable and not empty or broken; they say nothing about musical quality.
#[derive(Debug, Clone, PartialEq)]
pub struct Checks {
    pub seconds: f64,
    pub peak: f32,
    pub clipped: f64,
}

fn bad(message: impl Into<String>) -> RadioError {
    RadioError::Audio(message.into())
}

fn stereo(channels: usize, mut next: impl FnMut() -> Option<f32>) -> Vec<f32> {
    let mut out = Vec::new();
    let mut frame = vec![0.0f32; channels];
    'frames: loop {
        for slot in frame.iter_mut() {
            match next() {
                Some(v) => *slot = v,
                None => break 'frames,
            }
        }
        if channels == 1 {
            out.extend([frame[0], frame[0]]);
        } else {
            out.extend([frame[0], frame[1]]);
        }
    }
    out
}

/// Decode a WAV or FLAC file to stereo f32.
pub fn decode(path: &Path) -> Result<Audio, RadioError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "wav" => decode_wav(path),
        "flac" => decode_flac(path),
        _ => Err(bad(format!("unsupported audio file: {}", path.display()))),
    }
}

fn decode_wav(path: &Path) -> Result<Audio, RadioError> {
    let mut reader = hound::WavReader::open(path).map_err(|e| bad(format!("{e}")))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    if channels == 0 || spec.sample_rate == 0 {
        return Err(bad("WAV has no channels"));
    }
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => {
            let mut it = reader.samples::<f32>();
            stereo(channels, || it.next().and_then(Result::ok))
        }
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
            let mut it = reader.samples::<i32>();
            stereo(channels, || {
                it.next().and_then(Result::ok).map(|v| v as f32 * scale)
            })
        }
    };
    Ok(Audio {
        rate: spec.sample_rate,
        samples,
    })
}

fn decode_flac(path: &Path) -> Result<Audio, RadioError> {
    let mut reader = claxon::FlacReader::open(path).map_err(|e| bad(format!("{e}")))?;
    let info = reader.streaminfo();
    let channels = info.channels as usize;
    if channels == 0 || info.sample_rate == 0 {
        return Err(bad("FLAC has no channels"));
    }
    let scale = 1.0 / (1i64 << (info.bits_per_sample - 1)) as f32;
    let mut it = reader.samples();
    let samples = stereo(channels, || {
        it.next().and_then(Result::ok).map(|v| v as f32 * scale)
    });
    Ok(Audio {
        rate: info.sample_rate,
        samples,
    })
}

/// Reject missing, too short, silent or badly clipped audio.
pub fn check(audio: &Audio, min_seconds: f64) -> Result<Checks, RadioError> {
    let seconds = audio.seconds();
    if seconds < min_seconds {
        return Err(bad(format!("audio is only {seconds:.1} s long")));
    }
    let peak = audio.peak();
    if peak < 0.01 {
        return Err(bad("audio is silent"));
    }
    let clipped = audio.samples.iter().filter(|s| s.abs() >= 0.999).count() as f64
        / audio.samples.len().max(1) as f64;
    if clipped > 0.01 {
        return Err(bad(format!(
            "audio is clipped ({:.1}% of samples)",
            clipped * 100.0
        )));
    }
    Ok(Checks {
        seconds,
        peak,
        clipped,
    })
}

/// Scale to a -0.9 dBFS peak without changing the channels or rate.
pub fn normalize(audio: &mut Audio) {
    let peak = audio.peak();
    if peak > 0.0 {
        let gain = 0.9 / peak;
        audio.samples.iter_mut().for_each(|s| *s *= gain);
    }
}

/// Write 16-bit stereo PCM atomically.
pub fn write_wav(path: &Path, audio: &Audio) -> Result<(), RadioError> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: audio.rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let temp = path.with_extension("wav.tmp");
    let result = (|| -> Result<(), hound::Error> {
        let mut writer = hound::WavWriter::create(&temp, spec)?;
        for s in &audio.samples {
            writer.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)?;
        }
        writer.finalize()
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(bad(format!("write {}: {e}", path.display())));
    }
    std::fs::rename(&temp, path).map_err(|e| RadioError::Io(format!("{}: {e}", path.display())))
}

/// Interleaved stereo at `to` Hz.
pub fn resample(audio: &Audio, to: u32) -> Result<Vec<f32>, RadioError> {
    if audio.rate == to {
        return Ok(audio.samples.clone());
    }
    const CHUNK: usize = 1024;
    let mut resampler = FftFixedIn::<f32>::new(audio.rate as usize, to as usize, CHUNK, 2, 2)
        .map_err(|e| bad(format!("resampler: {e}")))?;
    let (left, right): (Vec<f32>, Vec<f32>) = audio
        .samples
        .as_chunks::<2>()
        .0
        .iter()
        .map(|f| (f[0], f[1]))
        .unzip();
    let mut out = Vec::with_capacity(
        (audio.samples.len() as f64 * to as f64 / audio.rate as f64) as usize + 4096,
    );
    let push = |out: &mut Vec<f32>, block: Vec<Vec<f32>>| {
        for (l, r) in block[0].iter().zip(&block[1]) {
            out.extend([*l, *r]);
        }
    };
    let mut pos = 0;
    while pos + CHUNK <= left.len() {
        let block = resampler
            .process(&[&left[pos..pos + CHUNK], &right[pos..pos + CHUNK]], None)
            .map_err(|e| bad(format!("resample: {e}")))?;
        push(&mut out, block);
        pos += CHUNK;
    }
    let block = resampler
        .process_partial(Some(&[&left[pos..], &right[pos..]]), None)
        .map_err(|e| bad(format!("resample: {e}")))?;
    push(&mut out, block);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, seconds: f64, amp: f32) -> Audio {
        let frames = (rate as f64 * seconds) as usize;
        let samples = (0..frames)
            .flat_map(|i| {
                let v = amp * (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin();
                [v, v]
            })
            .collect();
        Audio { rate, samples }
    }

    #[test]
    fn wav_round_trip_keeps_rate_and_length() {
        let dir = std::env::temp_dir().join(format!("radio-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.wav");
        let audio = tone(44100, 1.5, 0.5);
        write_wav(&path, &audio).unwrap();
        let back = decode(&path).unwrap();
        assert_eq!(back.rate, 44100);
        assert_eq!(back.frames(), audio.frames());
        assert!((back.samples[100] - audio.samples[100]).abs() < 1e-3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checks_reject_short_silent_and_clipped() {
        assert!(check(&tone(48000, 0.5, 0.5), 1.0).is_err());
        assert!(check(&tone(48000, 2.0, 0.001), 1.0).is_err());
        assert!(check(&tone(48000, 2.0, 4.0).clamped(), 1.0).is_err());
        let ok = check(&tone(48000, 2.0, 0.5), 1.0).unwrap();
        assert!((ok.seconds - 2.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_sets_peak() {
        let mut audio = tone(48000, 1.0, 0.2);
        normalize(&mut audio);
        assert!((audio.peak() - 0.9).abs() < 1e-3);
    }

    #[test]
    fn resample_scales_length() {
        let audio = tone(44100, 1.0, 0.5);
        let out = resample(&audio, 48000).unwrap();
        let frames = out.len() / 2;
        assert!((frames as i64 - 48000).abs() < 2048, "{frames}");
    }

    impl Audio {
        fn clamped(mut self) -> Audio {
            self.samples
                .iter_mut()
                .for_each(|s| *s = s.clamp(-1.0, 1.0));
            self
        }
    }
}
