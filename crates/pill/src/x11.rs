//! X11 backend (GNOME through XWayland, X11 sessions): an override-redirect
//! ARGB window with an empty input shape and no input hint, painted through
//! MIT-SHM, bottom centre of the primary monitor's work area.
//!
//! The primary monitor, not the pointer's: XWayland's pointer position is
//! stale while the pointer is over Wayland windows, so it would pick the wrong
//! monitor. Today's GTK pill lands on the primary monitor on GNOME too.

use crate::desktop;
use crate::runtime::{poll, trace, Change, Core, FRAME};
use delulu_pill::draw::{blit_bgra, canvas_size, union};
use delulu_pill::model::{HEIGHT, PAD_TOP};
use delulu_pill::{BOTTOM_MARGIN, PANEL_CLEARANCE, SCALE, UNAVAILABLE};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};
use tiny_skia::IntRect;
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shape::{self, SK, SO};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    AtomEnum, ClipOrdering, ColormapAlloc, ConfigureWindowAux, ConnectionExt as _, CreateGCAux,
    CreateWindowAux, EventMask, ImageFormat, PropMode, VisualClass, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

type Error = Box<dyn std::error::Error>;

/// A shared-memory image the size of the window.
struct ShmBuf {
    seg: shm::Seg,
    ptr: *mut u8,
    len: usize,
    /// The server has not finished reading the last frame.
    busy: bool,
}

impl ShmBuf {
    fn new(conn: &RustConnection, len: usize) -> Option<ShmBuf> {
        conn.shm_query_version().ok()?.reply().ok()?;
        // SAFETY: a plain syscall; the fd is owned below.
        let fd = unsafe { libc::memfd_create(c"delulu-pill".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        // SAFETY: fd is a fresh memfd we own.
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: a valid fd and length.
        if unsafe { libc::ftruncate(owned.as_raw_fd(), len as libc::off_t) } != 0 {
            return None;
        }
        // SAFETY: a shared mapping of our own memfd.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                owned.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }
        let buf = ShmBuf {
            seg: conn.generate_id().ok()?,
            ptr: ptr.cast(),
            len,
            busy: false,
        };
        // Dropping `buf` unmaps it if attaching fails.
        conn.shm_attach_fd(buf.seg, owned, false).ok()?.check().ok()?;
        Some(buf)
    }

    fn bytes(&mut self) -> &mut [u8] {
        // SAFETY: our own mapping of `len` bytes; callers write only while the
        // server is not reading it (`busy` is false).
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }

    fn detach(self, conn: &RustConnection) {
        let _ = conn.shm_detach(self.seg);
    }
}

impl Drop for ShmBuf {
    fn drop(&mut self) {
        // SAFETY: our own mapping, unmapped once.
        unsafe { libc::munmap(self.ptr.cast(), self.len) };
    }
}

/// The window's pixels: shared memory, or a local copy sent with PutImage.
enum Image {
    Shm(ShmBuf),
    Local(Vec<u8>),
}

struct X {
    conn: RustConnection,
    screen: usize,
    root: u32,
    win: u32,
    gc: u32,
    scale: f64,
    w: u16,
    h: u16,
    image: Image,
    /// The canvas rectangle the image holds pixels in.
    content: Option<IntRect>,
    /// What the window shows; None after an expose or resize (redraw all).
    shown: Option<Option<IntRect>>,
    mapped: bool,
    next_frame: Option<Instant>,
    period: Duration,
    xsettings: Option<u32>,
}

pub fn run(core: Core) -> i32 {
    let (conn, screen) = match x11rb::connect(None) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("pill: no X display: {e}");
            return UNAVAILABLE;
        }
    };
    match X::new(conn, screen) {
        Ok(mut x) => x.run(core),
        Err(e) => {
            eprintln!("pill: x11 setup: {e}");
            UNAVAILABLE
        }
    }
}

fn atom(conn: &RustConnection, name: &[u8]) -> Result<u32, Error> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}

impl X {
    fn new(conn: RustConnection, screen: usize) -> Result<X, Error> {
        let setup = conn.setup().roots[screen].clone();
        let root = setup.root;
        let visual = setup
            .allowed_depths
            .iter()
            .filter(|d| d.depth == 32)
            .flat_map(|d| d.visuals.iter())
            .find(|v| v.class == VisualClass::TRUE_COLOR)
            .map(|v| v.visual_id)
            .ok_or("no 32-bit TrueColor visual (no compositing?)")?;
        let cmap = conn.generate_id()?;
        conn.create_colormap(ColormapAlloc::NONE, cmap, root, visual)?;
        let win = conn.generate_id()?;
        conn.create_window(
            32,
            win,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            visual,
            &CreateWindowAux::new()
                .background_pixel(0)
                .border_pixel(0)
                .override_redirect(1)
                .colormap(cmap)
                .event_mask(EventMask::EXPOSURE),
        )?;
        conn.change_property8(
            PropMode::REPLACE,
            win,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            b"delulu-talks-pill",
        )?;
        conn.change_property8(
            PropMode::REPLACE,
            win,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"delulu-pill\0Delulu-pill\0",
        )?;
        let wtype = atom(&conn, b"_NET_WM_WINDOW_TYPE")?;
        let notification = atom(&conn, b"_NET_WM_WINDOW_TYPE_NOTIFICATION")?;
        conn.change_property32(PropMode::REPLACE, win, wtype, AtomEnum::ATOM, &[notification])?;
        // WM_HINTS: flags = InputHint, input = False. It never asks for focus.
        conn.change_property32(
            PropMode::REPLACE,
            win,
            AtomEnum::WM_HINTS,
            AtomEnum::WM_HINTS,
            &[1, 0, 0, 0, 0, 0, 0, 0, 0],
        )?;
        // Click-through: an empty input shape.
        shape::rectangles(&conn, SO::SET, SK::INPUT, ClipOrdering::UNSORTED, win, 0, 0, &[])?;
        let gc = conn.generate_id()?;
        conn.create_gc(gc, win, &CreateGCAux::new().graphics_exposures(0))?;
        let xsettings = atom(&conn, format!("_XSETTINGS_S{screen}").as_bytes()).ok();
        let hz = std::env::var("DELULU_PILL_HZ")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|hz| (1.0..=500.0).contains(hz));
        let mut x = X {
            conn,
            screen,
            root,
            win,
            gc,
            scale: 0.0,
            w: 0,
            h: 0,
            image: Image::Local(Vec::new()),
            content: None,
            shown: None,
            mapped: false,
            next_frame: None,
            period: hz.map_or(FRAME, |hz| Duration::from_secs_f64(1.0 / hz)),
            xsettings,
        };
        x.rescale();
        x.conn.flush()?;
        eprintln!(
            "pill: x11 backend (window {}x{}, scale {}, shm {})",
            x.w,
            x.h,
            x.scale,
            matches!(x.image, Image::Shm(_))
        );
        Ok(x)
    }

    fn resources(&self) -> String {
        self.conn
            .get_property(false, self.root, AtomEnum::RESOURCE_MANAGER, AtomEnum::STRING, 0, 1 << 16)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.value).into_owned())
            .unwrap_or_default()
    }

    /// Follow the session's scale (it can change between shows): size the
    /// window and its image for it.
    fn rescale(&mut self) {
        let scale = desktop::x11_scale(
            std::env::var("DELULU_PILL_X11_SCALE").ok().as_deref(),
            std::env::var("GDK_SCALE").ok().as_deref(),
            &self.resources(),
        );
        if scale == self.scale {
            return;
        }
        let (w, h) = canvas_size(SCALE * scale);
        self.scale = scale;
        (self.w, self.h) = (w as u16, h as u16);
        let _ = self.conn.configure_window(
            self.win,
            &ConfigureWindowAux::new().width(w).height(h),
        );
        let len = w as usize * h as usize * 4;
        let old = std::mem::replace(&mut self.image, Image::Local(Vec::new()));
        if let Image::Shm(buf) = old {
            buf.detach(&self.conn);
        }
        self.image = match ShmBuf::new(&self.conn, len) {
            Some(buf) => Image::Shm(buf),
            None => Image::Local(vec![0; len]),
        };
        // A fresh image is all zeroes; the window needs a full redraw.
        self.content = None;
        self.shown = None;
    }

    /// The desktop's "enable animations" (XSETTINGS, which GNOME and KDE both
    /// publish to X clients).
    fn reduces_motion(&self) -> bool {
        let read = || -> Option<bool> {
            let owner = self
                .conn
                .get_selection_owner(self.xsettings?)
                .ok()?
                .reply()
                .ok()?
                .owner;
            if owner == 0 {
                return None;
            }
            let prop = atom(&self.conn, b"_XSETTINGS_SETTINGS").ok()?;
            let reply = self
                .conn
                .get_property(false, owner, prop, prop, 0, 1 << 16)
                .ok()?
                .reply()
                .ok()?;
            desktop::xsettings_int(&reply.value, "Net/EnableAnimations").map(|on| on == 0)
        };
        read().unwrap_or(false)
    }

    fn run(&mut self, mut core: Core) -> i32 {
        trace("ready", ",\"backend\":\"x11\"");
        let x_fd = self.conn.stream().as_raw_fd();
        let stdin_fd = core.stdin_fd();
        loop {
            if self.drain(&mut core).is_err() {
                return 1;
            }
            let _ = self.conn.flush();
            let now = Instant::now();
            let frame_in = self.next_frame.map(|t| t.saturating_duration_since(now));
            let timeout = match (frame_in, core.timeout()) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let ready = poll(&[x_fd, stdin_fd], timeout);
            if ready[1] {
                let mapped = self.mapped;
                let change = core.read_stdin(|| !mapped && self.reduces_motion());
                self.handle(change, &mut core);
                if !core.stdin_open {
                    self.hide(&mut core);
                    let _ = self.conn.flush();
                    return 0;
                }
            }
            let change = core.on_timer();
            self.handle(change, &mut core);
            if let Some(t) = self.next_frame {
                let now = Instant::now();
                if now >= t {
                    // Keep the cadence; after a stall, restart it from now.
                    self.next_frame = Some(if now - t > self.period {
                        now + self.period
                    } else {
                        t + self.period
                    });
                    if !core.animates() {
                        self.next_frame = None;
                    } else if core.step() {
                        self.draw(&mut core);
                    } else {
                        self.hide(&mut core);
                    }
                }
            }
        }
    }

    fn drain(&mut self, core: &mut Core) -> Result<(), x11rb::errors::ConnectionError> {
        while let Some(ev) = self.conn.poll_for_event()? {
            match ev {
                Event::Expose(e) if e.count == 0 && self.mapped => {
                    self.shown = None;
                    self.draw(core);
                }
                Event::ShmCompletion(_) => {
                    if let Image::Shm(s) = &mut self.image {
                        s.busy = false;
                    }
                }
                Event::Error(e) => eprintln!("pill: x11 error: {e:?}"),
                _ => {}
            }
        }
        Ok(())
    }

    fn handle(&mut self, change: Change, core: &mut Core) {
        match change {
            Change::None => {}
            Change::Hide => self.hide(core),
            Change::Update => {
                if !self.mapped {
                    self.show(core);
                } else if self.next_frame.is_none() {
                    self.draw(core);
                }
                if core.animates() && self.next_frame.is_none() {
                    self.next_frame = Some(Instant::now() + self.period);
                }
            }
        }
    }

    fn show(&mut self, core: &mut Core) {
        self.rescale();
        let (x, y) = self.place();
        let _ = self
            .conn
            .configure_window(self.win, &ConfigureWindowAux::new().x(x).y(y));
        let _ = self.conn.map_window(self.win);
        self.mapped = true;
        self.shown = None;
        trace("map_request", &format!(",\"pos\":[{x},{y}]"));
        self.draw(core);
    }

    fn hide(&mut self, core: &mut Core) {
        if self.mapped {
            let _ = self.conn.unmap_window(self.win);
            let _ = self.conn.flush();
            self.mapped = false;
            trace("unmapped", "");
            core.stats.report("x11");
        }
        self.next_frame = None;
        core.stop_clock();
    }

    /// Bottom centre of the primary monitor's work area, clear of panels.
    fn place(&self) -> (i32, i32) {
        let monitors: Vec<Monitor> = self
            .conn
            .randr_get_monitors(self.root, true)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| {
                r.monitors
                    .iter()
                    .map(|m| Monitor {
                        rect: (
                            i32::from(m.x),
                            i32::from(m.y),
                            i32::from(m.width),
                            i32::from(m.height),
                        ),
                        primary: m.primary,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let screen = &self.conn.setup().roots[self.screen];
        let whole = (
            0,
            0,
            i32::from(screen.width_in_pixels),
            i32::from(screen.height_in_pixels),
        );
        let monitor = monitors
            .iter()
            .find(|m| m.primary)
            .or(monitors.first())
            .map_or(whole, |m| m.rect);
        let area = self.workarea(monitor).unwrap_or(monitor);
        let pos = place(monitor, area, (self.w, self.h), self.scale);
        trace(
            "place",
            &format!(
                ",\"monitor\":[{},{},{},{}],\"area\":[{},{},{},{}],\"monitors\":{}",
                monitor.0,
                monitor.1,
                monitor.2,
                monitor.3,
                area.0,
                area.1,
                area.2,
                area.3,
                monitors.len()
            ),
        );
        pos
    }

    /// The monitor's work area from _GTK_WORKAREAS_D0 (mutter) or _NET_WORKAREA.
    fn workarea(&self, mon: Rect) -> Option<Rect> {
        let prop = |name: &[u8]| -> Option<Vec<u32>> {
            let atom = self.conn.intern_atom(true, name).ok()?.reply().ok()?.atom;
            if atom == 0 {
                return None;
            }
            let r = self
                .conn
                .get_property(false, self.root, atom, AtomEnum::CARDINAL, 0, 1024)
                .ok()?
                .reply()
                .ok()?;
            let v: Vec<u32> = r.value32()?.collect();
            (v.len() >= 4).then_some(v)
        };
        let rects = prop(b"_GTK_WORKAREAS_D0")
            .or_else(|| prop(b"_NET_WORKAREA").map(|v| v[..4].to_vec()))?;
        rects
            .as_chunks::<4>()
            .0
            .iter()
            .filter_map(|r| {
                let (x, y, w, h) = (r[0] as i32, r[1] as i32, r[2] as i32, r[3] as i32);
                let x0 = x.max(mon.0);
                let y0 = y.max(mon.1);
                let x1 = (x + w).min(mon.0 + mon.2);
                let y1 = (y + h).min(mon.1 + mon.3);
                (x1 > x0 && y1 > y0).then_some((x0, y0, x1 - x0, y1 - y0))
            })
            .max_by_key(|r| r.2 * r.3)
    }

    fn draw(&mut self, core: &mut Core) {
        if !self.mapped {
            return;
        }
        if matches!(&self.image, Image::Shm(s) if s.busy) {
            // The server has not finished reading the last frame; skip this one.
            return;
        }
        let started = Instant::now();
        let (w, h) = (self.w, self.h);
        let stride = usize::from(w) * 4;
        let frame = core
            .renderer
            .render(&core.model, SCALE * self.scale, (u32::from(w), u32::from(h)));
        let rect = frame.as_ref().map(|f| f.rect);
        let damage = match self.shown {
            None => IntRect::from_xywh(0, 0, u32::from(w), u32::from(h)),
            Some(old) => union(old, rect),
        };
        let pixels = match &mut self.image {
            Image::Shm(s) => s.bytes(),
            Image::Local(v) => v.as_mut_slice(),
        };
        blit_bgra(frame.as_ref(), self.content, pixels, stride);
        self.content = rect;
        self.shown = Some(rect);
        if let Some(d) = damage {
            let (x, y, dw, dh) = (d.x() as i16, d.y() as i16, d.width() as u16, d.height() as u16);
            match &mut self.image {
                Image::Shm(s) => {
                    s.busy = true;
                    let _ = shm::put_image(
                        &self.conn,
                        self.win,
                        self.gc,
                        w,
                        h,
                        x as u16,
                        y as u16,
                        dw,
                        dh,
                        x,
                        y,
                        32,
                        ImageFormat::Z_PIXMAP.into(),
                        true,
                        s.seg,
                        0,
                    );
                }
                Image::Local(v) => {
                    // PutImage takes contiguous rows: copy the damaged ones out,
                    // a few at a time to stay under the request size limit.
                    let row = usize::from(dw) * 4;
                    let rows = (60_000 / row).max(1);
                    let mut chunk = Vec::with_capacity(rows * row);
                    let mut top = d.top();
                    while top < d.bottom() {
                        let n = (d.bottom() - top).min(rows as i32);
                        chunk.clear();
                        for yy in top..top + n {
                            let at = yy as usize * stride + d.x() as usize * 4;
                            chunk.extend_from_slice(&v[at..at + row]);
                        }
                        let _ = self.conn.put_image(
                            ImageFormat::Z_PIXMAP,
                            self.win,
                            self.gc,
                            dw,
                            n as u16,
                            x,
                            top as i16,
                            0,
                            32,
                            &chunk,
                        );
                        top += n;
                    }
                }
            }
        }
        let _ = self.conn.flush();
        let pixels = rect.map_or(0, |r| u64::from(r.width()) * u64::from(r.height()));
        core.stats
            .rendered(started.elapsed().as_secs_f64(), pixels);
    }
}

type Rect = (i32, i32, i32, i32);

struct Monitor {
    rect: Rect,
    primary: bool,
}

/// The window position: centred in the work area, the pill's bottom edge
/// `BOTTOM_MARGIN` above its bottom, or `PANEL_CLEARANCE` when the work area
/// reaches the monitor's bottom (XWayland often hides Wayland panels from it).
/// Margins are logical pixels, so they scale with the window.
fn place(monitor: Rect, area: Rect, (w, _h): (u16, u16), scale: f64) -> (i32, i32) {
    let bottom = area.1 + area.3;
    let margin = if bottom >= monitor.1 + monitor.3 {
        PANEL_CLEARANCE
    } else {
        BOTTOM_MARGIN
    };
    let above_bottom_edge = (margin + (PAD_TOP + f64::from(HEIGHT)) * SCALE) * scale;
    (
        area.0 + (area.2 - i32::from(w)) / 2,
        bottom - above_bottom_edge.round() as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_scales_its_margins() {
        let monitor = (0, 0, 1920, 1080);
        // No panel in the work area: clear an unseen Wayland panel.
        let (w, h) = (466, 134);
        let (x, y) = place(monitor, monitor, (w, h), 1.0);
        assert_eq!(x, (1920 - 466) / 2);
        // The pill's bottom edge (PAD_TOP + HEIGHT down the canvas, at 1.2).
        let pill_bottom = |y: i32, s: f64| y + ((PAD_TOP + f64::from(HEIGHT)) * SCALE * s).round() as i32;
        assert_eq!(1080 - pill_bottom(y, 1.0), 80);
        // A real panel in the work area: the normal margin above it.
        let area = (0, 0, 1920, 1032);
        let (_, y) = place(monitor, area, (w, h), 1.0);
        assert_eq!(1032 - pill_bottom(y, 1.0), 28);
        // At 2x (XWayland at native resolution), both double.
        let monitor2 = (1920, 0, 3840, 2160);
        let area2 = (1920, 0, 3840, 2064);
        let (x, y) = place(monitor2, area2, (932, 268), 2.0);
        assert_eq!(x, 1920 + (3840 - 932) / 2);
        assert_eq!(2064 - pill_bottom(y, 2.0), 56);
        let (_, y) = place(monitor2, monitor2, (932, 268), 2.0);
        assert_eq!(2160 - pill_bottom(y, 2.0), 160);
    }
}
