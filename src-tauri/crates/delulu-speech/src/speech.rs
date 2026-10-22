//! Wiring of the speech services, replacing the dictation, speech, magic,
//! paste-last and paste-recovery orchestration in `electron/main.ts` and the
//! service-side logic of `electron/ipc/{dictation,paste,runtime}.ts`.

use std::sync::{Arc, OnceLock};

use delulu_audio::Recorder;
use delulu_core::{emit, AppPaths, DomainError, DomainResult, SharedSink};
use delulu_desktop::{DeliveryTimings, MicrophonePermission, PasteService};
use delulu_domain::text::delivered_text;
use delulu_domain::{AppSettings, DeliveryState, LabRequest, PasteLastStatus, TranscriptRecord};
use tokio_util::sync::CancellationToken;

use crate::asr::{speech_engine_id, AsrService};
use crate::channels;
use crate::dictation::{DictationDeps, DictationService, WeakDictation};
use crate::paste_last::{PasteLastPorts, PasteLastService};
use crate::ports::{Delivery, Indicator};
use crate::profile::Profile;
use crate::support::{chars, plain};
use crate::transcripts::Transcripts;

/// Integrations owned by other services (voice, listening, tray).
#[derive(Clone)]
pub struct SpeechHooks {
    /// Before the microphone opens: `voice.interruptForDictation()` and
    /// `listening.pauseForDictation()`.
    pub before_capture: Arc<dyn Fn() + Send + Sync>,
    /// `listening.active`: a listening session keeps the speech model loaded.
    pub listening_active: Arc<dyn Fn() -> bool + Send + Sync>,
    /// After every speech status change, with `dictation.isActive`. The app
    /// calls `listening.resumeAfterDictation()` when inactive.
    pub runtime_status: Arc<dyn Fn(bool) + Send + Sync>,
    /// Something the tray shows changed (`rebuildTrayMenu`).
    pub changed: Arc<dyn Fn() + Send + Sync>,
    /// macOS microphone permission.
    pub microphone: Arc<dyn Fn() -> MicrophonePermission + Send + Sync>,
}

impl Default for SpeechHooks {
    fn default() -> Self {
        Self {
            before_capture: Arc::new(|| {}),
            listening_active: Arc::new(|| false),
            runtime_status: Arc::new(|_| {}),
            changed: Arc::new(|| {}),
            microphone: Arc::new(delulu_desktop::microphone_permission),
        }
    }
}

pub struct SpeechDeps {
    pub paths: AppPaths,
    pub profile: Arc<dyn Profile>,
    pub sink: SharedSink,
    /// Built by the app with [`Speech::paste_portal_hooks`] in its `PasteIo`.
    pub paste: PasteService,
    pub pill: Arc<dyn Indicator>,
    pub hooks: SpeechHooks,
}

/// The speech side of the app. Create inside a Tokio runtime.
pub struct Speech {
    pub asr: AsrService,
    pub dictation: DictationService,
    pub paste_last: PasteLastService,
    pub transcripts: Arc<Transcripts>,
    pub recorder: Recorder,
    paste: PasteService,
    profile: Arc<dyn Profile>,
}

impl Speech {
    /// `PasteIo.load_restore_token` / `save_restore_token` over the profile
    /// (`settings.pastePortalToken`).
    #[allow(clippy::type_complexity)]
    pub fn paste_portal_hooks(
        profile: Arc<dyn Profile>,
    ) -> (
        Arc<dyn Fn() -> Option<String> + Send + Sync>,
        Arc<dyn Fn(String) + Send + Sync>,
    ) {
        let reader = profile.clone();
        (
            Arc::new(move || {
                Some(reader.settings().paste_portal_token).filter(|token| !token.is_empty())
            }),
            Arc::new(move |token| profile.set_paste_portal_token(token)),
        )
    }

    pub fn new(deps: SpeechDeps) -> Self {
        let SpeechDeps {
            paths,
            profile,
            sink,
            paste,
            pill,
            hooks,
        } = deps;
        let asr = AsrService::new(paths.clone(), profile.clone(), sink.clone());
        let changed = hooks.changed.clone();
        let transcripts = Arc::new(Transcripts::new(profile.clone(), sink.clone(), move || {
            changed()
        }));
        let target: Arc<OnceLock<WeakDictation>> = Arc::new(OnceLock::new());
        let recorder = {
            let target = target.clone();
            Recorder::new(move |session, event| {
                if let Some(dictation) = target.get().and_then(WeakDictation::upgrade) {
                    dictation.handle_recorder_event(session, event);
                }
            })
        };
        let dictation = DictationService::new(DictationDeps {
            engine: Arc::new(asr.clone()),
            capture: Arc::new(recorder.clone()),
            delivery: Arc::new(paste.clone()),
            indicator: pill,
            profile: profile.clone(),
            transcripts: transcripts.clone(),
            sink: sink.clone(),
            paths,
            microphone: hooks.microphone.clone(),
            before_capture: hooks.before_capture.clone(),
        });
        let _ = target.set(dictation.downgrade());
        let paste_last = {
            let active = dictation.downgrade();
            let lookup = transcripts.clone();
            let record = transcripts.clone();
            let changed = hooks.changed.clone();
            let sink = sink.clone();
            PasteLastService::new(PasteLastPorts {
                capture_active: Arc::new(move || active.upgrade().is_some_and(|d| d.is_active())),
                current_text: Arc::new(move |id| {
                    lookup
                        .lookup(id)
                        .map(|record| delivered_text(&record).to_owned())
                }),
                delivery: Arc::new(paste.clone()),
                record: Arc::new(move |id, state, detail, method| {
                    if let Err(error) = record.record_delivery(id, state, detail, method) {
                        log::error!("Could not record delivery: {}", error.message);
                    }
                }),
                changed: Arc::new(move |status: &PasteLastStatus| {
                    emit(&*sink, channels::PASTE_LAST, status);
                    changed();
                }),
            })
        };
        {
            let dictation = dictation.downgrade();
            let listening = hooks.listening_active.clone();
            asr.set_idle_guard(move || {
                !dictation.upgrade().is_some_and(|d| d.is_active()) && !listening()
            });
        }
        {
            let dictation = dictation.downgrade();
            let paste_last = paste_last.clone();
            let hook = hooks.runtime_status.clone();
            asr.on_status(move |_| {
                let Some(dictation) = dictation.upgrade() else {
                    return;
                };
                let active = dictation.is_active();
                dictation.runtime_changed();
                if active {
                    paste_last.cancel_pending("Paste cancelled because a recording started.");
                }
                hook(active);
            });
        }
        {
            let dictation = dictation.downgrade();
            let changed = hooks.changed.clone();
            asr.on_magic_status(move |_| {
                if let Some(dictation) = dictation.upgrade() {
                    dictation.runtime_changed();
                }
                changed();
            });
        }
        Self {
            asr,
            dictation,
            paste_last,
            transcripts,
            recorder,
            paste,
            profile,
        }
    }

    /// Startup: checks both runtimes and applies preload settings.
    pub async fn initialize(&self) {
        self.asr.initialize(&self.profile.settings()).await;
    }

    /// Before quit: wipes retry audio, stops paste-last and the workers.
    /// The app shuts down the pill, paste service and shortcuts itself.
    pub async fn shutdown(&self) {
        self.dictation.release_retry_audio();
        self.paste_last.shutdown();
        self.recorder.cancel(None);
        self.asr.shutdown().await;
    }

    /// The `assertRuntimeIdle` guard of `runtime:*`/`magic:*` IPC.
    pub fn assert_runtime_idle(&self) -> DomainResult<()> {
        if self.dictation.is_active() || self.asr.is_busy() || self.paste.is_busy() {
            return Err(
                DomainError::busy("Finish the current recording or model operation first")
                    .with_operation(delulu_core::uuid(), "runtime:idle"),
            );
        }
        Ok(())
    }

    /// `runtime:setup`.
    pub async fn setup(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.setup(&self.profile.settings()).await
    }
    /// `runtime:load`.
    pub async fn load(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.load_model(&self.profile.settings()).await
    }
    /// `runtime:unload`.
    pub async fn unload(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.unload().await
    }
    /// `runtime:reset`.
    pub async fn reset(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.reset().await
    }
    /// `magic:setup`.
    pub async fn setup_magic(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.setup_magic(&self.profile.settings()).await
    }
    /// `magic:load`.
    pub async fn load_magic(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.load_magic(&self.profile.settings()).await
    }
    /// `magic:unload`.
    pub async fn unload_magic(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        self.asr.unload_magic().await
    }
    /// `magic:rewrite` (the request was validated by the IPC router).
    pub async fn rewrite(
        &self,
        request: delulu_domain::MagicRewriteRequest,
    ) -> DomainResult<delulu_domain::MagicRewriteResult> {
        if delulu_domain::js::trim(&request.text).is_empty() {
            return Err(plain("Add a transcript or draft before rewriting"));
        }
        self.assert_runtime_idle()?;
        self.asr
            .rewrite_magic(request, &self.profile.settings())
            .await
    }

    /// The model part of `models:deleteDownload`: unloads a loaded speech
    /// model so its files can be deleted.
    pub async fn release_speech_for_deletion(&self) -> DomainResult<()> {
        self.assert_runtime_idle()?;
        if self.asr.status().engine == delulu_domain::EnginePhase::Ready {
            self.asr.unload().await?;
        }
        self.assert_runtime_idle()
    }

    /// The idle check `applySettings` runs before and during a save.
    pub fn assert_engine_change_idle(
        &self,
        previous: &AppSettings,
        next: &AppSettings,
    ) -> DomainResult<()> {
        let engine_change = runtime_changed(previous, next)
            || next.magic_model != previous.magic_model
            || next.memory_policy != previous.memory_policy
            || next.magic_enabled != previous.magic_enabled;
        if engine_change && (self.dictation.is_active() || self.asr.is_busy()) {
            return Err(plain(
                "Finish the current recording or model operation before changing models",
            ));
        }
        Ok(())
    }

    /// Speech side effects of a saved settings change (`applySettings`):
    /// unloads replaced models, re-checks the runtime, applies residency and
    /// the overlay. Failures are logged; settings are already saved.
    pub async fn settings_changed(&self, previous: &AppSettings, saved: &AppSettings) {
        let speech_changed = runtime_changed(previous, saved);
        let magic_changed = saved.magic_model != previous.magic_model;
        if speech_changed {
            if let Err(error) = self.asr.unload().await {
                log::warn!("Speech model was not unloaded: {}", error.message);
            }
            // A new size may need packages the installed runtime lacks.
            if let Err(error) = self.asr.refresh_environment(saved).await {
                log::warn!("Speech runtime was not checked: {}", error.message);
            }
        }
        if magic_changed {
            if let Err(error) = self.asr.unload_magic().await {
                log::warn!("Rewrite model was not unloaded: {}", error.message);
            }
        }
        let residency_changed = saved.preload_model != previous.preload_model
            || saved.preload_magic_model != previous.preload_magic_model
            || saved.magic_enabled != previous.magic_enabled
            || saved.model_idle_minutes != previous.model_idle_minutes
            || saved.memory_policy != previous.memory_policy;
        if speech_changed || magic_changed || residency_changed {
            self.asr.configure_residency(saved);
        }
        if saved.show_overlay != previous.show_overlay {
            self.dictation.sync_overlay();
        }
    }

    /// `dictation:pasteLast` and the tray "Paste latest in Ns".
    pub fn schedule_paste_last(&self) -> DomainResult<PasteLastStatus> {
        let record = match self.transcripts.last() {
            Some(last) => self.transcripts.lookup(&last.id),
            None => self.profile.latest_history(),
        };
        let Some(record) = record else {
            return Err(plain("Record something first"));
        };
        self.paste_last.start(
            &record.id,
            delivered_text(&record),
            self.profile.settings().paste_last_delay_seconds,
        )
    }

    /// `paste:copyInstead`: copies the current text of the recovery's transcript.
    pub async fn copy_instead(&self, id: &str) -> DomainResult<()> {
        if self
            .transcripts
            .paste_recovery()
            .is_none_or(|recovery| recovery.transcript_id != id)
        {
            return Err(plain(
                "This paste recovery is no longer available. Open History to copy a retained transcript.",
            ));
        }
        // Resolve at the moment of the action: edits apply, deleted records never fall back to cached text.
        let Some(record) = self.transcripts.lookup(id) else {
            self.transcripts.set_paste_recovery(None);
            return Err(plain("The transcript was removed. Nothing was copied."));
        };
        if let Err(error) = Delivery::copy(
            &self.paste,
            delivered_text(&record),
            &mut DeliveryTimings::default(),
        )
        .await
        {
            let detail = chars(&error.message, 500);
            self.transcripts.set_paste_recovery(Some(delulu_domain::PasteRecovery {
                transcript_id: id.to_owned(),
                detail: format!(
                    "Copy failed: {detail}. Try Copy instead again, or open History to select the text manually."
                ),
            }));
            return Err(plain(
                "Copy failed. Try again or select the text in History.",
            ));
        }
        self.transcripts.set_paste_recovery(None);
        Ok(())
    }

    /// Tray "Copy …" items: copies a transcript and records the delivery.
    pub async fn copy_transcript(&self, record: &TranscriptRecord) -> DomainResult<()> {
        Delivery::copy(
            &self.paste,
            delivered_text(record),
            &mut DeliveryTimings::default(),
        )
        .await?;
        self.transcripts
            .record_delivery(&record.id, DeliveryState::Copied, None, None)
    }

    /// `lab:run` and the import-queue runner: transcribes one audio or video
    /// file (converted with FFmpeg when needed) into a saved transcript.
    /// The caller validates the path first.
    pub async fn transcribe_file(
        &self,
        path: &str,
        cancel: Option<CancellationToken>,
    ) -> DomainResult<TranscriptRecord> {
        self.dictation
            .run_lab(
                LabRequest {
                    path: path.to_owned(),
                },
                cancel,
            )
            .await
    }
}

/// Medium switches checkpoints with the language, so compare the loaded model.
fn runtime_changed(previous: &AppSettings, next: &AppSettings) -> bool {
    next.model != previous.model
        || next.speech_engine != previous.speech_engine
        || speech_engine_id(next) != speech_engine_id(previous)
}
