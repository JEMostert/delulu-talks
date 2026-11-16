//! Backend-independent pill logic: stdin, the model, the auto-hide timer, the
//! animation clock, and the trace and frame statistics the measurements use.

use delulu_pill::draw::Renderer;
use delulu_pill::model::{Message, Model, PillState};
use delulu_pill::protocol::Lines;
use std::os::fd::RawFd;
use std::time::{Duration, Instant};

/// The animation's nominal frame, for the first step and the X11 timer.
pub const FRAME: Duration = Duration::from_micros(16_667);

pub fn mono_ns() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: a valid pointer to a timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

fn trace_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("DELULU_PILL_TRACE").is_some())
}

/// One JSON line on stderr with a CLOCK_MONOTONIC timestamp, when
/// `DELULU_PILL_TRACE` is set (for latency measurements).
pub fn trace(ev: &str, extra: &str) {
    if trace_on() {
        eprintln!("{{\"ev\":\"{ev}\",\"t\":{}{extra}}}", mono_ns());
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    /// Nothing visible changed (e.g. a hide while already hidden).
    None,
    /// Visible: show if needed, then draw.
    Update,
    /// Gone: take it off the screen now.
    Hide,
}

pub struct Core {
    pub model: Model,
    pub renderer: Renderer,
    /// `--reduce-motion` or `DELULU_PILL_REDUCE_MOTION`: never animate.
    force_reduce_motion: bool,
    hide_at: Option<Instant>,
    lines: Lines,
    pub stdin_open: bool,
    last_step: Option<Instant>,
    pub stats: Stats,
}

impl Core {
    pub fn new(force_reduce_motion: bool) -> Self {
        Self {
            model: Model::default(),
            renderer: Renderer::new(),
            force_reduce_motion,
            hide_at: None,
            lines: Lines::default(),
            stdin_open: true,
            last_step: None,
            stats: Stats::default(),
        }
    }

    pub fn stdin_fd(&self) -> RawFd {
        0
    }

    /// Apply what stdin has. `desktop_reduces_motion` asks the desktop's
    /// animation setting; it runs only when the pill is about to appear.
    /// Returns the change that matters (Hide or Update wins over None).
    pub fn read_stdin(&mut self, mut desktop_reduces_motion: impl FnMut() -> bool) -> Change {
        let batch = self.lines.read(&mut RawStdin);
        self.stdin_open = batch.open;
        let mut change = Change::None;
        for m in batch.messages {
            trace("recv", &format!(",\"state\":\"{:?}\"", m.state));
            if !self.model.visible && m.state != PillState::Hidden {
                self.model.reduce_motion = self.force_reduce_motion || desktop_reduces_motion();
            }
            let c = self.apply(&m);
            if c != Change::None {
                change = c;
            }
        }
        change
    }

    fn apply(&mut self, m: &Message) -> Change {
        self.hide_at = None;
        let was_visible = self.model.visible;
        self.model.apply(m);
        if self.model.visible && self.model.leaving.is_none() {
            let width = self.renderer.width(&self.model);
            self.model.set_target_width(f64::from(width));
        }
        if !self.model.visible {
            self.last_step = None;
            return if was_visible {
                Change::Hide
            } else {
                Change::None
            };
        }
        if self.model.leaving.is_none() {
            if let Some(after) = self.model.auto_hide() {
                self.hide_at = Some(Instant::now() + after);
            }
        }
        if !was_visible {
            self.stats = Stats::default();
            if self.model.animates() {
                // The pill fades in from alpha 0: step one frame now, so the first
                // frame on screen already shows it instead of waiting a tick.
                self.model.step(FRAME.as_secs_f64());
                self.last_step = Some(Instant::now());
            }
        }
        Change::Update
    }

    /// Time until the auto-hide fires, if one is pending.
    pub fn timeout(&self) -> Option<Duration> {
        self.hide_at
            .map(|t| t.saturating_duration_since(Instant::now()))
    }

    pub fn on_timer(&mut self) -> Change {
        match self.hide_at {
            Some(t) if Instant::now() >= t => {
                self.hide_at = None;
                self.apply(&Message {
                    state: PillState::Hidden,
                    level: None,
                    label: None,
                })
            }
            _ => Change::None,
        }
    }

    /// Advance the animation to now. Returns false once the pill has sunk away.
    pub fn step(&mut self) -> bool {
        let now = Instant::now();
        let dt = self
            .last_step
            .replace(now)
            .map_or(FRAME.as_secs_f64(), |last| (now - last).as_secs_f64());
        self.stats.frame(dt);
        self.model.step(dt);
        if !self.model.visible {
            self.last_step = None;
        }
        self.model.visible
    }

    pub fn animates(&self) -> bool {
        self.model.animates()
    }

    pub fn stop_clock(&mut self) {
        self.last_step = None;
    }
}

/// stdin through read(2), so nothing sits in a user-space buffer that poll(2)
/// cannot see. Non-blocking, so a short read never stalls the event loop.
struct RawStdin;

pub fn make_stdin_nonblocking() {
    // SAFETY: plain fcntl on fd 0.
    unsafe {
        let flags = libc::fcntl(0, libc::F_GETFL);
        if flags >= 0 {
            libc::fcntl(0, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

impl std::io::Read for RawStdin {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // SAFETY: buf is valid for buf.len() bytes.
        let n = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
}

/// Frame intervals and render cost while shown; printed on hide when tracing.
#[derive(Default)]
pub struct Stats {
    intervals: Vec<f64>,
    render: Vec<f64>,
    pixels: u64,
}

impl Stats {
    fn frame(&mut self, dt: f64) {
        if self.intervals.len() < 100_000 {
            self.intervals.push(dt);
        }
    }

    pub fn rendered(&mut self, secs: f64, pixels: u64) {
        if self.render.len() < 100_000 {
            self.render.push(secs);
        }
        self.pixels += pixels;
    }

    pub fn report(&mut self, backend: &str) {
        if !trace_on() || self.intervals.len() < 3 {
            return;
        }
        // The first interval spans the gap before the first frame; drop it.
        let mut iv: Vec<f64> = self.intervals[1..].iter().map(|s| s * 1000.0).collect();
        iv.sort_by(f64::total_cmp);
        let mut rt: Vec<f64> = self.render.iter().map(|s| s * 1000.0).collect();
        rt.sort_by(f64::total_cmp);
        let q = |v: &[f64], p: f64| {
            v.get(((v.len().max(1) - 1) as f64 * p) as usize)
                .copied()
                .unwrap_or(0.0)
        };
        let mean = iv.iter().sum::<f64>() / iv.len() as f64;
        let late = iv.iter().filter(|&&x| x > mean * 1.5).count();
        let px = self.pixels / self.render.len().max(1) as u64;
        eprintln!(
            "{{\"ev\":\"frames\",\"backend\":\"{backend}\",\"n\":{},\"mean_ms\":{mean:.2},\"p50_ms\":{:.2},\"p95_ms\":{:.2},\"p99_ms\":{:.2},\"max_ms\":{:.2},\"late_1_5x\":{late},\"render_p50_ms\":{:.3},\"render_p95_ms\":{:.3},\"pixels_per_frame\":{px}}}",
            iv.len(),
            q(&iv, 0.5),
            q(&iv, 0.95),
            q(&iv, 0.99),
            q(&iv, 1.0),
            q(&rt, 0.5),
            q(&rt, 0.95),
        );
        *self = Stats::default();
    }
}

/// poll(2) on a few fds with an optional timeout; returns readiness per fd.
pub fn poll(fds: &[RawFd], timeout: Option<Duration>) -> Vec<bool> {
    let mut pfds: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let ms = timeout.map_or(-1, |d| {
        // Round up so a timer never fires a hair early and spins.
        let ms = d.as_micros().div_ceil(1000);
        ms.min(i32::MAX as u128) as i32
    });
    // SAFETY: pfds is a valid array of pollfd.
    let n = unsafe { libc::poll(pfds.as_mut_ptr(), pfds.len() as libc::nfds_t, ms) };
    if n <= 0 {
        return vec![false; fds.len()];
    }
    pfds.iter()
        .map(|p| p.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
        .collect()
}
