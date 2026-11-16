//! Cutting a long recording into pieces Whisper can hear whole.
//!
//! Whisper hears 30 seconds at a time. Given more, whisper.cpp decodes the first 30 s
//! window and, with timestamps off (as the app runs it), moves on by exactly 30 s, cutting
//! words in half at the border and dropping whatever the decoder skipped in that window.
//! So a long recording is cut at its quietest moments into pieces under 30 s, and each
//! piece is decoded on its own.
use std::ops::Range;

const RATE: usize = 16_000;
/// A piece never exceeds this, leaving margin under Whisper's 30 s window.
const MAX_PIECE: usize = 29 * RATE;
/// A cut is looked for this far into the piece at the earliest, so pieces stay long.
const MIN_PIECE: usize = 15 * RATE;
const FRAME: usize = RATE / 50;
/// Frames in the stretch whose total energy picks the cut: 200 ms, shorter than a pause
/// between sentences and longer than the gap between two words.
const PAUSE_FRAMES: usize = 10;

/// Contiguous ranges that cover `0..len` in order, each at most `MAX_PIECE` long.
pub(crate) fn pieces(samples: &[f32]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    while samples.len() - start > MAX_PIECE {
        let cut = quietest(samples, start + MIN_PIECE, start + MAX_PIECE);
        out.push(start..cut);
        start = cut;
    }
    out.push(start..samples.len());
    out
}

/// The middle of the quietest 200 ms that lies within `from..to`.
fn quietest(samples: &[f32], from: usize, to: usize) -> usize {
    let energy: Vec<f32> = samples[from..to]
        .as_chunks::<FRAME>()
        .0
        .iter()
        .map(|frame| frame.iter().map(|x| x * x).sum())
        .collect();
    let windows = energy.len().saturating_sub(PAUSE_FRAMES) + 1;
    let quietest = (0..windows)
        .map(|i| {
            (
                i,
                energy[i..(i + PAUSE_FRAMES).min(energy.len())]
                    .iter()
                    .sum::<f32>(),
            )
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map_or(0, |(i, _)| i);
    from + (quietest * FRAME + PAUSE_FRAMES * FRAME / 2).min(to - from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tone with pauses of `pause` seconds at the given seconds.
    fn speech_with_pauses(seconds: f32, pauses: &[f32], pause: f32) -> Vec<f32> {
        (0..(seconds * RATE as f32) as usize)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                if pauses.iter().any(|p| t >= *p && t < p + pause) {
                    0.0005
                } else {
                    0.3 * (t * 2.0 * std::f32::consts::PI * 220.0).sin()
                }
            })
            .collect()
    }

    fn assert_cover(samples: &[f32], pieces: &[Range<usize>]) {
        assert_eq!(pieces.first().unwrap().start, 0);
        assert_eq!(pieces.last().unwrap().end, samples.len());
        for pair in pieces.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "nothing lost or repeated");
        }
        assert!(pieces.iter().all(|p| p.len() <= MAX_PIECE && !p.is_empty()));
    }

    #[test]
    fn a_clip_under_the_window_stays_whole() {
        let samples = speech_with_pauses(29.0, &[10.0], 0.5);
        assert_eq!(pieces(&samples), vec![0..samples.len()]);
    }

    #[test]
    fn long_clips_are_cut_in_their_pauses() {
        let pauses = [12.0, 21.0, 40.0, 63.0];
        let samples = speech_with_pauses(75.0, &pauses, 0.6);
        let pieces = pieces(&samples);
        assert_cover(&samples, &pieces);
        let cuts: Vec<f32> = pieces[1..]
            .iter()
            .map(|p| p.start as f32 / RATE as f32)
            .collect();
        // 12 s is too early for the first cut; 21, 40 and 63 s are pauses in reach.
        assert_eq!(cuts.len(), 3);
        for (cut, pause) in cuts.iter().zip([21.0, 40.0, 63.0]) {
            assert!(*cut >= pause && *cut <= pause + 0.6, "cut at {cut} s");
        }
    }

    #[test]
    fn without_pauses_the_cuts_still_cover_everything() {
        let samples = speech_with_pauses(95.0, &[], 0.0);
        let pieces = pieces(&samples);
        assert_cover(&samples, &pieces);
        assert_eq!(pieces.len(), 4);
    }

    #[test]
    fn a_short_tail_after_a_late_pause_is_its_own_piece() {
        let samples = speech_with_pauses(30.5, &[28.0], 0.5);
        let pieces = pieces(&samples);
        assert_cover(&samples, &pieces);
        assert_eq!(pieces.len(), 2);
        assert!(pieces[1].start >= 28 * RATE);
    }
}
