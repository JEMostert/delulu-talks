//! Read-only setup snapshot (`setupSnapshot.ts`): which runtimes exist, which
//! interpreters are available and what installer inventory is cached. Probes
//! run Python with `-I -B -S`, so only standard-library modules execute;
//! discovering top-level specs does not import torch, MLX or transformers.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::inventory::{inventory_backend, RuntimeKind};
use crate::location::{python_in, runtime_directory};
use crate::manifest::RUNTIME_REVISION;
use crate::platform::{speech_model_for_platform, SpeechRuntimeProfile, TargetPlatform};
use crate::setup_space::{setup_space_snapshot, SetupInputs, SetupSpaceSnapshot};
use crate::support::{capture, split_command, CaptureError};
use crate::types::SpeechModelId;

const PROBE: &str = r#"import sys,json,os,importlib.util
root=os.path.dirname(os.path.dirname(sys.executable))
version='python%d.%d' % sys.version_info[:2]
for path in [os.path.join(root,'Lib','site-packages'),os.path.join(root,'lib',version,'site-packages'),os.path.join(root,'lib64',version,'site-packages')]:
    if os.path.isdir(path): sys.path.append(path)
modules={}
for name in sys.argv[1:]:
    try:
        spec=importlib.util.find_spec(name)
        modules[name]={'status':'located' if spec else 'missing','location':str(spec.origin or 'namespace package') if spec else None}
    except Exception:
        modules[name]={'status':'unknown','location':None}
print(json.dumps({'executable':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'machine':os.uname().machine if hasattr(os,'uname') else os.environ.get('PROCESSOR_ARCHITECTURE','unknown'),'modules':modules}))"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterpreterStatus {
    Observed,
    Missing,
    Unknown,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleStatus {
    Located,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleObservation {
    pub name: String,
    pub status: ModuleStatus,
    pub location: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InterpreterObservation {
    pub command: String,
    pub status: InterpreterStatus,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub machine: Option<String>,
    pub modules: Vec<ModuleObservation>,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    Present,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CachedInventoryStatus {
    Cached,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedInventory {
    pub status: CachedInventoryStatus,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
    pub revision: Option<String>,
    pub interpreter: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRuntimeObservation {
    pub kind: RuntimeKind,
    pub root: String,
    pub directory: Option<String>,
    pub runtime_state: RuntimeState,
    pub expected_revision: String,
    pub backend: String,
    pub device_preference: String,
    pub device_observation: String,
    pub interpreter: InterpreterObservation,
    pub bootstrap: Vec<InterpreterObservation>,
    pub import_probe: String,
    pub cached_inventory: CachedInventory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotSource {
    Desktop,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupSnapshot {
    pub checked_at: u64,
    pub platform: String,
    pub arch: String,
    pub source: SnapshotSource,
    pub space: Option<SetupSpaceSnapshot>,
    pub runtimes: Vec<SetupRuntimeObservation>,
}

fn observation(command: String, status: InterpreterStatus, detail: &str) -> InterpreterObservation {
    InterpreterObservation {
        command,
        status,
        executable: None,
        version: None,
        machine: None,
        modules: Vec::new(),
        detail: detail.into(),
    }
}

fn parse_probe(stdout: &str, modules: &[&str]) -> Option<(String, String, String, Vec<ModuleObservation>)> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let (executable, version, machine) = (text("executable")?, text("version")?, text("machine")?);
    let found = value.get("modules")?.as_object()?;
    let observations = modules
        .iter()
        .map(|name| {
            let item = found.get(*name)?;
            let status = match item.get("status")?.as_str()? {
                "located" => ModuleStatus::Located,
                "missing" => ModuleStatus::Missing,
                "unknown" => ModuleStatus::Unknown,
                _ => return None,
            };
            let location = match item.get("location")? {
                Value::Null => None,
                Value::String(location) => Some(location.clone()),
                _ => return None,
            };
            Some(ModuleObservation { name: (*name).to_owned(), status, location })
        })
        .collect::<Option<Vec<_>>>()?;
    Some((executable, version, machine, observations))
}

async fn inspect(program: &str, selector: &[String], modules: &[&str]) -> InterpreterObservation {
    let command = std::iter::once(program.to_owned()).chain(selector.iter().cloned()).collect::<Vec<_>>().join(" ");
    let mut args = selector.to_vec();
    args.extend(["-I", "-B", "-S", "-c", PROBE].map(String::from));
    args.extend(modules.iter().map(|name| (*name).to_owned()));
    match capture(program, &args, Duration::from_millis(2500), 128 * 1024).await {
        Err(CaptureError::NotFound) => observation(
            command,
            InterpreterStatus::Missing,
            "Interpreter not found. Configure its full path in Settings → Advanced.",
        ),
        Err(CaptureError::Failed) => observation(
            command,
            InterpreterStatus::Unknown,
            "Interpreter probe failed or timed out. Check the configured path and permissions; no package imports were attempted.",
        ),
        Ok(stdout) => match parse_probe(&stdout, modules) {
            Some((executable, version, machine, modules)) => InterpreterObservation {
                command,
                status: InterpreterStatus::Observed,
                executable: Some(executable),
                version: Some(version),
                machine: Some(machine),
                modules,
                detail: "Current isolated interpreter and module discovery. Located modules have not been imported.".into(),
            },
            None => observation(
                program.to_owned(),
                InterpreterStatus::Unknown,
                "Interpreter returned an unreadable probe result. Check Settings → Advanced.",
            ),
        },
    }
}

/// Executable paths and the Windows launcher selector only; never a
/// configured script, `-c` command or arbitrary flags in this read-only probe.
fn candidates(command: &str, metal: bool, target: &TargetPlatform) -> Vec<Vec<String>> {
    let parts = split_command(command);
    let selector_ok = parts.len() != 2 || (target.is_windows() && is_launcher_selector(&parts[1]));
    if parts.is_empty() || parts.len() > 2 || !selector_ok {
        return Vec::new();
    }
    if !matches!(parts[0].as_str(), "python" | "python3") {
        return vec![parts];
    }
    let one = |value: &str| vec![value.to_owned()];
    let mut fallbacks = if metal {
        let home = dirs::home_dir().unwrap_or_default();
        vec![
            one("python3.12"),
            one("/opt/homebrew/bin/python3.12"),
            one(&home.join(".local/bin/python3.12").to_string_lossy()),
        ]
    } else if target.is_windows() {
        vec![vec!["py".into(), "-3.12".into()], one("python3.12")]
    } else {
        vec![one("python3.13"), one("python3.12"), one("python3.11")]
    };
    fallbacks.push(parts);
    fallbacks
}

/// `/^-3\.\d+$/`
fn is_launcher_selector(value: &str) -> bool {
    value.strip_prefix("-3.").is_some_and(|minor| !minor.is_empty() && minor.bytes().all(|b| b.is_ascii_digit()))
}

fn compatible(interpreter: &InterpreterObservation, metal: bool, target: &TargetPlatform) -> bool {
    let version = interpreter.version.as_deref().unwrap_or_default();
    let mut numbers = version.split('.').map(|part| part.parse::<i64>().ok());
    let (major, minor) = (numbers.next().flatten(), numbers.next().flatten());
    interpreter.status == InterpreterStatus::Observed
        && major == Some(3)
        && minor.is_some_and(|minor| if metal || target.is_windows() { minor == 12 } else { (11..=13).contains(&minor) })
        && (!metal || interpreter.machine.as_deref() == Some("arm64"))
}

fn cached_inventory(path: &Path, kind: RuntimeKind) -> CachedInventory {
    let unreadable = CachedInventory {
        status: CachedInventoryStatus::Unreadable,
        created_at: None,
        revision: None,
        interpreter: None,
        detail: "Installer inventory is unreadable or invalid. Repair can create a new inventory; existing files were not changed.".into(),
    };
    let read = || -> Option<CachedInventory> {
        if std::fs::metadata(path).ok()?.len() > 2 * 1024 * 1024 {
            return None;
        }
        let inventory: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        let runtime = inventory.get("runtime")?;
        if inventory.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
            || runtime.get("kind").and_then(Value::as_str) != Some(kind.as_str())
        {
            return None;
        }
        let revision = runtime.get("revision")?.as_str()?;
        let created_at = inventory.get("createdAt")?.as_str()?;
        let interpreter = inventory.get("observed")?.get("interpreter")?.get("version")?.as_str()?;
        Some(CachedInventory {
            status: CachedInventoryStatus::Cached,
            created_at: Some(created_at.into()),
            revision: Some(revision.into()),
            interpreter: Some(interpreter.into()),
            detail: "Historical installer inventory, written after setup's successful readiness stage. It does not prove imports or hardware work now.".into(),
        })
    };
    read().unwrap_or(unreadable)
}

async fn runtime(inputs: &SetupInputs, kind: RuntimeKind) -> SetupRuntimeObservation {
    let metal = kind == RuntimeKind::Speech && speech_model_for_platform(&inputs.target) == SpeechModelId::R2t2Mlx;
    let root = if kind == RuntimeKind::Speech { &inputs.speech_venv } else { &inputs.magic_venv };
    let backend = inventory_backend(kind, metal, SpeechRuntimeProfile::Full);
    let modules: &[&str] = match kind {
        RuntimeKind::Magic => &["torch", "torchvision", "transformers"],
        _ if metal => &["mlx", "mlx_audio"],
        _ => &["torch", "transformers", "soundfile", "soxr"],
    };
    let mut result = SetupRuntimeObservation {
        kind,
        root: root.to_string_lossy().into_owned(),
        directory: None,
        runtime_state: RuntimeState::Missing,
        expected_revision: RUNTIME_REVISION.into(),
        backend: backend.engine.as_str().into(),
        device_preference: backend.device_preference.iter().map(|d| d.as_str()).collect::<Vec<_>>().join(" → "),
        device_observation: "Not probed. Device preference is selection policy, not proof of GPU availability.".into(),
        interpreter: observation(inputs.python_command.clone(), InterpreterStatus::Unknown, "Not observed."),
        bootstrap: Vec::new(),
        import_probe: "Not run. Module discovery cannot establish successful imports or native readiness.".into(),
        cached_inventory: CachedInventory {
            status: CachedInventoryStatus::Missing,
            created_at: None,
            revision: None,
            interpreter: None,
            detail: "No installer inventory. Setup records one after its readiness probe; no historical import result is available.".into(),
        },
    };
    match runtime_directory(root) {
        Ok(directory) => {
            result.directory = Some(directory.to_string_lossy().into_owned());
            let python = python_in(&directory);
            let python_text = python.to_string_lossy().into_owned();
            result.interpreter.command = python_text.clone();
            if python.exists() {
                result.runtime_state = RuntimeState::Present;
                result.interpreter = inspect(&python_text, &[], modules).await;
                if result.interpreter.status == InterpreterStatus::Observed
                    && !compatible(&result.interpreter, metal, &inputs.target)
                {
                    result.interpreter.status = InterpreterStatus::Unsupported;
                    result.interpreter.detail = "Interpreter version/architecture is unsupported. Repair the dedicated runtime with a compatible Python in Settings → Advanced.".into();
                }
            } else {
                result.interpreter.status = InterpreterStatus::Missing;
                result.interpreter.detail = "Dedicated runtime interpreter not found. Setup can create it using a compatible candidate below.".into();
            }
            let inventory = directory.join(format!("runtime-{}-inventory.json", kind.as_str()));
            if inventory.exists() {
                result.cached_inventory = cached_inventory(&inventory, kind);
            }
        }
        Err(_) => {
            result.runtime_state = RuntimeState::Unknown;
            result.interpreter.detail = "Runtime activation record is unreadable or invalid. Use Repair to rebuild safely; no files were changed.".into();
        }
    }
    let options = candidates(&inputs.python_command, metal, &inputs.target);
    let probes = options.iter().map(|option| inspect(&option[0], &option[1..], &[]));
    result.bootstrap = futures::future::join_all(probes).await;
    for item in &mut result.bootstrap {
        if item.status == InterpreterStatus::Observed && !compatible(item, metal, &inputs.target) {
            item.status = InterpreterStatus::Unsupported;
            item.detail = if metal {
                "Requires native arm64 Python 3.12."
            } else if inputs.target.is_windows() {
                "Requires Python 3.12."
            } else {
                "Requires Python 3.11–3.13."
            }
            .into();
        }
    }
    if options.is_empty() {
        result.interpreter.detail.push_str(
            " Configured command contains unsupported arguments; use an interpreter path (or Windows py -3.12).",
        );
    }
    result
}

/// One snapshot, without de-duplication.
pub async fn runtime_setup_snapshot(inputs: &SetupInputs) -> RuntimeSetupSnapshot {
    let (speech, magic, space) =
        tokio::join!(runtime(inputs, RuntimeKind::Speech), runtime(inputs, RuntimeKind::Magic), setup_space_snapshot(inputs));
    RuntimeSetupSnapshot {
        checked_at: delulu_core::now_ms(),
        platform: inputs.target.platform.clone(),
        arch: inputs.target.arch.clone(),
        source: SnapshotSource::Desktop,
        runtimes: vec![speech, magic],
        space: Some(space),
    }
}

type Shared = Arc<OnceCell<RuntimeSetupSnapshot>>;

/// Concurrent requests with the same Python command and Magic model share
/// one in-flight snapshot.
#[derive(Default)]
pub struct SetupSnapshots {
    pending: Mutex<Option<(String, Shared)>>,
}

impl SetupSnapshots {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self, inputs: &SetupInputs) -> RuntimeSetupSnapshot {
        let key = serde_json::json!([inputs.python_command, inputs.magic_model]).to_string();
        let cell = {
            let mut pending = self.pending.lock();
            match &*pending {
                Some((existing, cell)) if *existing == key => cell.clone(),
                _ => {
                    let cell: Shared = Arc::default();
                    *pending = Some((key, cell.clone()));
                    cell
                }
            }
        };
        let snapshot = cell.get_or_init(|| runtime_setup_snapshot(inputs)).await.clone();
        let mut pending = self.pending.lock();
        if pending.as_ref().is_some_and(|(_, current)| Arc::ptr_eq(current, &cell)) {
            *pending = None;
        }
        snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{MagicModelId, SpeechTier};

    #[test]
    fn probe_candidates_never_accept_scripts_or_flags() {
        let linux = TargetPlatform::new("linux", "x64");
        assert_eq!(candidates("python3", false, &linux).len(), 4);
        assert_eq!(candidates("/usr/bin/python3.12", false, &linux), vec![vec!["/usr/bin/python3.12".to_owned()]]);
        assert!(candidates("python3 -c evil", false, &linux).is_empty());
        assert!(candidates("py -3.12", false, &linux).is_empty());
        assert_eq!(candidates("py -3.12", false, &TargetPlatform::new("win32", "x64")).len(), 1);
    }

    #[tokio::test]
    async fn snapshot_observes_missing_runtimes_without_changing_files() {
        let dir = tempfile::tempdir().unwrap();
        let inputs = SetupInputs {
            speech_venv: dir.path().join("speech-venv"),
            magic_venv: dir.path().join("magic-venv"),
            model_cache: dir.path().join("models"),
            python_command: "python3".into(),
            speech_engine: SpeechTier::Small,
            magic_model: MagicModelId::Qwen35Small,
            target: TargetPlatform::new("linux", "x64"),
        };
        let snapshot = SetupSnapshots::new().snapshot(&inputs).await;
        let speech = &snapshot.runtimes[0];
        assert_eq!(speech.runtime_state, RuntimeState::Missing);
        assert_eq!(speech.interpreter.status, InterpreterStatus::Missing);
        assert_eq!(speech.bootstrap.len(), 4);
        assert_eq!(snapshot.space.as_ref().unwrap().plans[1].model_download_bytes, 1_600_000_000);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["runtimes"][1]["cachedInventory"]["status"], "missing");
        assert_eq!(json["runtimes"][0]["devicePreference"], "cuda");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
