//! Fakes for the worker, playback, capture, transcriber and profile.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use delulu_audio::{ListenEvent as CaptureEvent, PlaybackChunk, PlaybackEvent, PlaybackEventKind};
use delulu_core::{AppPaths, DomainResult};
use delulu_domain::listening::{ListenNextResult, ListenSessionInfo};
use delulu_domain::voice::{VoiceEngineId, VoiceSpeakRequest};
use delulu_domain::AppSettings;
use delulu_voice::{
    BoxFuture, BridgeError, BridgeHandlers, BridgeResult, CaptureCommand, CaptureEvents, ListenBackend,
    ListenTranscriber, ListeningService, SpeakReply, SpeechOutput, VoiceBridge, VoiceBridgeSnapshot, VoiceOptions,
    VoicePlayback, VoiceProfile, VoiceService, VoiceWorker,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub async fn until(check: impl Fn() -> bool, label: &str) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("Timed out waiting for {label}");
}

/* Profile */

pub struct FakeProfile {
    settings: Mutex<AppSettings>,
    paths: AppPaths,
}

impl FakeProfile {
    pub fn new(dir: &Path, patch: impl FnOnce(&mut AppSettings)) -> Arc<Self> {
        let mut settings = AppSettings { voice_enabled: true, ..AppSettings::default() };
        patch(&mut settings);
        Arc::new(Self { settings: Mutex::new(settings), paths: AppPaths::at(dir, dir) })
    }

    pub fn set(&self, patch: impl FnOnce(&mut AppSettings)) {
        patch(&mut self.settings.lock());
    }
}

impl VoiceProfile for FakeProfile {
    fn settings(&self) -> AppSettings {
        self.settings.lock().clone()
    }
    fn paths(&self) -> &AppPaths {
        &self.paths
    }
    fn persist_settings(&self, patch: Value) -> BoxFuture<'_, DomainResult<AppSettings>> {
        let mut value = serde_json::to_value(self.settings()).unwrap();
        for (key, item) in patch.as_object().unwrap() {
            value[key] = item.clone();
        }
        let saved: AppSettings = serde_json::from_value(value).unwrap();
        *self.settings.lock() = saved.clone();
        Box::pin(async move { Ok(saved) })
    }
}

/* Worker */

pub struct FakeWorker {
    running: AtomicBool,
    pub commands: Mutex<Vec<String>>,
    pub synthesized: Mutex<Vec<Value>>,
    duration_ms: f64,
    profile: Arc<FakeProfile>,
}

impl VoiceWorker for FakeWorker {
    fn request(&self, command: &str, payload: Value, _timeout: Option<Duration>) -> BoxFuture<'static, DomainResult<Value>> {
        self.commands.lock().push(command.to_owned());
        self.running.store(true, Ordering::SeqCst);
        let engine = self.profile.settings().voice_engine;
        let result = match command {
            "voiceLoad" => json!({
                "loaded": true, "model": "test", "device": "cpu", "residency": "resident",
                "warmup": "complete", "engine": payload["engine"],
            }),
            "voiceSynthesize" => {
                self.synthesized.lock().push(payload);
                json!({
                    "sampleRate": 24_000,
                    "audio": "AAAAAAAAAAA=",
                    "durationMs": self.duration_ms,
                    "processingTimeMs": 5,
                    "engine": engine,
                    "device": "cpu",
                    "unsupported": if engine == VoiceEngineId::Kokoro { vec!["laugh"] } else { vec![] },
                })
            }
            _ => json!({ "loaded": false, "model": null, "device": null, "residency": "unloaded", "warmup": "not-started", "engine": null }),
        };
        Box::pin(async move {
            tokio::task::yield_now().await;
            Ok(result)
        })
    }
    fn stop_and_wait(&self) -> BoxFuture<'static, ()> {
        self.running.store(false, Ordering::SeqCst);
        Box::pin(async {})
    }
    fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn busy(&self) -> bool {
        false
    }
}

/* Playback */

pub struct FakePlayback {
    pub played: Mutex<Vec<PlaybackChunk>>,
    pub stops: Mutex<Vec<Option<String>>>,
    autoplay: bool,
    service: OnceLock<VoiceService>,
}

impl VoicePlayback for FakePlayback {
    fn play(&self, chunk: PlaybackChunk) -> bool {
        self.played.lock().push(chunk.clone());
        if self.autoplay {
            let service = self.service.get().cloned().expect("service bound");
            tokio::spawn(async move {
                for event in [PlaybackEventKind::Started, PlaybackEventKind::Ended] {
                    service.playback_event(PlaybackEvent {
                        utterance_id: chunk.utterance_id.clone(),
                        chunk: chunk.chunk,
                        event,
                        message: None,
                    });
                }
            });
        }
        true
    }
    fn stop(&self, utterance_id: Option<&str>) {
        self.stops.lock().push(utterance_id.map(str::to_owned));
    }
}

pub struct VoiceFixture {
    pub dir: tempfile::TempDir,
    pub profile: Arc<FakeProfile>,
    pub worker: Arc<FakeWorker>,
    pub playback: Arc<FakePlayback>,
    pub service: VoiceService,
}

pub fn voice_fixture(patch: impl FnOnce(&mut AppSettings), duration_ms: f64, autoplay: bool, ready: bool) -> VoiceFixture {
    let dir = tempfile::tempdir().unwrap();
    let profile = FakeProfile::new(dir.path(), patch);
    let worker = Arc::new(FakeWorker {
        running: AtomicBool::new(false),
        commands: Mutex::new(Vec::new()),
        synthesized: Mutex::new(Vec::new()),
        duration_ms,
        profile: profile.clone(),
    });
    let playback = Arc::new(FakePlayback {
        played: Mutex::new(Vec::new()),
        stops: Mutex::new(Vec::new()),
        autoplay,
        service: OnceLock::new(),
    });
    let service = VoiceService::new(
        profile.clone(),
        playback.clone(),
        VoiceOptions { worker: Some(worker.clone()), ready: Some(Arc::new(move |_: &AppSettings| ready)) },
    );
    let _ = playback.service.set(service.clone());
    VoiceFixture { dir, profile, worker, playback, service }
}

/* Listening */

#[derive(Default)]
pub struct FakeTranscriber {
    pub prepared: AtomicUsize,
    pub transcripts: Mutex<VecDeque<String>>,
}

impl ListenTranscriber for FakeTranscriber {
    fn prepare(&self, _settings: &AppSettings) -> BoxFuture<'_, DomainResult<()>> {
        self.prepared.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
    fn transcribe(&self, audio_path: &Path, _duration_ms: u64) -> BoxFuture<'_, DomainResult<String>> {
        assert!(audio_path.exists(), "the utterance WAV is written before transcription");
        let text = self.transcripts.lock().pop_front().unwrap_or_default();
        Box::pin(async move { Ok(text) })
    }
}

#[derive(Default)]
pub struct FakeSpeech {
    pub interrupted: Mutex<Vec<String>>,
}

impl SpeechOutput for FakeSpeech {
    fn interrupt_speech(&self) -> Vec<String> {
        self.interrupted.lock().clone()
    }
    fn recently_spoken(&self) -> Vec<String> {
        vec!["All two hundred tests pass and the fix is merged.".into()]
    }
}

#[derive(Default)]
pub struct FakeBackend {
    pub commands: Mutex<Vec<CaptureCommand>>,
}

impl ListenBackend for FakeBackend {
    fn command(&self, command: CaptureCommand, _events: &CaptureEvents) -> bool {
        self.commands.lock().push(command);
        true
    }
}

pub struct ListenFixture {
    pub dir: tempfile::TempDir,
    pub service: ListeningService,
    pub transcriber: Arc<FakeTranscriber>,
    pub speech: Arc<FakeSpeech>,
    pub backend: Arc<FakeBackend>,
}

pub fn listen_fixture() -> ListenFixture {
    let dir = tempfile::tempdir().unwrap();
    let profile = FakeProfile::new(dir.path(), |_| {});
    let transcriber = Arc::new(FakeTranscriber::default());
    let speech = Arc::new(FakeSpeech::default());
    let backend = Arc::new(FakeBackend::default());
    let service = ListeningService::new(profile, transcriber.clone(), speech.clone(), backend.clone());
    ListenFixture { dir, service, transcriber, speech, backend }
}

impl ListenFixture {
    /// The user says `text`; resolves once it was transcribed.
    pub async fn say(&self, session_id: &str, text: &str) {
        self.transcriber.transcripts.lock().push_back(text.to_owned());
        self.service.capture_event(
            session_id,
            CaptureEvent::Utterance { wav: vec![0; 64], duration_ms: 1500, speech_ms: 1200, overlapped_playback: false },
        );
        let service = self.service.clone();
        until(move || !service.status(Some(session_id)).unwrap().unwrap().transcribing, "transcription").await;
    }

    pub fn barge_in(&self, session_id: &str, responses: &[&str]) {
        *self.speech.interrupted.lock() = responses.iter().map(|id| id.to_string()).collect();
        self.service.capture_event(session_id, CaptureEvent::BargeIn { utterance_ids: Vec::new() });
    }
}

/* Bridge */

pub type SpeakFn = Arc<dyn Fn(VoiceSpeakRequest, bool) -> BoxFuture<'static, BridgeResult<SpeakReply>> + Send + Sync>;

pub struct TestHandlers {
    pub speak_calls: Mutex<Vec<(VoiceSpeakRequest, bool)>>,
    pub stops: AtomicUsize,
    pub speak: Mutex<Option<SpeakFn>>,
    pub stop_error: Mutex<Option<BridgeError>>,
    pub snapshot: Mutex<VoiceBridgeSnapshot>,
    pub listen: ListenFixture,
}

pub fn snapshot() -> VoiceBridgeSnapshot {
    VoiceBridgeSnapshot {
        enabled: true,
        ready: true,
        engine: VoiceEngineId::Kokoro,
        speaking: false,
        queued: 0,
        message: "Ready".into(),
    }
}

impl TestHandlers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            speak_calls: Mutex::new(Vec::new()),
            stops: AtomicUsize::new(0),
            speak: Mutex::new(None),
            stop_error: Mutex::new(None),
            snapshot: Mutex::new(snapshot()),
            listen: listen_fixture(),
        })
    }
}

impl BridgeHandlers for TestHandlers {
    fn speak(&self, request: VoiceSpeakRequest, wait: bool) -> BoxFuture<'static, BridgeResult<SpeakReply>> {
        self.speak_calls.lock().push((request.clone(), wait));
        if let Some(speak) = self.speak.lock().clone() {
            return speak(request, wait);
        }
        let response_id = request.response_id.clone().unwrap_or_else(|| "r1".into());
        Box::pin(async move {
            Ok(if wait {
                SpeakReply::Done(serde_json::from_value(json!({
                    "id": "u1", "responseId": response_id, "outcome": "spoken", "durationMs": 4200,
                    "timestamps": [], "warnings": [], "unsupported": [],
                })).unwrap())
            } else {
                SpeakReply::Queued(serde_json::from_value(json!({ "id": "u1", "responseId": response_id, "position": 1 })).unwrap())
            })
        })
    }
    fn stop(&self) -> BoxFuture<'static, BridgeResult<()>> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let error = self.stop_error.lock().clone();
        Box::pin(async move { error.map_or(Ok(()), Err) })
    }
    fn status(&self) -> VoiceBridgeSnapshot {
        self.snapshot.lock().clone()
    }
    fn listen_start(&self, client: String) -> BoxFuture<'static, BridgeResult<ListenSessionInfo>> {
        let service = self.listen.service.clone();
        Box::pin(async move { Ok(service.start(&client).await?) })
    }
    fn listen_next(&self, session_id: String, after: Option<u64>, timeout_ms: u64, cancel: CancellationToken) -> BoxFuture<'static, BridgeResult<ListenNextResult>> {
        let service = self.listen.service.clone();
        Box::pin(async move { Ok(service.next(&session_id, after, timeout_ms, Some(cancel)).await?) })
    }
    fn listen_ack(&self, session_id: &str, after: u64) -> BridgeResult<ListenSessionInfo> {
        Ok(self.listen.service.ack(session_id, after)?)
    }
    fn listen_status(&self, session_id: Option<&str>) -> BridgeResult<Option<ListenSessionInfo>> {
        Ok(self.listen.service.status(session_id)?)
    }
    fn listen_stop(&self, session_id: String) -> BoxFuture<'static, BridgeResult<ListenSessionInfo>> {
        let result = self.listen.service.stop(&session_id, "Stopped by request");
        Box::pin(async move { Ok(result?) })
    }
}

pub struct StartedBridge {
    pub root: tempfile::TempDir,
    pub bridge: VoiceBridge,
    pub handlers: Arc<TestHandlers>,
    pub statuses: Arc<Mutex<Vec<delulu_domain::voice::VoiceBridgeStatus>>>,
    pub endpoint: String,
    pub token: String,
}

impl StartedBridge {
    pub fn bridge_file(&self) -> std::path::PathBuf {
        self.root.path().join("voice").join("bridge.json")
    }
}

pub async fn started_bridge(app_version: &str) -> StartedBridge {
    started_bridge_in(tempfile::tempdir().unwrap(), app_version, TestHandlers::new()).await
}

pub async fn started_bridge_in(root: tempfile::TempDir, app_version: &str, handlers: Arc<TestHandlers>) -> StartedBridge {
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let recorded = statuses.clone();
    let bridge = VoiceBridge::new(root.path().join("voice"), app_version, handlers.clone(), move |status| {
        recorded.lock().push(status)
    });
    bridge.start().await.unwrap();
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(root.path().join("voice").join("bridge.json")).unwrap()).unwrap();
    StartedBridge {
        endpoint: file["endpoint"].as_str().unwrap().to_owned(),
        token: file["token"].as_str().unwrap().to_owned(),
        root,
        bridge,
        handlers,
        statuses,
    }
}
