//! History retention preview helpers (`historyRetention.ts`).

use delulu_core::DomainError;
use delulu_domain::{
    HistoryRetentionEffects, HistoryRetentionPolicy, RetentionAffected, RetentionReason, TranscriptRecord,
    TranscriptSource,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{json as js, plain_error};

fn limit(source: &serde_json::Map<String, Value>, key: &str, minimum: f64, maximum: f64) -> Result<Option<f64>, DomainError> {
    match source.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let value = number.as_f64().unwrap_or(f64::NAN);
            if value.fract() == 0.0 && value >= minimum && value <= maximum {
                Ok(Some(value))
            } else {
                Err(limit_error(key, minimum, maximum))
            }
        }
        _ => Err(limit_error(key, minimum, maximum)),
    }
}

fn limit_error(key: &str, minimum: f64, maximum: f64) -> DomainError {
    plain_error(format!(
        "{} must be a whole number from {} to {}, or unlimited.",
        if key == "maxAgeDays" { "Age" } else { "Count" },
        js::format_number(minimum),
        js::format_number(maximum)
    ))
}

pub fn validate_retention_policy(value: &Value) -> Result<HistoryRetentionPolicy, DomainError> {
    let Some(source) = value.as_object() else {
        return Err(plain_error("Choose a retention age and/or count before previewing."));
    };
    Ok(HistoryRetentionPolicy {
        max_age_days: limit(source, "maxAgeDays", 1.0, 36_500.0)?,
        max_count: limit(source, "maxCount", 0.0, 500.0)?,
    })
}

/// The saved policy as JSON; invalid policies become unlimited. Valid saved
/// numbers keep their exact JSON representation.
pub fn saved_retention_policy(value: Option<&Value>) -> Value {
    let null = Value::Null;
    match validate_retention_policy(value.unwrap_or(&null)) {
        Ok(_) => {
            let source = value.and_then(Value::as_object).expect("validated object");
            json!({"maxAgeDays": source["maxAgeDays"], "maxCount": source["maxCount"]})
        }
        Err(_) => json!({"maxAgeDays": null, "maxCount": null}),
    }
}

/// SHA-256 of `JSON.stringify(value)`.
pub fn history_fingerprint_value(value: &Value) -> String {
    hex::encode(Sha256::digest(js::stringify(value).as_bytes()))
}

pub fn history_fingerprint<T: Serialize + ?Sized>(value: &T) -> String {
    history_fingerprint_value(&serde_json::to_value(value).unwrap_or(Value::Null))
}

pub fn affected_by_retention(
    records: &[TranscriptRecord],
    policy: &HistoryRetentionPolicy,
    previewed_at: f64,
) -> Vec<RetentionAffected> {
    let mut newest: Vec<(usize, &TranscriptRecord)> = records.iter().enumerate().collect();
    newest.sort_by(|(ai, a), (bi, b)| b.created_at.total_cmp(&a.created_at).then(ai.cmp(bi)));
    let cutoff = policy.max_age_days.map(|days| previewed_at - days * 86_400_000.0);
    newest
        .into_iter()
        .enumerate()
        .filter_map(|(index, (_, record))| {
            let age = cutoff.is_some_and(|cutoff| record.created_at < cutoff);
            let count = policy.max_count.is_some_and(|max| index as f64 >= max);
            let reason = match (age, count) {
                (true, true) => RetentionReason::AgeAndCount,
                (true, false) => RetentionReason::Age,
                (false, true) => RetentionReason::Count,
                (false, false) => return None,
            };
            Some(RetentionAffected { record: record.clone(), reason })
        })
        .collect()
}

/// Describe all text variants removed, independently of the displayed variant.
pub fn retention_effects<'a>(records: impl IntoIterator<Item = &'a TranscriptRecord>) -> HistoryRetentionEffects {
    let mut effects = HistoryRetentionEffects::default();
    for record in records {
        effects.originals += 1;
        effects.personalized += u64::from(matches!(record.personalized_text, Some(Some(_))));
        effects.corrections += u64::from(matches!(record.edited_text, Some(Some(_))));
        effects.rewrites += u64::from(matches!(record.magic_text, Some(Some(_))));
        effects.imported_references += u64::from(record.source == TranscriptSource::File);
    }
    effects
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, created_at: f64) -> TranscriptRecord {
        TranscriptRecord { id: id.into(), created_at, text: "t".into(), language: "en".into(), ..Default::default() }
    }

    #[test]
    fn retention_marks_old_and_excess_records_newest_first() {
        let day = 86_400_000.0;
        let now = 100.0 * day;
        let records = [record("old", now - 40.0 * day), record("new", now - day), record("mid", now - 5.0 * day)];
        let policy = validate_retention_policy(&json!({"maxAgeDays": 30, "maxCount": 1})).unwrap();
        let affected = affected_by_retention(&records, &policy, now);
        let ids: Vec<_> = affected.iter().map(|a| (a.record.id.as_str(), a.reason)).collect();
        assert_eq!(ids, [("mid", RetentionReason::Count), ("old", RetentionReason::AgeAndCount)]);
        assert_eq!(retention_effects(affected.iter().map(|a| &a.record)).originals, 2);
        assert!(validate_retention_policy(&json!({"maxAgeDays": 0, "maxCount": null})).is_err());
        assert!(validate_retention_policy(&json!({"maxAgeDays": null})).is_err());
        assert_eq!(saved_retention_policy(Some(&json!({"maxCount": 3}))), json!({"maxAgeDays": null, "maxCount": null}));
        assert_eq!(
            saved_retention_policy(Some(&json!({"maxAgeDays": 7, "maxCount": null}))),
            json!({"maxAgeDays": 7, "maxCount": null})
        );
    }
}
