//! The pill's look, without a desktop: each state's settled frame at 100 % and
//! 150 % against a stored reference. A drawing change that alters the pill fails
//! here; when the change is intended, regenerate the references with
//! `DELULU_PILL_BLESS=1 cargo test -p delulu-pill --test frames` and look at them.

use delulu_pill::draw::{canvas_size, preview_model, Renderer};
use delulu_pill::{PillState, SCALE};
use std::path::PathBuf;
use tiny_skia::Pixmap;

const CASES: [(&str, PillState, f32, Option<&str>); 4] = [
    ("listening", PillState::Listening, 0.6, None),
    ("transcribing", PillState::Transcribing, 0.0, None),
    ("success", PillState::Success, 0.0, Some("Typed")),
    ("error", PillState::Error, 0.0, Some("Nothing heard")),
];

/// Pixels whose largest channel difference is above 8 levels, as a share.
fn changed_share(a: &Pixmap, b: &Pixmap) -> f64 {
    let changed = a
        .data()
        .as_chunks::<4>()
        .0
        .iter()
        .zip(b.data().as_chunks::<4>().0)
        .filter(|(x, y)| x.iter().zip(*y).any(|(p, q)| p.abs_diff(*q) > 8))
        .count();
    changed as f64 / (a.width() * a.height()) as f64
}

#[test]
fn each_state_matches_its_reference_frame() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/frames");
    let bless = std::env::var_os("DELULU_PILL_BLESS").is_some();
    let mut r = Renderer::new();
    let mut failures = Vec::new();
    for output_scale in [1.0, 1.5] {
        let scale = SCALE * output_scale;
        let (w, h) = canvas_size(scale);
        for (name, state, level, label) in CASES {
            let m = preview_model(&r, state, level, label);
            let mut frame = Pixmap::new(w, h).unwrap();
            r.render_full(&m, scale, &mut frame);
            let path = dir.join(format!("{name}@{}.png", (output_scale * 100.0) as u32));
            if bless {
                frame.save_png(&path).unwrap();
                continue;
            }
            let reference = Pixmap::load_png(&path)
                .unwrap_or_else(|e| panic!("{}: {e} (bless to create it)", path.display()));
            assert_eq!((reference.width(), reference.height()), (w, h), "{name}");
            let share = changed_share(&frame, &reference);
            if share > 0.002 {
                failures.push(format!("{name} at {output_scale}x: {:.2} % of pixels changed", share * 100.0));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
