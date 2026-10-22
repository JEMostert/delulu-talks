//! Runtime diagnostics (`diagnostics.ts`): Python, FFmpeg and package
//! versions plus memory. Permission states are owned by the desktop crate and
//! passed in as opaque JSON values.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::location::runtime_python;
use crate::platform::TargetPlatform;
use crate::support::capture;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub platform: String,
    pub arch: String,
    #[serde(rename = "memoryGB")]
    pub memory_gb: u64,
    #[serde(rename = "freeMemoryGB")]
    pub free_memory_gb: u64,
    pub python: String,
    pub ffmpeg: String,
    pub data_directory: String,
    pub runtime_installed: bool,
    pub packages: Map<String, Value>,
    /// `MicrophonePermission` from the desktop crate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<Value>,
    /// `AccessibilityPermission` from the desktop crate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessibility: Option<Value>,
    pub checked_at: u64,
}

#[derive(Debug, Clone)]
pub struct DiagnosticsInputs {
    pub speech_venv: PathBuf,
    pub data_directory: PathBuf,
    pub microphone: Option<Value>,
    pub accessibility: Option<Value>,
}

async fn probe(program: &str, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    match capture(program, &args, Duration::from_secs(10), 256 * 1024).await {
        Ok(stdout) => stdout.trim().to_owned(),
        Err(_) => "Not available".into(),
    }
}

const PACKAGES_PROBE: &str = "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))";

pub async fn runtime_diagnostics(inputs: DiagnosticsInputs) -> RuntimeDiagnostics {
    let python_path = runtime_python(&inputs.speech_venv);
    let installed = python_path.as_ref().is_ok_and(|path| path.exists());
    let python_text = python_path.as_ref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    let fallback = if cfg!(windows) { "python" } else { "python3" };
    let python = async {
        match &python_path {
            Err(_) => "Invalid runtime activation record. Run Repair to rebuild safely.".to_owned(),
            Ok(_) => probe(if installed { &python_text } else { fallback }, &["--version"]).await,
        }
    };
    let metadata = async {
        if installed {
            probe(&python_text, &["-c", PACKAGES_PROBE]).await
        } else {
            "{}".to_owned()
        }
    };
    let (python, ffmpeg, metadata) = tokio::join!(python, probe("ffmpeg", &["-version"]), metadata);
    // A failed interpreter remains visible in diagnostics.
    let packages = serde_json::from_str::<Value>(&metadata)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let (total, free) = tokio::task::spawn_blocking(|| {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        (system.total_memory(), system.available_memory())
    })
    .await
    .unwrap_or((0, 0));
    let gib = |bytes: u64| (bytes as f64 / 1024f64.powi(3)).round() as u64;
    let target = TargetPlatform::current();
    RuntimeDiagnostics {
        platform: target.platform,
        arch: target.arch,
        memory_gb: gib(total),
        free_memory_gb: gib(free),
        python,
        ffmpeg: ffmpeg.split('\n').next().unwrap_or_default().to_owned(),
        data_directory: inputs.data_directory.to_string_lossy().into_owned(),
        runtime_installed: installed,
        packages,
        microphone: inputs.microphone,
        accessibility: inputs.accessibility,
        checked_at: delulu_core::now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn diagnostics_report_a_missing_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let report = runtime_diagnostics(DiagnosticsInputs {
            speech_venv: dir.path().join("speech-venv"),
            data_directory: dir.path().to_path_buf(),
            microphone: None,
            accessibility: Some(serde_json::json!({ "state": "not-applicable" })),
        })
        .await;
        assert!(!report.runtime_installed && report.packages.is_empty() && report.memory_gb > 0);
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("memoryGB").is_some() && json.get("microphone").is_none());
        assert_eq!(json["accessibility"]["state"], "not-applicable");
    }
}
