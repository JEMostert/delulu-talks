//! Versions of persisted records (`src/persistedSchema.ts`).
//!
//! Data format versions are independent of workflow/opt-in behavior versions.

use delulu_core::DomainError;
use serde_json::Value;

use crate::js;

pub const PERSISTED_SCHEMA_VERSION: u8 = 1;

string_enum! {
    pub enum PersistedSchemaKind { Settings = "settings", Transcript = "transcript", Rule = "rule" }
}

/// Rejects anything that is not an object of a supported version, before a
/// migration could replace existing data.
pub fn assert_persisted_schema(value: &Value, kind: PersistedSchemaKind) -> Result<(), DomainError> {
    let Some(object) = value.as_object() else {
        return Err(DomainError::failed(format!("Invalid {kind} data: expected an object. Existing data is preserved.")));
    };
    match object.get("schemaVersion") {
        None => Ok(()),
        Some(version) if version.as_f64() == Some(f64::from(PERSISTED_SCHEMA_VERSION)) => Ok(()),
        Some(version) => Err(DomainError::failed(format!(
            "Unsupported {kind} schemaVersion {}. Existing data is preserved; use a compatible app version.",
            js::value_to_string(version)
        ))),
    }
}

/// Additive migration: preserve unknown metadata and literal content unchanged.
pub fn version_persisted_record(value: &Value, kind: PersistedSchemaKind) -> Result<Value, DomainError> {
    assert_persisted_schema(value, kind)?;
    let mut versioned = value.clone();
    if let Some(object) = versioned.as_object_mut() {
        object.insert("schemaVersion".into(), Value::from(PERSISTED_SCHEMA_VERSION));
    }
    Ok(versioned)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReversibleSchemaMigration {
    pub kind: PersistedSchemaKind,
    pub before: Value,
    pub after: Value,
}

pub fn migrate_persisted_schema(value: &Value, kind: PersistedSchemaKind) -> Result<ReversibleSchemaMigration, DomainError> {
    Ok(ReversibleSchemaMigration { kind, before: value.clone(), after: version_persisted_record(value, kind)? })
}

/// Return the original snapshot, including whether the version field was absent.
pub fn reverse_persisted_schema(migration: &ReversibleSchemaMigration) -> Value {
    migration.before.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migration_and_reversal_preserve_literal_text_and_unknown_metadata() {
        let original = json!({
            "text": "\tExact\r\n  original\n",
            "replacement": "\r\nKeep spaces  ",
            "pluginMetadata": {"tags": ["private"]},
        });
        let mut migration = migrate_persisted_schema(&original, PersistedSchemaKind::Transcript).unwrap();
        let mut expected = original.clone();
        expected["schemaVersion"] = json!(1);
        assert_eq!(migration.after, expected);
        migration.after["pluginMetadata"]["tags"].as_array_mut().unwrap().push(json!("changed"));
        assert_eq!(reverse_persisted_schema(&migration), original);
        assert!(reverse_persisted_schema(&migration).get("schemaVersion").is_none());
    }

    #[test]
    fn rejects_unsupported_and_malformed_saved_data() {
        for kind in PersistedSchemaKind::ALL.iter().copied() {
            let future = json!({"schemaVersion": 2, "text": "Existing private text"});
            let error = migrate_persisted_schema(&future, kind).unwrap_err();
            assert!(error.message.contains("Existing data is preserved"));
            assert!(error.message.contains("schemaVersion 2."));
            for invalid in [json!(null), json!([]), json!("not a record"), json!({"schemaVersion": "1"})] {
                let error = assert_persisted_schema(&invalid, kind).unwrap_err();
                assert!(error.message.contains("Existing data is preserved"));
            }
        }
    }
}
