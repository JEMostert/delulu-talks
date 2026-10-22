//! Dictation pipeline behavior (ported from `dictation.test.ts`) and
//! paste-last, with fakes for the engine, recorder, delivery and storage.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use delulu_audio::{CaptureDiagnostics, RecorderEvent, RecorderOptions, Recording};
use delulu_core::{AppPaths, DomainError, DomainResult, RecordingSink};
use delulu_desktop::{DeliveryTimings, MicrophonePermission, MicrophoneState, PillCommand};
use delulu_domain::{
    AppSettings, CustomWord, DeliveryState, DictationPhase, DictationStatus, MagicPreset,
    MagicRewriteRequest, MagicRewriteResult, PasteLastPhase, RetryAudioState, TranscriptRecord,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::dictation::{DictationDeps, DictationService};
use crate::paste_last::{PasteLastPorts, PasteLastService};
use crate::ports::{Capture, Delivery, Indicator, SpeechEngine};
use crate::profile::Profile;
use crate::support::plain;
use crate::transcripts::Transcripts;

#[derive(Default)]
struct FakeProfile {
    settings: Mutex<AppSettings>,
    records: Mutex<Vec<TranscriptRecord>>,
    history_error: AtomicBool,
}

impl Profile for FakeProfile {
    fn settings(&self) -> AppSettings {
        self.settings.lock().clone()
    }
    fn set_paste_portal_token(&self, token: String) {
        self.settings.lock().paste_portal_token = token;
    }
    fn add_history(&self, record: &TranscriptRecord) -> DomainResult<()> {
        self.records.lock().push(record.clone());
        Ok(())
    }
    fn find_history(&self, id: &str) -> Option<TranscriptRecord> {
        self.records
            .lock()
            .iter()
            .find(|record| record.id == id)
            .cloned()
    }
    fn replace_history(&self, record: &TranscriptRecord) -> DomainResult<()> {
        if self.history_error.load(Ordering::SeqCst) {
            return Err(plain("Disk full"));
        }
        let mut records = self.records.lock();
        if let Some(slot) = records.iter_mut().find(|item| item.id == record.id) {
            *slot = record.clone();
        }
        Ok(())
    }
    fn latest_history(&self) -> Option<TranscriptRecord> {
        self.records.lock().last().cloned()
    }
    fn pinned_history_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn record_rule_usage(&self, _counts: &BTreeMap<String, u64>) {}
}

enum Inference {
    Text(Value),
    Fail(&'static str),
    Gate(oneshot::Receiver<Value>),
}

struct FakeEngine {
    status: Mutex<DictationStatus>,
    calls: Mutex<Vec<(AppSettings, Vec<u8>)>>,
    inference: Mutex<VecDeque<Inference>>,
    recovery: Mutex<Vec<bool>>,
}

impl FakeEngine {
    fn new() -> Self {
        Self {
            status: Mutex::new(
                serde_json::from_value(
                    json!({"phase": "idle", "engine": "ready", "message": "Ready"}),
                )
                .unwrap(),
            ),
            calls: Mutex::default(),
            inference: Mutex::default(),
            recovery: Mutex::default(),
        }
    }
    fn phase(&self) -> DictationPhase {
        self.status.lock().phase
    }
    fn message(&self) -> String {
        self.status.lock().message.clone()
    }
}

#[async_trait]
impl SpeechEngine for FakeEngine {
    fn status(&self) -> DictationStatus {
        self.status.lock().clone()
    }
    fn is_busy(&self) -> bool {
        false
    }
    fn set_activity(&self, phase: DictationPhase, message: &str, _detail: Option<&str>) {
        let mut status = self.status.lock();
        status.phase = phase;
        status.message = message.to_owned();
    }
    fn set_recovery(&self, available: bool, _retry_audio: RetryAudioState) {
        self.recovery.lock().push(available);
    }
    fn set_capture_input_notice(&self, message: Option<&str>) {
        self.status.lock().capture_input_notice = message.map(str::to_owned);
    }
    fn set_silence_countdown(&self, remaining_seconds: Option<f64>) {
        self.status.lock().silence_countdown_seconds = remaining_seconds;
    }
    async fn transcribe(&self, payload: Value, settings: &AppSettings) -> DomainResult<Value> {
        let audio = std::fs::read(payload["audioPath"].as_str().unwrap()).unwrap();
        self.calls.lock().push((settings.clone(), audio));
        let next = self.inference.lock().pop_front();
        match next {
            None => Ok(json!({"text": "Ship the release.", "recognizedLanguage": "en"})),
            Some(Inference::Text(value)) => Ok(value),
            Some(Inference::Fail(message)) => Err(plain(message)),
            Some(Inference::Gate(gate)) => Ok(gate.await.unwrap()),
        }
    }
    async fn rewrite(
        &self,
        _request: MagicRewriteRequest,
        _settings: &AppSettings,
    ) -> DomainResult<MagicRewriteResult> {
        Err(plain("Writing model unavailable"))
    }
}

#[derive(Default)]
struct FakeCapture {
    commands: Mutex<Vec<(String, String)>>,
    stop_error: Mutex<Option<DomainError>>,
}

impl FakeCapture {
    fn push(&self, action: &str, session: &str) {
        self.commands
            .lock()
            .push((action.to_owned(), session.to_owned()));
    }
    fn actions(&self) -> Vec<String> {
        self.commands
            .lock()
            .iter()
            .map(|(action, _)| action.clone())
            .collect()
    }
    fn last(&self) -> (String, String) {
        self.commands.lock().last().cloned().unwrap()
    }
}

impl Capture for FakeCapture {
    fn start(&self, options: RecorderOptions) -> DomainResult<()> {
        self.push("start", &options.session_id);
        Ok(())
    }
    fn pause(&self, session_id: &str) -> DomainResult<()> {
        self.push("pause", session_id);
        Ok(())
    }
    fn resume(&self, session_id: &str) -> DomainResult<()> {
        self.push("resume", session_id);
        Ok(())
    }
    fn stop(&self, session_id: &str) -> DomainResult<Recording> {
        self.push("stop", session_id);
        if let Some(error) = self.stop_error.lock().take() {
            return Err(error);
        }
        Ok(Recording {
            session_id: session_id.to_owned(),
            wav: vec![9; 64],
            duration_ms: 1200,
            diagnostics: CaptureDiagnostics {
                sample_count: 19_200,
                sample_rate: 16_000,
                peak_amplitude: 0.5,
                rms_amplitude: 0.1,
                clipped_sample_count: 0,
                clipping_threshold: 0.999,
            },
            capture_end_ms: 2.0,
            preprocessing_ms: 1.0,
        })
    }
    fn cancel(&self, session_id: &str) {
        self.push("cancel", session_id);
    }
}

#[derive(Default)]
struct FakeDelivery {
    deliveries: Mutex<Vec<String>>,
    error: Mutex<Option<DomainError>>,
    busy: AtomicBool,
}

#[async_trait]
impl Delivery for FakeDelivery {
    fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
    async fn paste(
        &self,
        text: &str,
        _restore: bool,
        timings: &mut DeliveryTimings,
    ) -> DomainResult<String> {
        self.deliveries.lock().push(text.to_owned());
        timings.paste_ms = Some(3.0);
        match self.error.lock().clone() {
            Some(error) => Err(error),
            None => Ok("fake-paste".into()),
        }
    }
    async fn copy(&self, text: &str, timings: &mut DeliveryTimings) -> DomainResult<()> {
        self.deliveries.lock().push(text.to_owned());
        timings.clipboard_ms = Some(1.0);
        Ok(())
    }
    fn clipboard_only(&self) -> bool {
        false
    }
}

struct NoIndicator;

impl Indicator for NoIndicator {
    fn show(&self, _command: PillCommand) {}
    fn hide(&self) {}
    fn level(&self, _value: f64) {}
}

struct Fixture {
    service: DictationService,
    engine: Arc<FakeEngine>,
    capture: Arc<FakeCapture>,
    delivery: Arc<FakeDelivery>,
    profile: Arc<FakeProfile>,
    transcripts: Arc<Transcripts>,
    cache: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn fixture(patch: impl FnOnce(&mut AppSettings)) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::at(dir.path(), dir.path());
    let mut settings = AppSettings::default();
    patch(&mut settings);
    let profile = Arc::new(FakeProfile {
        settings: Mutex::new(settings),
        ..FakeProfile::default()
    });
    let engine = Arc::new(FakeEngine::new());
    let capture = Arc::new(FakeCapture::default());
    let delivery = Arc::new(FakeDelivery::default());
    let sink = RecordingSink::new();
    let transcripts = Arc::new(Transcripts::new(profile.clone(), sink.clone(), || {}));
    let service = DictationService::new(DictationDeps {
        engine: engine.clone(),
        capture: capture.clone(),
        delivery: delivery.clone(),
        indicator: Arc::new(NoIndicator),
        profile: profile.clone(),
        transcripts: transcripts.clone(),
        sink,
        paths: paths.clone(),
        microphone: Arc::new(|| MicrophonePermission {
            state: MicrophoneState::Granted,
            can_request_capture: true,
            detail: "Allowed".into(),
        }),
        before_capture: Arc::new(|| {}),
    });
    Fixture {
        service,
        engine,
        capture,
        delivery,
        profile,
        transcripts,
        cache: paths.audio_cache(),
        _dir: dir,
    }
}

impl Fixture {
    fn start(&self) -> String {
        self.service.start();
        let (action, session) = self.capture.last();
        assert_eq!(action, "start", "capture did not start");
        session
    }

    async fn record(&self) -> String {
        let session = self.start();
        self.service
            .handle_recorder_event(&session, RecorderEvent::Started);
        self.service.stop();
        self.service.settle().await;
        session
    }

    fn records(&self) -> Vec<TranscriptRecord> {
        self.profile.records.lock().clone()
    }

    fn deliveries(&self) -> Vec<String> {
        self.delivery.deliveries.lock().clone()
    }

    fn cached_files(&self) -> usize {
        std::fs::read_dir(&self.cache)
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    async fn wait_for_inference(&self) {
        while self.engine.calls.lock().is_empty() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}

#[tokio::test]
async fn release_before_the_microphone_opens_stops_that_capture_once() {
    let f = fixture(|_| {});
    let session = f.start();
    f.service.stop();
    assert_eq!(f.capture.actions(), ["start"]);
    f.service
        .handle_recorder_event("foreign", RecorderEvent::Started);
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.settle().await;
    assert_eq!(f.capture.last(), ("stop".to_owned(), session.clone()));
    // A late duplicate start for the consumed session stays inert.
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.settle().await;
    assert_eq!(f.engine.calls.lock().len(), 1);
    assert_eq!(f.deliveries(), ["Ship the release."]);
    assert_eq!(f.records().len(), 1);
    assert_eq!(f.cached_files(), 0);
    assert!(!f.service.is_active());
}

#[tokio::test]
async fn failed_inference_retains_audio_and_captured_settings_for_one_successful_retry() {
    let f = fixture(|s| s.language = "en".into());
    f.engine
        .inference
        .lock()
        .push_back(Inference::Fail("Worker crashed"));
    f.record().await;
    assert!(f.deliveries().is_empty());
    assert_eq!(f.engine.phase(), DictationPhase::Error);
    assert_eq!(f.engine.recovery.lock().last(), Some(&true));
    assert_eq!(f.cached_files(), 0);
    f.profile.settings.lock().language = "nl".into();
    f.engine.inference.lock().push_back(Inference::Text(
        json!({"text": "Recovered words.", "recognizedLanguage": "en"}),
    ));
    f.service.retry().await.unwrap();
    let calls = f.engine.calls.lock().clone();
    assert_eq!(
        calls
            .iter()
            .map(|(s, _)| s.language.as_str())
            .collect::<Vec<_>>(),
        ["en", "en"]
    );
    assert_eq!(calls[1].1, vec![9; 64]);
    assert_eq!(f.deliveries(), ["Recovered words."]);
    assert_eq!(f.engine.recovery.lock().last(), Some(&false));
    let error = f.service.retry().await.unwrap_err();
    assert!(error.message.contains("No failed recording"));
    assert_eq!(f.cached_files(), 0);
}

#[tokio::test]
async fn paste_failures_report_clipboard_truth_and_never_offer_retry() {
    let cases = [
        (plain("Injector denied"), DeliveryState::Copied),
        (
            DomainError::failed("Clipboard denied").with_cause("ClipboardCopyError", None),
            DeliveryState::Transcribed,
        ),
    ];
    for (error, state) in cases {
        let f = fixture(|_| {});
        *f.delivery.error.lock() = Some(error.clone());
        f.record().await;
        let record = &f.records()[0];
        let delivery = record.delivery.as_ref().unwrap();
        assert_eq!(delivery.state, state);
        assert_eq!(delivery.detail.as_deref(), Some(error.message.as_str()));
        assert_eq!(f.deliveries(), ["Ship the release."]);
        assert_eq!(
            f.transcripts.paste_recovery().unwrap().transcript_id,
            record.id
        );
        assert!(f.service.retry().await.is_err());
    }
}

#[tokio::test]
async fn a_history_write_failure_after_paste_does_not_report_the_paste_as_failed() {
    let f = fixture(|_| {});
    f.profile.history_error.store(true, Ordering::SeqCst);
    f.record().await;
    assert_eq!(f.deliveries(), ["Ship the release."]);
    assert_eq!(f.engine.phase(), DictationPhase::Idle);
    assert_eq!(
        f.engine.message(),
        "Transcript: paste attempted — destination unconfirmed"
    );
    assert_ne!(
        f.records()[0].delivery.as_ref().unwrap().state,
        DeliveryState::Copied
    );
    assert!(f.service.retry().await.is_err());
}

#[tokio::test]
async fn rewrite_failure_holds_spoken_corrections_but_polishing_falls_back() {
    for preset in [MagicPreset::SpokenCorrections, MagicPreset::Polish] {
        let f = fixture(|s| {
            s.magic_enabled = true;
            s.magic_preset = preset;
        });
        f.record().await;
        let record = &f.records()[0];
        assert_eq!(record.text, "Ship the release.");
        let spoken = preset == MagicPreset::SpokenCorrections;
        assert_eq!(
            f.deliveries(),
            if spoken {
                vec![]
            } else {
                vec!["Ship the release.".to_owned()]
            }
        );
        assert_eq!(
            record.delivery.as_ref().unwrap().state,
            if spoken {
                DeliveryState::Transcribed
            } else {
                DeliveryState::PasteAttempted
            }
        );
    }
}

#[tokio::test]
async fn a_privacy_change_during_inference_prevents_persistence_while_capture_settings_govern_delivery(
) {
    let f = fixture(|s| {
        s.keep_history = true;
        s.auto_paste = false;
        s.copy_to_clipboard = true;
    });
    let (release, gate) = oneshot::channel();
    f.engine.inference.lock().push_back(Inference::Gate(gate));
    let session = f.start();
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.stop();
    f.wait_for_inference().await;
    {
        let mut settings = f.profile.settings.lock();
        settings.keep_history = false;
        settings.auto_paste = true;
    }
    // Presses while processing never start another capture.
    f.service.toggle();
    release
        .send(json!({"text": "Private words.", "recognizedLanguage": "en"}))
        .unwrap();
    f.service.settle().await;
    let record = &f.records()[0];
    assert_eq!(record.session_only, Some(true));
    assert_eq!(
        record.delivery.as_ref().unwrap().state,
        DeliveryState::Copied
    );
    assert_eq!(f.deliveries(), ["Private words."]);
    assert_eq!(
        f.capture.actions().iter().filter(|a| *a == "start").count(),
        1
    );
}

#[tokio::test]
async fn audio_stopped_by_the_recorder_while_paused_is_transcribed_exactly_once() {
    let f = fixture(|_| {});
    let session = f.start();
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.pause();
    f.service
        .handle_recorder_event(&session, RecorderEvent::PauseChanged(true));
    assert_eq!(f.engine.phase(), DictationPhase::Paused);
    // The recording limit stops the recorder on its own.
    f.service
        .handle_recorder_event(&session, RecorderEvent::LimitReached);
    f.service
        .handle_recorder_event(&session, RecorderEvent::LimitReached);
    f.service.settle().await;
    assert_eq!(f.deliveries(), ["Ship the release."]);
    assert_eq!(f.engine.phase(), DictationPhase::Idle);
    assert_eq!(
        f.capture.actions().iter().filter(|a| *a == "stop").count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn a_pause_the_recorder_never_acknowledges_fails_the_capture() {
    let acknowledged = fixture(|_| {});
    let session = acknowledged.start();
    acknowledged
        .service
        .handle_recorder_event(&session, RecorderEvent::Started);
    acknowledged.service.pause();
    acknowledged
        .service
        .handle_recorder_event(&session, RecorderEvent::PauseChanged(true));
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(acknowledged.engine.phase(), DictationPhase::Paused);
    assert!(acknowledged.service.is_active());

    let silent = fixture(|_| {});
    let session = silent.start();
    silent
        .service
        .handle_recorder_event(&session, RecorderEvent::Started);
    silent.service.pause();
    tokio::time::sleep(Duration::from_secs(16)).await;
    assert_eq!(silent.capture.last(), ("cancel".to_owned(), session));
    assert!(!silent.service.is_active());
    assert_eq!(silent.engine.phase(), DictationPhase::Error);
}

#[tokio::test]
async fn presses_during_paste_never_open_the_microphone() {
    let f = fixture(|_| {});
    f.delivery.busy.store(true, Ordering::SeqCst);
    f.service.start();
    assert!(f.capture.actions().is_empty());
    assert!(!f.service.is_active());
}

#[tokio::test]
async fn silence_is_not_a_failure_and_keeps_no_retry_audio() {
    let f = fixture(|_| {});
    f.engine.inference.lock().push_back(Inference::Text(
        json!({"text": "   ", "recognizedLanguage": "en"}),
    ));
    f.record().await;
    assert!(f.records().is_empty());
    assert!(f.deliveries().is_empty());
    assert_eq!(f.engine.phase(), DictationPhase::Idle);
    assert_eq!(
        f.engine.message(),
        "No speech detected — nothing was typed."
    );
    assert!(!f.engine.recovery.lock().contains(&true));
}

#[tokio::test]
async fn a_quick_tap_reports_a_short_recording_not_a_microphone_error() {
    let f = fixture(|_| {});
    *f.capture.stop_error.lock() = Some(DomainError::failed(
        "Recording too short — nothing was recorded.",
    ));
    f.record().await;
    assert_eq!(f.engine.phase(), DictationPhase::Idle);
    assert!(!f.service.is_active());
    assert!(f.engine.calls.lock().is_empty());
}

#[tokio::test]
async fn trailing_silence_counts_down_then_stops_and_a_lost_input_keeps_its_audio() {
    let f = fixture(|s| s.trailing_silence_stop_enabled = true);
    let session = f.start();
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.handle_recorder_event(
        &session,
        RecorderEvent::Silence {
            remaining_seconds: Some(3),
            stop: false,
        },
    );
    assert_eq!(f.engine.status.lock().silence_countdown_seconds, Some(3.0));
    f.service.handle_recorder_event(
        &session,
        RecorderEvent::Silence {
            remaining_seconds: Some(0),
            stop: true,
        },
    );
    f.service.settle().await;
    assert_eq!(f.engine.status.lock().silence_countdown_seconds, None);
    assert_eq!(f.deliveries(), ["Ship the release."]);

    let session = f.start();
    f.service
        .handle_recorder_event(&session, RecorderEvent::Started);
    f.service.handle_recorder_event(
        &session,
        RecorderEvent::InputChanged {
            message: "The recording microphone is gone".into(),
            input_lost: true,
        },
    );
    assert_eq!(
        f.engine.status.lock().capture_input_notice.as_deref(),
        Some("The recording microphone is gone")
    );
    f.service.settle().await;
    assert_eq!(f.deliveries().len(), 2);
}

#[tokio::test]
async fn automatic_language_guesses_dutch_or_english_when_the_model_reports_none() {
    let f = fixture(|s| {
        s.language = "auto".into();
        s.custom_words = vec![CustomWord {
            id: "nl".into(),
            language: Some("nl".into()),
            term: "Utrecht".into(),
            sounds_like: "uut recht".into(),
            enabled: true,
            ..CustomWord::default()
        }];
    });
    f.engine.inference.lock().push_back(Inference::Text(json!({
        "text": "Ik heb de code naar github gepusht en daarna ga ik naar uut recht",
        "recognizedLanguage": null,
    })));
    f.record().await;
    let record = &f.records()[0];
    assert_eq!(record.language, "nl");
    assert_eq!(record.recognized_language, Some(None));
    assert_eq!(record.requested_language, Some(Some("auto".into())));
    assert!(record
        .personalized_text
        .clone()
        .flatten()
        .unwrap()
        .contains("naar Utrecht"));

    f.engine.inference.lock().push_back(Inference::Text(
        json!({"text": "Kestrel Moondream Delulu", "recognizedLanguage": null}),
    ));
    f.record().await;
    assert_eq!(f.records()[1].language, "und");
}

#[tokio::test(start_paused = true)]
async fn paste_last_delivers_after_the_countdown_and_cancels_when_the_text_changes() {
    let delivery = Arc::new(FakeDelivery::default());
    let text = Arc::new(Mutex::new(Some("Hello".to_owned())));
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let service = {
        let text = text.clone();
        let recorded = recorded.clone();
        PasteLastService::new(PasteLastPorts {
            capture_active: Arc::new(|| false),
            current_text: Arc::new(move |_| text.lock().clone()),
            delivery: delivery.clone(),
            record: Arc::new(move |_, state, _, method| recorded.lock().push((state, method))),
            changed: Arc::new(|_| {}),
        })
    };
    assert!(service.start("id", "Hello", 0.5).is_err());
    assert_eq!(
        service.start("id", "Hello", 1.0).unwrap().phase,
        PasteLastPhase::Pending
    );
    assert!(
        service.start("id", "Hello", 1.0).is_err(),
        "only one countdown at a time"
    );
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(service.status().phase, PasteLastPhase::Attempted);
    assert_eq!(delivery.deliveries.lock().clone(), ["Hello"]);
    assert_eq!(
        recorded.lock().clone(),
        [(DeliveryState::PasteAttempted, Some("fake-paste".to_owned()))]
    );

    service.start("id", "Hello", 3.0).unwrap();
    *text.lock() = Some("Edited".into());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = service.status();
    assert_eq!(status.phase, PasteLastPhase::Cancelled);
    assert_eq!(
        status.message,
        "Paste cancelled because the transcript was removed or changed."
    );
    assert_eq!(delivery.deliveries.lock().len(), 1);
}
