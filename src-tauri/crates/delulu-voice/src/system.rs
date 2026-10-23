//! Voice orchestration moved out of `electron/main.ts` and
//! `electron/ipc/voice.ts`: service wiring, status events, the agent bridge
//! lifecycle and its handlers, settings changes, dictation coordination,
//! clipboard reading, tray items, launch flags and shutdown. The app crate
//! routes IPC channels to these methods and builds menus from
//! [`VoiceSystem::tray_items`].
//!
//! Events emitted through the sink: `voice:statusChanged` ([`VoiceStatus`])
//! and `listen:statusChanged` ([`ListenStatus`]).

use std::sync::Arc;

use delulu_core::{emit, DomainResult, SharedSink};
use delulu_desktop::ClipboardBackend;
use delulu_domain::listening::{ListenNextResult, ListenSessionInfo, ListenStatus, VoiceSkillInstall};
use delulu_domain::voice::{VoiceAgentSetup, VoiceSource, VoiceSpeakRequest, VoiceSpeakResult, VoiceStatus};
use delulu_domain::{AppSettings, EnginePhase};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::agent::{agent_executable, install_voice_skill, refresh_legacy_agent_script, voice_agent_setup};
use crate::bridge::{BridgeHandlers, BridgeResult, SpeakReply, VoiceBridge, VoiceBridgeSnapshot};
use crate::coordinator::{Coordinator, CoordinatorModel};
use crate::host::{BoxFuture, ListenTranscriber, VoiceProfile};
use crate::listening::{ListenBackend, ListeningService, NativeListenBackend, SpeechOutput};
use crate::service::{VoiceOptions, VoiceService};

pub struct VoiceSystemConfig {
    pub profile: Arc<dyn VoiceProfile>,
    pub transcriber: Arc<dyn ListenTranscriber>,
    pub sink: SharedSink,
    pub clipboard: Arc<dyn ClipboardBackend>,
    /// `app.getVersion()`, reported to agents.
    pub app_version: String,
    /// Called when the voice or listening part of the tray menu changes.
    pub on_tray_change: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceTrayAction {
    StopListening,
    StopSpeaking,
    ReadClipboard,
}

/// One tray menu entry; the app puts a separator before the voice items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceTrayItem {
    pub label: String,
    pub enabled: bool,
    pub action: VoiceTrayAction,
}

struct Inner {
    voice: VoiceService,
    listening: ListeningService,
    coordinator: Coordinator,
    bridge: tokio::sync::Mutex<Option<Arc<VoiceBridge>>>,
    profile: Arc<dyn VoiceProfile>,
    clipboard: Arc<dyn ClipboardBackend>,
    app_version: String,
    runtime: tokio::runtime::Handle,
}

/// Voice output, listening sessions and the agent bridge. Cheap to clone;
/// construct inside a Tokio runtime.
#[derive(Clone)]
pub struct VoiceSystem {
    inner: Arc<Inner>,
}

impl VoiceSystem {
    /// Native playback and capture.
    pub fn new(config: VoiceSystemConfig) -> Self {
        let (voice, player) = VoiceService::with_player(config.profile.clone(), VoiceOptions::default());
        Self::with_parts(config, voice, Arc::new(NativeListenBackend::new(Some(player))))
    }

    /// Custom voice service and microphone backend (tests).
    pub fn with_parts(config: VoiceSystemConfig, voice: VoiceService, backend: Arc<dyn ListenBackend>) -> Self {
        let speech: Arc<dyn SpeechOutput> = Arc::new(voice.clone());
        let listening = ListeningService::new(config.profile.clone(), config.transcriber.clone(), speech, backend);
        let tray = config.on_tray_change.clone();
        let sink = config.sink.clone();
        let voice_phase = Mutex::new(String::new());
        let voice_tray = tray.clone();
        voice.on_status(move |status: &VoiceStatus| {
            emit(sink.as_ref(), "voice:statusChanged", status);
            let phase = format!(
                "{}:{}:{}",
                status.engine,
                status.phase,
                status.current.as_ref().and_then(|current| current.agent.as_deref()).unwrap_or("")
            );
            if std::mem::replace(&mut *voice_phase.lock(), phase.clone()) != phase {
                if let Some(tray) = &voice_tray {
                    tray();
                }
            }
        });
        let sink = config.sink.clone();
        let listen_key = Mutex::new(String::new());
        listening.on_status(move |status: &ListenStatus| {
            emit(sink.as_ref(), "listen:statusChanged", status);
            let key = format!(
                "{}:{}",
                status.session.as_ref().map(|session| session.state.as_str()).unwrap_or(""),
                status.capturing
            );
            if std::mem::replace(&mut *listen_key.lock(), key.clone()) != key {
                if let Some(tray) = &tray {
                    tray();
                }
            }
        });
        let coordinator =
            Coordinator::new(config.profile.clone(), voice.clone(), listening.clone(), config.sink.clone());
        coordinator.attach_listener();
        Self {
            inner: Arc::new(Inner {
                coordinator,
                voice,
                listening,
                bridge: tokio::sync::Mutex::new(None),
                profile: config.profile,
                clipboard: config.clipboard,
                app_version: config.app_version,
                runtime: tokio::runtime::Handle::current(),
            }),
        }
    }

    pub fn coordinator(&self) -> &Coordinator {
        &self.inner.coordinator
    }
    pub fn set_coordinator_model(&self, model: Arc<dyn CoordinatorModel>) {
        self.inner.coordinator.set_model(model);
    }

    pub fn voice(&self) -> &VoiceService {
        &self.inner.voice
    }

    pub fn listening(&self) -> &ListeningService {
        &self.inner.listening
    }

    /// App start: the agent bridge (when enabled) and the voice runtime check.
    pub async fn start(&self) {
        let settings = self.inner.profile.settings();
        tokio::join!(self.sync_bridge(&settings), self.inner.voice.initialize(&settings));
    }

    /// Saved settings changed (`persistSettings` in main.ts).
    pub async fn settings_changed(&self, previous: &AppSettings, saved: &AppSettings) {
        self.inner.voice.settings_changed(previous, saved).await;
        if previous.voice_coordinator_mode != saved.voice_coordinator_mode {
            self.inner.coordinator.unload().await;
            self.inner.listening.stop_active("Voice helper selection changed");
        }
        if saved.voice_agent_bridge != previous.voice_agent_bridge {
            self.sync_bridge(saved).await;
        }
        if saved.listen_sensitivity != previous.listen_sensitivity
            || saved.listen_silence_ms != previous.listen_silence_ms
            || saved.listen_barge_in != previous.listen_barge_in
            || saved.listen_barge_in_ms != previous.listen_barge_in_ms
            || saved.input_device_id != previous.input_device_id
        {
            self.inner.listening.settings_changed(saved);
        }
    }

    /// Dictation is about to open the microphone (`dictation.beforeCapture`):
    /// answering by voice stops Delulu talking, and a listening session
    /// leaves the microphone to dictation until it finishes.
    pub fn before_dictation_capture(&self) {
        self.inner.voice.interrupt_for_dictation();
        self.inner.listening.pause_for_dictation();
    }

    /// The speech status changed while no dictation is active.
    pub fn dictation_finished(&self) {
        self.inner.listening.resume_after_dictation();
    }

    /// Start or stop the local agent bridge to match settings (`syncVoiceBridge`).
    pub async fn sync_bridge(&self, settings: &AppSettings) {
        let mut slot = self.inner.bridge.lock().await;
        if !settings.voice_agent_bridge {
            if let Some(bridge) = slot.as_ref() {
                bridge.stop().await;
            }
            return;
        }
        let bridge = slot
            .get_or_insert_with(|| {
                let voice = self.inner.voice.clone();
                Arc::new(VoiceBridge::new(
                    self.inner.profile.paths().voice_dir(),
                    self.inner.app_version.clone(),
                    Arc::new(AppBridge {
                        voice: self.inner.voice.clone(),
                        coordinator: self.inner.coordinator.clone(),
                        listening: self.inner.listening.clone(),
                        profile: self.inner.profile.clone(),
                    }),
                    move |status| voice.set_bridge_status(status),
                ))
            })
            .clone();
        drop(slot);
        refresh_legacy_agent_script(self.inner.profile.paths());
        if let Err(error) = bridge.start().await {
            log::error!("Voice bridge did not start: {error}");
        }
    }

    fn clipboard_text(&self) -> String {
        self.inner.clipboard.read().ok().and_then(|snapshot| snapshot.text).unwrap_or_default().trim().to_owned()
    }

    fn clipboard_request(text: String) -> VoiceSpeakRequest {
        VoiceSpeakRequest {
            text,
            source: Some(VoiceSource::Clipboard),
            agent: None,
            interrupt: Some(true),
            normalize: None,
            response_id: None,
        }
    }

    /// `voice:speakClipboard`: `None` when the clipboard has no text.
    pub async fn speak_clipboard(&self) -> DomainResult<Option<VoiceSpeakResult>> {
        let text = self.clipboard_text();
        if text.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.inner.voice.speak(Self::clipboard_request(text)).await?))
    }

    /// Tray, shortcut or `--read-clipboard`: speak the clipboard, interrupting
    /// current speech. Returns a message to show as a notification, if any.
    pub async fn read_clipboard_aloud(&self) -> Option<String> {
        let text = self.clipboard_text();
        if text.is_empty() {
            return Some("The clipboard has no text to read aloud.".into());
        }
        match self.inner.voice.speak(Self::clipboard_request(text)).await {
            Ok(result) => {
                result.error.filter(|_| result.outcome == delulu_domain::voice::VoiceUtteranceOutcome::Failed)
            }
            Err(error) => Some(error.message),
        }
    }

    /// Second-instance flags (`--read-clipboard`, `--stop-speaking`). Returns
    /// false when `argv` holds neither; clipboard notifications go to `notify`.
    /// Callable from any thread.
    pub fn handle_launch_args(&self, argv: &[String], notify: impl Fn(String) + Send + 'static) -> bool {
        if argv.iter().any(|arg| arg == "--read-clipboard") {
            let this = self.clone();
            self.inner.runtime.spawn(async move {
                if let Some(message) = this.read_clipboard_aloud().await {
                    notify(message);
                }
            });
            true
        } else if argv.iter().any(|arg| arg == "--stop-speaking") {
            self.inner.voice.stop("launch");
            true
        } else {
            false
        }
    }

    /// The voice part of the tray menu (`voiceMenuItems`).
    pub fn tray_items(&self, settings: &AppSettings) -> Vec<VoiceTrayItem> {
        let mut items = Vec::new();
        if self.inner.listening.active() {
            if let Some(session) = self.inner.listening.get_status().session {
                items.push(VoiceTrayItem {
                    label: format!("Stop listening ({})", session.client),
                    enabled: true,
                    action: VoiceTrayAction::StopListening,
                });
            }
        }
        if !settings.voice_enabled {
            return items;
        }
        let status = self.inner.voice.get_status();
        if self.inner.voice.is_speaking() {
            items.push(VoiceTrayItem {
                label: match status.current.as_ref().and_then(|current| current.agent.as_deref()) {
                    Some(agent) => format!("Stop speaking ({agent})"),
                    None => "Stop speaking".into(),
                },
                enabled: true,
                action: VoiceTrayAction::StopSpeaking,
            });
        }
        items.push(VoiceTrayItem {
            label: "Read clipboard aloud".into(),
            enabled: !matches!(status.engine, EnginePhase::Missing | EnginePhase::SettingUp),
            action: VoiceTrayAction::ReadClipboard,
        });
        items
    }

    /// Runs a tray item. Returns a message to show as a notification, if any.
    pub async fn tray_action(&self, action: VoiceTrayAction) -> Option<String> {
        match action {
            VoiceTrayAction::StopListening => {
                self.inner.coordinator.stop_listening();
                self.inner.listening.stop_active("Stopped from the tray");
                None
            }
            VoiceTrayAction::StopSpeaking => {
                self.inner.voice.stop("tray");
                None
            }
            VoiceTrayAction::ReadClipboard => self.read_clipboard_aloud().await,
        }
    }

    /// `listen:start` from the Voice page.
    pub async fn listen_start(&self) -> DomainResult<ListenStatus> {
        if self.inner.coordinator.enabled() {
            return self.inner.coordinator.start_listening().await;
        }
        self.inner.listening.start("delulu").await.map_err(|error| error.into_domain())?;
        Ok(self.inner.listening.get_status())
    }

    /// `listen:stop` from the Voice page.
    pub fn listen_stop(&self) -> ListenStatus {
        self.inner.coordinator.stop_listening();
        self.inner.listening.stop_active("Stopped in Delulu Talks");
        self.inner.listening.get_status()
    }

    /// `voice:agentSetup`.
    pub fn agent_setup(&self) -> VoiceAgentSetup {
        voice_agent_setup(&agent_executable(), cfg!(windows))
    }

    /// `voice:installSkill`.
    pub fn install_skill(&self) -> DomainResult<VoiceSkillInstall> {
        install_voice_skill(self.inner.profile.paths(), &self.agent_setup())
    }

    /// Quitting: stop the bridge, end listening and release the voice worker.
    pub async fn shutdown(&self) {
        let bridge = self.inner.bridge.lock().await.clone();
        self.inner.listening.shutdown();
        self.inner.coordinator.shutdown().await;
        self.inner.listening.finish_transcriptions().await;
        tokio::join!(
            async {
                if let Some(bridge) = bridge {
                    bridge.stop().await;
                }
            },
            self.inner.voice.shutdown()
        );
    }
}

/// The bridge handlers `syncVoiceBridge` built in main.ts.
struct AppBridge {
    voice: VoiceService,
    listening: ListeningService,
    coordinator: Coordinator,
    profile: Arc<dyn VoiceProfile>,
}

impl BridgeHandlers for AppBridge {
    fn coordinate(
        &self,
        method: String,
        params: serde_json::Value,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, BridgeResult<serde_json::Value>> {
        let coordinator = self.coordinator.clone();
        Box::pin(async move { coordinator.dispatch(&method, params, cancel).await.map_err(Into::into) })
    }
    fn speak(&self, mut request: VoiceSpeakRequest, wait: bool) -> BoxFuture<'static, BridgeResult<SpeakReply>> {
        request.source = Some(VoiceSource::Agent);
        let queued = if self.coordinator.enabled() {self.coordinator.enqueue_agent(request)} else {self.voice.enqueue(request)};
        Box::pin(async move {
            let handle = queued?;
            Ok(if wait { SpeakReply::Done(handle.done().await) } else { SpeakReply::Queued(handle.queued) })
        })
    }

    fn stop(&self) -> BoxFuture<'static, BridgeResult<()>> {
        self.voice.stop("agent");
        Box::pin(async { Ok(()) })
    }

    fn status(&self) -> VoiceBridgeSnapshot {
        let status = self.voice.get_status();
        let settings = self.profile.settings();
        VoiceBridgeSnapshot {
            enabled: settings.voice_enabled,
            ready: !matches!(status.engine, EnginePhase::Missing | EnginePhase::SettingUp | EnginePhase::Error),
            engine: settings.voice_engine,
            speaking: self.voice.is_speaking(),
            queued: status.queued,
            message: if settings.voice_enabled {
                status.message
            } else {
                "Speaking out loud is turned off in Delulu Talks.".into()
            },
        }
    }

    fn listen_start(&self, client: String) -> BoxFuture<'static, BridgeResult<ListenSessionInfo>> {
        let listening = self.listening.clone();
        let enabled = self.coordinator.enabled();
        Box::pin(async move {
            if enabled {
                return Err(crate::BridgeError::new(
                    crate::BridgeErrorCode::SessionBusy,
                    "The local helper owns the microphone. Register an agent inbox with agent.register instead.",
                ));
            }
            Ok(listening.start(&client).await?)
        })
    }

    fn listen_next(
        &self,
        session_id: String,
        after: Option<u64>,
        timeout_ms: u64,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, BridgeResult<ListenNextResult>> {
        let listening = self.listening.clone();
        Box::pin(async move { Ok(listening.next(&session_id, after, timeout_ms, Some(cancel)).await?) })
    }

    fn listen_ack(&self, session_id: &str, after: u64) -> BridgeResult<ListenSessionInfo> {
        Ok(self.listening.ack(session_id, after)?)
    }

    fn listen_status(&self, session_id: Option<&str>) -> BridgeResult<Option<ListenSessionInfo>> {
        Ok(self.listening.status(session_id)?)
    }

    fn listen_stop(&self, session_id: String) -> BoxFuture<'static, BridgeResult<ListenSessionInfo>> {
        let result = self.listening.stop(&session_id, "Stopped by request");
        Box::pin(async move { Ok(result?) })
    }
}
