//! Render the pill's full animation as PNG frames:
//! `cargo run -p delulu-overlay --example animation -- <dir> [fps]`.

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().unwrap_or_else(|| "pill-frames".into()));
    let fps = args.next().and_then(|f| f.parse().ok()).unwrap_or(30.0);
    std::fs::create_dir_all(&dir).expect("create output directory");
    let frames = delulu_overlay::render_demo(&dir, fps).expect("render");
    println!("{frames} frames in {}", dir.display());
}
