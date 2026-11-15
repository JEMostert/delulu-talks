//! Decoding, checks and storage for station audio. Items are stored as Ogg Opus
//! with their EBU R128 loudness; older stations hold WAV files until the background
//! conversion reaches them. Decoded audio is interleaved stereo f32 at the source
//! rate; the player resamples once per track.
use crate::model::Loudness;
use crate::RadioError;
use ebur128::{EbuR128, Mode};
use ogg::reading::PacketReader;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opus1::{Application, Bitrate, Channels, OpusDecoder, OpusEncoder, SampleRate, Signal};
use rubato::{FftFixedIn, Resampler};
use std::num::NonZeroU32;
use std::path::Path;

/// Opus codes and decodes at 48 kHz.
pub const OPUS_RATE: u32 = 48_000;
/// 20 ms.
const OPUS_FRAME: usize = 960;
/// The longest Opus packet, 120 ms.
const OPUS_MAX_FRAME: usize = 5760;
const OGG_SERIAL: u32 = 0x4445_4c55;
/// End an Ogg page about every second.
const PACKETS_PER_PAGE: usize = 50;

/// Playback evens items out towards this integrated loudness…
pub const TARGET_LUFS: f64 = -16.0;
/// …with a gain within these bounds (dB)…
pub const MAX_BOOST_DB: f64 = 6.0;
pub const MAX_CUT_DB: f64 = 12.0;
/// …and true peaks kept under this (dBTP): where the gain would lift them past
/// it, a look-ahead limiter holds the samples at `LIMIT_DB`.
pub const PEAK_CEILING_DB: f64 = -1.0;
pub const LIMIT_DB: f64 = PEAK_CEILING_DB - 0.5;
/// The limiter reaches its gain this far ahead of a peak…
const LIMIT_LOOKAHEAD_SECONDS: f64 = 0.005;
/// …and recovers with this time constant.
const LIMIT_RELEASE_SECONDS: f64 = 0.15;
/// BS.1770's absolute gate; anything quieter counts as silence.
const SILENCE_LUFS: f64 = -70.0;

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
    pub fn peak(&self) -> f32 {
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

/// Decode an Opus, WAV or FLAC file to stereo f32.
pub fn decode(path: &Path) -> Result<Audio, RadioError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "opus" => decode_opus_file(path),
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

/// Fade the last `seconds` out (an equal-power curve), for music cut at its length limit.
pub fn fade_out(audio: &mut Audio, seconds: f64) {
    let frames = audio.frames();
    let fade = ((seconds * audio.rate as f64) as usize).min(frames);
    for i in 0..fade {
        let gain = ((fade - i) as f32 / fade as f32 * std::f32::consts::FRAC_PI_2).sin();
        let f = frames - fade + i;
        audio.samples[f * 2] *= gain;
        audio.samples[f * 2 + 1] *= gain;
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

/// What an item holds; it sets the Opus bitrate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Content {
    Music,
    Speech,
}

impl Content {
    fn bitrate(self, channels: usize) -> u32 {
        match (self, channels) {
            // Transparent for stereo music.
            (Content::Music, _) => 160_000,
            (Content::Speech, 1) => 64_000,
            (Content::Speech, _) => 96_000,
        }
    }
}

fn opus_error(e: opus1::Error) -> RadioError {
    bad(format!("opus: {e}"))
}

fn ogg_error(e: impl std::fmt::Display) -> RadioError {
    bad(format!("ogg: {e}"))
}

/// RFC 7845 identification header, channel mapping family 0.
fn opus_head(channels: usize, pre_skip: usize, input_rate: u32) -> Vec<u8> {
    let mut head = b"OpusHead".to_vec();
    head.push(1);
    head.push(channels as u8);
    head.extend((pre_skip as u16).to_le_bytes());
    head.extend(input_rate.to_le_bytes());
    head.extend(0i16.to_le_bytes());
    head.push(0);
    head
}

fn opus_tags() -> Vec<u8> {
    let vendor = concat!("delulu-radio ", env!("CARGO_PKG_VERSION"), " (opus1)");
    let mut tags = b"OpusTags".to_vec();
    tags.extend((vendor.len() as u32).to_le_bytes());
    tags.extend(vendor.as_bytes());
    tags.extend(0u32.to_le_bytes());
    tags
}

/// Encode as Ogg Opus at 48 kHz. Speech with identical channels is coded as mono.
/// The final granule position trims the padding, so the file decodes to exactly
/// the resampled length.
pub fn encode_opus(audio: &Audio, content: Content) -> Result<Vec<u8>, RadioError> {
    let stereo = resample(audio, OPUS_RATE)?;
    let frames = stereo.len() / 2;
    let mono = content == Content::Speech && stereo.as_chunks::<2>().0.iter().all(|f| f[0] == f[1]);
    let (channels, pcm) = if mono {
        (1, stereo.iter().step_by(2).copied().collect())
    } else {
        (2, stereo)
    };
    let layout = if mono {
        Channels::Mono
    } else {
        Channels::Stereo
    };
    let mut encoder =
        OpusEncoder::new(SampleRate::Hz48000, layout, Application::Audio).map_err(opus_error)?;
    let bitrate = NonZeroU32::new(content.bitrate(channels)).expect("bitrate");
    encoder.set_bitrate(Bitrate::BitsPerSecond(bitrate));
    encoder.set_complexity(10).map_err(opus_error)?;
    encoder.set_signal(match content {
        Content::Music => Signal::Music,
        Content::Speech => Signal::Voice,
    });
    let pre_skip = encoder.lookahead();
    let mut out = Vec::with_capacity(frames / OPUS_FRAME * 1024 + 4096);
    let mut writer = PacketWriter::new(&mut out);
    let page = PacketWriteEndInfo::EndPage;
    let head = opus_head(channels, pre_skip, audio.rate);
    writer
        .write_packet(head, OGG_SERIAL, page, 0)
        .map_err(ogg_error)?;
    writer
        .write_packet(opus_tags(), OGG_SERIAL, page, 0)
        .map_err(ogg_error)?;
    // The encoder delays its input by `pre_skip`; zeros after the end flush it.
    let packets = (frames + pre_skip).div_ceil(OPUS_FRAME);
    let width = OPUS_FRAME * channels;
    let mut frame = vec![0.0f32; width];
    let mut packet = vec![0u8; 4000];
    for k in 0..packets {
        let start = (k * width).min(pcm.len());
        let end = ((k + 1) * width).min(pcm.len());
        frame.fill(0.0);
        frame[..end - start].copy_from_slice(&pcm[start..end]);
        let len = encoder
            .encode(&frame, OPUS_FRAME, &mut packet)
            .map_err(opus_error)?;
        let last = k + 1 == packets;
        let (info, granule) = if last {
            (PacketWriteEndInfo::EndStream, pre_skip + frames)
        } else if (k + 1) % PACKETS_PER_PAGE == 0 {
            (page, (k + 1) * OPUS_FRAME)
        } else {
            (PacketWriteEndInfo::NormalPacket, (k + 1) * OPUS_FRAME)
        };
        writer
            .write_packet(packet[..len].to_vec(), OGG_SERIAL, info, granule as u64)
            .map_err(ogg_error)?;
    }
    drop(writer);
    Ok(out)
}

/// Decode an Ogg Opus file (whatever its name) to stereo f32 at 48 kHz.
pub fn decode_opus_file(path: &Path) -> Result<Audio, RadioError> {
    let bytes = std::fs::read(path).map_err(|e| bad(format!("{}: {e}", path.display())))?;
    decode_opus(&bytes)
}

/// A file that ends before its last page (a write cut short) is an error.
pub fn decode_opus(bytes: &[u8]) -> Result<Audio, RadioError> {
    let mut reader = PacketReader::new(std::io::Cursor::new(bytes));
    let head = reader
        .read_packet()
        .map_err(ogg_error)?
        .ok_or_else(|| bad("empty Opus file"))?
        .data;
    if head.len() < 19 || &head[..8] != b"OpusHead" {
        return Err(bad("not an Ogg Opus file"));
    }
    let channels = head[9] as usize;
    let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;
    if !matches!(channels, 1 | 2) || head[18] != 0 {
        return Err(bad("unsupported Opus channel layout"));
    }
    reader
        .read_packet()
        .map_err(ogg_error)?
        .ok_or_else(|| bad("Opus file has no tags"))?;
    let layout = if channels == 1 {
        Channels::Mono
    } else {
        Channels::Stereo
    };
    let mut decoder = OpusDecoder::new(SampleRate::Hz48000, layout).map_err(opus_error)?;
    let mut pcm = Vec::with_capacity(bytes.len() * 8);
    let mut buffer = vec![0.0f32; OPUS_MAX_FRAME * channels];
    let mut end = None;
    while let Some(packet) = reader.read_packet().map_err(ogg_error)? {
        let n = decoder
            .decode(&packet.data, OPUS_MAX_FRAME, &mut buffer)
            .map_err(opus_error)?;
        pcm.extend_from_slice(&buffer[..n * channels]);
        if packet.last_in_stream() {
            end = Some(packet.absgp_page() as usize);
            break;
        }
    }
    let end = end.ok_or_else(|| bad("Opus file is cut short"))?;
    if end < pre_skip || end > pcm.len() / channels {
        return Err(bad("Opus file has a bad length"));
    }
    pcm.truncate(end * channels);
    pcm.drain(..pre_skip * channels);
    let samples = if channels == 1 {
        pcm.iter().flat_map(|&v| [v, v]).collect()
    } else {
        pcm
    };
    Ok(Audio {
        rate: OPUS_RATE,
        samples,
    })
}

fn meter_error(e: ebur128::Error) -> RadioError {
    bad(format!("loudness: {e}"))
}

/// Integrated loudness (ITU-R BS.1770 / EBU R128) and true peak.
pub fn measure(audio: &Audio) -> Result<Loudness, RadioError> {
    let mut meter = EbuR128::new(2, audio.rate, Mode::I | Mode::TRUE_PEAK).map_err(meter_error)?;
    meter.add_frames_f32(&audio.samples).map_err(meter_error)?;
    let lufs = meter.loudness_global().map_err(meter_error)?;
    let mut peak = 0.0f64;
    for channel in 0..2 {
        peak = peak.max(meter.true_peak(channel).map_err(meter_error)?);
    }
    // Silence measures -inf, which JSON cannot hold.
    Ok(Loudness {
        lufs: lufs.max(SILENCE_LUFS),
        true_peak: (20.0 * peak.log10()).max(-100.0),
    })
}

fn linear(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

/// The linear gain that brings an item towards `TARGET_LUFS`, within the bounds.
/// Unmeasured or silent items play as stored.
pub fn playback_gain(loudness: Option<Loudness>) -> f32 {
    match loudness.filter(|l| l.lufs > SILENCE_LUFS) {
        Some(l) => linear((TARGET_LUFS - l.lufs).clamp(-MAX_CUT_DB, MAX_BOOST_DB)),
        None => 1.0,
    }
}

/// Bring `audio` to the common loudness for playback: the bounded gain, and where
/// the true peak would end up past the ceiling, the limiter. Its result is measured,
/// so the true peak ends at or under the ceiling whatever the signal.
pub fn even_out(audio: &mut Audio, loudness: Option<Loudness>) {
    let Some(l) = loudness.filter(|l| l.lufs > SILENCE_LUFS) else {
        return;
    };
    let gain = playback_gain(loudness);
    let mut total = 20.0 * (gain as f64).log10();
    scale(audio, gain);
    if l.true_peak + total <= PEAK_CEILING_DB {
        return;
    }
    // Limiting takes some loudness off: make it up, within the bound.
    for pass in 0..4 {
        limit(audio, linear(LIMIT_DB));
        let Ok(m) = measure(audio) else { break };
        if m.true_peak > PEAK_CEILING_DB {
            // Peaks between samples the limiter did not see.
            scale(audio, linear(PEAK_CEILING_DB - m.true_peak));
            break;
        }
        let extra = (TARGET_LUFS - m.lufs).min(MAX_BOOST_DB - total);
        if extra < 0.1 || pass == 3 {
            break;
        }
        scale(audio, linear(extra));
        total += extra;
    }
}

fn scale(audio: &mut Audio, gain: f32) {
    audio.samples.iter_mut().for_each(|s| *s *= gain);
}

/// Keep every sample at or under `ceiling`: the gain falls in a short ramp that
/// ends at each peak, and recovers slowly after it.
fn limit(audio: &mut Audio, ceiling: f32) {
    let frames = audio.frames();
    let rate = audio.rate.max(1) as f64;
    let look = ((LIMIT_LOOKAHEAD_SECONDS * rate) as usize).max(1);
    // What each frame needs on its own.
    let need: Vec<f32> = audio
        .samples
        .as_chunks::<2>()
        .0
        .iter()
        .map(|f| {
            let peak = f[0].abs().max(f[1].abs());
            if peak > ceiling {
                ceiling / peak
            } else {
                1.0
            }
        })
        .collect();
    if need.iter().all(|&g| g >= 1.0) {
        return;
    }
    // The lowest need from this frame to `look` frames ahead (a sliding minimum).
    let mut ahead = vec![1.0f32; frames];
    let mut window = std::collections::VecDeque::new();
    for i in (0..frames).rev() {
        while window.back().is_some_and(|&j: &usize| need[j] >= need[i]) {
            window.pop_back();
        }
        window.push_back(i);
        while window.front().is_some_and(|&j| j > i + look) {
            window.pop_front();
        }
        ahead[i] = need[window[0]];
    }
    // Recover towards 1, never above what is ahead.
    let recover = (-1.0 / (LIMIT_RELEASE_SECONDS * rate)).exp() as f32;
    let mut gain = 1.0f32;
    for g in ahead.iter_mut() {
        gain = (1.0 - (1.0 - gain) * recover).min(*g);
        *g = gain;
    }
    // Average over the last `look` frames: the instant drops become ramps, and
    // each peak's whole window is already at or under what it needs.
    let mut sum = look as f32;
    let mut history = std::collections::VecDeque::from(vec![1.0f32; look]);
    for (i, &g) in ahead.iter().enumerate() {
        sum += g - history.pop_front().unwrap_or(1.0);
        history.push_back(g);
        let smooth = (sum / look as f32).min(need[i]);
        audio.samples[i * 2] *= smooth;
        audio.samples[i * 2 + 1] *= smooth;
    }
}

/// Interleaved stereo at `to` Hz, with the resampler's delay removed so the result
/// lines up with the source and has its exact length.
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
    let delay = resampler.output_delay();
    let wanted = (left.len() as f64 * to as f64 / audio.rate as f64).round() as usize;
    let mut out = Vec::with_capacity((delay + wanted + 2 * CHUNK) * 2);
    let push = |out: &mut Vec<f32>, block: Vec<Vec<f32>>| {
        for (l, r) in block[0].iter().zip(&block[1]) {
            out.extend([*l, *r]);
        }
    };
    let error = |e: rubato::ResampleError| bad(format!("resample: {e}"));
    let mut pos = 0;
    while pos + CHUNK <= left.len() {
        let block = resampler
            .process(&[&left[pos..pos + CHUNK], &right[pos..pos + CHUNK]], None)
            .map_err(error)?;
        push(&mut out, block);
        pos += CHUNK;
    }
    // rubato rejects an empty partial chunk, so a whole-chunk track has no tail call.
    if pos < left.len() {
        let block = resampler
            .process_partial(Some(&[&left[pos..], &right[pos..]]), None)
            .map_err(error)?;
        push(&mut out, block);
    }
    // Zeros push the delayed end of the track out of the resampler.
    while out.len() / 2 < delay + wanted {
        let block = resampler
            .process_partial::<&[f32]>(None, None)
            .map_err(error)?;
        push(&mut out, block);
    }
    out.drain(..delay * 2);
    out.truncate(wanted * 2);
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
    fn fade_out_ends_in_silence() {
        let mut audio = tone(48000, 2.0, 0.5);
        let before = audio.samples[1000];
        fade_out(&mut audio, 1.0);
        assert_eq!(audio.samples[1000], before);
        let tail = &audio.samples[audio.samples.len() - 200..];
        assert!(tail.iter().all(|s| s.abs() < 0.01));
    }

    #[test]
    fn normalize_sets_peak() {
        let mut audio = tone(48000, 1.0, 0.2);
        normalize(&mut audio);
        assert!((audio.peak() - 0.9).abs() < 1e-3);
    }

    /// rubato's `process_partial` rejects an empty tail ("Insufficient buffer size 0
    /// for input channel 0, expected 1024"), which every track whose length is a
    /// multiple of the chunk hit at the end of resampling.
    #[test]
    fn resample_handles_whole_chunks_and_short_tracks() {
        for frames in [1024 * 40, 1024, 1, 1023, 1025, 0] {
            let audio = Audio {
                rate: 44100,
                samples: vec![0.25; frames * 2],
            };
            let out = resample(&audio, 48000).unwrap_or_else(|e| panic!("{frames}: {e}"));
            let expected = (frames as f64 * 48000.0 / 44100.0).round() as usize;
            assert_eq!(out.len(), expected * 2, "{frames}");
        }
    }

    #[test]
    fn resample_scales_length() {
        let audio = tone(44100, 1.0, 0.5);
        let out = resample(&audio, 48000).unwrap();
        assert_eq!(out.len() / 2, 48000);
        // The delay is trimmed: the tone lines up with the source.
        let peak = |s: &[f32]| s.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak(&out[..200]) > 0.2 && peak(&out[out.len() - 200..]) > 0.2);
    }

    fn sine(rate: u32, seconds: f64, freq: f32, left: f32, right: f32) -> Audio {
        let frames = (rate as f64 * seconds) as usize;
        let samples = (0..frames)
            .flat_map(|i| {
                let v = (i as f32 * freq * std::f32::consts::TAU / rate as f32).sin();
                [v * left, v * right]
            })
            .collect();
        Audio { rate, samples }
    }

    /// Every source rate the station meets (Chatterbox 24 kHz, YuE2 48 kHz, imports
    /// at 44.1 kHz) decodes to exactly its length at 48 kHz, at its level, in mono
    /// (speech) and in stereo.
    #[test]
    fn opus_round_trip_keeps_length_and_level() {
        for (rate, content, right) in [
            (24000, Content::Speech, 0.5),
            (44100, Content::Music, 0.25),
            (48000, Content::Music, 0.5),
            (8000, Content::Speech, 0.25),
        ] {
            let source = sine(rate, 2.3, 440.0, 0.5, right);
            let back = decode_opus(&encode_opus(&source, content).unwrap()).unwrap();
            let expected = (source.frames() as f64 * 48000.0 / rate as f64).round() as usize;
            assert_eq!(back.frames(), expected, "{rate} Hz");
            let frames = back.frames();
            let mid = &back.samples[frames / 4 * 2..frames * 3 / 4 * 2];
            let peak = |c: usize| {
                mid.iter()
                    .skip(c)
                    .step_by(2)
                    .fold(0.0f32, |m, v| m.max(v.abs()))
            };
            assert!((peak(0) - 0.5).abs() < 0.05, "{rate} Hz left {}", peak(0));
            assert!(
                (peak(1) - right).abs() < 0.05,
                "{rate} Hz right {}",
                peak(1)
            );
        }
    }

    /// A file whose write was cut short must not pass for a stored item.
    #[test]
    fn opus_cut_short_is_rejected() {
        let bytes = encode_opus(&sine(48000, 3.0, 440.0, 0.5, 0.5), Content::Music).unwrap();
        assert!(decode_opus(&bytes[..bytes.len() / 2]).is_err());
        assert!(decode_opus(&bytes[..bytes.len() - 1]).is_err());
    }

    /// EBU Tech 3341 cases 1 and 2: a stereo 1 kHz sine at -23 / -33 dBFS measures
    /// -23 / -33 LUFS, also after it was stored as Opus.
    #[test]
    fn loudness_of_reference_tones() {
        for level in [-23.0f64, -33.0] {
            let amp = 10f64.powf(level / 20.0) as f32;
            let tone = sine(48000, 10.0, 1000.0, amp, amp);
            let direct = measure(&tone).unwrap();
            assert!((direct.lufs - level).abs() < 0.5, "{level}: {direct:?}");
            assert!(
                (direct.true_peak - level).abs() < 0.5,
                "{level}: {direct:?}"
            );
            let stored = decode_opus(&encode_opus(&tone, Content::Music).unwrap()).unwrap();
            let after = measure(&stored).unwrap();
            assert!(
                (after.lufs - level).abs() < 0.5,
                "{level} stored: {after:?}"
            );
        }
    }

    #[test]
    fn playback_gain_is_bounded() {
        let db = |lufs: f64| {
            let l = Loudness {
                lufs,
                true_peak: -1.0,
            };
            20.0 * (playback_gain(Some(l)) as f64).log10()
        };
        assert!((db(-10.0) + 6.0).abs() < 1e-3);
        assert!((db(-19.0) - 3.0).abs() < 1e-3);
        assert!((db(-1.0) + MAX_CUT_DB).abs() < 1e-3);
        assert!((db(-40.0) - MAX_BOOST_DB).abs() < 1e-3);
        // Unmeasured and silent items play as stored.
        assert_eq!(playback_gain(None), 1.0);
        assert_eq!(
            playback_gain(Some(Loudness {
                lufs: -70.0,
                true_peak: -100.0
            })),
            1.0
        );
    }

    /// Peak-normalized speech is quieter than the target with no headroom: it is
    /// raised to the target and its peaks are held under the ceiling. A loud song
    /// is only turned down, and a quiet one with headroom only up.
    #[test]
    fn even_out_reaches_the_target_without_clipping() {
        let rate = 48000;
        // A soft tone with a loud 10 ms burst every half second, like plosives.
        let burst = 480;
        let spiky = Audio {
            rate,
            samples: (0..rate as usize * 6)
                .flat_map(|i| {
                    let t = i as f32;
                    let mut v = 0.11 * (t * 0.06).sin();
                    if i % 24000 < burst {
                        let k = (i % 24000) as f32 / burst as f32;
                        let window = (std::f32::consts::PI * k).sin().powi(2);
                        v += 0.8 * window * (t * 1500.0 * std::f32::consts::TAU / 48000.0).sin();
                    }
                    [v, v * 0.8]
                })
                .collect(),
        };
        // About -10 and -20 LUFS.
        let loud = sine(rate, 6.0, 997.0, 0.3, 0.3);
        let quiet = sine(rate, 6.0, 997.0, 0.1, 0.1);
        for (name, mut audio) in [("spiky", spiky), ("loud", loud), ("quiet", quiet)] {
            let before = measure(&audio).unwrap();
            even_out(&mut audio, Some(before));
            let after = measure(&audio).unwrap();
            assert!(
                after.true_peak <= PEAK_CEILING_DB + 0.01,
                "{name}: {after:?}"
            );
            assert!(
                (after.lufs - TARGET_LUFS).abs() < 0.5,
                "{name}: {before:?} -> {after:?}"
            );
        }
    }

    /// Samples of a 12 kHz sine at 45° sit 3 dB under its true peak, so a sample
    /// limiter misses them; and at the target loudness the gain is 1.
    #[test]
    fn even_out_holds_peaks_between_samples() {
        let rate = 48000;
        let mut audio = Audio {
            rate,
            samples: (0..rate as usize * 4)
                .flat_map(|i| {
                    let phase =
                        i as f32 * std::f32::consts::FRAC_PI_2 + std::f32::consts::FRAC_PI_4;
                    let v = 1.13 * phase.sin();
                    [v, v]
                })
                .collect(),
        };
        let measured = measure(&audio).unwrap();
        assert!(measured.true_peak > 0.5 && audio.peak() < linear(LIMIT_DB));
        even_out(
            &mut audio,
            Some(Loudness {
                lufs: TARGET_LUFS,
                ..measured
            }),
        );
        let after = measure(&audio).unwrap();
        assert!(after.true_peak <= PEAK_CEILING_DB + 0.01, "{after:?}");
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
