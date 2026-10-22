//! 16-bit mono PCM WAV encoding (`src/captureEncoding.ts`) and PCM decoding.

/// The speech model's input rate.
pub const SPEECH_SAMPLE_RATE: u32 = 16_000;
/// Length of the canonical RIFF/WAVE header written by [`wav`].
pub const WAV_HEADER_BYTES: usize = 44;

/// Encodes mono samples as a 16-bit PCM WAV, clamping to [-1, 1]. Negative
/// samples scale by 0x8000 and positive ones by 0x7fff, truncating toward
/// zero like `DataView.setInt16`.
pub fn wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(WAV_HEADER_BYTES + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&to_i16(sample).to_le_bytes());
    }
    out
}

/// NaN becomes 0, like `ToInt16(NaN)`.
fn to_i16(sample: f32) -> i16 {
    let sample = sample.clamp(-1.0, 1.0);
    if sample < 0.0 {
        (sample * 32768.0) as i16
    } else {
        (sample * 32767.0) as i16
    }
}

/// 16-bit little-endian PCM to floats in [-1, 1). A trailing odd byte is ignored.
pub fn pcm16le_to_f32(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).collect()
}

#[cfg(test)]
pub(crate) fn wav_samples(bytes: &[u8]) -> Vec<f32> {
    // Walk chunks so fixtures with extra chunks decode too.
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            return pcm16le_to_f32(&bytes[offset + 8..offset + 8 + size]);
        }
        offset += 8 + size + (size % 2);
    }
    panic!("no data chunk");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_canonical_header_and_samples() {
        let bytes = wav(&[0.0, 1.0, -1.0, 0.5, -0.5, 2.0, f32::NAN], 16_000);
        assert_eq!(bytes.len(), 44 + 14);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 36 + 14);
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 1, "PCM");
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1, "mono");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(bytes[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(bytes[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 14);
        let samples: Vec<i16> =
            bytes[44..].chunks_exact(2).map(|p| i16::from_le_bytes([p[0], p[1]])).collect();
        assert_eq!(samples, vec![0, 32767, -32768, 16383, -16384, 32767, 0]);
    }

    #[test]
    fn decodes_pcm_like_the_player() {
        let pcm: Vec<u8> = [0i16, 16384, -32768, 32767].iter().flat_map(|v| v.to_le_bytes()).chain([7]).collect();
        assert_eq!(pcm16le_to_f32(&pcm), vec![0.0, 0.5, -1.0, 32767.0 / 32768.0]);
    }
}
