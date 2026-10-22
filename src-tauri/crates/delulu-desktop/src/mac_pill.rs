//! What the macOS recording panel shows (`electron/services/macPill.ts`),
//! so the app crate only has to own the window.
//!
//! Electron's panel, to reimplement as a Tauri webview window:
//! - 240×56, frameless, transparent, no shadow, not focusable, skips the
//!   taskbar, not resizable/movable/minimizable/maximizable/fullscreenable,
//!   NSPanel-style nonactivating (`type: "panel"`), ignores mouse events,
//!   always on top at the "floating" level, visible on all workspaces and
//!   over fullscreen apps, hidden in Mission Control.
//! - Loads [`HTML`] (a data URL with a CSP that forbids everything but
//!   inline styles); new windows and navigation are denied.
//! - On every visible command: position with [`position`] on the display
//!   nearest the cursor, evaluate [`render_script`], then `showInactive()`
//!   (show without activating) if no newer command arrived meanwhile.
//! - `hidden` hides the window. `success`/`error` hide automatically after
//!   [`AUTO_HIDE`].
//! - Any window failure reports `Mac recording indicator unavailable:
//!   <reason>` through the factory's `on_error` and destroys the window.
//! - It never hosts transcript content.

use std::time::Duration;

use serde::Serialize;

use crate::pill::{PillCommand, PillState};

pub const WIDTH: u32 = 240;
pub const HEIGHT: u32 = 56;
pub const AUTO_HIDE: Duration = Duration::from_millis(2500);

/// The page; a tiny Deep Sea pill with a pearl and wave bars.
pub fn html() -> String {
    let bars: String = (0..9)
        .map(|index| {
            let env = (std::f64::consts::PI * (index as f64 + 0.5) / 9.0).sin();
            format!(r#"<i style="--env:{env:.2};animation-delay:-{:.2}s"></i>"#, index as f64 * 0.11)
        })
        .collect();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{{margin:0;height:100%;background:transparent;overflow:hidden;font:600 12.5px -apple-system,BlinkMacSystemFont,sans-serif;color:#eaf6ff;user-select:none}}
body{{display:flex;align-items:center;justify-content:center;--accent:#75e4ff;--level:0}}
.pill{{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px 0 9px;border-radius:20px;background:#06192bf2;border:1px solid #bee8ff38;box-shadow:inset 0 1px #bee8ff24,0 6px 18px #00081455}}
.pearl{{position:relative;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#fff 0 12%,#f3eee8 40%,#c4ced9 100%);box-shadow:inset 0 -3px 5px color-mix(in srgb,var(--accent) 45%,transparent),0 0 calc(6px + 10px*var(--level)) color-mix(in srgb,var(--accent) 60%,transparent);transition:box-shadow .12s}}
.pearl::after{{content:"";position:absolute;inset:0;border-radius:50%;background:linear-gradient(135deg,#ffa8c738,#9ee0ff2e,#bca8ff33)}}
.bars{{display:flex;align-items:center;gap:3px;height:24px}}
.bars i{{display:block;width:3px;border-radius:2px;height:calc(3px + 19px*var(--env)*(0.2 + 0.8*var(--level)));background:linear-gradient(var(--accent),#75e4ffcc);animation:wave .8s ease-in-out infinite alternate;transition:height .1s}}
@keyframes wave{{from{{transform:scaleY(.45)}}to{{transform:scaleY(1)}}}}
.label:empty,.bars[hidden]{{display:none}}
@media (prefers-reduced-motion:reduce){{.bars i{{animation:none}}}}
</style></head><body><div class="pill" role="status"><div class="pearl"></div><div class="bars">{bars}</div><div class="label" id="label"></div></div></body></html>"#
    )
}

fn accent(state: PillState) -> &'static str {
    match state {
        PillState::Listening => "#ff6f86",
        PillState::Success => "#5fdcbf",
        PillState::Error => "#f6c979",
        _ => "#75e4ff",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MacPillPayload {
    pub accent: &'static str,
    pub level: f64,
    pub bars: bool,
    pub label: String,
}

pub fn render_payload(command: &PillCommand) -> MacPillPayload {
    let level = command.level.filter(|l| l.is_finite()).map_or(0.0, |l| l.clamp(0.0, 1.0));
    let paused = command.title.as_deref().unwrap_or("").to_lowercase() == "paused";
    let terminal = matches!(command.state, PillState::Success | PillState::Error);
    MacPillPayload {
        accent: if paused { "#c2aedb" } else { accent(command.state) },
        level: if command.state == PillState::Listening { level } else { 0.35 },
        bars: !paused
            && matches!(
                command.state,
                PillState::Listening | PillState::Transcribing | PillState::Magic | PillState::Delivering
            ),
        label: if terminal {
            let fallback = if command.state == PillState::Success { "Done" } else { "Needs attention" };
            truncate_utf16_units(command.title.as_deref().unwrap_or(fallback), 28)
        } else if paused {
            "Paused".into()
        } else {
            String::new()
        },
    }
}

fn truncate_utf16_units(text: &str, max: usize) -> String {
    delulu_core::util::truncate_utf16(text, max).to_owned()
}

/// The script evaluated in the panel for a command.
pub fn render_script(command: &PillCommand) -> String {
    let payload = serde_json::to_string(&render_payload(command)).unwrap_or_else(|_| "{}".into());
    format!(
        "(() => {{\n      const data = {payload};\n      document.body.style.setProperty('--accent', data.accent);\n      document.body.style.setProperty('--level', String(data.level));\n      document.querySelector('.bars').hidden = !data.bars;\n      document.getElementById('label').textContent = data.label;\n    }})()"
    )
}

/// Bottom-centre of the work area, 16 px above its bottom edge.
pub fn position(work_x: i32, work_y: i32, work_width: i32, work_height: i32) -> (i32, i32) {
    (
        (work_x as f64 + (work_width - WIDTH as i32) as f64 / 2.0).round() as i32,
        work_y + work_height - HEIGHT as i32 - 16,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_matches_the_electron_panel() {
        let listening = PillCommand { level: Some(3.0), ..PillCommand::new(PillState::Listening) };
        assert_eq!(
            render_payload(&listening),
            MacPillPayload { accent: "#ff6f86", level: 1.0, bars: true, label: String::new() }
        );
        let paused = PillCommand { title: Some("Paused".into()), ..PillCommand::new(PillState::Listening) };
        assert_eq!(render_payload(&paused).label, "Paused");
        assert!(!render_payload(&paused).bars);
        let error = PillCommand::new(PillState::Error);
        assert_eq!(render_payload(&error).label, "Needs attention");
        assert_eq!(render_payload(&error).level, 0.35);
        assert_eq!(position(0, 0, 1440, 900), (600, 828));
        assert!(html().contains("--env:0.17;animation-delay:-0.00s"));
    }
}
