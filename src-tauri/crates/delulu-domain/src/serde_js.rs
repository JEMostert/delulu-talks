//! Serde helpers that keep the JSON identical to what TypeScript produced.
//!
//! - `f64` fields serialize integral values without a fraction (`5`, not
//!   `5.0`), like `JSON.stringify`.
//! - [`double_option`] keeps the difference between an absent key and `null`
//!   for TypeScript fields typed `x?: T | null`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Serializes a JavaScript number.
pub fn f64<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE {
        if *value == 0.0 {
            // JSON.stringify(-0) is "0".
            serializer.serialize_i64(0)
        } else {
            serializer.serialize_i64(*value as i64)
        }
    } else if value.is_finite() {
        serializer.serialize_f64(*value)
    } else {
        // JSON.stringify(NaN) is "null".
        serializer.serialize_none()
    }
}

/// A JavaScript number as a JSON value: integral values become JSON
/// integers, non-finite values `null`, like `JSON.stringify`.
pub fn number(value: f64) -> serde_json::Value {
    serde_json::to_value(JsNumber(value)).unwrap_or(serde_json::Value::Null)
}

struct JsNumber(f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        f64(&self.0, serializer)
    }
}

/// Serializes an optional JavaScript number (`None` as `null` unless skipped).
pub fn opt_f64<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(number) => f64(number, serializer),
        None => serializer.serialize_none(),
    }
}

/// Serializes `Option<Option<f64>>` (use with [`double_option::deserialize`]).
pub fn opt_opt_f64<S: Serializer>(value: &Option<Option<f64>>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(Some(number)) => f64(number, serializer),
        _ => serializer.serialize_none(),
    }
}

/// `Option<Option<T>>`: `None` = key absent, `Some(None)` = `null`,
/// `Some(Some(v))` = value. Use with
/// `#[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]`.
pub mod double_option {
    use super::*;

    pub fn serialize<T: Serialize, S: Serializer>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(Some(inner)) => inner.serialize(serializer),
            _ => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Probe {
        #[serde(serialize_with = "f64")]
        a: f64,
        #[serde(default, skip_serializing_if = "Option::is_none", with = "double_option")]
        b: Option<Option<String>>,
    }

    #[test]
    fn numbers_and_nullable_fields_round_trip_like_json_stringify() {
        let json = serde_json::to_string(&Probe { a: 5.0, b: Some(None) }).unwrap();
        assert_eq!(json, r#"{"a":5,"b":null}"#);
        assert_eq!(serde_json::to_string(&Probe { a: 0.25, b: None }).unwrap(), r#"{"a":0.25}"#);
        let absent: Probe = serde_json::from_str(r#"{"a":1}"#).unwrap();
        assert_eq!(absent.b, None);
        let null: Probe = serde_json::from_str(r#"{"a":1,"b":null}"#).unwrap();
        assert_eq!(null.b, Some(None));
    }
}
