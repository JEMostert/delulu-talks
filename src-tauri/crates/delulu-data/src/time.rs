//! `Date.prototype.toISOString` and a `Date.parse` for ISO timestamps.

/// Milliseconds since the epoch as `YYYY-MM-DDTHH:MM:SS.sssZ`; `None` outside
/// the JavaScript date range.
pub fn iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (h, m, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!("{year}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z"))
}

pub fn now_iso() -> String {
    iso_string(delulu_core::now_ms() as f64).unwrap_or_default()
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses the ECMAScript date-time string format
/// (`YYYY[-MM[-DD]][THH:mm[:ss[.sss]][Z|±HH:mm]]`), which is what the app
/// writes. Returns epoch milliseconds.
pub fn parse_iso(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut pos = 0;
    let digits = |pos: &mut usize, count: usize| -> Option<i64> {
        let slice = bytes.get(*pos..*pos + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *pos += count;
        std::str::from_utf8(slice).ok()?.parse().ok()
    };
    let year = match bytes.first()? {
        b'+' | b'-' => {
            let negative = bytes[0] == b'-';
            pos = 1;
            let y = digits(&mut pos, 6)?;
            if negative { -y } else { y }
        }
        _ => digits(&mut pos, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if bytes.get(pos) == Some(&b'-') {
        pos += 1;
        month = digits(&mut pos, 2)?;
        if bytes.get(pos) == Some(&b'-') {
            pos += 1;
            day = digits(&mut pos, 2)?;
        }
    }
    let (mut h, mut mi, mut s, mut ms, mut offset) = (0, 0, 0, 0, 0i64);
    if bytes.get(pos) == Some(&b'T') {
        pos += 1;
        h = digits(&mut pos, 2)?;
        if bytes.get(pos) != Some(&b':') {
            return None;
        }
        pos += 1;
        mi = digits(&mut pos, 2)?;
        if bytes.get(pos) == Some(&b':') {
            pos += 1;
            s = digits(&mut pos, 2)?;
            if bytes.get(pos) == Some(&b'.') {
                pos += 1;
                let start = pos;
                while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
                    pos += 1;
                }
                let fraction = text.get(start..pos)?;
                if fraction.is_empty() {
                    return None;
                }
                ms = format!("{:0<3}", &fraction[..fraction.len().min(3)]).parse().ok()?;
            }
        }
        match bytes.get(pos) {
            Some(b'Z') => pos += 1,
            Some(sign @ (b'+' | b'-')) => {
                let negative = *sign == b'-';
                pos += 1;
                let oh = digits(&mut pos, 2)?;
                if bytes.get(pos) != Some(&b':') {
                    return None;
                }
                pos += 1;
                let om = digits(&mut pos, 2)?;
                offset = (oh * 60 + om) * if negative { -1 } else { 1 };
            }
            _ => {}
        }
    }
    if pos != bytes.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) || h > 24 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32);
    let value = days * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms - offset * 60_000;
    (value.abs() as f64 <= 8.64e15).then_some(value as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip() {
        assert_eq!(iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_700_000_000_123.0).unwrap(), "2023-11-14T22:13:20.123Z");
        assert_eq!(parse_iso("2023-11-14T22:13:20.123Z"), Some(1_700_000_000_123.0));
        assert_eq!(parse_iso("2023-11-14"), Some(1_699_920_000_000.0));
        assert_eq!(parse_iso("2023-11-14T23:13:20.123+01:00"), Some(1_700_000_000_123.0));
        assert_eq!(parse_iso("yesterday"), None);
    }
}
