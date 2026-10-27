use serde::{Deserialize, Serialize};
use std::time::Duration;

pub(crate) const BARS: usize = 9;
pub(crate) const HEIGHT: i32 = 40;
/// Words only where they help, and never long ones.
const LABEL_CHARS: usize = 28;

pub(crate) type Rgb = (f64, f64, f64);
// Deep Sea palette, as in the legacy pill.
pub(crate) const SHELL: (f64, f64, f64, f64) = (0.024, 0.098, 0.169, 0.95);
pub(crate) const RIM: (f64, f64, f64, f64) = (0.745, 0.91, 1.0, 0.22);
pub(crate) const INK: Rgb = (0.918, 0.965, 1.0);
pub(crate) const CORAL: Rgb = (1.0, 0.435, 0.525);
pub(crate) const FOAM: Rgb = (0.459, 0.894, 1.0);
pub(crate) const SEAGLASS: Rgb = (0.373, 0.863, 0.749);
pub(crate) const AMBER: Rgb = (0.965, 0.788, 0.475);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PillState {
    Hidden,
    Listening,
    Transcribing,
    Success,
    Error,
}

/// One line on the helper's stdin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub state: PillState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Raw RMS from the recorder (speech sits around 0.02–0.2) to the 0–1 meter
/// value the legacy pill was tuned for.
pub fn audible_level(rms: f32) -> f32 {
    if rms.is_finite() {
        (rms * 4.2).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// What the pill shows, independent of GTK.
#[derive(Debug, Clone)]
pub(crate) struct Model {
    pub(crate) state: PillState,
    pub(crate) label: String,
    pub(crate) level: f64,
    pub(crate) shown_level: f64,
    /// Seconds since the current state began, advanced only while animating.
    pub(crate) phase: f64,
    pub(crate) reduce_motion: bool,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            state: PillState::Hidden,
            label: String::new(),
            level: 0.0,
            shown_level: 0.0,
            phase: 0.0,
            reduce_motion: false,
        }
    }
}

impl Model {
    pub(crate) fn apply(&mut self, m: &Message) {
        if m.state == PillState::Hidden {
            self.state = PillState::Hidden;
            return;
        }
        if let Some(level) = m.level.filter(|l| l.is_finite()) {
            self.level = f64::from(level.clamp(0.0, 1.0));
        }
        if m.state != self.state {
            self.phase = 0.0;
            if m.state != PillState::Listening {
                self.level = 0.0;
            }
        }
        self.state = m.state;
        self.label = match (&m.label, m.state) {
            (Some(l), PillState::Success | PillState::Error) => {
                l.chars().take(LABEL_CHARS).collect()
            }
            _ => String::new(),
        };
        if self.reduce_motion {
            // No frames run, so the meter jumps straight to the voice.
            self.shown_level = self.level;
        }
    }

    pub(crate) fn shows_bars(&self) -> bool {
        matches!(self.state, PillState::Listening | PillState::Transcribing)
    }

    pub(crate) fn animates(&self) -> bool {
        self.shows_bars() && !self.reduce_motion
    }

    pub(crate) fn accent(&self) -> Rgb {
        match self.state {
            PillState::Listening => CORAL,
            PillState::Success => SEAGLASS,
            PillState::Error => AMBER,
            PillState::Hidden | PillState::Transcribing => FOAM,
        }
    }

    /// Width in logical pixels, given the label's advance at 12.5 px bold.
    pub(crate) fn width(&self, label_advance: f64) -> i32 {
        let bars = if self.shows_bars() {
            BARS as i32 * 6 + 10
        } else {
            0
        };
        let label = if self.label.is_empty() {
            0
        } else {
            label_advance as i32 + 12
        };
        (8 + 28 + bars + label + 8).max(52)
    }

    pub(crate) fn auto_hide(&self) -> Option<Duration> {
        match self.state {
            PillState::Success => Some(Duration::from_millis(1300)),
            PillState::Error => Some(Duration::from_millis(2600)),
            _ => None,
        }
    }

    /// Advance one frame of `dt` seconds.
    pub(crate) fn step(&mut self, dt: f64) {
        let dt = dt.clamp(0.0, 0.1);
        self.phase += dt;
        // Rise quickly with the voice, fall back gently like water. The legacy
        // rates were per frame at 60 Hz; scale them so 144 Hz looks the same.
        let rate: f64 = if self.level > self.shown_level {
            0.45
        } else {
            0.12
        };
        let k = 1.0 - (1.0 - rate).powf(dt * 60.0);
        self.shown_level += (self.level - self.shown_level) * k;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(state: PillState, level: Option<f32>, label: Option<&str>) -> Message {
        Message {
            state,
            level,
            label: label.map(Into::into),
        }
    }

    #[test]
    fn message_wire_format() {
        let line = serde_json::to_string(&msg(PillState::Listening, Some(0.5), None)).unwrap();
        assert_eq!(line, r#"{"state":"listening","level":0.5}"#);
        let parsed: Message = serde_json::from_str(r#"{"state":"error","label":"Nope"}"#).unwrap();
        assert_eq!(parsed, msg(PillState::Error, None, Some("Nope")));
    }

    #[test]
    fn labels_only_for_results_and_problems() {
        let mut m = Model::default();
        m.apply(&msg(PillState::Listening, None, Some("Hello")));
        assert_eq!(m.label, "");
        m.apply(&msg(PillState::Success, None, Some("Typed")));
        assert_eq!(m.label, "Typed");
        m.apply(&msg(PillState::Error, None, Some(&"x".repeat(40))));
        assert_eq!(m.label.chars().count(), 28);
    }

    #[test]
    fn accent_follows_state() {
        let mut m = Model::default();
        for (state, accent) in [
            (PillState::Listening, CORAL),
            (PillState::Transcribing, FOAM),
            (PillState::Success, SEAGLASS),
            (PillState::Error, AMBER),
        ] {
            m.apply(&msg(state, None, None));
            assert_eq!(m.accent(), accent);
        }
    }

    #[test]
    fn width_fits_bars_or_label() {
        let mut m = Model::default();
        m.apply(&msg(PillState::Listening, None, None));
        assert_eq!(m.width(0.0), 108);
        m.apply(&msg(PillState::Success, None, Some("Typed")));
        assert_eq!(m.width(38.4), 94);
        m.apply(&msg(PillState::Error, None, None));
        assert_eq!(m.width(0.0), 52);
    }

    #[test]
    fn level_is_kept_only_while_listening() {
        let mut m = Model::default();
        m.apply(&msg(PillState::Listening, Some(0.8), None));
        assert_eq!(m.level, f64::from(0.8_f32));
        m.apply(&msg(PillState::Listening, None, None));
        assert_eq!(m.level, f64::from(0.8_f32), "a level-less update keeps it");
        m.apply(&msg(PillState::Transcribing, None, None));
        assert_eq!(m.level, 0.0);
        m.apply(&msg(PillState::Listening, Some(f32::NAN), None));
        assert_eq!(m.level, 0.0);
        m.apply(&msg(PillState::Listening, Some(3.0), None));
        assert_eq!(m.level, 1.0);
    }

    #[test]
    fn smoothing_rises_fast_and_falls_slowly() {
        let mut m = Model::default();
        m.apply(&msg(PillState::Listening, Some(1.0), None));
        m.step(1.0 / 60.0);
        assert!((m.shown_level - 0.45).abs() < 1e-9);
        m.apply(&msg(PillState::Listening, Some(0.0), None));
        m.step(1.0 / 60.0);
        assert!((m.shown_level - 0.45 * 0.88).abs() < 1e-9);
        // Two 120 Hz frames land where one 60 Hz frame does.
        let (mut a, mut b) = (m.clone(), m.clone());
        a.step(1.0 / 60.0);
        b.step(1.0 / 120.0);
        b.step(1.0 / 120.0);
        assert!((a.shown_level - b.shown_level).abs() < 1e-9);
    }

    #[test]
    fn reduced_motion_jumps_to_level() {
        let mut m = Model {
            reduce_motion: true,
            ..Model::default()
        };
        m.apply(&msg(PillState::Listening, Some(0.6), None));
        assert!(!m.animates());
        assert_eq!(m.shown_level, f64::from(0.6_f32));
    }

    #[test]
    fn auto_hide_only_for_results() {
        let mut m = Model::default();
        m.apply(&msg(PillState::Listening, None, None));
        assert_eq!(m.auto_hide(), None);
        m.apply(&msg(PillState::Success, None, None));
        assert_eq!(m.auto_hide(), Some(Duration::from_millis(1300)));
        m.apply(&msg(PillState::Error, None, None));
        assert_eq!(m.auto_hide(), Some(Duration::from_millis(2600)));
    }

    #[test]
    fn audible_level_scales_and_clamps() {
        assert_eq!(audible_level(0.0), 0.0);
        assert!((audible_level(0.1) - 0.42).abs() < 1e-6);
        assert_eq!(audible_level(0.5), 1.0);
        assert_eq!(audible_level(f32::NAN), 0.0);
    }
}
