//! Optional local voice helper (Qwen3.5 0.8B). Its process is independent of
//! rewriting; the activated writing environment and pinned model cache are shared.
//!
//! Construction, `installed` and `load` never install or download. Only
//! explicit `setup` provisions dependencies and weights. The app must serialize
//! setup with its existing writing setup queue (both use `magic-venv`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use delulu_core::{AppPaths, DomainError, DomainResult};
use delulu_runtime::{
    installer::constraints_path,
    protocol::{validate_helper_context, validate_helper_decision, WorkerProgress},
    runtime_environment,
    types::SetupStage,
    worker::worker_script,
    ChildEnv, InstallProgress, InstallSettings, InstallerPaths, RuntimeInstaller, RuntimeKind, SpeechRuntimeProfile,
    WorkerClient, WorkerClientOptions, WorkerConfig,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

const MODEL: &str = "qwen35Small";
/// The pinned snapshot inside a Hugging Face hub cache.
const SNAPSHOT: &str = "models--Qwen--Qwen3.5-0.8B/snapshots/2fc06364715b967f1860aea9cf38778875588b17";

/// Debug builds only: the dev profile has no `magic-venv`, so an existing
/// interpreter (with its user site-packages) stands in for the runtime.
#[derive(Debug, Clone)]
struct DevOverride {
    python: PathBuf,
    cache: Option<PathBuf>,
}

impl DevOverride {
    fn from_env() -> Option<Self> {
        if !cfg!(debug_assertions) {
            return None;
        }
        let var = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from);
        Some(Self { python: var("DELULU_DEV_HELPER_PYTHON")?, cache: var("DELULU_DEV_HELPER_CACHE") })
    }
}

type ProgressSlot = Arc<parking_lot::Mutex<Option<mpsc::UnboundedSender<InstallProgress>>>>;

struct Inner {
    paths: AppPaths,
    dev: Option<DevOverride>,
    installer: Arc<RuntimeInstaller>,
    worker: WorkerClient,
    gate: Mutex<()>,
    setup_cancel: parking_lot::Mutex<CancellationToken>,
    /// Receives weight download progress while `setup` runs.
    progress: ProgressSlot,
}

#[derive(Clone)]
pub struct CoordinatorWorker {
    inner: Arc<Inner>,
}

fn environment(paths: &AppPaths, python: &Path) -> ChildEnv {
    let bin = python.parent().unwrap_or_else(|| Path::new("."));
    runtime_environment(RuntimeKind::Magic, &paths.data, &paths.models(), bin, delulu_core::host_vars())
}

/// The worker runs `python -u <script>` (no `-I`/`-s`), so `PYTHONNOUSERSITE`
/// alone disables user site-packages; the dev interpreter drops it.
fn helper_config(paths: &AppPaths, python: PathBuf, user_site: bool) -> WorkerConfig {
    let mut env = environment(paths, &python);
    env.insert("DELULU_RUNTIME_KIND".into(), "coordinator".into());
    if user_site {
        env.remove(std::ffi::OsStr::new("PYTHONNOUSERSITE"));
    }
    WorkerConfig { env, python, script: worker_script(paths) }
}

fn weights_present(hub: &Path) -> bool {
    let snapshot = hub.join(SNAPSHOT);
    // Snapshot entries are symlinks into blobs; `is_file` rejects dangling ones.
    snapshot.join("config.json").is_file()
        && std::fs::read_dir(&snapshot).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.extension().is_some_and(|extension| extension == "safetensors") && path.is_file()
            })
        })
}

fn setup_progress(event: &WorkerProgress) -> Option<InstallProgress> {
    let (stage, message) = match event.stage.as_str() {
        "download" => (SetupStage::ModelDownload, "Downloading the local helper"),
        "load" => (SetupStage::ModelLoad, "Loading the local helper"),
        _ => return None,
    };
    let megabytes = |bytes: u64| bytes / 1_000_000;
    let message = match &event.download_bytes {
        Some(bytes) => match bytes.total {
            Some(total) => format!("{message} ({} of {} MB)", megabytes(bytes.completed), megabytes(total)),
            None => format!("{message} ({} MB)", megabytes(bytes.completed)),
        },
        None => message.to_owned(),
    };
    let progress = event.fraction.unwrap_or(0.0);
    Some(InstallProgress { setup_stage: Some(stage), message, progress, detail: Some(event.detail.clone()) })
}

fn cancelled() -> DomainError {
    DomainError::cancelled("Local helper setup cancelled")
}

impl CoordinatorWorker {
    /// No interpreter/model work occurs until an explicit method call.
    pub fn new(paths: AppPaths) -> Self {
        Self::build(paths, DevOverride::from_env())
    }

    fn build(paths: AppPaths, dev: Option<DevOverride>) -> Self {
        let installer_paths = paths.clone();
        let installer = Arc::new(RuntimeInstaller::new(
            InstallerPaths {
                data_directory: paths.data.clone(),
                venv_directory: paths.magic_venv(),
                kind: Some(RuntimeKind::Magic),
            },
            Some(constraints_path(&paths)),
            move || {
                let fallback =
                    installer_paths.magic_venv().join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
                let python =
                    delulu_runtime::location::runtime_python(&installer_paths.magic_venv()).unwrap_or(fallback);
                environment(&installer_paths, &python)
            },
        ));
        let progress = ProgressSlot::default();
        let on_progress = {
            let progress = progress.clone();
            move |_: &str, event: &WorkerProgress| {
                if event.command != "coordinatorSetup" {
                    return;
                }
                if let (Some(sender), Some(update)) = (progress.lock().as_ref(), setup_progress(event)) {
                    let _ = sender.send(update);
                }
            }
        };
        let (source, config_paths, config_dev) = (installer.clone(), paths.clone(), dev.clone());
        let worker = WorkerClient::with_options(
            move || {
                if let Some(dev) = &config_dev {
                    return Ok(helper_config(&config_paths, dev.python.clone(), true));
                }
                let python = source.python()?;
                if !python.exists() {
                    return Err(DomainError::failed("Set up the local helper before loading it"));
                }
                Ok(helper_config(&config_paths, python, false))
            },
            |_| {}, // Request errors are returned to the helper's owner.
            WorkerClientOptions { on_progress: Some(Arc::new(on_progress)), ..Default::default() },
        )
        .expect("default limits are valid");
        Self {
            inner: Arc::new(Inner {
                paths,
                dev,
                installer,
                worker,
                gate: Mutex::new(()),
                setup_cancel: parking_lot::Mutex::new(CancellationToken::new()),
                progress,
            }),
        }
    }

    fn hub(&self) -> PathBuf {
        let dev_cache = self.inner.dev.as_ref().and_then(|dev| dev.cache.clone());
        dev_cache.unwrap_or_else(|| self.inner.paths.models().join("hub"))
    }

    fn model_payload(&self) -> Value {
        let mut payload = json!({ "model": MODEL });
        if let Some(cache) = self.inner.dev.as_ref().and_then(|dev| dev.cache.as_ref()) {
            payload["cacheDir"] = cache.to_string_lossy().into();
        }
        payload
    }

    async fn runtime_ready(&self) -> DomainResult<bool> {
        if self.inner.dev.is_some() {
            return Ok(true);
        }
        self.inner.installer.ready(RuntimeKind::Magic, SpeechRuntimeProfile::Cpu).await
    }

    /// `(runtime, weights)` are on disk. File checks only: no process, no network.
    pub fn installed(&self) -> (bool, bool) {
        let runtime = self.inner.dev.is_some()
            || delulu_runtime::location::runtime_python(&self.inner.paths.magic_venv())
                .is_ok_and(|python| python.is_file());
        (runtime, weights_present(&self.hub()))
    }

    /// The only method permitted to install dependencies or download weights.
    /// `publish` receives writing runtime provisioning and weight download progress.
    pub async fn setup(
        &self,
        settings: &InstallSettings,
        publish: impl Fn(InstallProgress) + Send + Sync,
    ) -> DomainResult<()> {
        let _guard = self.inner.gate.lock().await;
        let cancel = CancellationToken::new();
        *self.inner.setup_cancel.lock() = cancel.clone();
        self.inner.worker.stop_and_wait(None).await;
        let install = !self.runtime_ready().await?;
        let result = async {
            if install {
                self.inner.installer.install(RuntimeKind::Magic, settings, &publish, Some(cancel.clone())).await?;
            }
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            let (sender, mut updates) = mpsc::unbounded_channel();
            *self.inner.progress.lock() = Some(sender);
            let download = self.inner.worker.request("coordinatorSetup", self.model_payload(), None);
            tokio::pin!(download);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(cancelled()),
                    Some(update) = updates.recv() => publish(update),
                    result = &mut download => {
                        result?;
                        break;
                    }
                }
            }
            // Exercise one real decision before activating a candidate
            // environment; the decision itself is discarded.
            self.decide_inner("Hello", &json!({})).await?;
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            if install {
                self.inner.installer.commit()?;
            }
            Ok(())
        }
        .await;
        *self.inner.progress.lock() = None;
        if result.is_err() {
            self.inner.worker.stop_and_wait(None).await;
            if install {
                self.inner.installer.discard();
            }
        }
        result
    }

    /// Cached files only. Missing dependencies/weights require explicit setup.
    pub async fn load(&self) -> DomainResult<()> {
        let _guard = self.inner.gate.lock().await;
        if !self.runtime_ready().await? {
            return Err(DomainError::failed("Set up the local helper before loading it"));
        }
        self.inner.worker.request("coordinatorLoad", self.model_payload(), None).await?;
        Ok(())
    }

    /// Also interrupts in-flight inference immediately and releases its process.
    pub async fn unload(&self) {
        self.inner.setup_cancel.lock().cancel();
        self.inner.worker.stop_and_wait(None).await;
        let _guard = self.inner.gate.lock().await;
        // A queued operation may have started while termination was awaited.
        self.inner.worker.stop_and_wait(None).await;
    }

    /// One tool call for `text`, naming only ids from `context`.
    pub async fn decide(&self, text: &str, context: &Value) -> DomainResult<Value> {
        let _guard = self.inner.gate.lock().await;
        self.decide_inner(text, context).await
    }

    async fn decide_inner(&self, text: &str, context: &Value) -> DomainResult<Value> {
        validate_helper_context(context).map_err(DomainError::invalid)?;
        let payload = json!({ "text": text, "context": context });
        let decision = self.inner.worker.request("coordinatorDecide", payload, None).await?;
        validate_helper_decision(&decision, context).map_err(DomainError::invalid)?;
        Ok(decision)
    }

    /// One short spoken sentence about what the executor did for `call`.
    pub async fn reply(&self, text: &str, context: &Value, call: &Value, result: &str) -> DomainResult<Value> {
        let _guard = self.inner.gate.lock().await;
        validate_helper_context(context).map_err(DomainError::invalid)?;
        let payload = json!({ "text": text, "context": context, "call": call, "result": result });
        // The transport validates the result with `validate_helper_reply`.
        self.inner.worker.request("coordinatorReply", payload, None).await
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    /// The app boxes these as `Send` futures.
    #[allow(dead_code)]
    fn futures_are_send(worker: &CoordinatorWorker, settings: &InstallSettings) {
        fn send<T: Send>(_: T) {}
        send(worker.setup(settings, |_| {}));
        send(worker.load());
        send(worker.unload());
        send(worker.decide("", &Value::Null));
        send(worker.reply("", &Value::Null, &Value::Null, ""));
    }

    #[test]
    fn installed_checks_only_the_runtime_interpreter_and_pinned_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::at(dir.path(), dir.path());
        let worker = CoordinatorWorker::build(paths.clone(), None);
        assert_eq!(worker.installed(), (false, false));
        touch(&delulu_runtime::location::python_in(&paths.magic_venv()));
        let snapshot = paths.models().join("hub").join(SNAPSHOT);
        touch(&snapshot.join("config.json"));
        assert_eq!(worker.installed(), (true, false));
        touch(&snapshot.join("model.safetensors.incomplete"));
        assert_eq!(worker.installed(), (true, false));
        touch(&snapshot.join("model.safetensors"));
        assert_eq!(worker.installed(), (true, true));
    }

    #[test]
    fn dev_override_keeps_user_site_packages_and_its_own_cache() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::at(dir.path().join("data"), dir.path());
        let cache = dir.path().join("hub");
        let dev = DevOverride { python: "/usr/bin/python3".into(), cache: Some(cache.clone()) };
        let worker = CoordinatorWorker::build(paths.clone(), Some(dev));
        assert_eq!(worker.installed(), (true, false));
        touch(&cache.join(SNAPSHOT).join("config.json"));
        touch(&cache.join(SNAPSHOT).join("model.safetensors"));
        assert_eq!(worker.installed(), (true, true));
        assert_eq!(worker.model_payload(), json!({ "model": MODEL, "cacheDir": cache.to_string_lossy() }));

        let user_site = helper_config(&paths, "/usr/bin/python3".into(), true);
        assert_eq!(user_site.python, Path::new("/usr/bin/python3"));
        assert!(!user_site.env.contains_key(OsStr::new("PYTHONNOUSERSITE")));
        assert_eq!(user_site.env.get(OsStr::new("DELULU_RUNTIME_KIND")).unwrap(), "coordinator");
        let isolated = helper_config(&paths, "/venv/bin/python".into(), false);
        assert_eq!(isolated.env.get(OsStr::new("PYTHONNOUSERSITE")).unwrap(), "1");
    }
}
