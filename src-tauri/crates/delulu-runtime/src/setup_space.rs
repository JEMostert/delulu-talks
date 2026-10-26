//! Disk space planning for setup (`setupSpace.ts`). Queries the target
//! filesystems only; never enumerates runtime, cache or history files.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::inventory::RuntimeKind;
use crate::platform::{speech_model_for_platform, TargetPlatform};
use crate::support::resolve_lexical;
use crate::types::{MagicModelId, SpeechModelId, SpeechTier};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapacityStatus {
    Observed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDiskCapacity {
    pub label: String,
    pub requested_path: String,
    pub queried_path: Option<String>,
    pub available_bytes: Option<u64>,
    pub filesystem: Option<String>,
    pub status: CapacityStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSpacePlan {
    pub kind: RuntimeKind,
    pub model_name: String,
    pub model_download_bytes: u64,
    pub model_installed_bytes: u64,
    pub model_temporary_bytes: u64,
    pub basis: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSpaceSnapshot {
    pub magic_model: MagicModelId,
    pub checked_at: u64,
    pub disk: Vec<SetupDiskCapacity>,
    pub plans: Vec<SetupSpacePlan>,
    pub runtime_download: String,
    pub runtime_installed: String,
    pub runtime_temporary: String,
    pub caveat: String,
}

/// The settings and locations a setup snapshot reads.
#[derive(Debug, Clone)]
pub struct SetupInputs {
    pub speech_venv: PathBuf,
    pub magic_venv: PathBuf,
    pub model_cache: PathBuf,
    pub python_command: String,
    pub speech_engine: SpeechTier,
    pub magic_model: MagicModelId,
    pub target: TargetPlatform,
}

impl SetupInputs {
    pub fn new(
        paths: &delulu_core::AppPaths,
        python_command: impl Into<String>,
        speech_engine: SpeechTier,
        magic_model: MagicModelId,
    ) -> Self {
        Self {
            speech_venv: paths.speech_venv(),
            magic_venv: paths.magic_venv(),
            model_cache: paths.models(),
            python_command: python_command.into(),
            speech_engine,
            magic_model,
            target: TargetPlatform::current(),
        }
    }
}

fn unknown(label: &str, requested: &str, queried: Option<String>, detail: &str) -> SetupDiskCapacity {
    SetupDiskCapacity {
        label: label.into(),
        requested_path: requested.into(),
        queried_path: queried,
        available_bytes: None,
        filesystem: None,
        status: CapacityStatus::Unknown,
        detail: detail.into(),
    }
}

fn filesystem_id(metadata: &std::fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(metadata.dev().to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn query_capacity(label: &str, requested: &Path) -> SetupDiskCapacity {
    let requested_text = requested.to_string_lossy().into_owned();
    let resolved = resolve_lexical(requested);
    let mut current = resolved.clone();
    let unreadable = "Could not read filesystem capacity. Check the destination and permissions; no directory was created.";
    for _ in 0..16 {
        let queried = Some(current.to_string_lossy().into_owned());
        match std::fs::metadata(&current) {
            Ok(metadata) if metadata.is_dir() => {
                return match fs4::available_space(&current) {
                    Ok(available) if available <= 9_007_199_254_740_991 => SetupDiskCapacity {
                        label: label.into(),
                        requested_path: requested_text,
                        queried_path: queried,
                        available_bytes: Some(available),
                        filesystem: filesystem_id(&metadata),
                        status: CapacityStatus::Observed,
                        detail: if current == resolved {
                            "Current filesystem capacity available to this process, not a reservation."
                        } else {
                            "Destination does not exist yet; capacity is from its nearest existing ancestor. Future mounts or path changes may differ."
                        }
                        .into(),
                    },
                    _ => unknown(label, &requested_text, queried, unreadable),
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => match current.parent() {
                Some(parent) => current = parent.to_path_buf(),
                None => break,
            },
            // A file or an unreadable ancestor.
            _ => return unknown(label, &requested_text, queried, unreadable),
        }
    }
    unknown(label, &requested_text, None, "No accessible existing destination ancestor found within the bounded query.")
}

async fn capacity(label: &'static str, requested: PathBuf) -> SetupDiskCapacity {
    let text = requested.to_string_lossy().into_owned();
    let query = tokio::task::spawn_blocking(move || query_capacity(label, &requested));
    match tokio::time::timeout(Duration::from_millis(2500), query).await {
        Ok(Ok(capacity)) => capacity,
        _ => unknown(
            label,
            &text,
            None,
            "Filesystem query timed out. Refresh after checking the destination; capacity was not assumed.",
        ),
    }
}

fn pip_cache_directory(target: &TargetPlatform) -> PathBuf {
    let env = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from);
    if let Some(directory) = env("PIP_CACHE_DIR") {
        return directory;
    }
    let home = dirs::home_dir().unwrap_or_default();
    match target.platform.as_str() {
        "win32" => env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("pip").join("Cache"),
        "darwin" => home.join("Library").join("Caches").join("pip"),
        _ => env("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("pip"),
    }
}

fn magic_model_info(id: MagicModelId) -> (&'static str, &'static str, u64) {
    match id {
        MagicModelId::Qwen35Small => ("Qwen 3.5 · 0.8B", "0.8B", 800_000_000),
        MagicModelId::Qwen35Medium => ("Qwen 3.5 · 2B", "2B", 2_000_000_000),
        MagicModelId::Phi4Mini => ("Phi-4 mini · 3.8B", "3.8B", 3_800_000_000),
        MagicModelId::Qwen35Large => ("Qwen 3.5 · 4B", "4B", 4_000_000_000),
    }
}

pub async fn setup_space_snapshot(inputs: &SetupInputs) -> SetupSpaceSnapshot {
    let speech_id = speech_model_for_platform(&inputs.target);
    let tier = inputs.speech_engine;
    // Speech estimates are the existing model catalogue, not remote manifests.
    let (speech_name, download_size, speech_bytes) = match tier {
        SpeechTier::Small => ("Canary 180M Flash", "200 MB", 200_000_000u64),
        SpeechTier::Medium => ("Parakeet TDT 0.6B", "630 MB", 640_000_000),
        SpeechTier::Large if speech_id == SpeechModelId::R2t2Mlx => ("R2T2", "~4.1 GB", 4_100_000_000),
        SpeechTier::Large => ("R2T2", "~4 GB", 4_000_000_000),
    };
    // Marketing parameter count × two-byte BF16 weights is a planning estimate,
    // not a measured checkpoint size or a claim about RAM consumption.
    let (magic_name, parameters, parameter_count) = magic_model_info(inputs.magic_model);
    let magic_bytes = parameter_count * 2;
    let converted_bytes = if tier == SpeechTier::Large && inputs.target.is_windows() { speech_bytes } else { 0 };
    let disk = tokio::join!(
        capacity("Speech runtime generations", inputs.speech_venv.clone()),
        capacity("Rewrite runtime generations", inputs.magic_venv.clone()),
        capacity("Model cache", inputs.model_cache.clone()),
        capacity("System temporary files", std::env::temp_dir()),
        capacity("Expected pip download cache", pip_cache_directory(&inputs.target)),
    );
    SetupSpaceSnapshot {
        magic_model: inputs.magic_model,
        checked_at: delulu_core::now_ms(),
        disk: vec![disk.0, disk.1, disk.2, disk.3, disk.4],
        plans: vec![
            SetupSpacePlan {
                kind: RuntimeKind::Speech,
                model_name: speech_name.into(),
                model_download_bytes: speech_bytes,
                model_installed_bytes: speech_bytes + converted_bytes,
                model_temporary_bytes: speech_bytes,
                basis: format!(
                    "Approximate checkpoint download from the app catalogue ({download_size}). Installed estimate retains that checkpoint{}. Staging allowance is one additional checkpoint. Ancillary files and other cached revisions are excluded.",
                    if converted_bytes > 0 { " plus one similarly sized Windows converted copy" } else { "" }
                ),
            },
            SetupSpacePlan {
                kind: RuntimeKind::Magic,
                model_name: magic_name.into(),
                model_download_bytes: magic_bytes,
                model_installed_bytes: magic_bytes,
                model_temporary_bytes: magic_bytes,
                basis: format!(
                    "Weights-only planning estimate: {parameters} parameters × 2 bytes (BF16). Complete repository size is unknown; tokenizer, vision/config overhead, other dtypes and additional revisions can increase it. Staging allowance is one additional weights copy. This is a disk estimate, not the RAM estimate shown for this model."
                ),
            },
        ],
        runtime_download: "Unknown until platform wheels and transitive dependencies are resolved; no package downloads or resolution were started.".into(),
        runtime_installed: "Unknown. A full new isolated runtime generation is installed; manifest version pins contain no resolved disk-size metadata.".into(),
        runtime_temporary: "Unknown. Repair retains the previous runtime and creates one full additional generation. Wheel cache, unpacking and build scratch space need additional capacity in their respective destinations.".into(),
        caveat: "Estimates use decimal GB, assume no reusable cached checkpoint, and do not subtract existing caches. Previous generations, other models, old revisions, package caches and concurrent disk use remain on disk. No complete setup/repair total or sufficient-space guarantee is available.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_destinations_use_their_nearest_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("a/b/c");
        let observed = capacity("x", missing.clone()).await;
        assert_eq!(observed.status, CapacityStatus::Observed);
        assert_eq!(observed.queried_path.as_deref(), Some(&*dir.path().to_string_lossy()));
        assert!(observed.detail.starts_with("Destination does not exist yet"));
        std::fs::write(dir.path().join("file"), "").unwrap();
        let file = capacity("x", dir.path().join("file")).await;
        assert_eq!(file.status, CapacityStatus::Unknown);
    }
}
