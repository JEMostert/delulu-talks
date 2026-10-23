//! The storage and speech seams the service crates code against:
//! [`delulu_speech::Profile`] and [`delulu_voice::VoiceProfile`] over
//! delulu-data's `StorageService`, and [`delulu_voice::ListenTranscriber`]
//! over delulu-speech's `AsrService`.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use delulu_core::{AppPaths, DomainResult, SharedSink};
use delulu_data::history_batch::HistoryBatchDeletion;
use delulu_data::rule_usage::RuleUsageService;
use delulu_data::StorageService;
use delulu_domain::{AppSettings, TranscriptRecord};
use delulu_speech::AsrService;
use delulu_voice::talk::{HelperInstall, HelperModel};
use delulu_voice::{BoxFuture, ListenTranscriber, VoiceProfile};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::state::{plain, AppState};

pub struct AppProfile {
    pub app: AppHandle,
    pub storage: Arc<StorageService>,
    pub rule_usage: Arc<RuleUsageService>,
    pub sink: SharedSink,
    /// Set once the batch deletion exists (it needs the speech transcripts).
    pub deletion: OnceLock<HistoryBatchDeletion>,
}

impl delulu_speech::Profile for AppProfile {
    fn settings(&self) -> AppSettings {
        self.storage.get_settings()
    }

    fn set_paste_portal_token(&self, token: String) {
        match self.storage.patch_settings(&json!({ "pastePortalToken": token })) {
            Ok((_, saved)) => delulu_core::emit(self.sink.as_ref(), "settings:changed", &saved),
            Err(error) => log::error!("Could not save the paste permission: {}", error.message),
        }
    }

    fn add_history(&self, record: &TranscriptRecord) -> DomainResult<()> {
        self.storage.add_history(record).map(|_| ())
    }

    fn find_history(&self, id: &str) -> Option<TranscriptRecord> {
        self.storage.find_history(id)
    }

    fn replace_history(&self, record: &TranscriptRecord) -> DomainResult<()> {
        self.storage.replace_history(record)
    }

    fn latest_history(&self) -> Option<TranscriptRecord> {
        self.storage.get_history().into_iter().next()
    }

    fn pinned_history_ids(&self) -> Vec<String> {
        self.deletion.get().and_then(HistoryBatchDeletion::get_state).map(|state| state.ids).unwrap_or_default()
    }

    fn record_rule_usage(&self, counts: &BTreeMap<String, u64>) {
        let ids: Vec<String> = self.storage.get_settings().custom_words.iter().map(|rule| rule.id.clone()).collect();
        let counts: HashMap<String, u64> = counts.iter().map(|(id, count)| (id.clone(), *count)).collect();
        self.rule_usage.record(&counts, &ids);
    }
}

impl VoiceProfile for AppProfile {
    fn settings(&self) -> AppSettings {
        self.storage.get_settings()
    }

    fn paths(&self) -> &AppPaths {
        self.storage.paths()
    }

    fn persist_settings(&self, patch: Value) -> BoxFuture<'_, DomainResult<AppSettings>> {
        let app = self.app.clone();
        Box::pin(async move {
            let state = AppState::get(&app).ok_or_else(|| plain("Delulu Talks is still starting"))?;
            crate::settings::persist_settings(&state, patch).await
        })
    }
}

/// Listening sessions transcribe with the dictation speech model.
pub struct SpeechTranscriber {
    pub asr: AsrService,
    pub storage: Arc<StorageService>,
}

impl ListenTranscriber for SpeechTranscriber {
    fn prepare(&self, settings: &AppSettings) -> BoxFuture<'_, DomainResult<()>> {
        let settings = settings.clone();
        Box::pin(async move {
            if !self.asr.is_environment_ready(&settings).await? {
                return Err(plain("Set up a speech model on the Models page before listening."));
            }
            self.asr.ensure_loaded(&settings).await
        })
    }

    fn transcribe(&self, audio_path: &Path, duration_ms: u64) -> BoxFuture<'_, DomainResult<String>> {
        let payload = json!({ "audioPath": audio_path.to_string_lossy(), "durationMs": duration_ms });
        Box::pin(async move {
            let result = self.asr.transcribe(payload, &self.storage.get_settings()).await?;
            Ok(result.get("text").and_then(Value::as_str).unwrap_or("").to_owned())
        })
    }
}

/// The talk loop owns routing; speech supplies an isolated local model.
/// Provisioning shares a gate with writing setup because both activate magic-venv.
pub struct LocalHelper {
    pub worker: delulu_speech::CoordinatorWorker,
    pub profile: Arc<AppProfile>,
    pub asr: AsrService,
    pub provision: Arc<tokio::sync::Mutex<()>>,
}
impl HelperModel for LocalHelper {
    fn load(&self, download: bool) -> BoxFuture<'_, DomainResult<()>> {
        Box::pin(async move {
            if !download {
                return self.worker.load().await;
            }
            let _guard = self.provision.lock().await;
            self.asr.unload_magic().await?;
            let settings = self.profile.storage.get_settings();
            let install = delulu_runtime::InstallSettings {
                python_command: settings.python_command,
                speech_engine: serde_json::from_value(serde_json::to_value(settings.speech_engine)?)?,
                voice_engine: serde_json::from_value(serde_json::to_value(settings.voice_engine)?)?,
            };
            self.worker
                .setup(&install, |progress| {
                    if let Some(state) = AppState::get(&self.profile.app) {
                        state.voice.talk().setup_progress(&progress.message);
                    }
                })
                .await
        })
    }
    fn unload(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.worker.unload())
    }
    fn installed(&self) -> BoxFuture<'_, HelperInstall> {
        let (runtime, weights) = self.worker.installed();
        Box::pin(async move { HelperInstall { runtime, weights } })
    }
    fn decide(&self, text: String, context: Value) -> BoxFuture<'_, DomainResult<Value>> {
        Box::pin(async move { self.worker.decide(&text, &context).await })
    }
    fn reply(&self, text: String, context: Value, call: Value, result: String) -> BoxFuture<'_, DomainResult<Value>> {
        Box::pin(async move { self.worker.reply(&text, &context, &call, &result).await })
    }
}
