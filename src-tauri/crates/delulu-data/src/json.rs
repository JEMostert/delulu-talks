//! JavaScript JSON semantics for persisted data.
//!
//! The Electron app wrote profile files with `JSON.stringify(value, null, 2)`
//! and decided whether to rewrite them by comparing `JSON.stringify` output.
//! [`stringify`] reproduces that output exactly (key order from the map,
//! JavaScript number formatting, the same string escapes), so comparisons and
//! rewritten bytes match the TypeScript implementation.

use serde_json::{Map, Number, Value};

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(2), 0);
    out
}

/// `` `${JSON.stringify(value, null, 2)}\n` ``, the profile file format.
pub fn profile_bytes(value: &Value) -> String {
    let mut out = stringify_pretty(value);
    out.push('\n');
    out
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        out.push('\n');
        for _ in 0..width * depth {
            out.push(' ');
        }
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number_text(number: &Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    number.as_f64().map_or_else(|| number.to_string(), format_number)
}

/// `Number.prototype.toString()` for a finite value; `null` otherwise, like
/// `JSON.stringify`.
pub fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    // Shortest round-trip digits, then the ECMAScript layout rules.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exponent + 1;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// A JavaScript number as JSON: integral values become integers.
pub fn number(value: f64) -> Value {
    delulu_domain::serde_js::number(value)
}

/// `Number(value)` coercion.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => string_to_number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [single] if !single.is_array() && !single.is_object() => to_number(Some(single)),
            [single @ Value::Array(_)] => to_number(Some(single)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn string_to_number(text: &str) -> f64 {
    let text = delulu_domain::js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &[&str], radix: u32| {
        prefix
            .iter()
            .find_map(|p| text.strip_prefix(p))
            .map(|rest| u64::from_str_radix(rest, radix).map_or(f64::NAN, |v| v as f64))
    };
    if let Some(value) = radix(&["0x", "0X"], 16).or_else(|| radix(&["0o", "0O"], 8)).or_else(|| radix(&["0b", "0B"], 2)) {
        return value;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = text.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !valid || text.contains("inf") || text.contains("nan") {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// A finite JSON number, as `typeof value === "number"` sees it.
pub fn as_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

pub fn is_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// Sets a key with JavaScript assignment semantics: an existing key keeps
/// its position, a new key is appended. `None` behaves like assigning
/// `undefined`: the key keeps its slot but `JSON.stringify` omits it, which
/// here means removing it without disturbing the order of the others.
pub fn assign(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            if let Some(slot) = map.get_mut(key) {
                *slot = value;
            } else {
                map.insert(key.to_owned(), value);
            }
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// `delete object[key]`, preserving the order of the remaining keys.
pub fn delete(map: &mut Map<String, Value>, key: &str) {
    map.shift_remove(key);
}

/// Whether two values serialize identically with `JSON.stringify`.
pub fn same(a: &Value, b: &Value) -> bool {
    stringify(a) == stringify(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_format_like_javascript() {
        for (value, text) in [
            (5.0, "5"),
            (0.15, "0.15"),
            (-45.0, "-45"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012.5, "123456789012.5"),
            (1e20, "100000000000000000000"),
        ] {
            assert_eq!(format_number(value), text);
        }
    }

    #[test]
    fn pretty_output_matches_json_stringify() {
        let value = json!({"a": [1, {"b": "x\u{1}\n\"q\""}], "e": {}, "f": [], "g": 1.0});
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"x\\u0001\\n\\\"q\\\"\"\n    }\n  ],\n  \"e\": {},\n  \"f\": [],\n  \"g\": 1\n}"
        );
        assert_eq!(stringify(&value), r#"{"a":[1,{"b":"x\u0001\n\"q\""}],"e":{},"f":[],"g":1}"#);
    }

    #[test]
    fn number_coercion_follows_javascript() {
        assert_eq!(to_number(Some(&json!("50"))), 50.0);
        assert_eq!(to_number(Some(&json!(" 25 "))), 25.0);
        assert_eq!(to_number(Some(&json!(null))), 0.0);
        assert_eq!(to_number(Some(&json!([100]))), 100.0);
        assert!(to_number(Some(&json!("abc"))).is_nan());
        assert!(to_number(None).is_nan());
    }
}
