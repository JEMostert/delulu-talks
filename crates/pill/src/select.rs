//! Which window system the pill draws on, chosen once at start.
//!
//! `auto` (the default): layer-shell when there is a Wayland display whose
//! compositor offers `zwlr_layer_shell_v1` (KDE Plasma, wlroots), else X11 when
//! there is an X display (GNOME through XWayland, X11 sessions), else nothing.
//! `--backend` or `DELULU_PILL_BACKEND` forces one, for bug reports.

/// A window system the pill can draw on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    LayerShell,
    X11,
}

/// What the session offers, as far as the environment says.
#[derive(Debug, Clone, Copy, Default)]
pub struct Session {
    /// `WAYLAND_DISPLAY` or `WAYLAND_SOCKET` is set.
    pub wayland: bool,
    /// `DISPLAY` is set.
    pub x11: bool,
}

impl Session {
    pub fn from_env() -> Self {
        let set = |name| std::env::var_os(name).is_some_and(|v| !v.is_empty());
        Self {
            wayland: set("WAYLAND_DISPLAY") || set("WAYLAND_SOCKET"),
            x11: set("DISPLAY"),
        }
    }
}

/// Pick the backend. `requested` is the override (`auto` or none for the
/// default); `has_layer_shell` asks the compositor and runs only when needed.
pub fn choose(
    requested: Option<&str>,
    session: Session,
    has_layer_shell: impl FnOnce() -> bool,
) -> Result<Backend, String> {
    match requested.unwrap_or("auto") {
        "layer-shell" if session.wayland => Ok(Backend::LayerShell),
        "layer-shell" => Err("layer-shell needs a Wayland display".into()),
        "x11" if session.x11 => Ok(Backend::X11),
        "x11" => Err("x11 needs an X display (DISPLAY)".into()),
        "auto" if session.wayland && has_layer_shell() => Ok(Backend::LayerShell),
        "auto" if session.x11 => Ok(Backend::X11),
        "auto" if session.wayland => {
            Err("the compositor offers no layer-shell and there is no X display".into())
        }
        "auto" => Err("no Wayland or X display".into()),
        other => Err(format!(
            "unknown backend {other:?} (use auto, layer-shell or x11)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KDE: Session = Session {
        wayland: true,
        x11: true,
    };
    const GNOME: Session = KDE;
    const X_ONLY: Session = Session {
        wayland: false,
        x11: true,
    };
    const NONE: Session = Session {
        wayland: false,
        x11: false,
    };

    #[test]
    fn auto_prefers_layer_shell_then_x11() {
        assert_eq!(choose(None, KDE, || true), Ok(Backend::LayerShell));
        // GNOME offers no layer-shell: XWayland.
        assert_eq!(choose(None, GNOME, || false), Ok(Backend::X11));
        assert_eq!(choose(Some("auto"), X_ONLY, || unreachable!()), Ok(Backend::X11));
        let wayland_only = Session {
            wayland: true,
            x11: false,
        };
        assert!(choose(None, wayland_only, || false).is_err());
        assert!(choose(None, NONE, || unreachable!()).is_err());
    }

    #[test]
    fn overrides_skip_the_probe_but_need_their_display() {
        assert_eq!(choose(Some("x11"), KDE, || unreachable!()), Ok(Backend::X11));
        assert_eq!(
            choose(Some("layer-shell"), KDE, || unreachable!()),
            Ok(Backend::LayerShell)
        );
        assert!(choose(Some("layer-shell"), X_ONLY, || unreachable!()).is_err());
        assert!(choose(Some("x11"), NONE, || unreachable!()).is_err());
        assert!(choose(Some("gtk"), KDE, || unreachable!()).is_err());
    }
}
