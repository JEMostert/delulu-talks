//! Interpreter and readiness probes (`prerequisites.ts`).

use delulu_core::util::utf16_len;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::inventory::RuntimeKind;
use crate::platform::{SpeechRuntimeProfile, TargetPlatform};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimePrerequisiteCode {
    PythonVersion,
    PythonArchitecture,
    CudaBuild,
    CudaUnavailable,
    MetalUnavailable,
    PackageImport,
}

impl RuntimePrerequisiteCode {
    pub const ALL: [Self; 6] = [
        Self::PythonVersion,
        Self::PythonArchitecture,
        Self::CudaBuild,
        Self::CudaUnavailable,
        Self::MetalUnavailable,
        Self::PackageImport,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PythonVersion => "PYTHON_VERSION",
            Self::PythonArchitecture => "PYTHON_ARCHITECTURE",
            Self::CudaBuild => "CUDA_BUILD",
            Self::CudaUnavailable => "CUDA_UNAVAILABLE",
            Self::MetalUnavailable => "METAL_UNAVAILABLE",
            Self::PackageImport => "PACKAGE_IMPORT",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }

    pub fn guidance(self) -> &'static str {
        match self {
            Self::PythonVersion => "Install a supported Python interpreter and set its full path in Settings → Advanced: native arm64 Python 3.12 for MLX, x64 Python 3.12 for Windows, or x64 Python 3.11–3.13 for Linux.",
            Self::PythonArchitecture => "Use native arm64 Python for MLX (no Rosetta), or 64-bit x64 Python for Windows/Linux. Set its full path in Settings → Advanced.",
            Self::CudaBuild => "Repair the runtime to install CUDA-enabled PyTorch. A CPU-only PyTorch build cannot run R2T2 speech.",
            Self::CudaUnavailable => "R2T2 requires an available NVIDIA CUDA GPU. Install or update the NVIDIA driver, make the GPU accessible to this app, then retry setup.",
            Self::MetalUnavailable => "R2T2 MLX requires Apple Silicon, native arm64 Python 3.12 and macOS 15 or later. Update macOS and select the native interpreter, then retry setup.",
            Self::PackageImport => "Repair the runtime to reinstall compatible packages. If setup still fails, check the package error below.",
        }
    }
}

/// `[CODE] guidance details`, with details bounded to their last 8000 chars.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("[{}] {} {details}", code.as_str(), code.guidance())]
pub struct RuntimePrerequisiteError {
    pub code: RuntimePrerequisiteCode,
    pub details: String,
}

/// The last `max` UTF-16 units of `text` (`text.slice(-max)`).
pub(crate) fn tail_utf16(text: &str, max: usize) -> &str {
    let mut units = utf16_len(text);
    for (index, ch) in text.char_indices() {
        if units <= max {
            return &text[index..];
        }
        units -= ch.len_utf16();
    }
    ""
}

impl RuntimePrerequisiteError {
    pub fn new(code: RuntimePrerequisiteCode, details: &str) -> Self {
        Self { code, details: tail_utf16(details, 8000).to_owned() }
    }

    /// Recovers the code from a message produced by this error (for example
    /// after it became an `OPERATION_FAILED` domain error).
    pub fn code_in_message(message: &str) -> Option<RuntimePrerequisiteCode> {
        let rest = message.strip_prefix('[')?;
        RuntimePrerequisiteCode::parse(&rest[..rest.find(']')?])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PythonInterpreterProbe {
    pub version: [i64; 3],
    pub machine: String,
    pub bits: i64,
}

pub const PYTHON_INTERPRETER_PROBE: &str = "import json,platform,struct,sys; print(json.dumps({'version':list(sys.version_info[:3]),'machine':platform.machine(),'bits':struct.calcsize('P')*8}))";

pub fn validate_python_interpreter(
    output: &str,
    target: &TargetPlatform,
    metal: bool,
) -> Result<PythonInterpreterProbe, RuntimePrerequisiteError> {
    let probe = serde_json::from_str::<PythonInterpreterProbe>(output).map_err(|_| {
        RuntimePrerequisiteError::new(
            RuntimePrerequisiteCode::PythonVersion,
            &format!("Python did not return valid interpreter metadata: {}", tail_utf16(output, 1000)),
        )
    })?;
    let [major, minor, patch] = probe.version;
    let found = format!(
        "Found Python {major}.{minor}.{patch}, {}, {}-bit for {}/{}.",
        probe.machine, probe.bits, target.platform, target.arch
    );
    let version_ok = major == 3 && if metal || target.is_windows() { minor == 12 } else { (11..=13).contains(&minor) };
    if !version_ok {
        return Err(RuntimePrerequisiteError::new(RuntimePrerequisiteCode::PythonVersion, &found));
    }
    let machine = probe.machine.to_lowercase();
    let native_arm = machine == "arm64" || machine == "aarch64";
    let native_x64 = matches!(machine.as_str(), "x86_64" | "amd64" | "x64");
    let architecture_wrong = if metal {
        target.platform != "darwin" || target.arch != "arm64" || !native_arm
    } else if target.is_windows() || target.platform == "linux" {
        target.arch != "x64" || !native_x64
    } else {
        target.arch == "arm64" && !native_arm
    };
    if probe.bits != 64 || architecture_wrong {
        return Err(RuntimePrerequisiteError::new(RuntimePrerequisiteCode::PythonArchitecture, &found));
    }
    Ok(probe)
}

const MARKER: &str = "@delulu-prerequisite:";

/// The last valid `@delulu-prerequisite:` marker in a probe's stderr.
pub fn parse_runtime_prerequisite_error(diagnostic: &str) -> Option<RuntimePrerequisiteError> {
    diagnostic.lines().rev().filter_map(|line| line.strip_prefix(MARKER)).find_map(|json| {
        let value: Value = serde_json::from_str(json).ok()?;
        let code = RuntimePrerequisiteCode::parse(value.get("code")?.as_str()?)?;
        Some(RuntimePrerequisiteError::new(code, value.get("details")?.as_str()?))
    })
}

/// Import and hardware availability checks only; never load or download models.
pub fn runtime_readiness_script(
    kind: RuntimeKind,
    target: &TargetPlatform,
    metal: bool,
    profile: SpeechRuntimeProfile,
) -> String {
    // The CPU speech runtime checks only its own imports, not a GPU. The voice
    // runtime never requires a GPU: Chatterbox falls back to the CPU, slowly.
    let cpu = kind != RuntimeKind::Magic && profile == SpeechRuntimeProfile::Cpu;
    let metal = metal && kind != RuntimeKind::Voice && !cpu;
    let version = if metal || target.is_windows() {
        "sys.version_info[:2] == (3, 12)"
    } else {
        "sys.version_info.major == 3 and 11 <= sys.version_info.minor <= 13"
    };
    let architecture = if metal {
        if target.platform == "darwin" && target.arch == "arm64" {
            "platform.machine().lower() in ('arm64', 'aarch64')"
        } else {
            "False"
        }
    } else if target.is_windows() || target.platform == "linux" {
        if target.arch == "x64" {
            "platform.machine().lower() in ('x86_64', 'amd64', 'x64')"
        } else {
            "False"
        }
    } else if target.arch == "arm64" {
        "platform.machine().lower() in ('arm64', 'aarch64')"
    } else {
        "True"
    };
    let imports = match kind {
        RuntimeKind::Voice if cpu => "import numpy, sherpa_onnx, soundfile, soxr, huggingface_hub",
        RuntimeKind::Voice => "import numpy, sherpa_onnx, soundfile, soxr, huggingface_hub, torch, torchaudio, librosa\n    from chatterbox.tts_turbo import ChatterboxTurboTTS",
        RuntimeKind::Magic => "import torch, torchvision, transformers\n    from transformers import AutoModelForMultimodalLM, AutoProcessor\n    if int(transformers.__version__.split('.')[0]) < 5:\n        fail('PACKAGE_IMPORT', 'Magic requires transformers 5 or later')",
        RuntimeKind::Speech if cpu => "import numpy, sherpa_onnx, soundfile, soxr, huggingface_hub",
        RuntimeKind::Speech if metal => "import mlx.core as mx\n    from mlx_audio.stt.utils import load_model, load_audio",
        RuntimeKind::Speech => "import torch, soundfile, soxr, librosa\n    from transformers import Qwen3ASRConfig, Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor, Qwen3ASRFeatureExtractor",
    };
    let hardware = if kind != RuntimeKind::Speech || cpu {
        ""
    } else if metal {
        "try:
    if not mx.metal.is_available():
        fail('METAL_UNAVAILABLE', 'mlx.core reports Metal unavailable')
except Exception as exc:
    fail('METAL_UNAVAILABLE', repr(exc))"
    } else {
        "if torch.version.cuda is None:
    fail('CUDA_BUILD', 'torch.version.cuda is None')
try:
    if not torch.cuda.is_available():
        fail('CUDA_UNAVAILABLE', 'torch.cuda.is_available() is false')
except Exception as exc:
    fail('CUDA_UNAVAILABLE', repr(exc))"
    };
    format!(
        "import json, platform, struct, sys
def fail(code, details):
    print('{MARKER}' + json.dumps({{'code': code, 'details': str(details)[-1000:]}}), file=sys.stderr, flush=True)
    raise SystemExit(1)
interpreter = 'Python ' + platform.python_version() + ', ' + platform.machine() + ', ' + str(struct.calcsize('P') * 8) + '-bit'
if not ({version}):
    fail('PYTHON_VERSION', 'Found ' + interpreter)
if struct.calcsize('P') * 8 != 64 or not ({architecture}):
    fail('PYTHON_ARCHITECTURE', 'Found ' + interpreter)
try:
    {imports}
except Exception as exc:
    fail('PACKAGE_IMPORT', repr(exc))
{hardware}
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_probe_enforces_version_and_architecture() {
        let linux = TargetPlatform::new("linux", "x64");
        validate_python_interpreter(r#"{"version":[3,13,1],"machine":"x86_64","bits":64}"#, &linux, false).unwrap();
        let old = validate_python_interpreter(r#"{"version":[3,10,1],"machine":"x86_64","bits":64}"#, &linux, false);
        assert_eq!(old.unwrap_err().code, RuntimePrerequisiteCode::PythonVersion);
        let arm = validate_python_interpreter(r#"{"version":[3,12,1],"machine":"aarch64","bits":64}"#, &linux, false);
        assert_eq!(arm.unwrap_err().code, RuntimePrerequisiteCode::PythonArchitecture);
        let windows = TargetPlatform::new("win32", "x64");
        assert!(validate_python_interpreter(r#"{"version":[3,13,1],"machine":"AMD64","bits":64}"#, &windows, false).is_err());
        let error = validate_python_interpreter("garbage", &linux, false).unwrap_err();
        assert!(error.to_string().starts_with("[PYTHON_VERSION] Install a supported Python"));
        assert_eq!(RuntimePrerequisiteError::code_in_message(&error.to_string()), Some(RuntimePrerequisiteCode::PythonVersion));
    }

    #[test]
    fn last_valid_marker_wins() {
        let stderr = "@delulu-prerequisite:{\"code\":\"CUDA_BUILD\",\"details\":\"a\"}\nnoise\n@delulu-prerequisite:{\"code\":\"BOGUS\",\"details\":\"b\"}\n";
        let error = parse_runtime_prerequisite_error(stderr).unwrap();
        assert_eq!((error.code, error.details.as_str()), (RuntimePrerequisiteCode::CudaBuild, "a"));
        assert!(parse_runtime_prerequisite_error("plain failure").is_none());
    }

    #[test]
    fn voice_profile_follows_engine_and_never_requires_a_gpu() {
        use crate::platform::voice_runtime_profile;
        use crate::types::VoiceEngineId;
        assert_eq!(voice_runtime_profile(VoiceEngineId::Kokoro), SpeechRuntimeProfile::Cpu);
        assert_eq!(voice_runtime_profile(VoiceEngineId::ChatterboxTurbo), SpeechRuntimeProfile::Full);
        let target = TargetPlatform::new("linux", "x64");
        let full = runtime_readiness_script(RuntimeKind::Voice, &target, true, SpeechRuntimeProfile::Full);
        assert!(full.contains("from chatterbox.tts_turbo import"));
        assert!(!full.contains("torch.cuda.is_available"));
        assert!(!full.contains("mlx"));
        assert!(!runtime_readiness_script(RuntimeKind::Voice, &target, false, SpeechRuntimeProfile::Cpu).contains("torch"));
        let speech = runtime_readiness_script(RuntimeKind::Speech, &target, false, SpeechRuntimeProfile::Full);
        assert!(speech.contains("torch.cuda.is_available"));
    }
}
