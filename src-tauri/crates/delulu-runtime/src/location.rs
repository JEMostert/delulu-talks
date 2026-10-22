//! Active runtime generation pointer (`location.ts`). Venvs are never moved:
//! their scripts embed absolute paths, so only `active.json` switches.

use std::path::{Path, PathBuf};

use delulu_core::{DomainError, DomainResult};
use serde_json::{json, Value};

const INVALID_RECORD: &str = "Invalid runtime activation record. Run Repair to rebuild safely.";

pub fn valid_generation(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
}

/// The active generation, or `root` itself for pre-generation installations.
pub fn runtime_directory(root: &Path) -> DomainResult<PathBuf> {
    let pointer = root.join("active.json");
    if !pointer.exists() {
        return Ok(root.to_path_buf());
    }
    let text = std::fs::read_to_string(&pointer)?;
    let record: Value = serde_json::from_str(&text).map_err(|_| DomainError::failed(INVALID_RECORD))?;
    match record.get("generation").and_then(Value::as_str) {
        Some(generation) if valid_generation(generation) => Ok(root.join("generations").join(generation)),
        _ => Err(DomainError::failed(INVALID_RECORD)),
    }
}

pub fn python_in(directory: &Path) -> PathBuf {
    directory.join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" })
}

pub fn runtime_python(root: &Path) -> DomainResult<PathBuf> {
    runtime_directory(root).map(|directory| python_in(&directory))
}

/// Switches only the pointer, atomically, recording the previous generation.
pub fn activate_runtime(root: &Path, generation: &str) -> DomainResult<()> {
    if !valid_generation(generation) {
        return Err(DomainError::failed("Invalid runtime generation; existing activation was preserved"));
    }
    let pointer = root.join("active.json");
    // Legacy or damaged pointers have no previous generation.
    let previous = std::fs::read_to_string(&pointer)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|record| record.get("generation").cloned())
        .unwrap_or(Value::Null);
    let record = json!({ "generation": generation, "previous": previous });
    delulu_core::util::write_private_atomic(&pointer, record.to_string().as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "12345678-1234-1234-1234-123456789abc";
    const CANDIDATE: &str = "87654321-4321-4321-4321-cba987654321";

    #[test]
    fn legacy_installations_stay_usable_and_activation_switches_generations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(runtime_directory(root).unwrap(), root);
        activate_runtime(root, OLD).unwrap();
        assert_eq!(runtime_directory(root).unwrap(), root.join("generations").join(OLD));
        activate_runtime(root, CANDIDATE).unwrap();
        assert_eq!(runtime_directory(root).unwrap(), root.join("generations").join(CANDIDATE));
        let record: Value = serde_json::from_str(&std::fs::read_to_string(root.join("active.json")).unwrap()).unwrap();
        assert_eq!(record["previous"], OLD);
    }

    #[test]
    fn malformed_activation_cannot_replace_the_working_pointer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        activate_runtime(root, OLD).unwrap();
        let pointer = root.join("active.json");
        let original = std::fs::read_to_string(&pointer).unwrap();
        let error = activate_runtime(root, "../outside").unwrap_err();
        assert!(error.message.contains("Invalid runtime generation"));
        assert_eq!(std::fs::read_to_string(&pointer).unwrap(), original);
        let names: Vec<_> = std::fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec!["active.json"]);
        std::fs::write(&pointer, r#"{"generation":"../../etc"}"#).unwrap();
        assert!(runtime_directory(root).unwrap_err().message.contains("Run Repair"));
    }
}
