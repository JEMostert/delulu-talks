//! `delulu-pill`: the recording pill without GTK.
//!
//! ```text
//! delulu-pill [--backend auto|layer-shell|x11] [--reduce-motion]
//! delulu-pill --render STATE LEVEL LABEL OUT.png [SCALE]   one settled frame
//! delulu-pill --demo DIR [FPS]                              the animation as PNGs
//! delulu-pill --list-globals                                what the compositor offers
//! ```
//!
//! It reads one JSON message per line on stdin (`{"state":"listening","level":0.5}`,
//! `{"state":"success","label":"Typed"}`), exits 0 at the end of input and 3
//! when there is nothing to draw on. `DELULU_PILL_BACKEND` and
//! `DELULU_PILL_REDUCE_MOTION=1` do what the flags do; `DELULU_PILL_TRACE=1`
//! prints timing events for measurements.

mod desktop;
mod layer_shell;
mod runtime;
mod x11;

use delulu_pill::draw::{self, Renderer};
use delulu_pill::select::{self, Backend, Session};
use delulu_pill::{PillState, UNAVAILABLE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let after = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .map(|i| &args[i + 1..])
    };
    if flag("--help") || flag("-h") {
        println!("{}", USAGE.trim());
        return;
    }
    if flag("--version") {
        println!("delulu-pill {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if flag("--list-globals") {
        std::process::exit(layer_shell::list_globals());
    }
    if let Some(rest) = after("--render") {
        std::process::exit(render(rest));
    }
    if let Some(rest) = after("--demo") {
        std::process::exit(demo(rest));
    }

    let requested = after("--backend")
        .and_then(|rest| rest.first().cloned())
        .or_else(|| std::env::var("DELULU_PILL_BACKEND").ok().filter(|v| !v.is_empty()));
    let reduce_motion = flag("--reduce-motion")
        || std::env::var("DELULU_PILL_REDUCE_MOTION").is_ok_and(|v| v == "1");
    let backend = match select::choose(requested.as_deref(), Session::from_env(), layer_shell::available) {
        Ok(b) => b,
        Err(why) => {
            eprintln!("pill: {why}; no recording pill");
            std::process::exit(UNAVAILABLE);
        }
    };
    runtime::make_stdin_nonblocking();
    let core = runtime::Core::new(reduce_motion);
    std::process::exit(match backend {
        Backend::LayerShell => layer_shell::run(core),
        Backend::X11 => x11::run(core),
    });
}

const USAGE: &str = "
usage: delulu-pill [--backend auto|layer-shell|x11] [--reduce-motion]
       delulu-pill --render STATE LEVEL LABEL OUT.png [SCALE]
       delulu-pill --demo DIR [FPS]
       delulu-pill --list-globals

Reads JSON lines on stdin, e.g. {\"state\":\"listening\",\"level\":0.5}.
STATE is listening, transcribing, success or error; LABEL - for none.
";

/// One settled frame of a state to a PNG, for unattended visual checks.
fn render(a: &[String]) -> i32 {
    let state = match a.first().map(String::as_str) {
        Some("listening") => PillState::Listening,
        Some("transcribing") => PillState::Transcribing,
        Some("success") => PillState::Success,
        Some("error") => PillState::Error,
        _ => {
            eprintln!("{}", USAGE.trim());
            return 2;
        }
    };
    let level: f32 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let label = a
        .get(2)
        .filter(|s| !s.is_empty() && *s != "-")
        .map(String::as_str);
    let Some(out) = a.get(3) else {
        eprintln!("{}", USAGE.trim());
        return 2;
    };
    let scale: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let mut r = Renderer::new();
    let m = draw::preview_model(&r, state, level, label);
    let (w, h) = draw::canvas_size(scale);
    let Some(mut pix) = tiny_skia::Pixmap::new(w, h) else {
        return 1;
    };
    // The steady-state cost: 300 frames animated on from this state at 60 Hz.
    let started = std::time::Instant::now();
    let mut animated = m.clone();
    let mut pixels = 0u64;
    for _ in 0..300 {
        animated.step(1.0 / 60.0);
        if let Some(f) = r.render(&animated, scale, (w, h)) {
            pixels += u64::from(f.rect.width()) * u64::from(f.rect.height());
        }
    }
    let elapsed = started.elapsed();
    r.render_full(&m, scale, &mut pix);
    eprintln!(
        "render {:.3} ms/frame, {} of {} pixels, at {w}x{h}; pill {} wide",
        elapsed.as_secs_f64() * 1000.0 / 300.0,
        pixels / 300,
        u64::from(w) * u64::from(h),
        r.width(&m)
    );
    match pix.save_png(out) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{out}: {e}");
            1
        }
    }
}

fn demo(a: &[String]) -> i32 {
    let Some(dir) = a.first() else {
        eprintln!("{}", USAGE.trim());
        return 2;
    };
    let fps = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(30.0);
    let dir = std::path::Path::new(dir);
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("{}: {e}", dir.display());
        return 1;
    }
    match draw::render_demo(dir, fps) {
        Ok(n) => {
            println!("{n} frames in {}", dir.display());
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}
