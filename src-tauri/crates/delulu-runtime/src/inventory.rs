//! Runtime dependency inventory (`inventory.ts`), written into a candidate
//! generation after its readiness probe and before activation.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::artifacts::RuntimeArtifact;
use crate::platform::{SpeechRuntimeProfile, TargetPlatform};
use crate::support::{iso_timestamp, resolve_lexical};

/// Enumerates distribution metadata, without importing installed packages.
pub const PYTHON_INVENTORY_PROBE: &str = r#"import importlib.metadata as metadata
import json
import platform
import struct
import sys

distributions = []
for distribution in metadata.distributions():
    name = distribution.metadata.get("Name")
    version = distribution.version
    if not name or not version:
        raise ValueError("Installed distribution has missing Name or Version metadata")
    distributions.append({"name": name, "version": version})
distributions.sort(key=lambda item: (item["name"].lower(), item["version"]))
print(json.dumps({
    "interpreter": {
        "executable": sys.executable,
        "version": platform.python_version(),
        "fullVersion": sys.version,
        "implementation": platform.python_implementation(),
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "platform": sys.platform,
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "pointerBits": struct.calcsize("P") * 8,
    },
    "distributions": distributions,
    "distributionCount": len(distributions),
}))
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Speech,
    Magic,
    Voice,
}

impl RuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Speech => "speech",
            Self::Magic => "magic",
            Self::Voice => "voice",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InventoryEngine {
    MlxAudio,
    Transformers,
    OnnxCpu,
    Pytorch,
}

impl InventoryEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MlxAudio => "mlx-audio",
            Self::Transformers => "transformers",
            Self::OnnxCpu => "onnx-cpu",
            Self::Pytorch => "pytorch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePreference {
    Metal,
    Cuda,
    Mps,
    Cpu,
}

impl DevicePreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Metal => "metal",
            Self::Cuda => "cuda",
            Self::Mps => "mps",
            Self::Cpu => "cpu",
        }
    }
}

/// Selection policy, not an observed GPU capability or inference result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryBackend {
    pub engine: InventoryEngine,
    pub device_preference: Vec<DevicePreference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallStageName {
    Installer,
    WindowsCuda,
    LinuxCuda,
    Runtime,
    VoiceTorch,
    VoiceUnpinned,
}

impl InstallStageName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installer => "installer",
            Self::WindowsCuda => "windows-cuda",
            Self::LinuxCuda => "linux-cuda",
            Self::Runtime => "runtime",
            Self::VoiceTorch => "voice-torch",
            Self::VoiceUnpinned => "voice-unpinned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallConstraint {
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedInstallStage {
    pub name: InstallStageName,
    pub requirements: Vec<String>,
    pub pip_arguments: Vec<String>,
    pub constraint: Option<InstallConstraint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<RuntimeArtifact>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolver_arguments: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_requirements: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryInterpreter {
    pub executable: String,
    pub version: String,
    pub full_version: String,
    pub implementation: String,
    pub prefix: String,
    pub base_prefix: String,
    pub platform: String,
    pub system: String,
    pub release: String,
    pub machine: String,
    pub pointer_bits: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Distribution {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventoryRuntime {
    pub revision: String,
    pub kind: RuntimeKind,
    pub generation: String,
    pub backend: InventoryBackend,
    pub target: TargetPlatform,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryObservation {
    pub interpreter: InventoryInterpreter,
    pub distributions: Vec<Distribution>,
    pub distribution_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInventory {
    pub schema_version: u8,
    pub created_at: String,
    pub runtime: InventoryRuntime,
    pub requested: Vec<RequestedInstallStage>,
    pub observed: InventoryObservation,
}

pub fn inventory_backend(kind: RuntimeKind, metal: bool, profile: SpeechRuntimeProfile) -> InventoryBackend {
    use DevicePreference::*;
    let (engine, device_preference) = match (kind, profile) {
        (RuntimeKind::Magic, _) => (InventoryEngine::Transformers, vec![Cuda, Mps, Cpu]),
        (RuntimeKind::Voice, SpeechRuntimeProfile::Cpu) => (InventoryEngine::OnnxCpu, vec![Cpu]),
        (RuntimeKind::Voice, SpeechRuntimeProfile::Full) => (InventoryEngine::Pytorch, vec![Cuda, Mps, Cpu]),
        (RuntimeKind::Speech, SpeechRuntimeProfile::Cpu) => (InventoryEngine::OnnxCpu, vec![Cpu]),
        (RuntimeKind::Speech, _) if metal => (InventoryEngine::MlxAudio, vec![Metal]),
        (RuntimeKind::Speech, _) => (InventoryEngine::Transformers, vec![Cuda]),
    };
    InventoryBackend { engine, device_preference }
}

pub struct InventoryContext<'a> {
    pub revision: &'a str,
    pub kind: RuntimeKind,
    pub generation: &'a str,
    pub backend: InventoryBackend,
    pub target: TargetPlatform,
    pub python: &'a Path,
    pub directory: &'a Path,
    pub requested: Vec<RequestedInstallStage>,
}

/// Rejects incomplete/invalid observations before the activation pointer changes.
pub fn create_runtime_inventory(context: InventoryContext<'_>, output: &str) -> Result<RuntimeInventory, String> {
    static VERSION: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    static SEPARATORS: OnceLock<Regex> = OnceLock::new();
    let inner = || -> Result<RuntimeInventory, String> {
        let observed: Value = serde_json::from_str(output).map_err(|error| error.to_string())?;
        let Some(interpreter) = observed.get("interpreter").and_then(Value::as_object) else {
            return Err("missing interpreter metadata".into());
        };
        for field in [
            "executable",
            "version",
            "fullVersion",
            "implementation",
            "prefix",
            "basePrefix",
            "platform",
            "system",
            "release",
            "machine",
        ] {
            if !interpreter.get(field).and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty()) {
                return Err(format!("missing interpreter {field}"));
            }
        }
        let text = |key: &str| interpreter.get(key).and_then(Value::as_str).unwrap_or_default();
        let version = VERSION.get_or_init(|| Regex::new(r"^\d+\.\d+\.\d+").unwrap());
        let bits = interpreter.get("pointerBits").and_then(Value::as_f64);
        if !version.is_match(text("version")) || !matches!(bits, Some(b) if b == 32.0 || b == 64.0) {
            return Err("invalid interpreter version or pointer size".into());
        }
        let directory = resolve_lexical(context.directory);
        if resolve_lexical(Path::new(text("executable"))) != resolve_lexical(context.python)
            || resolve_lexical(Path::new(text("prefix"))) != directory
            || resolve_lexical(Path::new(text("basePrefix"))) == directory
        {
            return Err("metadata did not come from the candidate virtualenv".into());
        }
        let listed = observed.get("distributions").and_then(Value::as_array);
        let Some(listed) = listed.filter(|items| {
            !items.is_empty() && observed.get("distributionCount").and_then(Value::as_f64) == Some(items.len() as f64)
        }) else {
            return Err("missing or incomplete installed distributions".into());
        };
        let name_pattern = NAME.get_or_init(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$").unwrap());
        let separators = SEPARATORS.get_or_init(|| Regex::new(r"[-_.]+").unwrap());
        let mut names = std::collections::HashSet::new();
        let mut distributions = Vec::with_capacity(listed.len());
        for item in listed {
            let name = item.get("name").and_then(Value::as_str);
            let version = item.get("version").and_then(Value::as_str);
            let (Some(name), Some(version)) = (name, version) else {
                return Err("invalid installed distribution metadata".into());
            };
            if !name_pattern.is_match(name) || version.trim().is_empty() || version.contains(['\r', '\n', '\0']) {
                return Err("invalid installed distribution metadata".into());
            }
            let normalized = separators.replace_all(&name.to_lowercase(), "-").into_owned();
            if !names.insert(normalized.clone()) {
                return Err(format!("duplicate installed distribution: {normalized}"));
            }
            distributions.push(Distribution { name: name.to_owned(), version: version.to_owned() });
        }
        let interpreter = InventoryInterpreter {
            executable: text("executable").into(),
            version: text("version").into(),
            full_version: text("fullVersion").into(),
            implementation: text("implementation").into(),
            prefix: text("prefix").into(),
            base_prefix: text("basePrefix").into(),
            platform: text("platform").into(),
            system: text("system").into(),
            release: text("release").into(),
            machine: text("machine").into(),
            pointer_bits: bits.unwrap_or(64.0) as u8,
        };
        Ok(RuntimeInventory {
            schema_version: 1,
            created_at: iso_timestamp(delulu_core::now_ms()),
            runtime: InventoryRuntime {
                revision: context.revision.to_owned(),
                kind: context.kind,
                generation: context.generation.to_owned(),
                backend: context.backend.clone(),
                target: context.target.clone(),
            },
            requested: context.requested.clone(),
            observed: InventoryObservation { distribution_count: distributions.len(), interpreter, distributions },
        })
    };
    inner().map_err(|error| {
        format!("Could not validate runtime dependency inventory: {error}. The previous environment is unchanged.")
    })
}

/// A partial report never becomes the generation's inventory.
pub fn write_runtime_inventory(directory: &Path, inventory: &RuntimeInventory) -> Result<(), String> {
    let destination = directory.join(format!("runtime-{}-inventory.json", inventory.runtime.kind.as_str()));
    let write = || -> std::io::Result<()> {
        let text = format!("{}\n", serde_json::to_string_pretty(inventory).map_err(std::io::Error::other)?);
        delulu_core::util::write_private_atomic(&destination, text.as_bytes())
    };
    write().map_err(|error| {
        format!("Could not write runtime dependency inventory: {error}. The previous environment is unchanged.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inventory_must_come_from_the_candidate_venv() {
        let dir = tempfile::tempdir().unwrap();
        let python = dir.path().join("bin/python");
        let observation = |prefix: &Path, distributions: Value| {
            json!({
                "interpreter": {
                    "executable": python, "version": "3.13.1", "fullVersion": "3.13.1 (main)", "implementation": "CPython",
                    "prefix": prefix, "basePrefix": "/usr", "platform": "linux", "system": "Linux",
                    "release": "6.0", "machine": "x86_64", "pointerBits": 64,
                },
                "distributionCount": distributions.as_array().unwrap().len(),
                "distributions": distributions,
            })
            .to_string()
        };
        let context = || InventoryContext {
            revision: "r",
            kind: RuntimeKind::Voice,
            generation: "g",
            backend: inventory_backend(RuntimeKind::Voice, false, SpeechRuntimeProfile::Cpu),
            target: TargetPlatform::new("linux", "x64"),
            python: &python,
            directory: dir.path(),
            requested: Vec::new(),
        };
        let ok = observation(dir.path(), json!([{ "name": "pip", "version": "26.2.1" }]));
        let inventory = create_runtime_inventory(context(), &ok).unwrap();
        write_runtime_inventory(dir.path(), &inventory).unwrap();
        assert!(dir.path().join("runtime-voice-inventory.json").exists());
        let foreign = observation(Path::new("/elsewhere"), json!([{ "name": "pip", "version": "1" }]));
        assert!(create_runtime_inventory(context(), &foreign).unwrap_err().contains("candidate virtualenv"));
        let duplicate = observation(dir.path(), json!([{ "name": "Foo_Bar", "version": "1" }, { "name": "foo-bar", "version": "2" }]));
        assert!(create_runtime_inventory(context(), &duplicate).unwrap_err().contains("duplicate installed distribution: foo-bar"));
        assert_eq!(
            serde_json::to_value(inventory_backend(RuntimeKind::Speech, true, SpeechRuntimeProfile::Full)).unwrap(),
            json!({ "engine": "mlx-audio", "devicePreference": ["metal"] })
        );
    }
}
