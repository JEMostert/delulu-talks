//! The pill as a pearl in deep water: it pops in on a spring, strings its
//! voice meter as iridescent beads, sends out ripples and bubbles while it
//! listens, spins its nacre while it thinks, bursts into tiny pearls when the
//! words land, and sinks away when it is done.
//!
//! This is the only drawing of the pill. The native `delulu-pill` and the GTK
//! `--pill` helper in `delulu-overlay` both paint these frames, so the two
//! cannot drift apart while both exist.
//!
//! Cost: every frame first measures its own device-space bounds (the same code
//! with no pixels: it builds the paths and keeps their bounding boxes), then
//! rasterises only that rectangle. A backend clears the previous frame's
//! rectangle, writes the new one and damages the union of the two, so the
//! transparent room around the pill costs nothing.

use crate::model::{
    Message, Model, PillState, Rgb, BARS, CANVAS_H, CANVAS_W, FOAM, HEIGHT, INK, LEAVE_SECS,
    PAD_TOP,
};
use crate::text::Font;
use std::f64::consts::{PI, TAU};
use tiny_skia::{
    Color, FillRule, GradientStop, IntRect, LineCap, LineJoin, LinearGradient, Mask, Paint, Path,
    PathBuilder, Pixmap, PixmapMut, PixmapPaint, PixmapRef, Point, RadialGradient, Rect, Shader,
    SpreadMode, Stroke, StrokeDash, Transform,
};

const LABEL_SIZE: f32 = 12.5;
const PEARL_R: f64 = 11.0;
const BEAD_GAP: f64 = 6.0;
/// Nacre colours: rose, sea, gold and lilac.
const NACRE: [Rgb; 4] = [
    (1.0, 0.62, 0.78),
    (0.52, 0.92, 1.0),
    (1.0, 0.86, 0.58),
    (0.76, 0.66, 1.0),
];

fn col(r: f64, g: f64, b: f64, a: f64) -> Color {
    let c = |v: f64| v.clamp(0.0, 1.0) as f32;
    Color::from_rgba(c(r), c(g), c(b), c(a)).expect("clamped")
}

fn pt(x: f64, y: f64) -> Point {
    Point::from_xy(x as f32, y as f32)
}

fn stops(list: &[(f64, Color)]) -> Vec<GradientStop> {
    list.iter()
        .map(|&(p, c)| GradientStop::new(p as f32, c))
        .collect()
}

fn linear(
    (x0, y0): (f64, f64),
    (x1, y1): (f64, f64),
    s: &[(f64, Color)],
    mode: SpreadMode,
) -> Option<Shader<'static>> {
    LinearGradient::new(
        pt(x0, y0),
        pt(x1, y1),
        stops(s),
        mode,
        Transform::identity(),
    )
}

/// A two-point conical gradient, cairo's `RadialGradient`.
fn radial(
    (cx0, cy0, r0): (f64, f64, f64),
    (cx1, cy1, r1): (f64, f64, f64),
    s: &[(f64, Color)],
) -> Option<Shader<'static>> {
    RadialGradient::new(
        pt(cx0, cy0),
        r0.max(0.0) as f32,
        pt(cx1, cy1),
        r1.max(0.0) as f32,
        stops(s),
        SpreadMode::Pad,
        Transform::identity(),
    )
}

fn solid(r: f64, g: f64, b: f64, a: f64) -> Option<Shader<'static>> {
    Some(Shader::SolidColor(col(r, g, b, a)))
}

fn circle(cx: f64, cy: f64, r: f64) -> Option<Path> {
    PathBuilder::from_circle(cx as f32, cy as f32, r.max(0.01) as f32)
}

/// A rounded rectangle from four quarter arcs (cairo's arc-based recipe).
fn rounded(x: f64, y: f64, w: f64, h: f64, r: f64) -> Option<Path> {
    let r = r.min(w / 2.0).min(h / 2.0);
    let k = r * 0.552_284_75;
    let (x0, y0, x1, y1) = (x, y, x + w, y + h);
    let f = |v: f64| v as f32;
    let mut pb = PathBuilder::new();
    pb.move_to(f(x1 - r), f(y0));
    pb.cubic_to(f(x1 - r + k), f(y0), f(x1), f(y0 + r - k), f(x1), f(y0 + r));
    pb.line_to(f(x1), f(y1 - r));
    pb.cubic_to(f(x1), f(y1 - r + k), f(x1 - r + k), f(y1), f(x1 - r), f(y1));
    pb.line_to(f(x0 + r), f(y1));
    pb.cubic_to(f(x0 + r - k), f(y1), f(x0), f(y1 - r + k), f(x0), f(y1 - r));
    pb.line_to(f(x0), f(y0 + r));
    pb.cubic_to(f(x0), f(y0 + r - k), f(x0 + r - k), f(y0), f(x0 + r), f(y0));
    pb.close();
    pb.finish()
}

fn line(width: f64) -> Stroke {
    Stroke {
        width: width as f32,
        ..Stroke::default()
    }
}

/// A small cairo-like canvas over tiny-skia: a transform stack and one clip.
/// Without pixels it only measures what the frame would touch.
struct Canvas<'p, 'a> {
    pix: Option<&'p mut PixmapMut<'a>>,
    ts: Transform,
    clip: Option<Mask>,
    clip_rect: Option<Rect>,
    saved: Vec<(Transform, Option<Mask>, Option<Rect>)>,
    /// Device-space bounds of everything drawn so far (measuring only).
    bounds: Option<Rect>,
}

impl<'p, 'a> Canvas<'p, 'a> {
    fn new(pix: Option<&'p mut PixmapMut<'a>>, ts: Transform) -> Self {
        Self {
            pix,
            ts,
            clip: None,
            clip_rect: None,
            saved: Vec::new(),
            bounds: None,
        }
    }
    fn save(&mut self) {
        self.saved
            .push((self.ts, self.clip.clone(), self.clip_rect));
    }
    fn restore(&mut self) {
        if let Some((ts, clip, rect)) = self.saved.pop() {
            self.ts = ts;
            self.clip = clip;
            self.clip_rect = rect;
        }
    }
    fn translate(&mut self, x: f64, y: f64) {
        self.ts = self.ts.pre_translate(x as f32, y as f32);
    }
    fn scale(&mut self, sx: f64, sy: f64) {
        self.ts = self.ts.pre_scale(sx as f32, sy as f32);
    }
    fn device(&self, local: Rect) -> Option<Rect> {
        let r = local.transform(self.ts)?;
        match self.clip_rect {
            Some(clip) => r.intersect(&clip),
            None => Some(r),
        }
    }
    fn clip(&mut self, path: &Option<Path>) {
        let Some(path) = path else { return };
        let rect = path.bounds().transform(self.ts);
        self.clip_rect = match (self.clip_rect, rect) {
            (Some(a), Some(b)) => a.intersect(&b),
            (a, b) => a.or(b),
        };
        let Some(pix) = self.pix.as_deref() else {
            return;
        };
        match self.clip.as_mut() {
            Some(mask) => mask.intersect_path(path, FillRule::Winding, true, self.ts),
            None => {
                if let Some(mut mask) = Mask::new(pix.width(), pix.height()) {
                    mask.fill_path(path, FillRule::Winding, true, self.ts);
                    self.clip = Some(mask);
                }
            }
        }
    }
    fn touch(&mut self, local: Rect) {
        if let Some(r) = self.device(local) {
            self.bounds = Some(match self.bounds {
                Some(b) => b.join(&r).unwrap_or(b),
                None => r,
            });
        }
    }
    fn fill(&mut self, path: &Option<Path>, shader: Option<Shader<'static>>) {
        let (Some(path), Some(shader)) = (path, shader) else {
            return;
        };
        match self.pix.as_deref_mut() {
            Some(pix) => pix.fill_path(
                path,
                &paint(shader),
                FillRule::Winding,
                self.ts,
                self.clip.as_ref(),
            ),
            None => self.touch(path.bounds()),
        }
    }
    fn stroke(&mut self, path: &Option<Path>, shader: Option<Shader<'static>>, stroke: &Stroke) {
        let (Some(path), Some(shader)) = (path, shader) else {
            return;
        };
        match self.pix.as_deref_mut() {
            Some(pix) => pix.stroke_path(path, &paint(shader), stroke, self.ts, self.clip.as_ref()),
            None => {
                // Round caps and joins (or none: circles, rounded rectangles) reach
                // half the line width past the path.
                let half = stroke.width / 2.0;
                if let Some(r) = path.bounds().outset(half, half) {
                    self.touch(r);
                }
            }
        }
    }
}

fn paint(shader: Shader<'static>) -> Paint<'static> {
    Paint {
        shader,
        anti_alias: true,
        ..Paint::default()
    }
}

/// Stable pseudo-random 0..1 per index, so frames never flicker.
fn hash(i: f64) -> f64 {
    ((i * 12.9898 + 4.1414).sin() * 43_758.545_3).rem_euclid(1.0)
}

fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

/// A damped spring from 0 to 1 that overshoots once, like a bubble popping up.
fn spring(t: f64) -> f64 {
    if t <= 0.0 {
        0.0
    } else {
        1.0 - (-6.5 * t).exp() * (13.0 * t).cos()
    }
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    (
        a.0 + (b.0 - a.0) * t,
        a.1 + (b.1 - a.1) * t,
        a.2 + (b.2 - a.2) * t,
    )
}

/// One rasterised frame: `rect` of the canvas, as premultiplied RGBA rows.
pub struct Frame<'a> {
    pub rect: IntRect,
    pub data: &'a [u8],
}

/// Draws frames, reusing its buffers.
pub struct Renderer {
    font: Font,
    frame: Vec<u8>,
    group: Vec<u8>,
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            font: Font::embedded(),
            frame: Vec::new(),
            group: Vec::new(),
        }
    }

    /// The label's horizontal advance at the label size, for sizing the pill.
    pub fn label_advance(&self, label: &str) -> f64 {
        if label.is_empty() {
            return 0.0;
        }
        f64::from(self.font.extents(label, LABEL_SIZE).x_advance)
    }

    /// The pill width the model's content needs, in logical pixels.
    pub fn width(&self, model: &Model) -> i32 {
        model.width(self.label_advance(&model.label))
    }

    /// The canvas rectangle this frame touches, at `scale` device pixels per
    /// logical pixel on a canvas `size` device pixels large. None: nothing.
    pub fn bounds(&self, m: &Model, scale: f64, size: (u32, u32)) -> Option<IntRect> {
        if !m.visible {
            return None;
        }
        let mut cr = Canvas::new(None, Transform::from_scale(scale as f32, scale as f32));
        frame(&mut cr, m, &self.font);
        // One pixel more on each side for anti-aliasing.
        let r = cr.bounds?.outset(1.0, 1.0)?.round_out()?;
        r.intersect(&IntRect::from_xywh(0, 0, size.0, size.1)?)
    }

    /// Rasterise the part of the frame that has pixels; None when nothing does.
    pub fn render(&mut self, m: &Model, scale: f64, size: (u32, u32)) -> Option<Frame<'_>> {
        let rect = self.bounds(m, scale, size)?;
        let len = rect.width() as usize * rect.height() as usize * 4;
        let ts = Transform::from_translate(-rect.x() as f32, -rect.y() as f32)
            .pre_scale(scale as f32, scale as f32);
        let alpha = group_alpha(m);
        let frame_buf = clear_prefix(&mut self.frame, len);
        let mut out = PixmapMut::from_bytes(frame_buf, rect.width(), rect.height())?;
        if alpha >= 1.0 {
            frame(&mut Canvas::new(Some(&mut out), ts), m, &self.font);
        } else {
            // The whole-pill alpha (fading in, sinking away) applies to the pill as
            // one layer, so overlapping parts do not show through each other.
            let group_buf = clear_prefix(&mut self.group, len);
            {
                let mut group = PixmapMut::from_bytes(group_buf, rect.width(), rect.height())?;
                frame(&mut Canvas::new(Some(&mut group), ts), m, &self.font);
            }
            let group = PixmapRef::from_bytes(&self.group[..len], rect.width(), rect.height())?;
            out.draw_pixmap(
                0,
                0,
                group,
                &PixmapPaint {
                    opacity: alpha as f32,
                    ..PixmapPaint::default()
                },
                Transform::identity(),
                None,
            );
        }
        Some(Frame {
            rect,
            data: &self.frame[..len],
        })
    }

    /// The whole canvas, `out` sized for it at `scale`.
    pub fn render_full(&mut self, m: &Model, scale: f64, out: &mut Pixmap) {
        out.fill(Color::TRANSPARENT);
        let size = (out.width(), out.height());
        let stride = out.width() as usize * 4;
        if let Some(f) = self.render(m, scale, size) {
            let row = f.rect.width() as usize * 4;
            let data = out.data_mut();
            for (y, src) in f.data.chunks_exact(row).enumerate() {
                let at = (f.rect.y() as usize + y) * stride + f.rect.x() as usize * 4;
                data[at..at + row].copy_from_slice(src);
            }
        }
    }
}

fn clear_prefix(buf: &mut Vec<u8>, len: usize) -> &mut [u8] {
    if buf.len() < len {
        buf.resize(len, 0);
    }
    let prefix = &mut buf[..len];
    prefix.fill(0);
    prefix
}

/// Write `frame` into a whole-canvas buffer of little-endian ARGB8888 pixels
/// (bytes B, G, R, A: both `wl_shm` and a depth-32 X image), after clearing
/// `stale`, the rectangle the buffer last held pixels in.
pub fn blit_bgra(frame: Option<&Frame>, stale: Option<IntRect>, dst: &mut [u8], stride: usize) {
    if let Some(r) = stale {
        let row = r.width() as usize * 4;
        for y in r.top()..r.bottom() {
            let at = y as usize * stride + r.x() as usize * 4;
            if let Some(px) = dst.get_mut(at..at + row) {
                px.fill(0);
            }
        }
    }
    let Some(f) = frame else { return };
    let row = f.rect.width() as usize * 4;
    for (y, src) in f.data.chunks_exact(row).enumerate() {
        let at = (f.rect.y() as usize + y) * stride + f.rect.x() as usize * 4;
        let Some(out) = dst.get_mut(at..at + row) else {
            break;
        };
        for (s, d) in src
            .as_chunks::<4>()
            .0
            .iter()
            .zip(out.as_chunks_mut::<4>().0)
        {
            *d = [s[2], s[1], s[0], s[3]];
        }
    }
}

/// The smallest rectangle holding both.
pub fn union(a: Option<IntRect>, b: Option<IntRect>) -> Option<IntRect> {
    match (a, b) {
        (Some(a), Some(b)) => IntRect::from_ltrb(
            a.left().min(b.left()),
            a.top().min(b.top()),
            a.right().max(b.right()),
            a.bottom().max(b.bottom()),
        ),
        (a, b) => a.or(b),
    }
}

/// The whole-pill alpha the frame uses (fade in, sink away).
fn group_alpha(m: &Model) -> f64 {
    if m.reduce_motion {
        return 1.0;
    }
    let mut alpha = (m.age / 0.12).min(1.0);
    if let Some(leaving) = m.leaving {
        let q = (leaving / LEAVE_SECS).clamp(0.0, 1.0);
        alpha *= 1.0 - q * q;
    }
    alpha
}

/// One frame on the `CANVAS_W` × `CANVAS_H` logical canvas.
fn frame(cr: &mut Canvas, m: &Model, font: &Font) {
    let motion = !m.reduce_motion;
    let h = f64::from(HEIGHT);
    let w = m.shown_width;
    let accent = m.accent();
    let level = if m.state == PillState::Listening {
        m.shown_level
    } else {
        0.0
    };

    // Whole-pill envelope: pop in, a little boing on each new state, sink away.
    let (mut scale, mut sink) = (1.0, 0.0);
    if motion {
        scale = 0.3 + 0.7 * spring(m.age);
        if m.age > 0.6 {
            scale *= 1.0 + 0.05 * (-9.0 * m.phase).exp() * (m.phase * 22.0).sin();
        }
        if let Some(leaving) = m.leaving {
            let q = (leaving / LEAVE_SECS).clamp(0.0, 1.0);
            // A quick inhale, then shrink and sink.
            scale *= 1.0 + 0.06 * (q * PI).sin() - 0.45 * q * q;
            sink = 10.0 * q * q;
        }
    }
    let shake = if motion && m.state == PillState::Error {
        4.5 * (-5.0 * m.phase).exp() * (m.phase * 42.0).sin()
    } else {
        0.0
    };

    cr.save();
    cr.translate(CANVAS_W / 2.0 + shake, PAD_TOP + h / 2.0 + sink);
    cr.scale(scale, scale);
    let left = -w / 2.0;
    let (px, py) = (left + 22.0, 0.0);

    under_glow(cr, m, w, h, accent, level);
    if motion && m.state == PillState::Listening {
        bubbles(cr, m, w, h, level);
        ripples(cr, m, px, py, accent, level);
    }
    shell(cr, m, w, h, accent);
    if motion {
        // A light sweep over the glass as it arrives and when the words land.
        sweep(cr, w, h, (m.age - 0.1) / 0.65);
        if m.state == PillState::Success {
            sweep(cr, w, h, (m.phase - 0.05) / 0.5);
        }
    }
    let mut x = left + 44.0;
    if m.shows_bars() {
        beads(cr, m, x + 1.5, accent, level);
        x += BARS as f64 * BEAD_GAP + 10.0;
    }
    pearl(cr, m, px, py, accent, level, font);
    if !m.label.is_empty() {
        label(cr, m, x - 2.0, font);
    }
    if motion && m.state == PillState::Success {
        burst(cr, m.phase, px, py, accent);
    }
    cr.restore();
}

/// A soft pool of light under the pill, brighter with the voice.
fn under_glow(cr: &mut Canvas, m: &Model, w: f64, h: f64, a: Rgb, level: f64) {
    let pulse = match m.state {
        PillState::Transcribing if !m.reduce_motion => 0.5 + 0.5 * (m.phase * 3.0).sin(),
        PillState::Error if !m.reduce_motion => 0.5 + 0.5 * (m.phase * 6.0).cos(),
        _ => 0.5,
    };
    let strength = 0.16 + 0.22 * level + 0.1 * pulse;
    cr.save();
    cr.scale(w / 2.0 + 26.0, h / 2.0 + 16.0);
    let glow = radial(
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 1.0),
        &[
            (0.0, col(a.0, a.1, a.2, strength)),
            (0.6, col(a.0, a.1, a.2, strength * 0.35)),
            (1.0, col(a.0, a.1, a.2, 0.0)),
        ],
    );
    cr.fill(&circle(0.0, 0.0, 1.0), glow);
    cr.restore();
}

/// Tiny bubbles drifting up from behind the pill while it listens.
fn bubbles(cr: &mut Canvas, m: &Model, w: f64, h: f64, level: f64) {
    for i in 0..9 {
        let i = f64::from(i);
        let period = 1.5 + 1.1 * hash(i * 1.7);
        let t = ((m.phase + period * hash(i * 3.1)) / period).rem_euclid(1.0);
        let x = -w / 2.0 + 26.0 + hash(i * 7.3) * (w - 44.0) + (t * 7.0 + i).sin() * 3.0;
        let y = -h / 2.0 + 6.0 - ease_out(t) * (PAD_TOP - 4.0);
        let r = (0.8 + 1.7 * hash(i * 5.7)) * (0.65 + 0.9 * level);
        let alpha = (t * PI).sin().powf(0.7) * (0.35 + 0.5 * level);
        if alpha < 0.004 {
            continue;
        }
        let c = circle(x, y, r);
        cr.fill(&c, solid(FOAM.0, FOAM.1, FOAM.2, alpha * 0.18));
        cr.stroke(&c, solid(0.85, 0.97, 1.0, alpha * 0.75), &line(0.6));
        cr.fill(
            &circle(x - r * 0.35, y - r * 0.35, r * 0.28),
            solid(1.0, 1.0, 1.0, alpha),
        );
    }
}

/// Rings spreading from the pearl, like a drop in still water.
fn ripples(cr: &mut Canvas, m: &Model, px: f64, py: f64, a: Rgb, level: f64) {
    for k in 0..3 {
        let t = (m.phase * 0.85 + f64::from(k) / 3.0).rem_euclid(1.0);
        let r = PEARL_R + 2.0 + ease_out(t) * (20.0 + 22.0 * level);
        let alpha = (1.0 - t).powi(2) * (0.18 + 0.55 * level);
        cr.stroke(
            &circle(px, py, r),
            solid(a.0, a.1, a.2, alpha),
            &line(0.4 + 1.4 * (1.0 - t)),
        );
    }
}

/// Deep-sea glass with drifting caustics and a slowly sliding iridescent rim.
fn shell(cr: &mut Canvas, m: &Model, w: f64, h: f64, a: Rgb) {
    let (x, y) = (-w / 2.0, -h / 2.0);
    let outline = rounded(x + 0.5, y + 0.5, w - 1.0, h - 1.0, h / 2.0);
    let body = linear(
        (0.0, y),
        (0.0, y + h),
        &[
            (0.0, col(0.055, 0.15, 0.25, 0.97)),
            (1.0, col(0.012, 0.045, 0.095, 0.97)),
        ],
        SpreadMode::Pad,
    );
    cr.fill(&outline, body);
    cr.save();
    cr.clip(&outline);
    // Caustics: soft light patches wandering across the water. Each glow is
    // transparent past its radius, so only its disc is filled.
    if !m.reduce_motion {
        for i in 0..3 {
            let i = f64::from(i);
            let cx = (m.age * (0.35 + 0.12 * i) + hash(i * 9.1) * TAU).sin() * w * 0.42;
            let cy = (m.age * (0.5 + 0.2 * i) + i).cos() * h * 0.35;
            let glow = radial(
                (cx, cy, 0.0),
                (cx, cy, 22.0),
                &[
                    (0.0, col(a.0, a.1, a.2, 0.11)),
                    (1.0, col(a.0, a.1, a.2, 0.0)),
                ],
            );
            cr.fill(&circle(cx, cy, 22.0), glow);
        }
    }
    // The top sheen's corners reach past the outline's rounder ones: clipped.
    let top = linear(
        (0.0, y),
        (0.0, y + h / 2.0),
        &[
            (0.0, col(1.0, 1.0, 1.0, 0.12)),
            (1.0, col(1.0, 1.0, 1.0, 0.0)),
        ],
        SpreadMode::Pad,
    );
    cr.fill(
        &rounded(x + 1.5, y + 1.5, w - 3.0, h / 2.0, h / 2.0 - 1.0),
        top,
    );
    cr.restore();
    // Mother-of-pearl rim whose colours slide around the edge.
    let offset = if m.reduce_motion { 0.0 } else { m.age * 40.0 };
    let rim_stops: Vec<(f64, Color)> = NACRE
        .iter()
        .enumerate()
        .map(|(i, c)| (i as f64 / 3.0, col(c.0, c.1, c.2, 0.6)))
        .collect();
    let rim = linear(
        (x + offset, y),
        (x + offset + 140.0, y + h),
        &rim_stops,
        SpreadMode::Reflect,
    );
    cr.stroke(
        &rounded(x + 0.6, y + 0.6, w - 1.2, h - 1.2, h / 2.0),
        rim,
        &line(1.2),
    );
}

/// A diagonal band of light crossing the glass; `t` runs 0 to 1.
fn sweep(cr: &mut Canvas, w: f64, h: f64, t: f64) {
    if !(0.0..=1.0).contains(&t) {
        return;
    }
    let bx = -w / 2.0 - 30.0 + ease_out(t) * (w + 60.0);
    let band = linear(
        (bx - 16.0, -h / 2.0),
        (bx + 16.0, h / 2.0),
        &[
            (0.0, col(1.0, 1.0, 1.0, 0.0)),
            (0.5, col(1.0, 1.0, 1.0, 0.28 * (t * PI).sin())),
            (1.0, col(1.0, 1.0, 1.0, 0.0)),
        ],
        SpreadMode::Pad,
    );
    cr.fill(&rounded(-w / 2.0, -h / 2.0, w, h, h / 2.0), band);
}

/// The voice meter as a string of pearls on a silk thread.
fn beads(cr: &mut Canvas, m: &Model, x0: f64, a: Rgb, level: f64) {
    let listening = m.state == PillState::Listening;
    let motion = !m.reduce_motion;
    let mut points = Vec::with_capacity(BARS);
    for index in 0..BARS {
        let i = index as f64;
        let envelope = (PI * (i + 0.5) / BARS as f64).sin().powf(0.8);
        let (dy, r, shine) = if !motion {
            (0.0, 1.8 + 1.4 * envelope * level, 0.0)
        } else if listening {
            let wave = (m.phase * 5.5 - i * 0.8).sin();
            let ripple = (m.phase * 9.0 - i * 1.6).sin() * 0.35;
            let amp = (1.2 + 9.5 * level) * envelope;
            (
                (wave + ripple) * amp * 0.75,
                1.9 + envelope * (0.7 + 1.7 * level) * (0.8 + 0.2 * wave),
                level * envelope * 0.5,
            )
        } else {
            // Thinking: a calm swell with light running along the string.
            let wave = (m.phase * 3.0 - i * 0.7).sin();
            let head = (m.phase * 11.0).rem_euclid(BARS as f64 + 6.0) - 3.0;
            let shine = (-(i - head).powi(2) / 2.5).exp();
            (wave * 2.4 * envelope, 1.8 + 0.6 * shine, shine)
        };
        points.push((x0 + i * BEAD_GAP, dy, r, shine));
    }
    // The thread first, so the pearls sit on it.
    let mut pb = PathBuilder::new();
    for (n, &(x, y, _, _)) in points.iter().enumerate() {
        if n == 0 {
            pb.move_to((x - 3.0) as f32, y as f32);
        }
        pb.line_to(x as f32, y as f32);
    }
    if let Some(&(x, y, _, _)) = points.last() {
        pb.line_to((x + 3.0) as f32, y as f32);
    }
    let thread = Stroke {
        width: 0.7,
        line_join: LineJoin::Round,
        line_cap: LineCap::Round,
        ..Stroke::default()
    };
    cr.stroke(&pb.finish(), solid(a.0, a.1, a.2, 0.35), &thread);
    let tint = mix((1.0, 1.0, 1.0), a, 0.45);
    for &(x, y, r, shine) in &points {
        if shine > 0.05 {
            let glow = radial(
                (x, y, 0.0),
                (x, y, r * 3.0),
                &[
                    (0.0, col(a.0, a.1, a.2, 0.5 * shine)),
                    (1.0, col(a.0, a.1, a.2, 0.0)),
                ],
            );
            cr.fill(&circle(x, y, r * 3.0), glow);
        }
        let body = radial(
            (x - r * 0.35, y - r * 0.4, 0.1),
            (x, y, r),
            &[
                (0.0, col(1.0, 1.0, 1.0, 1.0)),
                (0.5, col(tint.0, tint.1, tint.2, 1.0)),
                (1.0, col(a.0 * 0.62, a.1 * 0.62, a.2 * 0.62, 1.0)),
            ],
        );
        cr.fill(&circle(x, y, r), body);
        cr.fill(
            &circle(x - r * 0.35, y - r * 0.38, r * 0.3),
            solid(1.0, 1.0, 1.0, 0.9),
        );
    }
}

/// A four-point sparkle.
fn sparkle(cr: &mut Canvas, x: f64, y: f64, s: f64, c: Rgb, alpha: f64) {
    let glow = radial(
        (x, y, 0.0),
        (x, y, s * 1.6),
        &[
            (0.0, col(c.0, c.1, c.2, alpha * 0.6)),
            (1.0, col(c.0, c.1, c.2, 0.0)),
        ],
    );
    cr.fill(&circle(x, y, s * 1.6), glow);
    let k = s * 0.22;
    let f = |v: f64| v as f32;
    let mut pb = PathBuilder::new();
    pb.move_to(f(x), f(y - s));
    pb.cubic_to(
        f(x + k * 0.3),
        f(y - k),
        f(x + k),
        f(y - k * 0.3),
        f(x + s),
        f(y),
    );
    pb.cubic_to(
        f(x + k),
        f(y + k * 0.3),
        f(x + k * 0.3),
        f(y + k),
        f(x),
        f(y + s),
    );
    pb.cubic_to(
        f(x - k * 0.3),
        f(y + k),
        f(x - k),
        f(y + k * 0.3),
        f(x - s),
        f(y),
    );
    pb.cubic_to(
        f(x - k),
        f(y - k * 0.3),
        f(x - k * 0.3),
        f(y - k),
        f(x),
        f(y - s),
    );
    pb.close();
    cr.fill(&pb.finish(), solid(1.0, 1.0, 1.0, alpha));
}

/// The pearl: swirling nacre, a soft limb, a crisp highlight and the state mark.
fn pearl(cr: &mut Canvas, m: &Model, cx: f64, cy: f64, a: Rgb, level: f64, font: &Font) {
    let motion = !m.reduce_motion;
    // It lands a beat after the shell, with its own bounce.
    let pop = if motion {
        0.2 + 0.8 * spring(m.age - 0.08)
    } else {
        1.0
    };
    let breathe = if motion && m.state == PillState::Listening {
        1.0 + 0.12 * level + 0.025 * (m.phase * 2.2).sin()
    } else {
        1.0
    };
    let flash = if motion && m.state == PillState::Success {
        (-6.0 * m.phase).exp()
    } else {
        0.0
    };
    let r = PEARL_R * pop * breathe * (1.0 + 0.12 * flash);

    // Halo.
    let halo = r + 5.0 + 6.0 * level + 8.0 * flash;
    let glow = radial(
        (cx, cy, r * 0.8),
        (cx, cy, halo),
        &[
            (0.0, col(a.0, a.1, a.2, 0.45 + 0.3 * level + 0.4 * flash)),
            (1.0, col(a.0, a.1, a.2, 0.0)),
        ],
    );
    cr.fill(&circle(cx, cy, halo), glow);

    // Body.
    let body = radial(
        (cx - r * 0.32, cy - r * 0.36, 0.5),
        (cx, cy, r),
        &[
            (0.0, col(1.0, 1.0, 1.0, 1.0)),
            (0.5, col(0.96, 0.94, 0.93, 1.0)),
            (1.0, col(0.76, 0.79, 0.86, 1.0)),
        ],
    );
    let disc = circle(cx, cy, r);
    cr.fill(&disc, body);

    // Nacre: colour clouds orbiting inside, faster with the voice or while thinking.
    cr.save();
    cr.clip(&disc);
    let spin = match m.state {
        _ if !motion => 0.0,
        PillState::Listening => 1.0 + 3.0 * level,
        PillState::Transcribing => 4.5,
        _ => 0.7,
    };
    let turn = if motion {
        m.age * 0.6 + m.phase * spin
    } else {
        0.6
    };
    for (i, c) in NACRE.iter().enumerate() {
        let angle = turn + i as f64 * TAU / 4.0;
        let (bx, by) = (cx + angle.cos() * r * 0.5, cy + angle.sin() * r * 0.5);
        let cloud = radial(
            (bx, by, 0.0),
            (bx, by, r * 0.85),
            &[
                (0.0, col(c.0, c.1, c.2, 0.42)),
                (1.0, col(c.0, c.1, c.2, 0.0)),
            ],
        );
        cr.fill(&circle(bx, by, r * 0.85), cloud);
    }
    let tint = radial(
        (cx, cy + r * 0.5, 0.5),
        (cx, cy + r * 0.2, r * 1.1),
        &[
            (0.0, col(a.0, a.1, a.2, 0.38)),
            (1.0, col(a.0, a.1, a.2, 0.0)),
        ],
    );
    cr.fill(&disc, tint);
    let limb = radial(
        (cx, cy, r * 0.55),
        (cx, cy, r),
        &[
            (0.0, col(0.1, 0.15, 0.25, 0.0)),
            (1.0, col(0.1, 0.15, 0.25, 0.32)),
        ],
    );
    cr.fill(&disc, limb);
    cr.restore();

    // Highlights.
    let (sx, sy) = (cx - r * 0.36, cy - r * 0.4);
    let spec = radial(
        (sx, sy, 0.0),
        (sx, sy, r * 0.36),
        &[
            (0.0, col(1.0, 1.0, 1.0, 1.0)),
            (0.45, col(1.0, 1.0, 1.0, 0.85)),
            (1.0, col(1.0, 1.0, 1.0, 0.0)),
        ],
    );
    cr.fill(&circle(sx, sy, r * 0.36), spec);
    cr.fill(
        &circle(cx + r * 0.38, cy + r * 0.42, r * 0.12),
        solid(1.0, 1.0, 1.0, 0.45),
    );
    cr.stroke(&disc, solid(1.0, 1.0, 1.0, 0.5 + 0.5 * flash), &line(0.8));

    if motion && m.state == PillState::Transcribing {
        for k in 0..2 {
            let angle = m.phase * 3.6 + f64::from(k) * PI;
            let twinkle = 0.6 + 0.4 * (m.phase * 9.0 + f64::from(k) * 2.0).sin();
            let orbit = r + 4.5;
            sparkle(
                cr,
                cx + angle.cos() * orbit,
                cy + angle.sin() * orbit * 0.8,
                2.6 * twinkle,
                FOAM,
                twinkle,
            );
        }
    }

    match m.state {
        PillState::Success => {
            // The check draws itself in.
            let progress = if motion {
                ease_out((m.phase - 0.1) / 0.3)
            } else {
                1.0
            };
            if progress > 0.0 {
                let len = 4.7 + 9.2;
                let mut pb = PathBuilder::new();
                pb.move_to((cx - 4.5) as f32, (cy + 0.5) as f32);
                pb.line_to((cx - 1.2) as f32, (cy + 3.8) as f32);
                pb.line_to((cx + 4.8) as f32, (cy - 3.2) as f32);
                let check = Stroke {
                    width: 2.3,
                    line_cap: LineCap::Round,
                    line_join: LineJoin::Round,
                    dash: StrokeDash::new(vec![(len * progress) as f32, len as f32], 0.0),
                    ..Stroke::default()
                };
                cr.stroke(&pb.finish(), solid(0.03, 0.32, 0.27, 1.0), &check);
            }
        }
        PillState::Error => {
            let e = font.extents("!", 12.0);
            let x = cx - f64::from(e.width) / 2.0 - f64::from(e.x_bearing);
            let y = cy - f64::from(e.y_bearing) - f64::from(e.height) / 2.0;
            let glyph = font.path("!", 12.0, x as f32, y as f32);
            cr.fill(&glyph, solid(0.03, 0.15, 0.25, 1.0));
        }
        _ => {}
    }
}

fn label(cr: &mut Canvas, m: &Model, x: f64, font: &Font) {
    let e = font.extents(&m.label, LABEL_SIZE);
    let t = if m.reduce_motion {
        1.0
    } else {
        ease_out((m.phase - 0.08) / 0.3)
    };
    let y = -f64::from(e.y_bearing) - f64::from(e.height) / 2.0 + 4.0 * (1.0 - t);
    let shadow = font.path(&m.label, LABEL_SIZE, x as f32, (y + 1.0) as f32);
    cr.fill(&shadow, solid(0.0, 0.0, 0.0, 0.35 * t));
    let text = font.path(&m.label, LABEL_SIZE, x as f32, y as f32);
    cr.fill(&text, solid(INK.0, INK.1, INK.2, t));
}

/// Success: a shockwave and a spray of tiny pearls and sparkles.
fn burst(cr: &mut Canvas, t: f64, px: f64, py: f64, a: Rgb) {
    if t > 1.3 {
        return;
    }
    let ring = (t / 0.55).min(1.0);
    if ring < 1.0 {
        cr.stroke(
            &circle(px, py, PEARL_R + ease_out(ring) * 34.0),
            solid(a.0, a.1, a.2, 0.7 * (1.0 - ring)),
            &line(2.4 * (1.0 - ring) + 0.3),
        );
        cr.stroke(
            &circle(px, py, PEARL_R + ease_out(ring) * 22.0),
            solid(1.0, 1.0, 1.0, 0.45 * (1.0 - ring)),
            &line(1.0),
        );
    }
    for i in 0..18 {
        let i = f64::from(i);
        let angle = i * TAU / 18.0 + (hash(i) - 0.5) * 0.5;
        let speed = 30.0 + 34.0 * hash(i * 2.3);
        let q = t.min(1.0);
        let d = PEARL_R + speed * ease_out(q);
        let x = px + angle.cos() * d;
        let y = py + angle.sin() * d * 0.85 + 16.0 * t * t;
        let fade = (1.0 - t / 1.3).max(0.0);
        let size = (1.1 + 1.6 * hash(i * 4.7)) * (0.4 + 0.6 * fade);
        if (i as usize).is_multiple_of(3) {
            let c = NACRE[(i as usize / 3) % NACRE.len()];
            sparkle(cr, x, y, size * 1.8, c, fade);
        } else {
            let c = NACRE[i as usize % NACRE.len()];
            let body = radial(
                (x - size * 0.35, y - size * 0.4, 0.1),
                (x, y, size),
                &[
                    (0.0, col(1.0, 1.0, 1.0, fade)),
                    (1.0, col(c.0, c.1, c.2, fade)),
                ],
            );
            cr.fill(&circle(x, y, size), body);
        }
    }
}

/// A settled frame of one state, as the previews and reference frames use it
/// (age 2 s, phase 0.9 s, level reached).
pub fn preview_model(r: &Renderer, state: PillState, level: f32, label: Option<&str>) -> Model {
    let mut m = Model::default();
    m.apply(&Message {
        state,
        level: Some(level),
        label: label.map(Into::into),
    });
    let w = r.width(&m);
    m.set_target_width(f64::from(w));
    m.age = 2.0;
    m.phase = 0.9;
    m.shown_level = m.level;
    m
}

/// The canvas in device pixels at `scale` device pixels per logical pixel.
pub fn canvas_size(scale: f64) -> (u32, u32) {
    (
        (CANVAS_W * scale).round() as u32,
        (CANVAS_H * scale).round() as u32,
    )
}

/// A scripted run (appear, talk, think, land, leave, then an error) as
/// numbered PNG frames over a dim backdrop. Returns the frame count.
pub fn render_demo(dir: &std::path::Path, fps: f64) -> Result<usize, String> {
    let msg = |state, level: Option<f32>, label: Option<&str>| Message {
        state,
        level,
        label: label.map(Into::into),
    };
    // (seconds, message to apply at the start of the segment)
    let script = [
        (2.6, msg(PillState::Listening, Some(0.0), None)),
        (1.3, msg(PillState::Transcribing, None, None)),
        (1.4, msg(PillState::Success, None, Some("Typed"))),
        (0.5, msg(PillState::Hidden, None, None)),
        (1.6, msg(PillState::Error, None, Some("Nothing heard"))),
        (0.5, msg(PillState::Hidden, None, None)),
    ];
    let mut r = Renderer::new();
    let mut m = Model::default();
    let (w, h) = canvas_size(2.0);
    let mut pill = Pixmap::new(w, h).ok_or("pixmap")?;
    let dt = 1.0 / fps;
    let (mut frame_no, mut clock) = (0, 0.0_f64);
    for (secs, message) in script {
        m.apply(&message);
        if m.visible && m.leaving.is_none() {
            let width = r.width(&m);
            m.set_target_width(f64::from(width));
        }
        let mut t = 0.0;
        while t < secs {
            if m.state == PillState::Listening && m.leaving.is_none() {
                // Speech-like syllables.
                let s = (clock * 7.0).sin().max(0.0) * (clock * 1.9 + 1.0).sin().abs();
                m.apply(&msg(
                    PillState::Listening,
                    Some((0.25 + 0.7 * s) as f32),
                    None,
                ));
            }
            m.step(dt);
            r.render_full(&m, 2.0, &mut pill);
            let mut out = backdrop(w, h, clock)?;
            out.draw_pixmap(
                0,
                0,
                pill.as_ref(),
                &PixmapPaint::default(),
                Transform::identity(),
                None,
            );
            let path = dir.join(format!("frame_{frame_no:04}.png"));
            out.save_png(&path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            frame_no += 1;
            t += dt;
            clock += dt;
        }
    }
    Ok(frame_no)
}

/// A dim desktop-like backdrop, so glow and bursts read in previews.
pub fn backdrop(w: u32, h: u32, t: f64) -> Result<Pixmap, String> {
    let mut bg = Pixmap::new(w, h).ok_or("pixmap")?;
    let shader = linear(
        (0.0, 0.0),
        (f64::from(w), f64::from(h)),
        &[
            (0.0, col(0.13, 0.15, 0.2, 1.0)),
            (1.0, col(0.2 + 0.02 * t.sin(), 0.22, 0.28, 1.0)),
        ],
        SpreadMode::Pad,
    );
    if let (Some(rect), Some(shader)) = (Rect::from_xywh(0.0, 0.0, w as f32, h as f32), shader) {
        bg.fill_rect(rect, &paint(shader), Transform::identity(), None);
    }
    Ok(bg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole canvas drawn without measuring first.
    fn unbounded(r: &Renderer, m: &Model, scale: f64) -> Pixmap {
        let (w, h) = canvas_size(scale);
        let mut out = Pixmap::new(w, h).unwrap();
        let mut group = Pixmap::new(w, h).unwrap();
        let ts = Transform::from_scale(scale as f32, scale as f32);
        frame(&mut Canvas::new(Some(&mut group.as_mut()), ts), m, &r.font);
        out.draw_pixmap(
            0,
            0,
            group.as_ref(),
            &PixmapPaint {
                opacity: group_alpha(m) as f32,
                ..PixmapPaint::default()
            },
            Transform::identity(),
            None,
        );
        out
    }

    /// The most opaque pixel of `p` outside `rect`.
    fn alpha_outside(p: &Pixmap, rect: Option<IntRect>) -> u8 {
        let w = p.width() as i32;
        p.data()
            .as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .filter(|(k, _)| {
                let (x, y) = (*k as i32 % w, *k as i32 / w);
                !rect.is_some_and(|r| {
                    x >= r.left() && x < r.right() && y >= r.top() && y < r.bottom()
                })
            })
            .map(|(_, px)| px[3])
            .max()
            .unwrap_or(0)
    }

    /// Every animation frame of a dictation, as the pill would step through it.
    fn run() -> Vec<Model> {
        let r = Renderer::new();
        let mut m = Model::default();
        let mut frames = Vec::new();
        let script: [(f64, Message); 5] = [
            (
                1.5,
                Message {
                    state: PillState::Listening,
                    level: Some(1.0),
                    label: None,
                },
            ),
            (
                0.6,
                Message {
                    state: PillState::Transcribing,
                    level: None,
                    label: None,
                },
            ),
            (
                1.4,
                Message {
                    state: PillState::Success,
                    level: None,
                    label: Some("Not transcribed".into()),
                },
            ),
            (
                0.4,
                Message {
                    state: PillState::Hidden,
                    level: None,
                    label: None,
                },
            ),
            (
                0.8,
                Message {
                    state: PillState::Error,
                    level: None,
                    label: Some("Mic error".into()),
                },
            ),
        ];
        for (secs, msg) in script {
            m.apply(&msg);
            if m.visible && m.leaving.is_none() {
                m.set_target_width(f64::from(r.width(&m)));
            }
            let mut t = 0.0;
            while t < secs && m.visible {
                frames.push(m.clone());
                m.step(1.0 / 30.0);
                t += 1.0 / 30.0;
            }
        }
        frames
    }

    #[test]
    fn the_measured_region_holds_every_pixel_of_the_frame() {
        let r = Renderer::new();
        for scale in [crate::SCALE, crate::SCALE * 1.5, crate::SCALE * 2.0] {
            let size = canvas_size(scale);
            for (i, m) in run().iter().enumerate() {
                let rect = r.bounds(m, scale, size);
                let stray = alpha_outside(&unbounded(&r, m, scale), rect);
                assert_eq!(
                    stray, 0,
                    "frame {i} at {scale} draws outside {rect:?} ({:?})",
                    m.state
                );
            }
        }
    }

    #[test]
    fn blitting_clears_the_previous_frame() {
        let mut r = Renderer::new();
        let scale = crate::SCALE;
        let (w, h) = canvas_size(scale);
        let stride = w as usize * 4;
        let frames = run();
        let (a, b) = (&frames[3], &frames[frames.len() - 1]);
        // Listening then error: the second pill is narrower and in other places.
        let mut buf = vec![0u8; stride * h as usize];
        let first = r.render(a, scale, (w, h)).map(|f| {
            let rect = f.rect;
            blit_bgra(Some(&f), None, &mut buf, stride);
            rect
        });
        {
            let f = r.render(b, scale, (w, h));
            blit_bgra(f.as_ref(), first, &mut buf, stride);
        }
        let mut fresh = vec![0u8; stride * h as usize];
        let f = r.render(b, scale, (w, h));
        blit_bgra(f.as_ref(), None, &mut fresh, stride);
        assert!(buf == fresh, "pixels of the earlier frame were left behind");
        // Gone: clearing the last rectangle leaves nothing.
        let last = f.map(|f| f.rect);
        blit_bgra(None, last, &mut fresh, stride);
        assert!(fresh.iter().all(|&b| b == 0));
    }
}
