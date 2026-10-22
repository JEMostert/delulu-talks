//! Speech model identity and execution facts (`src/speechModels.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::Platform;

string_enum! {
    /// Model identity is independent of the execution adapter or stored selection key.
    /// Nemotron (removed in v0.13.0) and Parakeet Redux (removed in v0.16.0) stay only
    /// to read older history records.
    pub enum SpeechIdentity {
        R2t2 = "r2t2",
        Canary = "canary",
        Parakeet = "parakeet",
        Nemotron = "nemotron",
        Redux = "redux",
    }
}

string_enum! {
    /// Historical records may name vLLM; current runtimes never select it.
    pub enum SpeechBackendId {
        VllmCuda = "vllm-cuda",
        TransformersCuda = "transformers-cuda",
        TransformersCpu = "transformers-cpu",
        MlxAudio = "mlx-audio",
        OnnxCpu = "onnx-cpu",
        PhotonCpu = "photon-cpu",
    }
}

string_enum! {
    pub enum SpeechPrecision { Bf16 = "bf16", Fp16 = "fp16", Fp32 = "fp32", Int8 = "int8" }
}

string_enum! {
    pub enum SpeechDevice { Cuda = "cuda", Mlx = "mlx", Cpu = "cpu" }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCheckpoint {
    pub repository: String,
    pub revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechExecution {
    pub model_id: SpeechIdentity,
    pub backend_id: SpeechBackendId,
    pub precision: Option<SpeechPrecision>,
    pub checkpoint: SpeechCheckpoint,
    pub platform: Platform,
    pub device: SpeechDevice,
}

/// `SPEECH_IDENTITY`.
pub struct SpeechIdentityInfo {
    pub id: SpeechIdentity,
    pub name: &'static str,
    pub upstream_repository: &'static str,
}

pub const SPEECH_IDENTITY: SpeechIdentityInfo =
    SpeechIdentityInfo { id: SpeechIdentity::R2t2, name: "R2T2", upstream_repository: "netease-youdao/Confucius4-R2T2" };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechBackend {
    pub id: SpeechBackendId,
    pub label: &'static str,
    pub platforms: &'static [Platform],
    pub device: SpeechDevice,
    pub models: &'static [SpeechIdentity],
}

use Platform::{Darwin, Linux, Win32};

pub const SPEECH_BACKENDS: &[SpeechBackend] = &[
    SpeechBackend {
        id: SpeechBackendId::OnnxCpu,
        label: "sherpa-onnx · CPU · INT8",
        platforms: &[Linux, Darwin, Win32],
        device: SpeechDevice::Cpu,
        models: &[SpeechIdentity::Canary, SpeechIdentity::Parakeet],
    },
    SpeechBackend {
        id: SpeechBackendId::PhotonCpu,
        label: "Photon · CPU · packed ternary (previous releases)",
        platforms: &[Linux],
        device: SpeechDevice::Cpu,
        models: &[SpeechIdentity::Redux],
    },
    SpeechBackend {
        id: SpeechBackendId::VllmCuda,
        label: "vLLM · CUDA (previous releases)",
        platforms: &[Linux],
        device: SpeechDevice::Cuda,
        models: &[SpeechIdentity::R2t2],
    },
    SpeechBackend {
        id: SpeechBackendId::TransformersCuda,
        label: "Transformers · CUDA",
        platforms: &[Linux, Win32],
        device: SpeechDevice::Cuda,
        models: &[SpeechIdentity::R2t2, SpeechIdentity::Nemotron],
    },
    SpeechBackend {
        id: SpeechBackendId::TransformersCpu,
        label: "Transformers · CPU (previous releases)",
        platforms: &[Linux, Win32],
        device: SpeechDevice::Cpu,
        models: &[SpeechIdentity::Nemotron],
    },
    SpeechBackend {
        id: SpeechBackendId::MlxAudio,
        label: "MLX Audio · Metal",
        platforms: &[Darwin],
        device: SpeechDevice::Mlx,
        models: &[SpeechIdentity::R2t2],
    },
];

/// Checkpoint repositories each identity has been loaded from.
pub fn speech_repositories(identity: SpeechIdentity) -> &'static [&'static str] {
    match identity {
        SpeechIdentity::R2t2 => &["netease-youdao/Confucius4-R2T2", "mlx-community/Confucius4-R2T2-bf16"],
        SpeechIdentity::Canary => &["csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8"],
        SpeechIdentity::Parakeet => &[
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
            "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        ],
        SpeechIdentity::Nemotron => &["nvidia/nemotron-3.5-asr-streaming-0.6b"],
        SpeechIdentity::Redux => &["moondream/parakeet-redux"],
    }
}

pub fn speech_backend_by_id(id: SpeechBackendId) -> &'static SpeechBackend {
    SPEECH_BACKENDS.iter().find(|backend| backend.id == id).expect("every backend id is listed")
}

/// Accept reported historical facts, without upgrading them to today's pins.
pub fn normalize_speech_execution(value: &Value) -> Option<SpeechExecution> {
    let source = value.as_object()?;
    let text = |key: &str| source.get(key).and_then(Value::as_str);
    let backend = SPEECH_BACKENDS.iter().find(|backend| Some(backend.id.as_str()) == text("backendId"))?;
    let model_id = text("modelId").and_then(SpeechIdentity::parse).filter(|id| backend.models.contains(id))?;
    let platform = text("platform").and_then(Platform::parse).filter(|p| backend.platforms.contains(p))?;
    if text("device") != Some(backend.device.as_str()) {
        return None;
    }
    let precision = match source.get("precision") {
        Some(Value::Null) => None,
        Some(Value::String(precision)) => Some(SpeechPrecision::parse(precision)?),
        _ => return None,
    };
    let checkpoint = source.get("checkpoint")?.as_object()?;
    let repository = checkpoint.get("repository").and_then(Value::as_str)?;
    if !speech_repositories(model_id).contains(&repository) {
        return None;
    }
    let revision = match checkpoint.get("revision") {
        Some(Value::Null) => None,
        Some(Value::String(revision)) if revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(revision.clone())
        }
        _ => return None,
    };
    Some(SpeechExecution {
        model_id,
        backend_id: backend.id,
        precision,
        checkpoint: SpeechCheckpoint { repository: repository.to_owned(), revision },
        platform,
        device: backend.device,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn historical_execution_is_kept_only_when_consistent() {
        let value = json!({
            "modelId": "r2t2", "backendId": "vllm-cuda", "precision": "bf16",
            "checkpoint": {"repository": "netease-youdao/Confucius4-R2T2", "revision": null},
            "platform": "linux", "device": "cuda"
        });
        let execution = normalize_speech_execution(&value).unwrap();
        assert_eq!(serde_json::to_value(&execution).unwrap(), value);
        let mut wrong_device = value.clone();
        wrong_device["device"] = json!("cpu");
        assert!(normalize_speech_execution(&wrong_device).is_none());
        let mut missing_precision = value.clone();
        missing_precision.as_object_mut().unwrap().remove("precision");
        assert!(normalize_speech_execution(&missing_precision).is_none());
        let mut short_revision = value;
        short_revision["checkpoint"]["revision"] = json!("abc");
        assert!(normalize_speech_execution(&short_revision).is_none());
    }
}
