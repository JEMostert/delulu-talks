//! Optional local routing worker. Its process is independent of rewriting;
//! the activated writing environment and pinned model cache are shared.
//!
//! Construction, readiness and ordinary loads never install/download. Only
//! explicit `setup` provisions dependencies and weights. The app must serialize
//! setup with its existing writing setup queue (both use `magic-venv`).

use std::sync::Arc;

use delulu_core::{AppPaths, DomainError, DomainResult};
use delulu_runtime::{
    installer::constraints_path,
    protocol::{validate_coordinator_context, validate_coordinator_route},
    runtime_environment,
    worker::worker_script,
    ChildEnv, InstallProgress, InstallSettings, InstallerPaths, RuntimeInstaller, RuntimeKind, SpeechRuntimeProfile,
    WorkerClient, WorkerConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CoordinatorModel {
    #[serde(rename = "qwen35Small")]
    Lightweight,
    #[serde(rename = "qwen35Medium")]
    Conversational,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorContextEntry {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinatorContext {
    #[serde(default)]
    pub tasks: Vec<CoordinatorContextEntry>,
    #[serde(default)]
    pub agents: Vec<CoordinatorContextEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_agent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorIntent {
    Delegate,
    Status,
    StopSpeaking,
    StopListening,
    CancelTask,
    Conversation,
}

/// Routing metadata only. The caller must retain the original user text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinatorRoute {
    pub intent: CoordinatorIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

struct Inner {
    installer: Arc<RuntimeInstaller>,
    worker: WorkerClient,
    gate: Mutex<()>,
    setup_cancel: parking_lot::Mutex<CancellationToken>,
}

#[derive(Clone)]
pub struct CoordinatorWorker {
    inner: Arc<Inner>,
}

fn environment(paths: &AppPaths, python: &std::path::Path, coordinator: bool) -> ChildEnv {
    let bin = python.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut env = runtime_environment(RuntimeKind::Magic, &paths.data, &paths.models(), bin, delulu_core::host_vars());
    if coordinator {
        env.insert("DELULU_RUNTIME_KIND".into(), "coordinator".into());
    }
    env
}

impl CoordinatorWorker {
    /// No interpreter/model work occurs until an explicit method call.
    pub fn new(paths: AppPaths) -> Self {
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
                environment(&installer_paths, &python, false)
            },
        ));
        let source = installer.clone();
        let worker = WorkerClient::new(
            move || {
                let python = source.python()?;
                if !python.exists() {
                    return Err(DomainError::failed("Set up the coordinator runtime before loading its model"));
                }
                Ok(WorkerConfig { env: environment(&paths, &python, true), python, script: worker_script(&paths) })
            },
            |_| {}, // Request errors are returned to the coordinator's owner.
        );
        Self {
            inner: Arc::new(Inner {
                installer,
                worker,
                gate: Mutex::new(()),
                setup_cancel: parking_lot::Mutex::new(CancellationToken::new()),
            }),
        }
    }

    /// Checks writing dependencies only; does not load or download weights.
    pub async fn ready(&self) -> DomainResult<bool> {
        let _guard = self.inner.gate.lock().await;
        self.inner.installer.ready(RuntimeKind::Magic, SpeechRuntimeProfile::Cpu).await
    }

    /// The only method permitted to install dependencies or download weights.
    /// `publish` receives the existing writing runtime provisioning progress.
    pub async fn setup(
        &self,
        settings: &InstallSettings,
        model: CoordinatorModel,
        publish: impl Fn(InstallProgress) + Send + Sync,
    ) -> DomainResult<()> {
        let _guard = self.inner.gate.lock().await;
        let cancel = CancellationToken::new();
        *self.inner.setup_cancel.lock() = cancel.clone();
        self.inner.worker.stop_and_wait(None).await;
        let install = !self.inner.installer.ready(RuntimeKind::Magic, SpeechRuntimeProfile::Cpu).await?;
        let result = async {
            if install {
                self.inner.installer.install(RuntimeKind::Magic, settings, publish, Some(cancel.clone())).await?;
            }
            if cancel.is_cancelled() {
                return Err(DomainError::cancelled("Coordinator setup cancelled"));
            }
            tokio::select! {
                _=cancel.cancelled()=>return Err(DomainError::cancelled("Coordinator setup cancelled")),
                result=self.inner.worker.request("coordinatorSetup",json!({"model":model}),None)=>{result?;}
            }
            // Exercise the same short, non-thinking inference before activating
            // a candidate environment. Generated text never leaves the worker.
            self.classify_inner("Hello", &CoordinatorContext::default()).await?;
            if cancel.is_cancelled() {
                return Err(DomainError::cancelled("Coordinator setup cancelled"));
            }
            if install {
                self.inner.installer.commit()?;
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            self.inner.worker.stop_and_wait(None).await;
            self.inner.installer.discard();
        }
        result
    }

    /// Cached files only. Missing dependencies/weights require explicit setup.
    pub async fn load(&self, model: CoordinatorModel) -> DomainResult<()> {
        let _guard = self.inner.gate.lock().await;
        if !self.inner.installer.ready(RuntimeKind::Magic, SpeechRuntimeProfile::Cpu).await? {
            return Err(DomainError::failed("Set up the coordinator runtime before loading its model"));
        }
        self.inner.worker.request("coordinatorLoad", json!({"model": model}), None).await?;
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

    pub async fn classify(&self, user_text: &str, context: &CoordinatorContext) -> DomainResult<CoordinatorRoute> {
        let _guard = self.inner.gate.lock().await;
        self.classify_inner(user_text, context).await
    }

    async fn classify_inner(&self, user_text: &str, context: &CoordinatorContext) -> DomainResult<CoordinatorRoute> {
        let context_json: Value =
            serde_json::to_value(context).map_err(|_| DomainError::invalid("Invalid coordinator context"))?;
        validate_coordinator_context(&context_json).map_err(DomainError::invalid)?;
        let result = self
            .inner
            .worker
            .request("coordinatorClassify", json!({"text": user_text, "context": context_json}), None)
            .await?;
        validate_coordinator_route(&result).map_err(DomainError::invalid)?;
        let route: CoordinatorRoute =
            serde_json::from_value(result).map_err(|_| DomainError::invalid("Invalid coordinator route"))?;
        if route.task_id.as_ref().is_some_and(|id| !context.tasks.iter().any(|entry| &entry.id == id))
            || route.agent_id.as_ref().is_some_and(|id| !context.agents.iter().any(|entry| &entry.id == id))
        {
            return Err(DomainError::invalid("Coordinator returned an ID outside the supplied context"));
        }
        Ok(route)
    }
}
