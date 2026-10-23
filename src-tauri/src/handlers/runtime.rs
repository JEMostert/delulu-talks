//! `electron/ipc/runtime.ts`: speech and rewriting runtimes, model
//! downloads and cache, diagnostics, setup snapshots and local data.

use delulu_core::DomainResult;
use delulu_data::local_data::local_data_overview;
use delulu_domain::{EnginePhase, MagicRewriteRequest, RenderingMode, RuntimeSetupKind};
use delulu_runtime::diagnostics::{runtime_diagnostics, DiagnosticsInputs};
use delulu_runtime::setup_space::SetupInputs;

use crate::ipc::Router;
use crate::state::{plain, AppState};

fn settings_idle(state: &AppState, message: &str) -> DomainResult<()> {
    if state.settings_queue.busy() {
        return Err(plain(message));
    }
    Ok(())
}

/// `DELULU_SOFTWARE_RENDERING=1` disables WebKit compositing (see `main.rs`).
pub fn rendering_mode() -> RenderingMode {
    if std::env::var("DELULU_SOFTWARE_RENDERING").as_deref() == Ok("1") {
        RenderingMode::Software
    } else {
        RenderingMode::Hardware
    }
}

/// delulu-runtime keeps its own copies of a few wire enums.
fn rewire<T: serde::Serialize, U: serde::de::DeserializeOwned>(value: &T) -> DomainResult<U> {
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

fn valid_rewrite_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("runtime:diagnostics", |state, _| async move {
            let inputs = DiagnosticsInputs {
                speech_venv: state.paths.speech_venv(),
                data_directory: state.paths.data.clone(),
                microphone: serde_json::to_value(delulu_desktop::microphone_permission()).ok(),
                accessibility: serde_json::to_value(delulu_desktop::accessibility_permission(
                    delulu_desktop::Platform::current(),
                ))
                .ok(),
            };
            Ok(runtime_diagnostics(inputs).await)
        })
        .handle("runtime:renderingMode", |_, _| async move { Ok(rendering_mode()) })
        .handle("cache:preview", |state, _| async move { state.model_cache.preview() })
        .handle("models:downloads", |state, _| async move { state.model_cache.speech_downloads() })
        .handle("models:deleteDownload", |state, args| async move {
            let id: String = args.get(0)?;
            state.speech.assert_runtime_idle()?;
            settings_idle(&state, "Wait for settings to finish saving before deleting")?;
            // The loaded checkpoint's files are in use: release them first.
            state.speech.release_speech_for_deletion().await?;
            state.model_cache.delete_speech_download(&id)
        })
        .handle("cache:cleanup", |state, args| async move {
            let token: String = args.get(0)?;
            let ids: Vec<String> = args.get(1)?;
            state.speech.assert_runtime_idle()?;
            settings_idle(&state, "Wait for settings to finish saving before cleaning the cache")?;
            let unloaded = |engine: EnginePhase| matches!(engine, EnginePhase::Unloaded | EnginePhase::Missing);
            if !unloaded(state.speech.asr.status().engine) || !unloaded(state.speech.asr.magic_status().engine) {
                return Err(plain("Explicitly unload speech and rewriting before deleting cached models"));
            }
            if token.len() > 128 || ids.is_empty() || ids.len() > 100 || ids.iter().any(|id| id.len() > 512) {
                return Err(plain("Select cached models from a fresh preview"));
            }
            // Stay synchronous after the idle/residency checks: another request
            // cannot start loading a model between the guard and deletion.
            Ok(state.model_cache.cleanup(&token, &ids))
        })
        .handle("runtime:setupSnapshot", |state, _| async move {
            let settings = state.storage.get_settings();
            let inputs = SetupInputs::new(
                &state.paths,
                settings.python_command,
                rewire(&settings.speech_engine)?,
                rewire(&settings.magic_model)?,
            );
            Ok(state.setup_snapshots.snapshot(&inputs).await)
        })
        .handle("runtime:setupLog", |state, args| async move {
            let kind: RuntimeSetupKind = args.get(0)?;
            Ok(match kind {
                RuntimeSetupKind::Voice => serde_json::to_value(state.voice.voice().get_setup_log())?,
                kind => serde_json::to_value(state.speech.asr.setup_log(kind))?,
            })
        })
        .handle("storage:overview", |state, _| async move {
            let data = state.paths.data.clone();
            crate::handlers::blocking(move || Ok(local_data_overview(&data))).await
        })
        .handle("runtime:status", |state, _| async move { Ok(state.speech.asr.status()) })
        .handle("runtime:cancelSetup", |state, _| async move { state.speech.asr.cancel_setup(false).await })
        .handle("magic:cancelSetup", |state, _| async move { state.speech.asr.cancel_setup(true).await })
        .handle("runtime:setup", |state, _| async move { state.speech.setup().await })
        .handle("runtime:load", |state, _| async move { state.speech.load().await })
        .handle("runtime:unload", |state, _| async move { state.speech.unload().await })
        .handle("runtime:reset", |state, _| async move { state.speech.reset().await })
        .handle("magic:status", |state, _| async move { Ok(state.speech.asr.magic_status()) })
        .handle("magic:setup", |state, _| async move {
            state.voice.coordinator().unload().await;
            let _guard = state.coordinator_provision.lock().await;
            state.speech.setup_magic().await
        })
        .handle("magic:load", |state, _| async move { state.speech.load_magic().await })
        .handle("magic:unload", |state, _| async move { state.speech.unload_magic().await })
        .handle("magic:cancelRewrite", |state, args| async move {
            let id: String = args.get(0)?;
            if !valid_rewrite_id(&id) {
                return Err(plain("Invalid rewrite operation ID"));
            }
            Ok(state.speech.asr.cancel_rewrite(&id).await)
        })
        .handle("magic:rewrite", |state, args| async move {
            let request: MagicRewriteRequest = args.get(0)?;
            state.speech.rewrite(request).await
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn rewrite_ids_follow_the_typescript_pattern() {
        assert!(super::valid_rewrite_id("abc_DEF-123"));
        assert!(!super::valid_rewrite_id(""));
        assert!(!super::valid_rewrite_id("a b"));
        assert!(!super::valid_rewrite_id(&"a".repeat(129)));
    }
}
