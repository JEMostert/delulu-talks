//! Edge silence. Supertonic pads each chunk with about 0.5 s of silence in front and
//! 0.6–0.8 s behind, which made 1.3–1.6 s gaps between sentences in the spike. Each
//! chunk is cut to [`KEEP_MS`] of silence at both ends; the caller then adds the
//! pause it wants ([`crate::SENTENCE_PAUSE_MS`] and friends).

/// Silence kept at each edge, so soft onsets and word endings are not clipped.
pub const KEEP_MS: u32 = 30;
/// Analysis window.
const WINDOW_MS: u32 = 5;
/// Fade over the cut, against clicks.
const FADE_MS: u32 = 5;
/// A window is speech when its RMS reaches −45 dBFS, or 30 dB under the chunk's
/// peak for very quiet chunks, but never below −65 dBFS.
const FLOOR_DBFS: f32 = -45.0;
const BELOW_PEAK_DB: f32 = 30.0;
const MIN_DBFS: f32 = -65.0;

fn db_to_amp(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// The start and end (exclusive) of `samples` after trimming; `(0, 0)` when it is all
/// silence.
pub fn speech_bounds(samples: &[f32], rate: u32) -> (usize, usize) {
    let window = ((rate * WINDOW_MS) / 1000).max(1) as usize;
    let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
    let threshold = db_to_amp(FLOOR_DBFS)
        .min(peak * db_to_amp(-BELOW_PEAK_DB))
        .max(db_to_amp(MIN_DBFS));
    let loud = |chunk: &[f32]| {
        let energy = chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32;
        energy.sqrt() >= threshold
    };
    let windows: Vec<&[f32]> = samples.chunks(window).collect();
    let Some(first) = windows.iter().position(|w| loud(w)) else {
        return (0, 0);
    };
    let last = windows.iter().rposition(|w| loud(w)).expect("first exists");
    let keep = ((rate * KEEP_MS) / 1000) as usize;
    let start = (first * window).saturating_sub(keep);
    let end = ((last + 1) * window + keep).min(samples.len());
    (start, end)
}

/// The trimmed chunk with short fades at the cuts (none where nothing was cut).
pub fn trim(samples: &[f32], rate: u32) -> Vec<f32> {
    let (start, end) = speech_bounds(samples, rate);
    let mut out = samples[start..end].to_vec();
    let fade = (((rate * FADE_MS) / 1000) as usize).min(out.len() / 2);
    if start > 0 {
        for (i, s) in out.iter_mut().take(fade).enumerate() {
            *s *= i as f32 / fade as f32;
        }
    }
    if end < samples.len() {
        let n = out.len();
        for i in 0..fade {
            out[n - 1 - i] *= i as f32 / fade as f32;
        }
    }
    out
}

pub fn silence(ms: u32, rate: u32) -> Vec<f32> {
    vec![0.0; (rate as u64 * ms as u64 / 1000) as usize]
}

/// The longest run below −45 dBFS between the first and last speech, in ms. Used to
/// check the pause between sentences.
pub fn longest_inner_gap_ms(samples: &[f32], rate: u32) -> u32 {
    let window = ((rate * WINDOW_MS) / 1000).max(1) as usize;
    let threshold = db_to_amp(FLOOR_DBFS);
    let quiet: Vec<bool> = samples
        .chunks(window)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt() < threshold)
        .collect();
    let (Some(first), Some(last)) = (
        quiet.iter().position(|q| !q),
        quiet.iter().rposition(|q| !q),
    ) else {
        return 0;
    };
    let (mut best, mut run) = (0usize, 0usize);
    for &q in &quiet[first..=last] {
        run = if q { run + 1 } else { 0 };
        best = best.max(run);
    }
    (best * window * 1000 / rate as usize) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    const RATE: u32 = 44_100;

    fn tone(ms: u32, amp: f32) -> Vec<f32> {
        (0..(RATE * ms / 1000))
            .map(|i| amp * (i as f32 * 0.05).sin())
            .collect()
    }

    /// Speech padded like Supertonic's output: 0.5 s before, 0.7 s after, with a
    /// faint noise floor that must still count as silence.
    fn padded(speech: &[f32]) -> Vec<f32> {
        let noise = |ms| -> Vec<f32> {
            (0..(RATE * ms / 1000))
                .map(|i| 0.0005 * ((i * 7919) % 13) as f32 / 13.0)
                .collect()
        };
        [noise(500), speech.to_vec(), noise(700)].concat()
    }

    #[test]
    fn padding_is_cut_to_the_kept_margin() {
        let speech = tone(800, 0.3);
        let trimmed = trim(&padded(&speech), RATE);
        let ms = trimmed.len() as u32 * 1000 / RATE;
        assert!(
            (800..=800 + 2 * KEEP_MS + 2 * WINDOW_MS).contains(&ms),
            "{ms} ms"
        );
    }

    #[test]
    fn two_sentences_joined_with_a_pause_leave_a_gap_in_range() {
        let a = trim(&padded(&tone(600, 0.3)), RATE);
        let b = trim(&padded(&tone(600, 0.2)), RATE);
        let joined = [a, silence(crate::SENTENCE_PAUSE_MS, RATE), b].concat();
        let gap = longest_inner_gap_ms(&joined, RATE);
        // The pause plus at most the two kept margins.
        assert!(
            (crate::SENTENCE_PAUSE_MS..=crate::SENTENCE_PAUSE_MS + 2 * KEEP_MS + 2 * WINDOW_MS)
                .contains(&gap),
            "{gap} ms"
        );
    }

    #[test]
    fn a_quiet_chunk_is_judged_against_its_own_peak() {
        let speech = tone(400, 0.004);
        let trimmed = trim(&padded(&speech), RATE);
        assert!(!trimmed.is_empty());
        assert!(trimmed.len() < padded(&speech).len() / 2);
    }

    #[test]
    fn silence_alone_trims_to_nothing() {
        assert!(trim(&vec![0.0; 44_100], RATE).is_empty());
        assert!(trim(&[], RATE).is_empty());
    }
}
