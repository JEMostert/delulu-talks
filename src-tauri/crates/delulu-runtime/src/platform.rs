//! Platform policy (`platform.ts`). Platform and architecture names use the
//! Node spellings (`linux`/`darwin`/`win32`, `x64`/`arm64`) because they are
//! recorded in inventories and shown in diagnostics.

use serde::{Deserialize, Serialize};

use crate::types::{SpeechModelId, SpeechTier, VoiceEngineId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetPlatform {
    pub platform: String,
    pub arch: String,
}

impl TargetPlatform {
    pub fn new(platform: &str, arch: &str) -> Self {
        Self { platform: platform.into(), arch: arch.into() }
    }

    /// The running platform, as Node's `process.platform`/`process.arch`.
    pub fn current() -> Self {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "ia32",
            other => other,
        };
        Self::new(platform, arch)
    }

    pub fn is_windows(&self) -> bool {
        self.platform == "win32"
    }
}

pub fn speech_model_for_platform(target: &TargetPlatform) -> SpeechModelId {
    if target.platform == "darwin" && target.arch == "arm64" {
        SpeechModelId::R2t2Mlx
    } else {
        SpeechModelId::R2t2
    }
}

pub fn uses_metal() -> bool {
    speech_model_for_platform(&TargetPlatform::current()) == SpeechModelId::R2t2Mlx
}

/// R2T2 (Large) needs CUDA on x64 Linux/Windows or MLX on Apple Silicon.
pub fn large_speech_supported(target: &TargetPlatform) -> bool {
    if target.platform == "darwin" {
        target.arch == "arm64"
    } else {
        target.arch == "x64"
    }
}

/// Small and Medium need only the CPU runtime; Large adds PyTorch or MLX.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechRuntimeProfile {
    Cpu,
    Full,
}

impl SpeechRuntimeProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Full => "full",
        }
    }
}

pub fn speech_runtime_profile(tier: SpeechTier) -> SpeechRuntimeProfile {
    if tier == SpeechTier::Large {
        SpeechRuntimeProfile::Full
    } else {
        SpeechRuntimeProfile::Cpu
    }
}

/// Kokoro needs only the CPU voice runtime; Chatterbox Turbo adds PyTorch.
pub fn voice_runtime_profile(engine: VoiceEngineId) -> SpeechRuntimeProfile {
    if engine == VoiceEngineId::ChatterboxTurbo {
        SpeechRuntimeProfile::Full
    } else {
        SpeechRuntimeProfile::Cpu
    }
}
