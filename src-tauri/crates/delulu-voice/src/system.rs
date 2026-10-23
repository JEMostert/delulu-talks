//! Voice orchestration moved out of `electron/main.ts` and
//! `electron/ipc/voice.ts`: service wiring, status events, the agent bridge
//! lifecycle and its handlers, settings changes, dictation coordination,
//! clipboard reading, tray items, launch flags and shutdown. The app crate
//! routes IPC channels to these methods and builds menus from
//! [`VoiceSystem::tray_items`].
//!
//! Events emitted through the sink: `voice:statusChanged` ([`VoiceStatus`]),
//! `listen:statusChanged` ([`ListenStatus`]), and from [`Talk`]
//! `talk:statusChanged` and `talk:level`.

use std::sync::Arc;

use delulu_core::{emit, DomainError, DomainResult, SharedSink};
use delulu_desktop::ClipboardBackend;
use delulu_domain::listening::{ListenStatus, VoiceSkillInstall};
use delulu_domain::voice::{VoiceAgentSetup, VoiceSource, VoiceSpeakRequest, VoiceSpeakResult, VoiceStatus};
use delulu_domain::{AppSettings, EnginePhase};
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::agent::{agent_executable, install_voice_skill, refresh_legacy_agent_script, voice_agent_setup};
use crate::bridge::{BridgeHandlers, BridgeResult, SpeakReply, VoiceBridge, VoiceBridgeSnapshot, INJECT_METHOD};
use crate::host::{BoxFuture, ListenTranscriber, VoiceProfile};
use crate::inbox::Inbox;
use crate::listening::{ListenBackend, ListeningService, NativeListenBackend, SpeechOutput};
use crate::service::{VoiceOptions, VoiceService};
use crate::talk::{HelperModel, Talk};

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
    inbox: Inbox,
    talk: Talk,
    bridge: tokio::sync::Mutex<Option<Arc<VoiceBridge>>>,
    profile: Arc<dyn VoiceProfile>,
    clipboard: Arc<dyn ClipboardBackend>,
    app_version: String,
    runtime: tokio::runtime::Handle,
}

/// Voice output, Talk (listening and routing), the agent inbox and the agent
/// bridge. Cheap to clone; construct inside a Tokio runtime.
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
        let inbox = Inbox::open(config.profile.paths().voice_dir());
        let talk =
            Talk::new(config.profile.clone(), voice.clone(), listening.clone(), inbox.clone(), config.sink.clone());
        Self {
            inner: Arc::new(Inner {
                inbox,
                talk,
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

    pub fn talk(&self) -> &Talk {
        &self.inner.talk
    }

    pub fn inbox(&self) -> &Inbox {
        &self.inner.inbox
    }

    pub fn set_helper_model(&self, model: Arc<dyn HelperModel>) {
        self.inner.talk.set_helper_model(model);
    }

    pub fn voice(&self) -> &VoiceService {
        &self.inner.voice
    }

    pub fn listening(&self) -> &ListeningService {
        &self.inner.listening
    }

    /// App start: the agent bridge (when enabled), the voice runtime check and
    /// the helper install check.
    pub async fn start(&self) {
        let settings = self.inner.profile.settings();
        tokio::join!(self.sync_bridge(&settings), self.inner.voice.initialize(&settings), self.inner.talk.refresh());
    }

    /// Saved settings changed (`persistSettings` in main.ts).
    pub async fn settings_changed(&self, previous: &AppSettings, saved: &AppSettings) {
        self.inner.voice.settings_changed(previous, saved).await;
        self.inner.talk.settings_changed(previous, saved).await;
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
    /// answering by voice stops Delulu talking, and Talk leaves the
    /// microphone to dictation until it finishes.
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
                        inbox: self.inner.inbox.clone(),
                        talk: self.inner.talk.clone(),
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
        if self.inner.talk.is_on() {
            items.push(VoiceTrayItem {
                label: "Stop listening".into(),
                enabled: true,
                action: VoiceTrayAction::StopListening,
            });
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
                self.inner.talk.stop("Stopped from the tray").await;
                None
            }
            VoiceTrayAction::StopSpeaking => {
                self.inner.voice.stop("tray");
                None
            }
            VoiceTrayAction::ReadClipboard => self.read_clipboard_aloud().await,
        }
    }

    /// `voice:agentSetup`.
    pub fn agent_setup(&self) -> VoiceAgentSetup {
        voice_agent_setup(&agent_executable(), cfg!(windows))
    }

    /// `voice:installSkill`.
    pub fn install_skill(&self) -> DomainResult<VoiceSkillInstall> {
        install_voice_skill(self.inner.profile.paths(), &self.agent_setup())
    }

    /// Quitting: stop the bridge, end Talk and release the voice worker.
    pub async fn shutdown(&self) {
        let bridge = self.inner.bridge.lock().await.clone();
        self.inner.talk.shutdown().await;
        self.inner.listening.shutdown();
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

fn encoded(value: impl serde::Serialize) -> DomainResult<Value> {
    serde_json::to_value(value).map_err(|error| DomainError::failed(error.to_string()))
}

/// The bridge handlers `syncVoiceBridge` built in main.ts.
struct AppBridge {
    voice: VoiceService,
    inbox: Inbox,
    talk: Talk,
    profile: Arc<dyn VoiceProfile>,
}

impl BridgeHandlers for AppBridge {
    fn speak(&self, mut request: VoiceSpeakRequest, wait: bool) -> BoxFuture<'static, BridgeResult<SpeakReply>> {
        request.source = Some(VoiceSource::Agent);
        let queued = self.talk.speak_for_agent(request);
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

    fn dispatch(&self, method: String, params: Value, cancel: CancellationToken) -> BoxFuture<'static, BridgeResult<Value>> {
        let (inbox, talk) = (self.inbox.clone(), self.talk.clone());
        Box::pin(async move {
            let result = match method.as_str() {
                "talk.status" => encoded(talk.status()),
                INJECT_METHOD if cfg!(debug_assertions) => {
                    let text = params.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
                    talk.inject(text).await.and_then(encoded)
                }
                _ => inbox.dispatch(&method, params, cancel).await,
            };
            Ok(result?)
        })
    }
}
