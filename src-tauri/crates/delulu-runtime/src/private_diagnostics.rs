//! Untrusted backend text is classified, never copied into diagnostic output
//! (`electron/runtime/privateDiagnostics.ts`). These categories are
//! deliberately lossy; unknown text remains undisclosed.

use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};
use serde::Serialize;

use crate::support::iso_timestamp;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendFailure {
    pub category: &'static str,
    pub message: &'static str,
}

const RULES: &[(&str, &str, &str)] = &[
    (
        r"out of memory|OutOfMemoryError|memory allocation|resource exhausted",
        "memory",
        "The model ran out of memory. Unload the other model or use a smaller rewriting model.",
    ),
    (
        r"ModuleNotFoundError|ImportError|No module named|missing dependency|dependency unavailable",
        "dependency",
        "A required model dependency is unavailable. Repair this runtime.",
    ),
    (
        r"permission denied|PermissionError|EACCES|access denied",
        "permission",
        "The runtime cannot access a required local resource. Check permissions and retry.",
    ),
    (
        r"FileNotFoundError|ENOENT|file no longer exists|required file|missing file",
        "missing-file",
        "A required file is unavailable. Re-select the audio file or repair the runtime.",
    ),
    (
        r"CUDA|cuDNN|cuBLAS|NVIDIA|GPU driver|Metal.*unavailable",
        "accelerator",
        "The model accelerator failed. Check the GPU driver and runtime setup, then reload the model.",
    ),
    (r"not loaded|no model.*loaded|load .*model first", "not-loaded", "No model is loaded. Load the model and retry."),
    (r"cancelled|canceled", "cancelled", "The model operation was cancelled. Retry when ready."),
    (
        r"connection|network|download|HTTPError|offline",
        "download",
        "The model download or connection failed. Check connectivity and retry setup.",
    ),
    (r"timed out|timeout", "timeout", "The model operation timed out. Reload the model and retry."),
    (
        r"protocol|JSON|serialization|serialized|UTF-8 bytes|byte limit",
        "protocol",
        "The model worker protocol failed. Restart the app or repair the runtime.",
    ),
    (
        r"ValueError|TypeError|invalid.*input|input.*invalid|empty.*rewrite|empty.*text",
        "input",
        "The model rejected its input. Check the audio or text selection and retry.",
    ),
];

fn rules() -> &'static [(Regex, &'static str, &'static str)] {
    static COMPILED: OnceLock<Vec<(Regex, &'static str, &'static str)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .map(|(pattern, category, message)| {
                // JavaScript `.` does not match line terminators either.
                let regex = RegexBuilder::new(pattern).case_insensitive(true).build().expect("valid pattern");
                (regex, *category, *message)
            })
            .collect()
    })
}

/// Classifies backend text (an error message or stderr tail).
pub fn backend_failure(text: &str) -> BackendFailure {
    for (regex, category, message) in rules() {
        if regex.is_match(text) {
            return BackendFailure { category, message };
        }
    }
    BackendFailure {
        category: "backend",
        message: "The model backend failed. Reload the model or repair its runtime. Backend details were omitted to protect text and local paths.",
    }
}

/// The private failure log written beside a runtime; it never includes
/// backend output. `runtime` is `"speech"` or `"magic"`.
pub fn private_failure_log(runtime: &str, error_message: &str, stderr: &str) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Log<'a> {
        schema_version: u8,
        occurred_at: String,
        runtime: &'a str,
        category: &'static str,
        message: &'static str,
        diagnostic_bytes: usize,
        backend_output_included: bool,
    }
    let failure = backend_failure(error_message);
    let log = Log {
        schema_version: 1,
        occurred_at: iso_timestamp(delulu_core::now_ms()),
        runtime,
        category: failure.category,
        message: failure.message,
        diagnostic_bytes: stderr.len(),
        backend_output_included: false,
    };
    format!("{}\n", serde_json::to_string_pretty(&log).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_is_lossy_and_ordered() {
        assert_eq!(backend_failure("torch.cuda.OutOfMemoryError: CUDA out of memory").category, "memory");
        assert_eq!(backend_failure("No module named 'torch'").category, "dependency");
        assert_eq!(backend_failure("transcript text /home/me/secret").category, "backend");
        let log = private_failure_log("speech", "CUDA error", "secret stderr");
        assert!(log.contains("\"category\": \"accelerator\"") && !log.contains("secret"));
    }
}
