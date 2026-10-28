//! Render the pill's states to PNGs: `cargo run -p delulu-overlay --example preview -- <dir>`.

use delulu_overlay::{render_preview, PillState};

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| ".".into()));
    std::fs::create_dir_all(&dir).expect("create output directory");
    for (name, state, level, label) in [
        ("listening-0.1", PillState::Listening, 0.1, None),
        ("listening-0.8", PillState::Listening, 0.8, None),
        ("transcribing", PillState::Transcribing, 0.0, None),
        ("success-typed", PillState::Success, 0.0, Some("Typed")),
        (
            "error-nothing-heard",
            PillState::Error,
            0.0,
            Some("Nothing heard"),
        ),
    ] {
        let path = dir.join(format!("{name}.png"));
        let width = render_preview(state, level, label, &path).expect("render");
        println!("{} (pill {width} wide, @2x)", path.display());
    }
}
