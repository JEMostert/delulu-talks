//! `cargo run -p delulu-models --example fetch -- <models-dir> [model-id]`
//! Without an id it lists the registry and what is installed; with one it downloads
//! that model (resuming any partial file) and prints progress.
use std::io::Write;
use std::sync::atomic::AtomicBool;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("usage: fetch <models-dir> [model-id]"));
    let Some(id) = args.next() else {
        for m in delulu_models::MODELS {
            let state = if m.installed(&dir) {
                "installed"
            } else {
                "missing"
            };
            println!("{:<24} {:>13} bytes  {state}", m.id, m.bytes);
        }
        return;
    };
    let model = delulu_models::get(&id).expect("unknown model id");
    let mut last = u64::MAX;
    let result = delulu_models::download(
        &dir,
        model,
        &mut |done, total| {
            let percent = done * 100 / total.max(1);
            if percent != last {
                last = percent;
                print!("\r{done} / {total} bytes ({percent}%)");
                let _ = std::io::stdout().flush();
            }
        },
        &AtomicBool::new(false),
    );
    println!();
    if let Err(e) = result {
        eprintln!("download failed: {e}");
        std::process::exit(1);
    }
    println!("{id} installed");
}
