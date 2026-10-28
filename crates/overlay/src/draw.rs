//! The pill as a pearl in deep water: it pops in on a spring, strings its
//! voice meter as iridescent beads, sends out ripples and bubbles while it
//! listens, spins its nacre while it thinks, bursts into tiny pearls when the
//! words land, and sinks away when it is done.

use crate::model::{
    Model, PillState, Rgb, BARS, CANVAS_H, CANVAS_W, FOAM, HEIGHT, INK, LEAVE_SECS, PAD_TOP,
};
use cairo::{
    Context, Extend, FontSlant, FontWeight, LineCap, LineJoin, LinearGradient, Operator,
    RadialGradient,
};
use std::f64::consts::{PI, TAU};

const FONT: &str = "Inter";
const LABEL_SIZE: f64 = 12.5;
const PEARL_R: f64 = 11.0;
const BEAD_GAP: f64 = 6.0;
/// Nacre colours: rose, sea, gold and lilac.
const NACRE: [Rgb; 4] = [
    (1.0, 0.62, 0.78),
    (0.52, 0.92, 1.0),
    (1.0, 0.86, 0.58),
    (0.76, 0.66, 1.0),
];

type Res = Result<(), cairo::Error>;

fn rounded(cr: &Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    cr.new_sub_path();
    cr.arc(x + w - r, y + r, r, -PI / 2.0, 0.0);
    cr.arc(x + w - r, y + h - r, r, 0.0, PI / 2.0);
    cr.arc(x + r, y + h - r, r, PI / 2.0, PI);
    cr.arc(x + r, y + r, r, PI, 3.0 * PI / 2.0);
    cr.close_path();
}

fn circle(cr: &Context, cx: f64, cy: f64, r: f64) {
    cr.new_path();
    cr.arc(cx, cy, r.max(0.01), 0.0, TAU);
}

fn label_font(cr: &Context) {
    cr.select_font_face(FONT, FontSlant::Normal, FontWeight::Bold);
    cr.set_font_size(LABEL_SIZE);
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

/// The label's horizontal advance, for sizing the pill before drawing.
pub(crate) fn label_advance(label: &str) -> f64 {
    if label.is_empty() {
        return 0.0;
    }
    let measure = || -> Result<f64, cairo::Error> {
        let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, 1, 1)?;
        let cr = Context::new(&surface)?;
        label_font(&cr);
        Ok(cr.text_extents(label)?.x_advance())
    };
    measure().unwrap_or(label.chars().count() as f64 * 7.5)
}

pub(crate) fn width(model: &Model) -> i32 {
    model.width(label_advance(&model.label))
}

/// Draw one frame on the `CANVAS_W` × `CANVAS_H` logical canvas; the caller scales.
pub(crate) fn draw(cr: &Context, m: &Model) -> Res {
    cr.set_operator(Operator::Source);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    cr.paint()?;
    cr.set_operator(Operator::Over);
    if !m.visible {
        return Ok(());
    }
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
    let (mut scale, mut alpha, mut sink) = (1.0, 1.0, 0.0);
    if motion {
        scale = 0.3 + 0.7 * spring(m.age);
        alpha = (m.age / 0.12).min(1.0);
        if m.age > 0.6 {
            scale *= 1.0 + 0.05 * (-9.0 * m.phase).exp() * (m.phase * 22.0).sin();
        }
        if let Some(leaving) = m.leaving {
            let q = (leaving / LEAVE_SECS).clamp(0.0, 1.0);
            // A quick inhale, then shrink and sink.
            scale *= 1.0 + 0.06 * (q * PI).sin() - 0.45 * q * q;
            alpha *= 1.0 - q * q;
            sink = 10.0 * q * q;
        }
    }
    let shake = if motion && m.state == PillState::Error {
        4.5 * (-5.0 * m.phase).exp() * (m.phase * 42.0).sin()
    } else {
        0.0
    };

    cr.save()?;
    cr.translate(CANVAS_W / 2.0 + shake, PAD_TOP + h / 2.0 + sink);
    cr.scale(scale, scale);
    cr.push_group();
    let left = -w / 2.0;
    let (px, py) = (left + 22.0, 0.0);

    under_glow(cr, m, w, h, accent, level)?;
    if motion && m.state == PillState::Listening {
        bubbles(cr, m, w, h, level)?;
        ripples(cr, m, px, py, accent, level)?;
    }
    shell(cr, m, w, h, accent)?;
    if motion {
        // A light sweep over the glass as it arrives and when the words land.
        sweep(cr, w, h, (m.age - 0.1) / 0.65)?;
        if m.state == PillState::Success {
            sweep(cr, w, h, (m.phase - 0.05) / 0.5)?;
        }
    }
    let mut x = left + 44.0;
    if m.shows_bars() {
        beads(cr, m, x + 1.5, accent, level)?;
        x += BARS as f64 * BEAD_GAP + 10.0;
    }
    pearl(cr, m, px, py, accent, level)?;
    if !m.label.is_empty() {
        label(cr, m, x - 2.0)?;
    }
    if motion && m.state == PillState::Success {
        burst(cr, m.phase, px, py, accent)?;
    }

    cr.pop_group_to_source()?;
    cr.paint_with_alpha(alpha)?;
    cr.restore()
}

/// A soft pool of light under the pill, brighter with the voice.
fn under_glow(cr: &Context, m: &Model, w: f64, h: f64, a: Rgb, level: f64) -> Res {
    let pulse = match m.state {
        PillState::Transcribing if !m.reduce_motion => 0.5 + 0.5 * (m.phase * 3.0).sin(),
        PillState::Error if !m.reduce_motion => 0.5 + 0.5 * (m.phase * 6.0).cos(),
        _ => 0.5,
    };
    let strength = 0.16 + 0.22 * level + 0.1 * pulse;
    cr.save()?;
    cr.scale(w / 2.0 + 26.0, h / 2.0 + 16.0);
    let glow = RadialGradient::new(0.0, 0.0, 0.0, 0.0, 0.0, 1.0);
    glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, strength);
    glow.add_color_stop_rgba(0.6, a.0, a.1, a.2, strength * 0.35);
    glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
    circle(cr, 0.0, 0.0, 1.0);
    cr.set_source(&glow)?;
    cr.fill()?;
    cr.restore()
}

/// Tiny bubbles drifting up from behind the pill while it listens.
fn bubbles(cr: &Context, m: &Model, w: f64, h: f64, level: f64) -> Res {
    for i in 0..9 {
        let i = f64::from(i);
        let period = 1.5 + 1.1 * hash(i * 1.7);
        let t = ((m.phase + period * hash(i * 3.1)) / period).rem_euclid(1.0);
        let x = -w / 2.0 + 26.0 + hash(i * 7.3) * (w - 44.0) + (t * 7.0 + i).sin() * 3.0;
        let y = -h / 2.0 + 6.0 - ease_out(t) * (PAD_TOP - 4.0);
        let r = (0.8 + 1.7 * hash(i * 5.7)) * (0.65 + 0.9 * level);
        let alpha = (t * PI).sin().powf(0.7) * (0.35 + 0.5 * level);
        circle(cr, x, y, r);
        cr.set_source_rgba(FOAM.0, FOAM.1, FOAM.2, alpha * 0.18);
        cr.fill_preserve()?;
        cr.set_source_rgba(0.85, 0.97, 1.0, alpha * 0.75);
        cr.set_line_width(0.6);
        cr.stroke()?;
        circle(cr, x - r * 0.35, y - r * 0.35, r * 0.28);
        cr.set_source_rgba(1.0, 1.0, 1.0, alpha);
        cr.fill()?;
    }
    Ok(())
}

/// Rings spreading from the pearl, like a drop in still water.
fn ripples(cr: &Context, m: &Model, px: f64, py: f64, a: Rgb, level: f64) -> Res {
    for k in 0..3 {
        let t = (m.phase * 0.85 + f64::from(k) / 3.0).rem_euclid(1.0);
        let r = PEARL_R + 2.0 + ease_out(t) * (20.0 + 22.0 * level);
        let alpha = (1.0 - t).powi(2) * (0.18 + 0.55 * level);
        circle(cr, px, py, r);
        cr.set_source_rgba(a.0, a.1, a.2, alpha);
        cr.set_line_width(0.4 + 1.4 * (1.0 - t));
        cr.stroke()?;
    }
    Ok(())
}

/// Deep-sea glass with drifting caustics and a slowly sliding iridescent rim.
fn shell(cr: &Context, m: &Model, w: f64, h: f64, a: Rgb) -> Res {
    let (x, y) = (-w / 2.0, -h / 2.0);
    rounded(cr, x + 0.5, y + 0.5, w - 1.0, h - 1.0, h / 2.0);
    let body = LinearGradient::new(0.0, y, 0.0, y + h);
    body.add_color_stop_rgba(0.0, 0.055, 0.15, 0.25, 0.97);
    body.add_color_stop_rgba(1.0, 0.012, 0.045, 0.095, 0.97);
    cr.set_source(&body)?;
    cr.fill_preserve()?;
    cr.save()?;
    cr.clip();
    // Caustics: soft light patches wandering across the water.
    if !m.reduce_motion {
        for i in 0..3 {
            let i = f64::from(i);
            let cx = (m.age * (0.35 + 0.12 * i) + hash(i * 9.1) * TAU).sin() * w * 0.42;
            let cy = (m.age * (0.5 + 0.2 * i) + i).cos() * h * 0.35;
            let glow = RadialGradient::new(cx, cy, 0.0, cx, cy, 22.0);
            glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.11);
            glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
            cr.set_source(&glow)?;
            cr.paint()?;
        }
    }
    let top = LinearGradient::new(0.0, y, 0.0, y + h / 2.0);
    top.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, 0.12);
    top.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.0);
    rounded(cr, x + 1.5, y + 1.5, w - 3.0, h / 2.0, h / 2.0 - 1.0);
    cr.set_source(&top)?;
    cr.fill()?;
    cr.restore()?;
    // Mother-of-pearl rim whose colours slide around the edge.
    let offset = if m.reduce_motion { 0.0 } else { m.age * 40.0 };
    let rim = LinearGradient::new(x + offset, y, x + offset + 140.0, y + h);
    rim.set_extend(Extend::Reflect);
    for (i, c) in NACRE.iter().enumerate() {
        rim.add_color_stop_rgba(i as f64 / 3.0, c.0, c.1, c.2, 0.6);
    }
    rounded(cr, x + 0.6, y + 0.6, w - 1.2, h - 1.2, h / 2.0);
    cr.set_source(&rim)?;
    cr.set_line_width(1.2);
    cr.stroke()
}

/// A diagonal band of light crossing the glass; `t` runs 0 to 1.
fn sweep(cr: &Context, w: f64, h: f64, t: f64) -> Res {
    if !(0.0..=1.0).contains(&t) {
        return Ok(());
    }
    let bx = -w / 2.0 - 30.0 + ease_out(t) * (w + 60.0);
    cr.save()?;
    rounded(cr, -w / 2.0, -h / 2.0, w, h, h / 2.0);
    cr.clip();
    let band = LinearGradient::new(bx - 16.0, -h / 2.0, bx + 16.0, h / 2.0);
    band.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, 0.0);
    band.add_color_stop_rgba(0.5, 1.0, 1.0, 1.0, 0.28 * (t * PI).sin());
    band.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.0);
    cr.set_source(&band)?;
    cr.paint()?;
    cr.restore()
}

/// The voice meter as a string of pearls on a silk thread.
fn beads(cr: &Context, m: &Model, x0: f64, a: Rgb, level: f64) -> Res {
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
    cr.new_path();
    for (n, &(x, y, _, _)) in points.iter().enumerate() {
        if n == 0 {
            cr.move_to(x - 3.0, y);
        }
        cr.line_to(x, y);
    }
    if let Some(&(x, y, _, _)) = points.last() {
        cr.line_to(x + 3.0, y);
    }
    cr.set_source_rgba(a.0, a.1, a.2, 0.35);
    cr.set_line_width(0.7);
    cr.set_line_join(LineJoin::Round);
    cr.set_line_cap(LineCap::Round);
    cr.stroke()?;
    for &(x, y, r, shine) in &points {
        if shine > 0.05 {
            let glow = RadialGradient::new(x, y, 0.0, x, y, r * 3.0);
            glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.5 * shine);
            glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
            circle(cr, x, y, r * 3.0);
            cr.set_source(&glow)?;
            cr.fill()?;
        }
        let tint = mix((1.0, 1.0, 1.0), a, 0.45);
        let body = RadialGradient::new(x - r * 0.35, y - r * 0.4, 0.1, x, y, r);
        body.add_color_stop_rgb(0.0, 1.0, 1.0, 1.0);
        body.add_color_stop_rgb(0.5, tint.0, tint.1, tint.2);
        body.add_color_stop_rgb(1.0, a.0 * 0.62, a.1 * 0.62, a.2 * 0.62);
        circle(cr, x, y, r);
        cr.set_source(&body)?;
        cr.fill()?;
        circle(cr, x - r * 0.35, y - r * 0.38, r * 0.3);
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.9);
        cr.fill()?;
    }
    Ok(())
}

/// A four-point sparkle.
fn sparkle(cr: &Context, x: f64, y: f64, s: f64, c: Rgb, alpha: f64) -> Res {
    let glow = RadialGradient::new(x, y, 0.0, x, y, s * 1.6);
    glow.add_color_stop_rgba(0.0, c.0, c.1, c.2, alpha * 0.6);
    glow.add_color_stop_rgba(1.0, c.0, c.1, c.2, 0.0);
    circle(cr, x, y, s * 1.6);
    cr.set_source(&glow)?;
    cr.fill()?;
    let k = s * 0.22;
    cr.new_path();
    cr.move_to(x, y - s);
    cr.curve_to(x + k * 0.3, y - k, x + k, y - k * 0.3, x + s, y);
    cr.curve_to(x + k, y + k * 0.3, x + k * 0.3, y + k, x, y + s);
    cr.curve_to(x - k * 0.3, y + k, x - k, y + k * 0.3, x - s, y);
    cr.curve_to(x - k, y - k * 0.3, x - k * 0.3, y - k, x, y - s);
    cr.close_path();
    cr.set_source_rgba(1.0, 1.0, 1.0, alpha);
    cr.fill()
}

/// The pearl: swirling nacre, a soft limb, a crisp highlight and the state mark.
fn pearl(cr: &Context, m: &Model, cx: f64, cy: f64, a: Rgb, level: f64) -> Res {
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
    let glow = RadialGradient::new(cx, cy, r * 0.8, cx, cy, halo);
    glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.45 + 0.3 * level + 0.4 * flash);
    glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
    circle(cr, cx, cy, halo);
    cr.set_source(&glow)?;
    cr.fill()?;

    // Body.
    let body = RadialGradient::new(cx - r * 0.32, cy - r * 0.36, 0.5, cx, cy, r);
    body.add_color_stop_rgb(0.0, 1.0, 1.0, 1.0);
    body.add_color_stop_rgb(0.5, 0.96, 0.94, 0.93);
    body.add_color_stop_rgb(1.0, 0.76, 0.79, 0.86);
    circle(cr, cx, cy, r);
    cr.set_source(&body)?;
    cr.fill()?;

    // Nacre: colour clouds orbiting inside, faster with the voice or while thinking.
    cr.save()?;
    circle(cr, cx, cy, r);
    cr.clip();
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
        let cloud = RadialGradient::new(bx, by, 0.0, bx, by, r * 0.85);
        cloud.add_color_stop_rgba(0.0, c.0, c.1, c.2, 0.42);
        cloud.add_color_stop_rgba(1.0, c.0, c.1, c.2, 0.0);
        cr.set_source(&cloud)?;
        cr.paint()?;
    }
    let tint = RadialGradient::new(cx, cy + r * 0.5, 0.5, cx, cy + r * 0.2, r * 1.1);
    tint.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.38);
    tint.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
    cr.set_source(&tint)?;
    cr.paint()?;
    let limb = RadialGradient::new(cx, cy, r * 0.55, cx, cy, r);
    limb.add_color_stop_rgba(0.0, 0.1, 0.15, 0.25, 0.0);
    limb.add_color_stop_rgba(1.0, 0.1, 0.15, 0.25, 0.32);
    cr.set_source(&limb)?;
    cr.paint()?;
    cr.restore()?;

    // Highlights.
    let spec = RadialGradient::new(
        cx - r * 0.36,
        cy - r * 0.4,
        0.0,
        cx - r * 0.36,
        cy - r * 0.4,
        r * 0.36,
    );
    spec.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, 1.0);
    spec.add_color_stop_rgba(0.45, 1.0, 1.0, 1.0, 0.85);
    spec.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.0);
    circle(cr, cx - r * 0.36, cy - r * 0.4, r * 0.36);
    cr.set_source(&spec)?;
    cr.fill()?;
    circle(cr, cx + r * 0.38, cy + r * 0.42, r * 0.12);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.45);
    cr.fill()?;
    circle(cr, cx, cy, r);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.5 + 0.5 * flash);
    cr.set_line_width(0.8);
    cr.stroke()?;

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
            )?;
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
                cr.new_path();
                cr.move_to(cx - 4.5, cy + 0.5);
                cr.line_to(cx - 1.2, cy + 3.8);
                cr.line_to(cx + 4.8, cy - 3.2);
                cr.set_dash(&[len * progress, len], 0.0);
                cr.set_source_rgb(0.03, 0.32, 0.27);
                cr.set_line_width(2.3);
                cr.set_line_cap(LineCap::Round);
                cr.set_line_join(LineJoin::Round);
                cr.stroke()?;
                cr.set_dash(&[], 0.0);
            }
        }
        PillState::Error => {
            cr.select_font_face(FONT, FontSlant::Normal, FontWeight::Bold);
            cr.set_font_size(12.0);
            let e = cr.text_extents("!")?;
            cr.set_source_rgb(0.03, 0.15, 0.25);
            cr.move_to(
                cx - e.width() / 2.0 - e.x_bearing(),
                cy - e.y_bearing() - e.height() / 2.0,
            );
            cr.show_text("!")?;
        }
        _ => {}
    }
    Ok(())
}

fn label(cr: &Context, m: &Model, x: f64) -> Res {
    label_font(cr);
    let e = cr.text_extents(&m.label)?;
    let t = if m.reduce_motion {
        1.0
    } else {
        ease_out((m.phase - 0.08) / 0.3)
    };
    let y = -e.y_bearing() - e.height() / 2.0 + 4.0 * (1.0 - t);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.35 * t);
    cr.move_to(x, y + 1.0);
    cr.show_text(&m.label)?;
    cr.set_source_rgba(INK.0, INK.1, INK.2, t);
    cr.move_to(x, y);
    cr.show_text(&m.label)
}

/// Success: a shockwave and a spray of tiny pearls and sparkles.
fn burst(cr: &Context, t: f64, px: f64, py: f64, a: Rgb) -> Res {
    if t > 1.3 {
        return Ok(());
    }
    let ring = (t / 0.55).min(1.0);
    if ring < 1.0 {
        circle(cr, px, py, PEARL_R + ease_out(ring) * 34.0);
        cr.set_source_rgba(a.0, a.1, a.2, 0.7 * (1.0 - ring));
        cr.set_line_width(2.4 * (1.0 - ring) + 0.3);
        cr.stroke()?;
        circle(cr, px, py, PEARL_R + ease_out(ring) * 22.0);
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.45 * (1.0 - ring));
        cr.set_line_width(1.0);
        cr.stroke()?;
    }
    for i in 0..18 {
        let i = f64::from(i);
        let angle = i * TAU / 18.0 + (hash(i) - 0.5) * 0.5;
        let speed = 30.0 + 34.0 * hash(i * 2.3);
        let q = (t / 1.0).min(1.0);
        let d = PEARL_R + speed * ease_out(q);
        let x = px + angle.cos() * d;
        let y = py + angle.sin() * d * 0.85 + 16.0 * t * t;
        let fade = (1.0 - t / 1.3).max(0.0);
        let size = (1.1 + 1.6 * hash(i * 4.7)) * (0.4 + 0.6 * fade);
        if (i as usize).is_multiple_of(3) {
            let c = NACRE[(i as usize / 3) % NACRE.len()];
            sparkle(cr, x, y, size * 1.8, c, fade)?;
        } else {
            let c = NACRE[i as usize % NACRE.len()];
            let body = RadialGradient::new(x - size * 0.35, y - size * 0.4, 0.1, x, y, size);
            body.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, fade);
            body.add_color_stop_rgba(1.0, c.0, c.1, c.2, fade);
            circle(cr, x, y, size);
            cr.set_source(&body)?;
            cr.fill()?;
        }
    }
    Ok(())
}

/// Draw one frame offscreen at 2× to a PNG, for unattended visual checks.
/// Returns the logical pill width.
pub fn render_preview(
    state: PillState,
    level: f32,
    label: Option<&str>,
    path: &std::path::Path,
) -> Result<i32, String> {
    let mut m = Model::default();
    m.apply(&crate::Message {
        state,
        level: Some(level),
        label: label.map(Into::into),
    });
    let w = width(&m);
    m.set_target_width(f64::from(w));
    m.age = 2.0;
    m.phase = 0.9;
    m.shown_level = m.level;
    write_png(&m, path, None)?;
    Ok(w)
}

fn write_png(m: &Model, path: &std::path::Path, backdrop: Option<f64>) -> Result<(), String> {
    let surface = cairo::ImageSurface::create(
        cairo::Format::ARgb32,
        (CANVAS_W * 2.0) as i32,
        (CANVAS_H * 2.0) as i32,
    )
    .map_err(|e| e.to_string())?;
    {
        let cr = Context::new(&surface).map_err(|e| e.to_string())?;
        cr.scale(2.0, 2.0);
        let frame = cairo::ImageSurface::create(
            cairo::Format::ARgb32,
            (CANVAS_W * 2.0) as i32,
            (CANVAS_H * 2.0) as i32,
        )
        .map_err(|e| e.to_string())?;
        {
            let fc = Context::new(&frame).map_err(|e| e.to_string())?;
            fc.scale(2.0, 2.0);
            draw(&fc, m).map_err(|e| e.to_string())?;
        }
        if let Some(t) = backdrop {
            // A dim desktop-like backdrop so glow and bursts read in a GIF.
            let bg = LinearGradient::new(0.0, 0.0, CANVAS_W, CANVAS_H);
            bg.add_color_stop_rgb(0.0, 0.13, 0.15, 0.2);
            bg.add_color_stop_rgb(1.0, 0.2 + 0.02 * t.sin(), 0.22, 0.28);
            cr.set_source(&bg).map_err(|e| e.to_string())?;
            cr.paint().map_err(|e| e.to_string())?;
        }
        cr.scale(0.5, 0.5);
        cr.set_source_surface(&frame, 0.0, 0.0)
            .map_err(|e| e.to_string())?;
        cr.paint().map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    surface
        .write_to_png(&mut file)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Render a scripted run (appear, talk, think, land, leave, then an error) as
/// numbered PNG frames over a backdrop. Returns the frame count.
pub fn render_demo(dir: &std::path::Path, fps: f64) -> Result<usize, String> {
    use crate::Message;
    let msg = |state, level: Option<f32>, label: Option<&str>| Message {
        state,
        level,
        label: label.map(Into::into),
    };
    // (seconds, message to apply at the start of the segment)
    let script: Vec<(f64, Option<Message>)> = vec![
        (2.6, Some(msg(PillState::Listening, Some(0.0), None))),
        (1.3, Some(msg(PillState::Transcribing, None, None))),
        (1.4, Some(msg(PillState::Success, None, Some("Typed")))),
        (0.5, Some(msg(PillState::Hidden, None, None))),
        (
            1.6,
            Some(msg(PillState::Error, None, Some("Nothing heard"))),
        ),
        (0.5, Some(msg(PillState::Hidden, None, None))),
    ];
    let mut m = Model::default();
    let dt = 1.0 / fps;
    let mut frame = 0;
    let mut clock: f64 = 0.0;
    for (secs, message) in script {
        if let Some(message) = message {
            m.apply(&message);
            if m.visible {
                let w = width(&m);
                m.set_target_width(f64::from(w));
            }
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
            write_png(&m, &dir.join(format!("frame_{frame:04}.png")), Some(clock))?;
            frame += 1;
            t += dt;
            clock += dt;
        }
    }
    Ok(frame)
}
