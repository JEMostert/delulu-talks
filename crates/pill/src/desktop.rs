//! What the desktop says about scaling and motion, read without D-Bus or GTK.

use std::path::PathBuf;

/// The X11 scale from what the session publishes: `DELULU_PILL_X11_SCALE`,
/// then `GDK_SCALE` (what GTK apps are told), then `Xft.dpi` from the X
/// resources (GNOME's and KDE's settings daemons set it to 96 × scale). Rounded
/// to quarters; never below 1.
pub fn x11_scale(env_override: Option<&str>, gdk_scale: Option<&str>, resources: &str) -> f64 {
    let parse = |s: Option<&str>| s.and_then(|s| s.trim().parse::<f64>().ok()).filter(|s| *s > 0.0);
    let dpi = || {
        resources.lines().find_map(|l| {
            l.strip_prefix("Xft.dpi:")
                .and_then(|v| v.trim().parse::<f64>().ok())
        })
    };
    let scale = parse(env_override)
        .or_else(|| parse(gdk_scale))
        .or_else(|| dpi().map(|d| d / 96.0))
        .unwrap_or(1.0);
    ((scale * 4.0).round() / 4.0).clamp(1.0, 4.0)
}

/// An integer setting from an `_XSETTINGS_SETTINGS` property (the XSETTINGS
/// wire format: byte order, serial, count, then typed name/value records).
pub fn xsettings_int(data: &[u8], wanted: &str) -> Option<i32> {
    let big = *data.first()? != 0;
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = data.get(at..at + 2)?.try_into().ok()?;
        Some(if big {
            u16::from_be_bytes(b)
        } else {
            u16::from_le_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
        Some(if big {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    };
    let pad4 = |n: usize| n.div_ceil(4) * 4;
    let count = u32_at(8)?;
    let mut at = 12;
    for _ in 0..count {
        let kind = *data.get(at)?;
        let name_len = usize::from(u16_at(at + 2)?);
        let name = data.get(at + 4..at + 4 + name_len)?;
        // Then the name's padding and the last-change serial.
        let value = at + 4 + pad4(name_len) + 4;
        if kind == 0 && name == wanted.as_bytes() {
            return Some(u32_at(value)? as i32);
        }
        at = value
            + match kind {
                0 => 4,
                1 => 4 + pad4(u32_at(value)? as usize),
                2 => 8,
                _ => return None,
            };
    }
    None
}

/// KDE's "animation speed" set to instant (`AnimationDurationFactor=0` in
/// `[KDE]` of kdeglobals) means no motion. None when it does not say.
pub fn kde_reduces_motion(kdeglobals: &str) -> Option<bool> {
    let mut in_kde = false;
    for line in kdeglobals.lines().map(str::trim) {
        if line.starts_with('[') {
            in_kde = line == "[KDE]";
        } else if in_kde {
            if let Some(v) = line.strip_prefix("AnimationDurationFactor=") {
                return v.trim().parse::<f64>().ok().map(|f| f <= 0.0);
            }
        }
    }
    None
}

/// The user's kdeglobals, for [`kde_reduces_motion`].
pub fn kdeglobals_path() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("kdeglobals"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x11_scale_follows_the_session() {
        assert_eq!(x11_scale(None, None, ""), 1.0);
        assert_eq!(x11_scale(None, None, "Xft.antialias:\t1\nXft.dpi:\t144\n"), 1.5);
        assert_eq!(x11_scale(None, None, "Xft.dpi: 192"), 2.0);
        // KDE writes odd DPIs for 125 %: 120 → 1.25.
        assert_eq!(x11_scale(None, None, "Xft.dpi: 120"), 1.25);
        assert_eq!(x11_scale(None, None, "Xft.dpi: 72"), 1.0, "never below 1");
        assert_eq!(x11_scale(None, Some("2"), "Xft.dpi: 96"), 2.0);
        assert_eq!(x11_scale(Some("1.5"), Some("2"), "Xft.dpi: 192"), 1.5);
        assert_eq!(x11_scale(Some("bogus"), None, "Xft.dpi: 144"), 1.5);
    }

    /// An XSETTINGS blob as gsd-xsettings writes it.
    fn blob(big: bool, records: &[(u8, &str, Vec<u8>)]) -> Vec<u8> {
        let u16b = |v: u16| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let u32b = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut out = vec![u8::from(big), 0, 0, 0];
        out.extend(u32b(7));
        out.extend(u32b(records.len() as u32));
        for (kind, name, value) in records {
            out.extend([*kind, 0]);
            out.extend(u16b(name.len() as u16));
            out.extend(name.as_bytes());
            out.resize(out.len().div_ceil(4) * 4, 0);
            out.extend(u32b(3));
            out.extend(value);
        }
        out
    }

    #[test]
    fn reads_enable_animations_from_xsettings() {
        for big in [false, true] {
            let u32b = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
            let mut theme = u32b(7).to_vec();
            theme.extend(b"Adwaita\0");
            let data = blob(
                big,
                &[
                    (1, "Net/ThemeName", theme),
                    (2, "Gtk/Color", vec![0; 8]),
                    (0, "Gdk/WindowScalingFactor", u32b(2).to_vec()),
                    (0, "Net/EnableAnimations", u32b(0).to_vec()),
                ],
            );
            assert_eq!(xsettings_int(&data, "Net/EnableAnimations"), Some(0));
            assert_eq!(xsettings_int(&data, "Gdk/WindowScalingFactor"), Some(2));
            assert_eq!(xsettings_int(&data, "Net/Missing"), None);
            assert_eq!(xsettings_int(&data[..data.len() - 2], "Net/EnableAnimations"), None);
        }
    }

    #[test]
    fn kde_instant_animations_reduce_motion() {
        let text = "[General]\nAnimationDurationFactor=1\n[KDE]\nLookAndFeelPackage=x\nAnimationDurationFactor=0\n";
        assert_eq!(kde_reduces_motion(text), Some(true));
        assert_eq!(kde_reduces_motion("[KDE]\nAnimationDurationFactor=0.5"), Some(false));
        assert_eq!(kde_reduces_motion("[General]\nAnimationDurationFactor=0"), None);
    }
}
