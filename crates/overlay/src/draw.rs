use crate::model::{Model, PillState, Rgb, BARS, FOAM, HEIGHT, INK, RIM, SHELL};
use cairo::{Context, FontSlant, FontWeight, LineCap, LineJoin, LinearGradient, Operator};
use std::f64::consts::PI;

const FONT: &str = "Inter";
const LABEL_SIZE: f64 = 12.5;

fn rounded(cr: &Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    let r = r.min(w / 2.0).min(h / 2.0);
    cr.new_sub_path();
    cr.arc(x + w - r, y + r, r, -PI / 2.0, 0.0);
    cr.arc(x + w - r, y + h - r, r, 0.0, PI / 2.0);
    cr.arc(x + r, y + h - r, r, PI / 2.0, PI);
    cr.arc(x + r, y + r, r, PI, 3.0 * PI / 2.0);
    cr.close_path();
}

fn label_font(cr: &Context) {
    cr.select_font_face(FONT, FontSlant::Normal, FontWeight::Bold);
    cr.set_font_size(LABEL_SIZE);
}

/// The label's horizontal advance, for sizing the window before drawing.
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

/// Draw one frame at logical size `width` × `HEIGHT`; the caller scales for HiDPI.
pub(crate) fn draw(cr: &Context, m: &Model, width: f64) -> Result<(), cairo::Error> {
    let height = f64::from(HEIGHT);
    cr.set_operator(Operator::Source);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    cr.paint()?;
    cr.set_operator(Operator::Over);
    let accent = m.accent();
    // Shell: smoked navy glass with a cool rim and a soft top light.
    rounded(cr, 0.5, 0.5, width - 1.0, height - 1.0, height / 2.0);
    cr.set_source_rgba(SHELL.0, SHELL.1, SHELL.2, SHELL.3);
    cr.fill_preserve()?;
    cr.set_source_rgba(RIM.0, RIM.1, RIM.2, RIM.3);
    cr.set_line_width(1.0);
    cr.stroke()?;
    let top = LinearGradient::new(0.0, 0.0, 0.0, height / 2.0);
    top.add_color_stop_rgba(0.0, 1.0, 1.0, 1.0, 0.08);
    top.add_color_stop_rgba(1.0, 1.0, 1.0, 1.0, 0.0);
    rounded(cr, 1.5, 1.5, width - 3.0, height / 2.0, height / 2.0 - 1.0);
    cr.set_source(&top)?;
    cr.fill()?;
    pearl(cr, m, 22.0, height / 2.0, accent)?;
    let mut x = 44.0;
    if m.shows_bars() {
        bars(cr, m, x, height / 2.0, accent)?;
        x += BARS as f64 * 6.0 + 10.0;
    }
    if !m.label.is_empty() {
        label_font(cr);
        let e = cr.text_extents(&m.label)?;
        cr.set_source_rgb(INK.0, INK.1, INK.2);
        cr.move_to(x - 2.0, height / 2.0 - e.y_bearing() - e.height() / 2.0);
        cr.show_text(&m.label)?;
    }
    Ok(())
}

fn radial(x0: f64, y0: f64, r0: f64, x1: f64, y1: f64, r1: f64) -> cairo::RadialGradient {
    cairo::RadialGradient::new(x0, y0, r0, x1, y1, r1)
}

fn circle(cr: &Context, cx: f64, cy: f64, r: f64) {
    cr.new_path();
    cr.arc(cx, cy, r, 0.0, 2.0 * PI);
}

fn pearl(cr: &Context, m: &Model, cx: f64, cy: f64, a: Rgb) -> Result<(), cairo::Error> {
    let radius = 11.0;
    if m.state == PillState::Listening {
        // A halo that breathes with the voice.
        let halo = radius + 2.0 + 5.0 * m.shown_level;
        let glow = radial(cx, cy, radius, cx, cy, halo + 3.0);
        glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.55);
        glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
        circle(cr, cx, cy, halo + 3.0);
        cr.set_source(&glow)?;
        cr.fill()?;
    } else if m.state == PillState::Transcribing && !m.reduce_motion {
        let pulse = 0.5 + 0.5 * (m.phase * 3.2).sin();
        let glow = radial(cx, cy, radius, cx, cy, radius + 6.0);
        glow.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.25 + 0.3 * pulse);
        glow.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
        circle(cr, cx, cy, radius + 6.0);
        cr.set_source(&glow)?;
        cr.fill()?;
    }
    // Mother-of-pearl body: warm white core, cool rim, a tint of the state.
    let body = radial(cx - 3.5, cy - 4.0, 1.0, cx, cy, radius);
    body.add_color_stop_rgb(0.0, 1.0, 1.0, 1.0);
    body.add_color_stop_rgb(0.45, 0.95, 0.93, 0.91);
    body.add_color_stop_rgb(1.0, 0.77, 0.81, 0.86);
    circle(cr, cx, cy, radius);
    cr.set_source(&body)?;
    cr.fill()?;
    let tint = radial(cx, cy + 5.0, 1.0, cx, cy + 2.0, radius + 1.0);
    let tint_alpha = if m.state == PillState::Listening {
        0.55
    } else {
        0.35
    };
    tint.add_color_stop_rgba(0.0, a.0, a.1, a.2, tint_alpha);
    tint.add_color_stop_rgba(1.0, a.0, a.1, a.2, 0.0);
    circle(cr, cx, cy, radius);
    cr.set_source(&tint)?;
    cr.fill()?;
    // Iridescent sheen and a crisp highlight.
    let sheen = LinearGradient::new(cx - radius, cy - radius, cx + radius, cy + radius);
    sheen.add_color_stop_rgba(0.0, 1.0, 0.66, 0.78, 0.22);
    sheen.add_color_stop_rgba(0.5, 0.62, 0.88, 1.0, 0.18);
    sheen.add_color_stop_rgba(1.0, 0.74, 0.66, 1.0, 0.2);
    circle(cr, cx, cy, radius);
    cr.set_source(&sheen)?;
    cr.fill()?;
    circle(cr, cx - 3.8, cy - 4.2, 2.6);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.95);
    cr.fill()?;
    circle(cr, cx, cy, radius);
    cr.set_source_rgba(1.0, 1.0, 1.0, 0.55);
    cr.set_line_width(0.8);
    cr.stroke()?;
    match m.state {
        PillState::Success => {
            cr.set_source_rgb(0.03, 0.32, 0.27);
            cr.set_line_width(2.2);
            cr.set_line_cap(LineCap::Round);
            cr.set_line_join(LineJoin::Round);
            cr.move_to(cx - 4.5, cy + 0.5);
            cr.line_to(cx - 1.2, cy + 3.8);
            cr.line_to(cx + 4.8, cy - 3.2);
            cr.stroke()?;
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

fn bars(cr: &Context, m: &Model, x: f64, cy: f64, a: Rgb) -> Result<(), cairo::Error> {
    let listening = m.state == PillState::Listening;
    for index in 0..BARS {
        // A travelling wave; while listening its swell follows the voice.
        let i = index as f64;
        let envelope = (PI * (i + 0.5) / BARS as f64).sin().powf(0.8);
        let speed = if listening { 5.0 } else { 3.0 };
        let wave = 0.5 + 0.5 * (m.phase * speed - i * 0.75).sin();
        let amount = if m.reduce_motion {
            0.15 + 0.5 * envelope * if listening { m.shown_level } else { 0.4 }
        } else if listening {
            0.12 + envelope * (0.25 + 0.75 * m.shown_level) * (0.55 + 0.45 * wave)
        } else {
            0.15 + 0.35 * envelope * wave
        };
        let bar = (22.0 * amount).clamp(3.0, 22.0);
        let left = x + i * 6.0;
        let gradient = LinearGradient::new(0.0, cy - bar / 2.0, 0.0, cy + bar / 2.0);
        gradient.add_color_stop_rgba(0.0, a.0, a.1, a.2, 0.95);
        let foam_alpha = if listening { 0.75 } else { 0.95 };
        gradient.add_color_stop_rgba(1.0, FOAM.0, FOAM.1, FOAM.2, foam_alpha);
        rounded(cr, left, cy - bar / 2.0, 3.0, bar, 1.5);
        cr.set_source(&gradient)?;
        cr.fill()?;
    }
    Ok(())
}

/// Draw one frame offscreen at 2× to a PNG, for unattended visual checks.
/// Returns the logical width.
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
    m.phase = 0.9;
    m.shown_level = m.level;
    let w = width(&m);
    let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, w * 2, HEIGHT * 2)
        .map_err(|e| e.to_string())?;
    {
        let cr = Context::new(&surface).map_err(|e| e.to_string())?;
        cr.scale(2.0, 2.0);
        draw(&cr, &m, f64::from(w)).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    surface
        .write_to_png(&mut file)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(w)
}
