//! The `--pill` helper process: a GTK3 override-redirect popup on X11
//! (XWayland on Wayland desktops), driven by JSON lines on stdin.

use crate::draw;
use crate::model::{Model, CANVAS_H, CANVAS_W, HEIGHT, PAD_TOP};
use crate::Message;
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use std::cell::{Cell, RefCell};
use std::io::Read;
use std::os::fd::{AsFd, AsRawFd};
use std::rc::Rc;

/// Exit code when there is no X display to draw on; the client stops trying.
pub const UNAVAILABLE: i32 = 3;
const BOTTOM_MARGIN: i32 = 28;
/// XWayland often reports the full screen as work area, hiding Wayland panels
/// (a KDE panel is ~54 px plus its floating gap); stay clear of them then.
const PANEL_CLEARANCE: i32 = 80;
/// The pill is drawn at this size relative to its logical layout.
const SCALE: f64 = 1.2;

fn scaled(px: f64) -> i32 {
    (px * SCALE).round() as i32
}

struct Pill {
    window: gtk::Window,
    model: RefCell<Model>,
    tick: RefCell<Option<gtk::TickCallbackId>>,
    last_frame: Cell<Option<i64>>,
    hide_timer: RefCell<Option<glib::SourceId>>,
    mapped_once: Cell<bool>,
}

/// Run the helper until stdin closes. Returns the process exit code.
pub fn run_pill() -> i32 {
    if let Err(e) = gtk::init() {
        eprintln!("pill: no display: {e}");
        return UNAVAILABLE;
    }
    let window = gtk::Window::new(gtk::WindowType::Popup);
    window.set_title("delulu-talks-pill");
    window.set_app_paintable(true);
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_accept_focus(false);
    window.set_focus_on_map(false);
    window.set_can_focus(false);
    window.set_type_hint(gdk::WindowTypeHint::Notification);
    let screen = WidgetExt::screen(&window);
    match screen.as_ref().and_then(|s| s.rgba_visual()) {
        Some(visual) if screen.as_ref().is_some_and(|s| s.is_composited()) => {
            window.set_visual(Some(&visual));
        }
        _ => eprintln!("pill: no compositor, drawing without transparency"),
    }
    // One fixed canvas with room for glow and bursts; the pill animates inside it.
    window.set_size_request(scaled(CANVAS_W), scaled(CANVAS_H));
    window.resize(scaled(CANVAS_W), scaled(CANVAS_H));
    window.realize();

    let reduce_motion = gtk::Settings::default().is_some_and(|s| !s.is_gtk_enable_animations());
    let pill = Rc::new(Pill {
        window: window.clone(),
        model: RefCell::new(Model {
            reduce_motion,
            ..Model::default()
        }),
        tick: RefCell::new(None),
        last_frame: Cell::new(None),
        hide_timer: RefCell::new(None),
        mapped_once: Cell::new(false),
    });

    let p = pill.clone();
    window.connect_draw(move |_, cr| {
        cr.scale(SCALE, SCALE);
        if let Err(e) = draw::draw(cr, &p.model.borrow()) {
            eprintln!("pill: draw: {e}");
        }
        glib::Propagation::Stop
    });
    let p = pill.clone();
    window.connect_map_event(move |w, _| {
        if !p.mapped_once.replace(true) {
            let (x, y) = w.position();
            eprintln!(
                "pill: mapped at {x},{y} ({}x{}, scale {})",
                w.allocated_width(),
                w.allocated_height(),
                w.scale_factor()
            );
        }
        glib::Propagation::Proceed
    });
    if let Some(settings) = gtk::Settings::default() {
        let p = pill.clone();
        settings.connect_gtk_enable_animations_notify(move |s| {
            p.model.borrow_mut().reduce_motion = !s.is_gtk_enable_animations();
            p.sync_tick();
            p.window.queue_draw();
        });
    }

    let stdin = match std::io::stdin().as_fd().try_clone_to_owned() {
        Ok(fd) => std::fs::File::from(fd),
        Err(e) => {
            eprintln!("pill: stdin: {e}");
            return 1;
        }
    };
    let fd = stdin.as_raw_fd();
    let mut reader = Lines {
        file: stdin,
        pending: Vec::new(),
    };
    let p = pill.clone();
    glib::source::unix_fd_add_local(
        fd,
        glib::IOCondition::IN | glib::IOCondition::HUP | glib::IOCondition::ERR,
        move |_, _| {
            let open = reader.read(|line| match serde_json::from_slice::<Message>(line) {
                Ok(m) => Pill::apply(&p, &m),
                Err(e) => eprintln!("pill: bad command: {e}"),
            });
            if open {
                glib::ControlFlow::Continue
            } else {
                gtk::main_quit();
                glib::ControlFlow::Break
            }
        },
    );
    gtk::main();
    pill.window.hide();
    0
}

/// Splits stdin into lines without ever blocking the main loop.
struct Lines {
    file: std::fs::File,
    pending: Vec<u8>,
}

impl Lines {
    /// One read; returns false on end of input.
    fn read(&mut self, mut line: impl FnMut(&[u8])) -> bool {
        let mut buf = [0u8; 4096];
        let n = match self.file.read(&mut buf) {
            Ok(0) => return false,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => return true,
            Err(e) => {
                eprintln!("pill: stdin: {e}");
                return false;
            }
        };
        self.pending.extend_from_slice(&buf[..n]);
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let rest = self.pending.split_off(end + 1);
            let text = std::mem::replace(&mut self.pending, rest);
            let text = text.trim_ascii();
            if !text.is_empty() {
                line(text);
            }
        }
        if self.pending.len() > 64 * 1024 {
            self.pending.clear();
        }
        true
    }
}

impl Pill {
    fn apply(self: &Rc<Self>, m: &Message) {
        if let Some(id) = self.hide_timer.take() {
            id.remove();
        }
        let (visible, leaving, auto_hide) = {
            let mut model = self.model.borrow_mut();
            model.apply(m);
            if model.visible && model.leaving.is_none() {
                let width = draw::width(&model);
                model.set_target_width(f64::from(width));
            }
            (model.visible, model.leaving.is_some(), model.auto_hide())
        };
        if !visible {
            self.hide();
            return;
        }
        self.sync_tick();
        if leaving {
            // Sinking away; the tick hides the window when it is done.
            return;
        }
        if !self.window.is_visible() {
            self.place();
            // Click-through: an empty input shape lets every click fall to the app below.
            self.window
                .input_shape_combine_region(Some(&cairo::Region::create()));
            self.window.show();
        }
        self.window.queue_draw();
        if let Some(after) = auto_hide {
            let weak = Rc::downgrade(self);
            let id = glib::timeout_add_local_once(after, move || {
                if let Some(p) = weak.upgrade() {
                    p.hide_timer.take();
                    Pill::apply(
                        &p,
                        &Message {
                            state: crate::PillState::Hidden,
                            level: None,
                            label: None,
                        },
                    );
                }
            });
            *self.hide_timer.borrow_mut() = Some(id);
        }
    }

    fn hide(self: &Rc<Self>) {
        self.sync_tick();
        self.window.hide();
    }

    /// Bottom centre of the active monitor's work area, so KDE panels stay clear.
    fn place(&self) {
        let display = self.window.display();
        let Some(monitor) = active_monitor(&display)
            .or_else(|| display.primary_monitor())
            .or_else(|| display.monitor(0))
        else {
            return;
        };
        let geometry = monitor.geometry();
        let mut area = monitor.workarea();
        if area.width() <= 0 || area.height() <= 0 {
            area = geometry;
        }
        if area.width() <= 0 || area.height() <= 0 {
            // No monitor right now (screen off or unplugged); place it on the next update.
            return;
        }
        let bottom = area.y() + area.height();
        let margin = if bottom >= geometry.y() + geometry.height() {
            PANEL_CLEARANCE
        } else {
            BOTTOM_MARGIN
        };
        // The pill's bottom edge sits `margin` above the bottom; glow room hangs below.
        self.window.move_(
            area.x() + (area.width() - scaled(CANVAS_W)) / 2,
            bottom - margin - scaled(PAD_TOP + f64::from(HEIGHT)),
        );
    }

    /// Run frames only while something moves.
    fn sync_tick(self: &Rc<Self>) {
        let animate = self.model.borrow().animates();
        let mut tick = self.tick.borrow_mut();
        if animate && tick.is_none() {
            let weak = Rc::downgrade(self);
            *tick = Some(self.window.add_tick_callback(move |w, clock| {
                let Some(p) = weak.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                let now = clock.frame_time();
                let dt = p
                    .last_frame
                    .replace(Some(now))
                    .map_or(1.0 / 60.0, |last| (now - last) as f64 / 1e6);
                let visible = {
                    let mut model = p.model.borrow_mut();
                    model.step(dt);
                    model.visible
                };
                w.queue_draw();
                if !visible {
                    // Done sinking away; hide outside this callback.
                    let p = p.clone();
                    glib::idle_add_local_once(move || {
                        // A new message may have brought it back meanwhile.
                        if !p.model.borrow().visible {
                            p.hide();
                        }
                    });
                }
                glib::ControlFlow::Continue
            }));
        } else if !animate {
            if let Some(id) = tick.take() {
                id.remove();
            }
            self.last_frame.set(None);
        }
    }
}

/// The monitor KWin calls active (where the pointer or focus is). XWayland only
/// sees the pointer over X windows, so ask the compositor. None off KDE.
fn active_monitor(display: &gdk::Display) -> Option<gdk::Monitor> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()?;
    let reply = bus
        .call_sync(
            Some("org.kde.KWin"),
            "/KWin",
            "org.kde.KWin",
            "activeOutputName",
            None,
            Some(glib::VariantTy::new("(s)").ok()?),
            gio::DBusCallFlags::NO_AUTO_START,
            200,
            gio::Cancellable::NONE,
        )
        .ok()?;
    let (name,): (String,) = reply.get()?;
    (0..display.n_monitors())
        .filter_map(|i| display.monitor(i))
        .find(|m| m.model().is_some_and(|model| model == name))
}
