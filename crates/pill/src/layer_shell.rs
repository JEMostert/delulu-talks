//! Layer-shell backend (KDE Plasma, wlroots): an overlay-layer surface with no
//! keyboard interactivity and an empty input region, anchored bottom centre of
//! the output the compositor picks (output None: KWin uses its active output).
//!
//! The surface is created on each show and destroyed on hide, so every
//! appearance lands on the then-active output. wp_fractional_scale with
//! wp_viewporter keeps it sharp at 125 % or 150 %; frame callbacks pace the
//! animation at the output's refresh rate.

use crate::runtime::{poll, trace, Change, Core};
use delulu_pill::draw::{blit_bgra, union};
use delulu_pill::model::{CANVAS_H, CANVAS_W, HEIGHT, PAD_TOP};
use delulu_pill::{BOTTOM_MARGIN, SCALE, UNAVAILABLE};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState, FrameCallbackData, Region},
    delegate_registry,
    dispatch2::Dispatch2,
    output::{OutputHandler, OutputState},
    presentation_time::{PresentTime, PresentationTimeHandler, PresentationTimeState},
    reexports::{
        client::{
            globals::{registry_queue_init, GlobalListContents},
            protocol::{wl_output, wl_registry, wl_shm, wl_surface},
            Connection, Dispatch, QueueHandle, WEnum,
        },
        protocols::wp::{
            fractional_scale::v1::client::{
                wp_fractional_scale_manager_v1, wp_fractional_scale_v1,
            },
            presentation_time::client::wp_presentation_feedback,
            viewporter::client::{wp_viewport, wp_viewporter},
        },
    },
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{
        slot::{Buffer, SlotPool},
        Shm, ShmHandler,
    },
};
use std::os::fd::AsRawFd;
use std::time::Instant;
use tiny_skia::IntRect;

/// The surface's logical size: the canvas at the pill's [`SCALE`].
fn logical_size() -> (i32, i32) {
    (
        (CANVAS_W * SCALE).round() as i32,
        (CANVAS_H * SCALE).round() as i32,
    )
}

/// User data for the few protocol objects sctk does not wrap.
struct Wp;

/// An shm buffer and the canvas rectangle it last held pixels in.
struct Slot {
    buffer: Buffer,
    /// None: clear. A fresh buffer's memory may hold anything, so it starts as
    /// the whole canvas.
    content: Option<IntRect>,
}

struct Shown {
    layer: LayerSurface,
    frac: Option<wp_fractional_scale_v1::WpFractionalScaleV1>,
    viewport: Option<wp_viewport::WpViewport>,
    configured: bool,
    frame_pending: bool,
    /// The canvas rectangle the last commit showed pixels in.
    committed: Option<IntRect>,
    /// The next commit damages the whole surface: the first one, or after a
    /// scale change.
    full_damage: bool,
    /// Presentation feedback for the first frames, when tracing.
    feedback_left: u8,
}

struct Wl {
    core: Core,
    registry: RegistryState,
    outputs: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    shm: Shm,
    presentation: PresentationTimeState,
    frac_mgr: Option<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1>,
    viewporter: Option<wp_viewporter::WpViewporter>,
    pool: SlotPool,
    slots: Vec<Slot>,
    shown: Option<Shown>,
    /// Preferred scale ×120 from wp_fractional_scale, or 0.
    scale120: u32,
    int_scale: i32,
    logged_scale: f64,
}

struct Probe;

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Probe {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

fn globals() -> Option<Vec<(String, u32)>> {
    let conn = Connection::connect_to_env().ok()?;
    let (globals, _queue) = registry_queue_init::<Probe>(&conn).ok()?;
    Some(
        globals
            .contents()
            .with_list(|l| l.iter().map(|g| (g.interface.clone(), g.version)).collect()),
    )
}

/// Whether the compositor offers layer-shell.
pub fn available() -> bool {
    globals().is_some_and(|g| g.iter().any(|(name, _)| name == "zwlr_layer_shell_v1"))
}

/// Print every global the compositor offers (for "does this desktop offer
/// layer-shell?" in bug reports).
pub fn list_globals() -> i32 {
    let Some(globals) = globals() else {
        eprintln!("pill: no Wayland display");
        return UNAVAILABLE;
    };
    for (name, version) in globals {
        println!("{name} v{version}");
    }
    0
}

pub fn run(core: Core) -> i32 {
    let conn = match Connection::connect_to_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("pill: wayland: {e}");
            return UNAVAILABLE;
        }
    };
    let (globals, mut queue) = match registry_queue_init::<Wl>(&conn) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("pill: wayland registry: {e}");
            return UNAVAILABLE;
        }
    };
    let qh = queue.handle();
    let (Ok(compositor), Ok(layer_shell), Ok(shm)) = (
        CompositorState::bind(&globals, &qh),
        LayerShell::bind(&globals, &qh),
        Shm::bind(&globals, &qh),
    ) else {
        eprintln!("pill: the compositor lacks wl_compositor, layer-shell or wl_shm");
        return UNAVAILABLE;
    };
    let (lw, lh) = logical_size();
    let Ok(pool) = SlotPool::new((lw * lh * 4 * 2) as usize, &shm) else {
        eprintln!("pill: no shared memory for the pill");
        return 1;
    };
    let mut state = Wl {
        core,
        registry: RegistryState::new(&globals),
        outputs: OutputState::new(&globals, &qh),
        compositor,
        layer_shell,
        shm,
        presentation: PresentationTimeState::bind(&globals, &qh),
        frac_mgr: globals.bind(&qh, 1..=1, Wp).ok(),
        viewporter: globals.bind(&qh, 1..=1, Wp).ok(),
        pool,
        slots: Vec::new(),
        shown: None,
        scale120: 0,
        int_scale: 1,
        logged_scale: 0.0,
    };
    // Learn the outputs before the first show.
    let _ = queue.roundtrip(&mut state);
    eprintln!(
        "pill: layer-shell backend (fractional-scale {}, viewporter {})",
        state.frac_mgr.is_some(),
        state.viewporter.is_some()
    );
    trace("ready", ",\"backend\":\"layer-shell\"");

    let stdin_fd = state.core.stdin_fd();
    loop {
        if conn.flush().is_err() {
            return 1;
        }
        let guard = loop {
            match queue.prepare_read() {
                Some(g) => break g,
                None => {
                    if queue.dispatch_pending(&mut state).is_err() {
                        return 1;
                    }
                }
            }
        };
        let wl_fd = guard.connection_fd().as_raw_fd();
        let ready = poll(&[wl_fd, stdin_fd], state.core.timeout());
        if ready[0] {
            if let Err(e) = guard.read() {
                eprintln!("pill: wayland read: {e}");
                return 1;
            }
        } else {
            drop(guard);
        }
        if queue.dispatch_pending(&mut state).is_err() {
            return 1;
        }
        if ready[1] {
            let change = state.core.read_stdin(reduces_motion);
            state.handle(change, &qh);
            if !state.core.stdin_open {
                state.hide();
                let _ = conn.flush();
                return 0;
            }
        }
        let change = state.core.on_timer();
        state.handle(change, &qh);
    }
}

/// The desktop's animation setting. Only KDE publishes one a layer-shell
/// client can read without D-Bus.
fn reduces_motion() -> bool {
    crate::desktop::kdeglobals_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| crate::desktop::kde_reduces_motion(&text))
        .unwrap_or(false)
}

impl Wl {
    fn handle(&mut self, change: Change, qh: &QueueHandle<Self>) {
        match change {
            Change::None => {}
            Change::Hide => self.hide(),
            Change::Update => match &self.shown {
                None => self.show(qh),
                Some(s) if s.configured && !s.frame_pending => self.draw(qh),
                // A frame callback is coming and draws the new state.
                Some(_) => {}
            },
        }
    }

    fn show(&mut self, qh: &QueueHandle<Self>) {
        let surface = self.compositor.create_surface(qh);
        let frac = self
            .frac_mgr
            .as_ref()
            .map(|m| m.get_fractional_scale(&surface, qh, Wp));
        let viewport = self
            .viewporter
            .as_ref()
            .map(|v| v.get_viewport(&surface, qh, Wp));
        let layer = self.layer_shell.create_layer_surface(
            qh,
            surface,
            Layer::Overlay,
            Some("delulu-pill"),
            None,
        );
        let (lw, lh) = logical_size();
        layer.set_anchor(Anchor::BOTTOM);
        layer.set_size(lw as u32, lh as u32);
        // The pill's bottom edge sits BOTTOM_MARGIN above the usable area (the
        // compositor keeps panels' exclusive zones out of it); the glow room
        // below the pill hangs into that margin. In logical pixels, so the
        // compositor scales it with the output.
        let below_pill = f64::from(lh) - (PAD_TOP + f64::from(HEIGHT)) * SCALE;
        layer.set_margin(0, 0, (BOTTOM_MARGIN - below_pill).round() as i32, 0);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer.set_exclusive_zone(0);
        // Click-through: an empty input region.
        if let Ok(region) = Region::new(&self.compositor) {
            layer.set_input_region(Some(region.wl_region()));
        }
        layer.commit();
        trace("map_request", "");
        self.shown = Some(Shown {
            layer,
            frac,
            viewport,
            configured: false,
            frame_pending: false,
            committed: None,
            full_damage: true,
            feedback_left: 2,
        });
    }

    fn hide(&mut self) {
        if let Some(s) = self.shown.take() {
            if let Some(f) = s.frac {
                f.destroy();
            }
            if let Some(v) = s.viewport {
                v.destroy();
            }
            drop(s.layer);
            trace("unmapped", "");
            self.core.stats.report("layer-shell");
        }
        self.core.stop_clock();
    }

    fn fractional(&self) -> bool {
        self.scale120 > 0 && self.viewporter.is_some()
    }

    fn scale(&self) -> f64 {
        if self.fractional() {
            f64::from(self.scale120) / 120.0
        } else {
            f64::from(self.int_scale.max(1))
        }
    }

    fn draw(&mut self, qh: &QueueHandle<Self>) {
        let started = Instant::now();
        let s = self.scale();
        let fractional = self.fractional();
        let (lw, lh) = logical_size();
        let (bw, bh) = (
            (f64::from(lw) * s).round() as u32,
            (f64::from(lh) * s).round() as u32,
        );
        if s != self.logged_scale {
            eprintln!("pill: drawing at scale {s} ({bw}x{bh} buffer for {lw}x{lh})");
            self.logged_scale = s;
        }
        let Some(shown) = self.shown.as_mut() else {
            return;
        };
        if !shown.configured {
            return;
        }
        let stride = bw as i32 * 4;
        // A buffer the compositor is done with, of this size, or a new one.
        self.slots
            .retain(|b| b.buffer.height() == bh as i32 && b.buffer.stride() == stride);
        let idx = match self
            .slots
            .iter()
            .position(|b| b.buffer.slot().canvas(&mut self.pool).is_some())
        {
            Some(i) => i,
            None => match self.pool.create_buffer(
                bw as i32,
                bh as i32,
                stride,
                wl_shm::Format::Argb8888,
            ) {
                Ok((buffer, _)) => {
                    self.slots.push(Slot {
                        buffer,
                        content: IntRect::from_xywh(0, 0, bw, bh),
                    });
                    self.slots.len() - 1
                }
                Err(e) => {
                    eprintln!("pill: buffer: {e}");
                    return;
                }
            },
        };
        // Device pixels per logical canvas unit: the pill scale times the output scale.
        let draw_scale = SCALE * f64::from(bw) / f64::from(lw);
        let frame = self
            .core
            .renderer
            .render(&self.core.model, draw_scale, (bw, bh));
        let rect = frame.as_ref().map(|f| f.rect);
        let slot = &mut self.slots[idx];
        if let Some(canvas) = slot.buffer.slot().canvas(&mut self.pool) {
            blit_bgra(frame.as_ref(), slot.content, canvas, stride as usize);
        }
        slot.content = rect;
        let pixels = rect.map_or(0, |r| u64::from(r.width()) * u64::from(r.height()));
        let surface = shown.layer.wl_surface().clone();
        if fractional {
            if let Some(v) = &shown.viewport {
                v.set_destination(lw, lh);
            }
            let _ = shown.layer.set_buffer_scale(1);
        } else {
            let _ = shown.layer.set_buffer_scale(s as u32);
        }
        // Only what changed since the last commit: the old and new pixels.
        let damage = if shown.full_damage {
            IntRect::from_xywh(0, 0, bw, bh)
        } else {
            union(shown.committed, rect)
        };
        if let Some(d) = damage {
            surface.damage_buffer(d.x(), d.y(), d.width() as i32, d.height() as i32);
        }
        shown.committed = rect;
        shown.full_damage = false;
        if self.core.animates() {
            surface.frame(qh, FrameCallbackData(surface.clone()));
            shown.frame_pending = true;
        }
        if shown.feedback_left > 0 {
            shown.feedback_left -= 1;
            let _ = self.presentation.feedback(&surface, qh);
            trace("commit", &format!(",\"frame\":{}", 2 - shown.feedback_left));
        }
        if slot.buffer.attach_to(&surface).is_err() {
            eprintln!("pill: buffer busy");
        }
        shown.layer.commit();
        self.core
            .stats
            .rendered(started.elapsed().as_secs_f64(), pixels);
    }

    fn redraw(&mut self, qh: &QueueHandle<Self>) {
        if let Some(s) = self.shown.as_mut() {
            // The buffer size changes with the scale: damage all of it.
            s.full_damage = true;
            if s.configured && !s.frame_pending {
                self.draw(qh);
            }
        }
    }
}

impl CompositorHandler for Wl {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        f: i32,
    ) {
        if f != self.int_scale {
            self.int_scale = f;
            if !self.fractional() {
                self.redraw(qh);
            }
        }
    }
    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
    }
    fn frame(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {
        if let Some(s) = self.shown.as_mut() {
            s.frame_pending = false;
        }
        if !self.core.animates() {
            return;
        }
        if self.core.step() {
            self.draw(qh);
        } else {
            self.hide();
        }
    }
    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        o: &wl_output::WlOutput,
    ) {
        if let Some(info) = self.outputs.info(o) {
            let name = info.name.clone().unwrap_or_default();
            trace(
                "surface_enter",
                &format!(
                    ",\"output\":\"{name}\",\"pos\":[{},{}],\"scale\":{}",
                    info.logical_position.map_or(0, |p| p.0),
                    info.logical_position.map_or(0, |p| p.1),
                    info.scale_factor
                ),
            );
            eprintln!(
                "pill: on output {name} at {:?} ({:?})",
                info.logical_position, info.logical_size
            );
        }
    }
    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}

impl LayerShellHandler for Wl {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &LayerSurface) {
        // The compositor took it away (output gone); the next show makes a new one.
        self.shown = None;
        self.core.stop_clock();
    }
    fn configure(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        _: &LayerSurface,
        c: LayerSurfaceConfigure,
        _: u32,
    ) {
        trace(
            "configure",
            &format!(",\"size\":[{},{}]", c.new_size.0, c.new_size.1),
        );
        if let Some(s) = self.shown.as_mut() {
            s.configured = true;
            if !s.frame_pending {
                self.draw(qh);
            }
        }
    }
}

impl OutputHandler for Wl {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
}

impl ShmHandler for Wl {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

impl PresentationTimeHandler for Wl {
    fn presentation_time_state(&mut self) -> &mut PresentationTimeState {
        &mut self.presentation
    }
    #[allow(clippy::too_many_arguments)]
    fn presented(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        _: &wl_surface::WlSurface,
        _: Vec<wl_output::WlOutput>,
        time: PresentTime,
        refresh: u32,
        _: u64,
        _: WEnum<wp_presentation_feedback::Kind>,
    ) {
        let ns = time.tv_sec * 1_000_000_000 + u64::from(time.tv_nsec);
        trace(
            "presented",
            &format!(
                ",\"clk\":{},\"present_t\":{ns},\"refresh_ns\":{refresh}",
                time.clk_id
            ),
        );
    }
    fn discarded(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        _: &wl_surface::WlSurface,
    ) {
        trace("discarded", "");
    }
}

impl Dispatch2<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1, Wl> for Wp {
    fn event(
        &self,
        _: &mut Wl,
        _: &wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
        _: wp_fractional_scale_manager_v1::Event,
        _: &Connection,
        _: &QueueHandle<Wl>,
    ) {
    }
}

impl Dispatch2<wp_fractional_scale_v1::WpFractionalScaleV1, Wl> for Wp {
    fn event(
        &self,
        state: &mut Wl,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        _: &Connection,
        qh: &QueueHandle<Wl>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            if scale != state.scale120 {
                state.scale120 = scale;
                state.redraw(qh);
            }
        }
    }
}

impl Dispatch2<wp_viewporter::WpViewporter, Wl> for Wp {
    fn event(
        &self,
        _: &mut Wl,
        _: &wp_viewporter::WpViewporter,
        _: wp_viewporter::Event,
        _: &Connection,
        _: &QueueHandle<Wl>,
    ) {
    }
}

impl Dispatch2<wp_viewport::WpViewport, Wl> for Wp {
    fn event(
        &self,
        _: &mut Wl,
        _: &wp_viewport::WpViewport,
        _: wp_viewport::Event,
        _: &Connection,
        _: &QueueHandle<Wl>,
    ) {
    }
}

delegate_registry!(Wl);

impl ProvidesRegistryState for Wl {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    registry_handlers![OutputState];
}

smithay_client_toolkit::delegate_dispatch2!(Wl);
