//! The dictation pipeline (`electron/services/dictation.ts`) over the native
//! recorder: capture state machine, transcription, personalization and
//! formatting, optional rewriting, delivery with paste recovery, retry audio
//! and the Speech Lab / import path (`runLab`).
//!
//! The renderer no longer owns the microphone. `recorder:command` sends
//! became [`Capture`] calls and the `recorder:*` IPC callbacks became
//! [`DictationService::handle_recorder_event`]. A stop runs
//! [`Capture::stop`] on a blocking thread and submits the audio itself.
//! Deadlines still guard a recorder that never answers.

use delulu_core::HostEnv;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use delulu_audio::{RecorderEvent, RecorderOptions, Recording, TrailingSilence};
use delulu_core::{AppPaths, DomainError, DomainResult, SharedSink};
use delulu_desktop::{
    is_clipboard_copy_error, DeliveryTimings, MicrophonePermission, PillCommand, PillState,
    ShortcutActions,
};
use delulu_domain::capture_diagnostics::normalize_capture_diagnostics;
use delulu_domain::pipeline_timings::normalize_timings;
use delulu_domain::speech_models::normalize_speech_execution;
use delulu_domain::text::{
    delivered_text, format_dictation, format_spoken_commands, guess_text_language,
    normalize_language_metadata, normalize_reported_language, personalize_with_usage,
};
use delulu_domain::word_packs::active_rules;
use delulu_domain::{
    js, AppSettings, DeliveryState, DictationFormatting, DictationPhase, EnginePhase, LabRequest,
    MagicPreset, MagicRewriteRequest, PipelineTimings, ShortcutMode, TranscriptRecord,
    TranscriptSource, AUTO_LANGUAGE, TOO_SHORT,
};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::channels;
use crate::ports::{Capture, Delivery, Indicator, SpeechEngine};
use crate::profile::Profile;
use crate::retry_audio::{RetryAudioStore, Submission};
use crate::support::{chars, elapsed_ms, numeric, plain, Finally};
use crate::transcripts::{delivery as delivery_record, with_delivery_timings, Transcripts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureState {
    Idle,
    Opening,
    Listening,
    Pausing,
    Paused,
    Resuming,
    Stopping,
    Processing,
}

use CaptureState::*;

const ACTIVE_CAPTURE: [CaptureState; 5] = [Opening, Listening, Pausing, Paused, Resuming];
const OPENING_DEADLINE: Duration = Duration::from_secs(45);
const PAUSING_DEADLINE: Duration = Duration::from_secs(15);
const STOPPING_DEADLINE: Duration = Duration::from_secs(30);
const MAX_RECORDING_BYTES: usize = 500 * 1024 * 1024;
const NO_SPEECH: &str = "No speech detected — nothing was typed.";

fn no_speech() -> DomainError {
    DomainError::failed(NO_SPEECH).with_cause("NoSpeechError", None)
}

fn is_no_speech(error: &DomainError) -> bool {
    error
        .cause
        .as_ref()
        .is_some_and(|cause| cause.name == "NoSpeechError")
}

fn hud(state: PillState, title: Option<&str>, detail: Option<&str>) -> PillCommand {
    PillCommand {
        state,
        title: title.map(str::to_owned),
        detail: detail.map(str::to_owned),
        level: None,
    }
}

impl Submission {
    fn from_recording(recording: Recording) -> Self {
        Submission {
            timings: normalize_timings(
                &json!({"captureEndMs": recording.capture_end_ms, "preprocessingMs": recording.preprocessing_ms}),
            ),
            capture_diagnostics: serde_json::to_value(&recording.diagnostics)
                .ok()
                .and_then(|value| normalize_capture_diagnostics(&value)),
            duration_ms: recording.duration_ms as f64,
            wav: recording.wav,
        }
    }
}

/// Everything the service talks to.
pub struct DictationDeps {
    pub engine: Arc<dyn SpeechEngine>,
    pub capture: Arc<dyn Capture>,
    pub delivery: Arc<dyn Delivery>,
    pub indicator: Arc<dyn Indicator>,
    pub profile: Arc<dyn Profile>,
    pub transcripts: Arc<Transcripts>,
    pub sink: SharedSink,
    pub paths: AppPaths,
    /// macOS microphone permission (`delulu_desktop::microphone_permission`).
    pub microphone: Arc<dyn Fn() -> MicrophonePermission + Send + Sync>,
    /// Runs just before the microphone opens (stop speech, pause listening).
    pub before_capture: Arc<dyn Fn() + Send + Sync>,
}

struct State {
    capture: CaptureState,
    session: Option<String>,
    capture_settings: Option<AppSettings>,
    retry_settings: Option<AppSettings>,
    retry: RetryAudioStore,
    hud: PillCommand,
    busy_notice: bool,
    busy_generation: u64,
    deadline: Option<(u64, JoinHandle<()>)>,
    deadline_sequence: u64,
    tasks: Vec<JoinHandle<()>>,
}

struct Inner {
    deps: DictationDeps,
    runtime: Handle,
    state: Mutex<State>,
    /// Serializes `start` so two presses cannot both leave idle.
    starting: Mutex<()>,
}

/// Cheap to clone; clones share one pipeline. Create inside a Tokio runtime.
#[derive(Clone)]
pub struct DictationService {
    inner: Arc<Inner>,
}

/// A handle that does not keep the service alive (for recorder callbacks).
#[derive(Clone)]
pub struct WeakDictation(Weak<Inner>);

impl WeakDictation {
    pub fn upgrade(&self) -> Option<DictationService> {
        self.0.upgrade().map(|inner| DictationService { inner })
    }
}

impl DictationService {
    pub fn new(deps: DictationDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                runtime: Handle::current(),
                state: Mutex::new(State {
                    capture: Idle,
                    session: None,
                    capture_settings: None,
                    retry_settings: None,
                    retry: RetryAudioStore::default(),
                    hud: PillCommand::hidden(),
                    busy_notice: false,
                    busy_generation: 0,
                    deadline: None,
                    deadline_sequence: 0,
                    tasks: Vec::new(),
                }),
                starting: Mutex::new(()),
            }),
        }
    }

    pub fn downgrade(&self) -> WeakDictation {
        WeakDictation(Arc::downgrade(&self.inner))
    }

    fn deps(&self) -> &DictationDeps {
        &self.inner.deps
    }

    fn engine(&self) -> &dyn SpeechEngine {
        &*self.inner.deps.engine
    }

    /// Capturing or processing (`dictation.isActive`).
    pub fn is_active(&self) -> bool {
        self.inner.state.lock().capture != Idle
    }

    /// The microphone is open and Stop would transcribe it.
    pub fn can_stop_recording(&self) -> bool {
        ACTIVE_CAPTURE.contains(&self.inner.state.lock().capture)
    }

    /// `dictation:discardFailed`.
    pub fn discard_failure(&self) {
        {
            let mut state = self.inner.state.lock();
            state.retry.discard();
            state.retry_settings = None;
        }
        self.publish_retry_audio();
        if !self.is_active() {
            self.engine()
                .set_activity(DictationPhase::Idle, "Failed recording discarded", None);
        }
    }

    /// Wipes retry audio at shutdown.
    pub fn release_retry_audio(&self) {
        self.inner.state.lock().retry.dispose();
        self.publish_retry_audio();
    }

    fn publish_retry_audio(&self) {
        let (available, audio) = {
            let state = self.inner.state.lock();
            (state.retry.available(), state.retry.state())
        };
        self.engine().set_recovery(available, audio);
    }

    /// `dictation:retry`: transcribes the retained failed recording again,
    /// with the settings captured for it.
    pub async fn retry(&self) -> DomainResult<()> {
        let lease = {
            let mut state = self.inner.state.lock();
            if state.capture != Idle || !state.retry.available() {
                return Err(plain("No failed recording is available to retry"));
            }
            state.retry.begin_retry()
        };
        let Some((lease, recording)) = lease else {
            return Err(plain("No failed recording is available to retry"));
        };
        self.publish_retry_audio();
        let result = self.process_recording(recording, Some(lease)).await;
        let failed = !matches!(result, Ok(true));
        self.inner.state.lock().retry.finish_retry(lease, failed);
        self.publish_retry_audio();
        result.map(|_| ())
    }

    /// Re-applies the overlay after `showOverlay` changes.
    pub fn sync_overlay(&self) {
        self.apply_hud();
    }

    fn set_hud(&self, command: PillCommand) {
        {
            let mut state = self.inner.state.lock();
            state.busy_generation += 1;
            state.busy_notice = false;
            state.hud = command;
        }
        self.apply_hud();
    }

    fn apply_hud(&self) {
        let command = self.inner.state.lock().hud.clone();
        if !self.deps().profile.settings().show_overlay || command.state == PillState::Hidden {
            self.deps().indicator.hide();
        } else {
            self.deps().indicator.show(command);
        }
    }

    fn hide_busy_notice(&self) {
        if self.inner.state.lock().busy_notice {
            self.set_hud(PillCommand::hidden());
        }
    }

    /// Called on every runtime status change: a busy notice ends with the work.
    pub fn runtime_changed(&self) {
        if self.inner.state.lock().busy_notice
            && !matches!(
                self.engine().status().phase,
                DictationPhase::Loading | DictationPhase::Preparing | DictationPhase::Transcribing
            )
        {
            self.set_hud(PillCommand::hidden());
        }
    }

    fn show_busy_notice(&self) {
        self.set_hud(hud(
            PillState::Transcribing,
            Some("Please wait"),
            Some("Engine is busy — try again shortly"),
        ));
        let generation = {
            let mut state = self.inner.state.lock();
            state.busy_notice = true;
            state.busy_generation
        };
        let this = self.clone();
        self.inner.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if this.inner.state.lock().busy_generation == generation {
                this.set_hud(PillCommand::hidden());
            }
        });
    }

    fn hold_mode(&self) -> bool {
        let captured = self
            .inner
            .state
            .lock()
            .capture_settings
            .as_ref()
            .map(|settings| settings.shortcut_mode);
        captured.unwrap_or_else(|| self.deps().profile.settings().shortcut_mode)
            == ShortcutMode::Hold
    }

    /// `dictation:start`. Presses while busy show a notice instead of failing.
    pub fn start(&self) {
        let _starting = self.inner.starting.lock();
        let status = self.engine().status();
        let current = self.inner.state.lock().capture;
        if current != Idle {
            // Processing a previous recording: say so instead of ignoring the press.
            if current == Processing {
                self.show_busy_notice();
            }
            return;
        }
        if self.deps().delivery.is_busy()
            || self.engine().is_busy()
            || matches!(
                status.phase,
                DictationPhase::Transcribing | DictationPhase::Preparing | DictationPhase::Loading
            )
        {
            self.show_busy_notice();
            return;
        }
        if matches!(status.engine, EnginePhase::Missing | EnginePhase::Error) {
            let missing = status.engine == EnginePhase::Missing;
            self.engine().set_activity(
                DictationPhase::Error,
                if missing {
                    "Set up the speech runtime before your first dictation"
                } else {
                    "Repair the speech runtime or reload the speech model before starting another dictation"
                },
                None,
            );
            self.set_hud(if missing {
                hud(
                    PillState::Error,
                    Some("Setup needed"),
                    Some("Set up the speech runtime"),
                )
            } else {
                hud(
                    PillState::Error,
                    Some("Unavailable"),
                    Some("Open Delulu Talks"),
                )
            });
            return;
        }
        let microphone = (self.deps().microphone)();
        if !microphone.can_request_capture {
            self.engine()
                .set_activity(DictationPhase::Error, &microphone.detail, None);
            self.set_hud(hud(
                PillState::Error,
                Some("Microphone access blocked"),
                Some(&microphone.detail),
            ));
            return;
        }
        let settings = self.deps().profile.settings();
        (self.deps().before_capture)();
        let session = delulu_core::uuid();
        {
            let mut state = self.inner.state.lock();
            state.capture_settings = Some(settings.clone());
            state.session = Some(session.clone());
            state.capture = Opening;
        }
        self.arm_deadline(
            OPENING_DEADLINE,
            "The microphone did not start. Try again or choose another input.",
        );
        self.engine().set_capture_input_notice(None);
        self.engine().set_silence_countdown(None);
        self.engine()
            .set_activity(DictationPhase::Idle, "Opening microphone", None);
        let options = RecorderOptions {
            session_id: session.clone(),
            device_id: settings.input_device_id.clone(),
            trailing_silence: settings
                .trailing_silence_stop_enabled
                .then_some(TrailingSilence {
                    seconds: settings.trailing_silence_seconds,
                    threshold_db: settings.trailing_silence_threshold_db,
                }),
            max_duration: None,
            cue_volume: (!settings.capture_sounds_muted)
                .then_some(settings.capture_sound_volume as f32),
        };
        if let Err(error) = self.deps().capture.start(options) {
            if self.inner.state.lock().session.as_deref() == Some(session.as_str()) {
                self.fail_capture(&error.message);
            }
        }
    }

    /// `dictation:stop`: finish and transcribe.
    pub fn stop(&self) {
        self.stop_capture(true);
    }

    fn stop_capture(&self, by_user: bool) {
        self.engine().set_silence_countdown(None);
        self.hide_busy_notice();
        let session = {
            let mut state = self.inner.state.lock();
            match state.capture {
                Opening => {
                    state.capture = Stopping;
                    None
                }
                Listening | Pausing | Paused | Resuming => {
                    state.capture = Stopping;
                    state.session.clone()
                }
                _ => return,
            }
        };
        if by_user {
            self.engine().set_capture_input_notice(None);
        }
        let Some(session) = session else {
            self.engine().set_activity(
                DictationPhase::Idle,
                "Shortcut released — closing the microphone",
                None,
            );
            return;
        };
        self.arm_deadline(
            STOPPING_DEADLINE,
            "The recording did not finish. Please dictate again.",
        );
        self.spawn_stop(session);
    }

    fn spawn_stop(&self, session: String) {
        let this = self.clone();
        let capture = self.deps().capture.clone();
        let task = self.inner.runtime.spawn(async move {
            let id = session.clone();
            let result = tokio::task::spawn_blocking(move || capture.stop(&id))
                .await
                .unwrap_or_else(|error| {
                    Err(DomainError::failed(format!(
                        "The recording did not finish: {error}"
                    )))
                });
            match result {
                Ok(recording) => {
                    this.submit_recording(&session, Submission::from_recording(recording))
                        .await
                }
                Err(error) if error.is_cancelled() => {}
                Err(error) => this.recording_failed(&session, &error.message),
            }
        });
        let mut state = self.inner.state.lock();
        state.tasks.retain(|task| !task.is_finished());
        state.tasks.push(task);
    }

    /// Waits for stops and transcriptions already in flight.
    pub async fn settle(&self) {
        loop {
            let tasks = std::mem::take(&mut self.inner.state.lock().tasks);
            if tasks.is_empty() {
                return;
            }
            for task in tasks {
                let _ = task.await;
            }
        }
    }

    /// The recorder owns the microphone. If it never answers, fail the
    /// capture instead of staying "recording" forever.
    fn arm_deadline(&self, after: Duration, message: &'static str) {
        let mut state = self.inner.state.lock();
        if let Some((_, timer)) = state.deadline.take() {
            timer.abort();
        }
        state.deadline_sequence += 1;
        let id = state.deadline_sequence;
        let session = state.session.clone();
        let this = self.clone();
        let timer = self.inner.runtime.spawn(async move {
            tokio::time::sleep(after).await;
            {
                let mut state = this.inner.state.lock();
                if state
                    .deadline
                    .as_ref()
                    .is_none_or(|(current, _)| *current != id)
                {
                    return;
                }
                state.deadline = None;
                if session.is_none()
                    || session != state.session
                    || !matches!(state.capture, Opening | Pausing | Stopping)
                {
                    return;
                }
            }
            if let Some(session) = &session {
                this.deps().capture.cancel(session);
            }
            this.fail_capture(message);
        });
        state.deadline = Some((id, timer));
    }

    fn clear_deadline(state: &mut State) {
        if let Some((_, timer)) = state.deadline.take() {
            timer.abort();
        }
    }

    /// `dictation:toggle`.
    pub fn toggle(&self) {
        let current = self.inner.state.lock().capture;
        if ACTIVE_CAPTURE.contains(&current) {
            self.stop();
        } else if current == Idle {
            self.start();
        }
    }

    /// `dictation:pause`: keeps the microphone open and the audio so far.
    pub fn pause(&self) {
        let session = {
            let mut state = self.inner.state.lock();
            if state.capture != Listening {
                return;
            }
            state.capture = Pausing;
            state.session.clone()
        };
        self.engine().set_capture_input_notice(None);
        self.arm_deadline(
            PAUSING_DEADLINE,
            "The recording did not pause. Please dictate again.",
        );
        if let Some(session) = session {
            let capture = self.deps().capture.clone();
            // The acknowledgement arrives as `PauseChanged`; the deadline covers silence.
            self.inner.runtime.spawn_blocking(move || {
                if let Err(error) = capture.pause(&session) {
                    log::warn!("recording pause failed: {}", error.message);
                }
            });
        }
    }

    /// `dictation:resume`.
    pub fn resume(&self) {
        let session = {
            let mut state = self.inner.state.lock();
            if state.capture != Paused {
                return;
            }
            state.capture = Resuming;
            state.session.clone()
        };
        if let Some(session) = session {
            let capture = self.deps().capture.clone();
            self.inner.runtime.spawn_blocking(move || {
                if let Err(error) = capture.resume(&session) {
                    log::warn!("recording resume failed: {}", error.message);
                }
            });
        }
    }

    /// `dictation:cancel`: discards the capture without transcribing.
    pub fn cancel(&self) {
        self.engine().set_silence_countdown(None);
        self.hide_busy_notice();
        let session = {
            let mut state = self.inner.state.lock();
            if matches!(state.capture, Idle | Processing) {
                return;
            }
            Self::clear_deadline(&mut state);
            state.capture = Idle;
            state.capture_settings = None;
            state.session.take()
        };
        if let Some(session) = session {
            self.deps().capture.cancel(&session);
        }
        self.engine().set_capture_input_notice(None);
        self.set_hud(PillCommand::hidden());
        self.engine()
            .set_activity(DictationPhase::Idle, "Recording cancelled", None);
    }

    /// Routes one [`RecorderEvent`] (called on the capture thread).
    pub fn handle_recorder_event(&self, session: &str, event: RecorderEvent) {
        match event {
            RecorderEvent::Started => self.recording_started(session),
            RecorderEvent::Level(level) => self.recording_level(level),
            RecorderEvent::Silence {
                remaining_seconds,
                stop,
            } => self.recording_silence(session, remaining_seconds, stop),
            RecorderEvent::LimitReached => self.recording_limit_reached(session),
            RecorderEvent::InputChanged {
                message,
                input_lost,
            } => self.recording_input_changed(session, &message, input_lost),
            RecorderEvent::Failed(message) => self.recording_failed(session, &message),
            RecorderEvent::PauseChanged(paused) => self.recording_pause_changed(session, paused),
        }
    }

    fn is_session(state: &State, session: &str) -> bool {
        state.session.as_deref() == Some(session)
    }

    fn recording_level(&self, level: f32) {
        let level = if level.is_finite() {
            level.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.deps()
            .sink
            .emit_value(channels::RECORDER_LEVEL, json!(level));
        let show = {
            let state = self.inner.state.lock();
            if state.hud.state != PillState::Listening {
                return;
            }
            state
                .capture_settings
                .as_ref()
                .map(|settings| settings.show_overlay)
        };
        if show.unwrap_or_else(|| self.deps().profile.settings().show_overlay) {
            self.deps().indicator.level(f64::from(level));
        }
    }

    fn recording_started(&self, session: &str) {
        let action = {
            let mut state = self.inner.state.lock();
            if !Self::is_session(&state, session) {
                return;
            }
            match state.capture {
                Stopping => Stopping,
                Opening => {
                    Self::clear_deadline(&mut state);
                    state.capture = Listening;
                    Listening
                }
                _ => return,
            }
        };
        if action == Stopping {
            self.engine()
                .set_activity(DictationPhase::Listening, "Finishing capture", None);
            self.spawn_stop(session.to_owned());
            return;
        }
        let hold = self.hold_mode();
        self.engine().set_activity(
            DictationPhase::Listening,
            if hold {
                "Listening — release the shortcut to transcribe"
            } else {
                "Listening — press the shortcut again to finish"
            },
            None,
        );
        self.set_hud(hud(
            PillState::Listening,
            None,
            Some(if hold {
                "Release to send"
            } else {
                "Press shortcut to send"
            }),
        ));
    }

    fn recording_pause_changed(&self, session: &str, paused: bool) {
        {
            let mut state = self.inner.state.lock();
            if !Self::is_session(&state, session)
                || state.capture != (if paused { Pausing } else { Resuming })
            {
                return;
            }
            Self::clear_deadline(&mut state);
            state.capture = if paused { Paused } else { Listening };
        }
        if paused {
            self.engine().set_activity(
                DictationPhase::Paused,
                "Paused — audio retained; microphone remains open. Resume or Stop to transcribe.",
                None,
            );
            // The microphone stays open while paused, so the overlay stays visible.
            self.set_hud(hud(
                PillState::Listening,
                Some("Paused"),
                Some("Microphone open · Resume or Stop"),
            ));
        } else {
            self.engine().set_activity(
                DictationPhase::Listening,
                "Listening — resumed the same recording",
                None,
            );
            self.set_hud(hud(
                PillState::Listening,
                None,
                Some("Resumed — Stop to transcribe"),
            ));
        }
    }

    fn recording_silence(&self, session: &str, remaining_seconds: Option<u32>, stop: bool) {
        let listening = {
            let state = self.inner.state.lock();
            if !Self::is_session(&state, session) || !matches!(state.capture, Opening | Listening) {
                return;
            }
            state.capture == Listening
        };
        self.engine()
            .set_silence_countdown(remaining_seconds.map(f64::from));
        if !stop {
            if listening {
                let hold = self.deps().profile.settings().shortcut_mode == ShortcutMode::Hold;
                let detail = match remaining_seconds {
                    None if hold => "Release to send".to_owned(),
                    None => "Press shortcut to send".to_owned(),
                    Some(seconds) => format!("Auto-stop in {seconds}s · Stop still available"),
                };
                self.set_hud(hud(PillState::Listening, None, Some(&detail)));
            }
            return;
        }
        self.stop_capture(false);
        self.engine().set_activity(
            DictationPhase::Listening,
            "Trailing silence — finishing capture",
            None,
        );
        self.set_hud(hud(
            PillState::Transcribing,
            Some("Finishing capture"),
            Some("Trailing silence"),
        ));
    }

    fn recording_limit_reached(&self, session: &str) {
        {
            let state = self.inner.state.lock();
            if !Self::is_session(&state, session) || !ACTIVE_CAPTURE.contains(&state.capture) {
                return;
            }
        }
        // Use the same ownership transition as a user Stop so bounded audio is
        // accepted by the normal transcript/rewrite/delivery pipeline.
        self.stop_capture(false);
        self.engine().set_activity(
            DictationPhase::Listening,
            "Recording limit reached — finishing capture",
            None,
        );
        self.set_hud(hud(
            PillState::Transcribing,
            Some("Finishing capture"),
            Some("Recording limit reached"),
        ));
    }

    fn recording_input_changed(&self, session: &str, message: &str, input_lost: bool) {
        {
            let state = self.inner.state.lock();
            if !Self::is_session(&state, session) || !ACTIVE_CAPTURE.contains(&state.capture) {
                return;
            }
        }
        self.engine().set_capture_input_notice(Some(message));
        if input_lost {
            self.stop_capture(false);
        }
    }

    fn recording_failed(&self, session: &str, message: &str) {
        {
            let mut state = self.inner.state.lock();
            if !Self::is_session(&state, session) || state.capture == Processing {
                return;
            }
            if message.starts_with(TOO_SHORT) {
                // A quick tap is not a microphone failure.
                Self::clear_deadline(&mut state);
                state.capture = Idle;
                state.session = None;
                state.capture_settings = None;
            }
        }
        if !message.starts_with(TOO_SHORT) {
            self.fail_capture(message);
            return;
        }
        self.engine().set_silence_countdown(None);
        let hold = self.deps().profile.settings().shortcut_mode == ShortcutMode::Hold;
        self.set_hud(hud(
            PillState::Error,
            Some("Too short"),
            Some(if hold {
                "Hold the shortcut while you speak"
            } else {
                "Speak, then press the shortcut again"
            }),
        ));
        self.engine()
            .set_activity(DictationPhase::Idle, message, None);
    }

    fn fail_capture(&self, message: &str) {
        {
            let mut state = self.inner.state.lock();
            Self::clear_deadline(&mut state);
            state.capture = Idle;
            state.session = None;
            state.capture_settings = None;
        }
        self.engine().set_silence_countdown(None);
        let lower = message.to_lowercase();
        let device = ["microphone", "input", "audio"]
            .iter()
            .any(|word| lower.contains(word));
        self.set_hud(hud(
            PillState::Error,
            Some("Could not finish"),
            Some(if device {
                "Check the microphone"
            } else {
                "Open Delulu Talks for details"
            }),
        ));
        self.engine()
            .set_activity(DictationPhase::Error, message, None);
    }

    /// Accepts the audio of the current capture exactly once. Cancellation
    /// consumes the session, so late audio cannot reach an idle or newer one.
    async fn submit_recording(&self, session: &str, submission: Submission) {
        {
            let mut state = self.inner.state.lock();
            if !(state.capture == Stopping || ACTIVE_CAPTURE.contains(&state.capture))
                || !Self::is_session(&state, session)
            {
                return;
            }
            Self::clear_deadline(&mut state);
            state.session = None;
        }
        self.engine().set_silence_countdown(None);
        if let Err(error) = self.process_recording(submission, None).await {
            log::error!("dictation processing failed: {}", error.message);
        }
    }

    /// Returns whether the recording was handled (delivered, held for
    /// review, or discarded as too short).
    async fn process_recording(
        &self,
        submission: Submission,
        retry_lease: Option<u64>,
    ) -> DomainResult<bool> {
        let settings = {
            let mut state = self.inner.state.lock();
            if state.capture == Processing {
                return Err(plain("A recording is already being processed"));
            }
            state.capture = Processing;
            let settings = state
                .capture_settings
                .clone()
                .or_else(|| retry_lease.and(state.retry_settings.clone()))
                .unwrap_or_else(|| self.deps().profile.settings());
            state.capture_settings = Some(settings.clone());
            settings
        };
        if submission.wav.len() < 44 {
            self.fail_capture("The microphone returned an empty recording");
            return Ok(false);
        }
        if submission.wav.len() > MAX_RECORDING_BYTES {
            self.fail_capture("Recording is too large; keep dictation captures below 500 MB");
            return Ok(false);
        }
        if submission.duration_ms < 180.0 {
            {
                let mut state = self.inner.state.lock();
                state.capture = Idle;
                state.capture_settings = None;
            }
            self.set_hud(hud(
                PillState::Error,
                Some("Too short"),
                Some("Hold a little longer"),
            ));
            self.engine().set_activity(
                DictationPhase::Idle,
                "Recording was too short and was discarded",
                None,
            );
            return Ok(true);
        }
        let cache = self.deps().paths.audio_cache();
        let audio_path = cache.join(format!(
            "dictation-{}-{}.wav",
            delulu_core::now_ms(),
            delulu_core::uuid()
        ));
        let _finally = Finally(|| {
            {
                let mut state = self.inner.state.lock();
                state.capture = Idle;
                state.capture_settings = None;
            }
            // Windows can briefly lock the file; never let cleanup mask the result.
            if let Err(error) = std::fs::remove_file(&audio_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::error!("Could not remove temporary dictation audio: {error}");
                }
            }
        });
        let mut delivery_started = false;
        let result = self
            .transcribe_and_deliver(
                &submission,
                &settings,
                &cache,
                &audio_path,
                &mut delivery_started,
            )
            .await;
        let Err(error) = result else { return result };
        if is_no_speech(&error) && retry_lease.is_none() {
            // Silence is not a failure, and must not replace audio kept for retry.
            self.set_hud(hud(
                PillState::Error,
                Some("No speech detected"),
                Some("Nothing was typed"),
            ));
            self.engine()
                .set_activity(DictationPhase::Idle, &error.message, None);
            return Ok(false);
        }
        let retained = {
            let mut state = self.inner.state.lock();
            if delivery_started {
                state.retry.discard();
                state.retry_settings = None;
            }
            let retained =
                !delivery_started && (retry_lease.is_some() || state.retry.retain(&submission));
            state.retry_settings = retained.then(|| settings.clone());
            retained
        };
        self.publish_retry_audio();
        self.set_hud(PillCommand::new(PillState::Error));
        let message = if retained {
            error.message.clone()
        } else {
            format!(
                "{} — This recording could not be retained for retry.",
                error.message
            )
        };
        self.engine()
            .set_activity(DictationPhase::Error, &message, None);
        Ok(false)
    }

    async fn transcribe_and_deliver(
        &self,
        submission: &Submission,
        settings: &AppSettings,
        cache: &Path,
        audio_path: &Path,
        delivery_started: &mut bool,
    ) -> DomainResult<bool> {
        let deps = self.deps();
        let mut timings = submission.timings.clone().unwrap_or_default();
        let preprocessing_started = Instant::now();
        std::fs::create_dir_all(cache)?;
        {
            use std::io::Write;
            let mut file = delulu_core::util::create_private(audio_path)?;
            file.write_all(&submission.wav)?;
        }
        timings.preprocessing_ms =
            Some(timings.preprocessing_ms.unwrap_or(0.0) + elapsed_ms(preprocessing_started));
        self.engine()
            .set_activity(DictationPhase::Transcribing, "Transcribing locally", None);
        self.set_hud(PillCommand::new(PillState::Transcribing));
        let result = self
            .engine()
            .transcribe(
                json!({"audioPath": audio_path, "durationMs": submission.duration_ms}),
                settings,
            )
            .await?;
        if result
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| js::trim(text).is_empty())
        {
            return Err(no_speech());
        }
        self.inner.state.lock().retry.clear_available();
        self.publish_retry_audio();
        let mut record = create_record(
            &*deps.profile,
            &result,
            TranscriptSource::Dictation,
            Some(submission.duration_ms),
            None,
            settings,
            Some(&timings),
        )?;
        record.capture_diagnostics = submission.capture_diagnostics.clone();
        let mut output = delivered_text(&record).to_owned();
        if js::trim(&output).is_empty() {
            return Err(plain(
                "Personalization returned no text. Review your saved rules and retry.",
            ));
        }
        let spoken = settings.magic_preset == MagicPreset::SpokenCorrections;
        let mut magic_failure: Option<String> = None;
        if settings.magic_enabled {
            self.engine().set_activity(
                DictationPhase::Transcribing,
                if spoken {
                    "Resolving spoken corrections"
                } else {
                    "Rewriting is polishing the transcript"
                },
                None,
            );
            self.set_hud(if spoken {
                hud(
                    PillState::Magic,
                    Some("Keeping your final words"),
                    Some("Resolving spoken corrections"),
                )
            } else {
                PillCommand::new(PillState::Magic)
            });
            let request = MagicRewriteRequest {
                operation_id: None,
                text: output.clone(),
                preset: settings.magic_preset,
                instructions: None,
                source_language: Some(record.language.clone()),
                context: None,
                allow_inferences: settings.magic_allow_inferences,
            };
            match self.engine().rewrite(request, settings).await {
                Ok(magic) => {
                    output = magic.text.clone();
                    let merged = merge_timings(record.timings.as_ref(), magic.timings.as_ref());
                    record.rewrite_source_revision =
                        Some(Some(record.source_revision.unwrap_or(0.0)));
                    record.magic_text = Some(Some(magic.text));
                    record.magic_model = Some(Some(magic.model));
                    record.magic_preset = Some(Some(settings.magic_preset));
                    record.magic_included_inferences = Some(magic.included_inferences);
                    record.magic_processing_time_ms = Some(magic.processing_time_ms);
                    record.timings = merged;
                }
                Err(error) => {
                    magic_failure =
                        Some(chars(error.message.lines().next().unwrap_or_default(), 180));
                }
            }
        }
        record.session_only = Some(!settings.keep_history || !deps.profile.settings().keep_history);
        if let (Some(failure), true) = (&magic_failure, spoken) {
            record.delivery = Some(delivery_record(
                DeliveryState::Transcribed,
                Some(format!(
                    "Spoken corrections need review: {failure}. Nothing sent."
                )),
                None,
            ));
        }
        deps.profile.add_history(&record)?;
        deps.transcripts.broadcast(record.clone());
        if let (Some(failure), true) = (&magic_failure, spoken) {
            self.set_hud(hud(
                PillState::Error,
                Some("Review your words"),
                Some("Original saved · nothing sent"),
            ));
            self.engine().set_activity(
                DictationPhase::Idle,
                &format!("Spoken corrections: {failure}. Original available in Latest output; nothing sent."),
                None,
            );
            return Ok(true);
        }
        let output_name = if record
            .magic_text
            .as_ref()
            .and_then(Option::as_deref)
            .is_some_and(|text| !text.is_empty())
        {
            "Rewrite result"
        } else {
            "Transcript"
        };
        let mut completion = format!("{output_name} ready in Latest output");
        let mut failed = false;
        self.set_hud(PillCommand::new(PillState::Delivering));
        *delivery_started = true;
        let mut measured = DeliveryTimings::default();
        let delivered = settings.auto_paste || settings.copy_to_clipboard;
        if settings.auto_paste {
            let result = deps
                .delivery
                .paste(
                    &output,
                    settings.restore_clipboard_after_paste,
                    &mut measured,
                )
                .await;
            record.timings = merge_delivery(record.timings.as_ref(), &measured);
            match result {
                Ok(method) => {
                    completion =
                        format!("{output_name}: paste attempted — destination unconfirmed");
                    record = self.record_delivery(
                        &record,
                        DeliveryState::PasteAttempted,
                        Some("Paste command sent; destination receipt is not confirmed".into()),
                        Some(method),
                    );
                }
                Err(error) => {
                    let detail = chars(&error.message, 500);
                    let copied = !is_clipboard_copy_error(&error);
                    deps.transcripts.report_paste_failure(&record.id, &detail);
                    failed = !copied;
                    record = self.record_delivery(
                        &record,
                        if copied {
                            DeliveryState::Copied
                        } else {
                            DeliveryState::Transcribed
                        },
                        Some(detail.clone()),
                        None,
                    );
                    completion = if copied {
                        format!("Copied — paste manually ({detail})")
                    } else {
                        format!("Transcribed — clipboard copy failed ({detail})")
                    };
                }
            }
        } else if settings.copy_to_clipboard {
            let result = deps.delivery.copy(&output, &mut measured).await;
            record.timings = merge_delivery(record.timings.as_ref(), &measured);
            match result {
                Ok(()) => {
                    record = self.record_delivery(&record, DeliveryState::Copied, None, None);
                    completion = format!("{output_name} copied to clipboard");
                }
                Err(error) => {
                    let detail = chars(&error.message, 500);
                    failed = true;
                    record = self.record_delivery(
                        &record,
                        DeliveryState::Transcribed,
                        Some(detail.clone()),
                        None,
                    );
                    completion = format!("Transcribed — clipboard copy failed ({detail})");
                }
            }
        }
        if delivered {
            self.publish_delivery_timings(&record, &output);
        }
        if let Some(failure) = &magic_failure {
            completion = format!("{completion} · Rewriting unavailable: {failure}");
        }
        let state = record.delivery.as_ref().map(|delivery| delivery.state);
        self.set_hud(hud(
            if failed {
                PillState::Error
            } else {
                PillState::Success
            },
            Some(match state {
                Some(DeliveryState::PasteAttempted) => "Paste sent",
                Some(DeliveryState::Copied) => "Copied",
                _ => "Transcribed",
            }),
            Some(if state == Some(DeliveryState::PasteAttempted) {
                "Check your text at the cursor"
            } else if magic_failure.is_some() {
                "Rewriting skipped"
            } else {
                "Ready to keep talking"
            }),
        ));
        self.engine()
            .set_activity(DictationPhase::Idle, &completion, None);
        Ok(true)
    }

    /// Delivery already happened; a failed history write must not turn a
    /// paste or copy into a reported failure.
    fn record_delivery(
        &self,
        record: &TranscriptRecord,
        state: DeliveryState,
        detail: Option<String>,
        method: Option<String>,
    ) -> TranscriptRecord {
        let delivery = delivery_record(state, detail, method);
        let saved = self.deps().profile.find_history(&record.id);
        let updated = TranscriptRecord {
            delivery: Some(delivery.clone()),
            ..saved.clone().unwrap_or_else(|| record.clone())
        };
        if saved.is_some() {
            if let Err(error) = self.deps().profile.replace_history(&updated) {
                log::error!("Could not record delivery: {}", error.message);
                return TranscriptRecord {
                    delivery: Some(delivery),
                    ..record.clone()
                };
            }
        }
        self.deps().transcripts.broadcast(updated.clone());
        updated
    }

    /// Best effort: delivery timings join the record unless it changed meanwhile.
    fn publish_delivery_timings(&self, record: &TranscriptRecord, output: &str) {
        let existing = self.deps().profile.find_history(&record.id);
        if existing
            .as_ref()
            .is_some_and(|existing| delivered_text(existing) != output)
        {
            return;
        }
        let base = existing.clone().unwrap_or_else(|| record.clone());
        let updated = TranscriptRecord {
            timings: with_delivery_timings(base.timings.as_ref(), record.timings.as_ref()),
            ..base
        };
        if existing.is_some() {
            // Timing metadata must not turn completed delivery into a failed recording.
            let _ = self.deps().profile.replace_history(&updated);
        }
        self.deps().transcripts.broadcast(updated);
    }

    /// Speech Lab and import-queue transcription of one file (`runLab`).
    /// Cancelling `cancel` stops FFmpeg and saves nothing.
    pub async fn run_lab(
        &self,
        request: LabRequest,
        cancel: Option<CancellationToken>,
    ) -> DomainResult<TranscriptRecord> {
        let cancelled = || cancel.as_ref().is_some_and(CancellationToken::is_cancelled);
        let check = || {
            if cancelled() {
                Err(plain("Import cancelled; no transcript was saved."))
            } else {
                Ok(())
            }
        };
        check()?;
        {
            let mut state = self.inner.state.lock();
            if state.capture != Idle || self.engine().is_busy() {
                return Err(plain(
                    "Finish the current recording or model operation first",
                ));
            }
            state.capture = Processing;
        }
        let _finally = Finally(|| self.inner.state.lock().capture = Idle);
        let settings = self.deps().profile.settings();
        self.engine().set_activity(
            DictationPhase::Transcribing,
            "Transcribing imported audio",
            None,
        );
        let mut prepared: Option<PathBuf> = None;
        let result: DomainResult<TranscriptRecord> = async {
            let preprocessing_started = Instant::now();
            let (path, directory) = self
                .prepare_audio(Path::new(&request.path), cancel.as_ref())
                .await?;
            prepared = directory;
            check()?;
            let timings = PipelineTimings {
                preprocessing_ms: Some(elapsed_ms(preprocessing_started)),
                ..Default::default()
            };
            let payload = self
                .engine()
                .transcribe(json!({"audioPath": path}), &settings)
                .await?;
            check()?;
            let name = Path::new(&request.path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
            let mut record = create_record(
                &*self.deps().profile,
                &payload,
                TranscriptSource::File,
                None,
                name,
                &settings,
                Some(&timings),
            )?;
            record.session_only =
                Some(!settings.keep_history || !self.deps().profile.settings().keep_history);
            self.deps().profile.add_history(&record)?;
            self.deps().transcripts.broadcast(record.clone());
            self.engine()
                .set_activity(DictationPhase::Idle, "Speech Lab result ready", None);
            Ok(record)
        }
        .await;
        if let Err(error) = &result {
            if cancelled() {
                self.engine().set_activity(
                    DictationPhase::Idle,
                    "Import cancelled; no transcript was saved.",
                    None,
                );
            } else {
                self.engine()
                    .set_activity(DictationPhase::Error, &error.message, None);
            }
        }
        if let Some(directory) = prepared {
            if let Err(error) = remove_import_directory(&directory).await {
                self.engine()
                    .set_activity(DictationPhase::Error, &error.message, None);
                return Err(error);
            }
        }
        result
    }

    async fn prepare_audio(
        &self,
        source: &Path,
        cancel: Option<&CancellationToken>,
    ) -> DomainResult<(PathBuf, Option<PathBuf>)> {
        let extension = source
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ["wav", "flac", "ogg", "opus"].contains(&extension.as_str()) {
            // Source files are read-only inference inputs, never cleanup targets.
            return Ok((source.to_path_buf(), None));
        }
        let cache = self.deps().paths.audio_cache();
        std::fs::create_dir_all(&cache)?;
        let directory = cache.join(format!("import-{}", delulu_core::uuid()));
        create_private_dir(&directory)?;
        let output = directory.join("audio.wav");
        match convert_with_ffmpeg(source, &output, cancel).await {
            Ok(()) => Ok((output, Some(directory))),
            Err(error) => {
                remove_import_directory(&directory).await?;
                Err(error)
            }
        }
    }
}

impl ShortcutActions for DictationService {
    fn start(&self) {
        DictationService::start(self)
    }
    fn stop(&self) {
        DictationService::stop(self)
    }
    fn toggle(&self) {
        DictationService::toggle(self)
    }
}

/// An exclusively owned directory with owner-only access (like `mkdtemp`).
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

async fn remove_import_directory(directory: &Path) -> DomainResult<()> {
    let mut attempts = 0;
    loop {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempts >= 3 => {
                return Err(
                    plain("Could not remove temporary converted audio after import")
                        .with_cause("IoError", delulu_core::error::io_error_code(&error)),
                )
            }
            Err(_) => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn convert_with_ffmpeg(
    source: &Path,
    output: &Path,
    cancel: Option<&CancellationToken>,
) -> DomainResult<()> {
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new("ffmpeg");
    command
        .host_env()
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i"])
        .arg(source)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|error| {
        plain(format!(
            "This format needs FFmpeg. Install ffmpeg and try again ({error})"
        ))
        .with_cause("IoError", delulu_core::error::io_error_code(&error))
    })?;
    let stderr_pipe = child.stderr.take();
    let reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut bytes).await;
        }
        bytes
    });
    let never = CancellationToken::new();
    let token = cancel.unwrap_or(&never);
    let status = tokio::select! {
        status = child.wait() => status,
        _ = token.cancelled() => {
            let _ = child.kill().await;
            return Err(plain("Import cancelled"));
        }
    };
    // Wait for stdio to close before removing partial output.
    let stderr = reader.await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&stderr);
    let stderr = {
        let start = stderr.len().saturating_sub(16_000);
        let start = (start..=stderr.len())
            .find(|index| stderr.is_char_boundary(*index))
            .unwrap_or(stderr.len());
        stderr[start..].trim().to_owned()
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(plain(format!(
            "FFmpeg could not decode this media file: {}",
            if stderr.is_empty() {
                format!(
                    "exit code {}",
                    status
                        .code()
                        .map_or("null".to_owned(), |code| code.to_string())
                )
            } else {
                stderr
            }
        ))),
        Err(error) => Err(plain(format!(
            "This format needs FFmpeg. Install ffmpeg and try again ({error})"
        ))),
    }
}

fn timings_map(timings: Option<&PipelineTimings>) -> Map<String, Value> {
    match timings.map(serde_json::to_value) {
        Some(Ok(Value::Object(map))) => map,
        _ => Map::new(),
    }
}

fn merge_timings(
    base: Option<&PipelineTimings>,
    extra: Option<&PipelineTimings>,
) -> Option<PipelineTimings> {
    let mut map = timings_map(base);
    map.extend(timings_map(extra));
    normalize_timings(&Value::Object(map))
}

fn merge_delivery(
    base: Option<&PipelineTimings>,
    measured: &DeliveryTimings,
) -> Option<PipelineTimings> {
    let extra = PipelineTimings {
        clipboard_ms: measured.clipboard_ms,
        paste_ms: measured.paste_ms,
        ..Default::default()
    };
    merge_timings(base, Some(&extra))
}

/// Builds the transcript record from a worker result (`createRecord`).
pub(crate) fn create_record(
    profile: &dyn Profile,
    result: &Value,
    source: TranscriptSource,
    duration_override: Option<f64>,
    source_name: Option<String>,
    settings: &AppSettings,
    timings: Option<&PipelineTimings>,
) -> DomainResult<TranscriptRecord> {
    let Some(text) = result.get("text").and_then(Value::as_str) else {
        return Err(plain("The speech worker returned an invalid text result."));
    };
    let text = js::trim(text).to_owned();
    if text.is_empty() {
        return Err(plain(
            "The speech model returned no text. Check the recording and retry.",
        ));
    }
    // With automatic detection, rules and formatting follow the language the
    // model reported. When it reports none, as for Dutch full of English
    // terms, guess Dutch or English from the text; otherwise it stays unknown.
    let guessed = (settings.language == AUTO_LANGUAGE)
        .then(|| guess_text_language(&text).unwrap_or("und").to_owned());
    let language =
        normalize_reported_language(result.get("recognizedLanguage").unwrap_or(&Value::Null))
            .or_else(|| guessed.clone())
            .unwrap_or_else(|| settings.language.clone());
    let formatted = if settings.spoken_formatting_commands {
        format_spoken_commands(&text, &language)
    } else {
        text.clone()
    };
    let rules = active_rules(&settings.custom_words, &settings.word_packs);
    let personalized = personalize_with_usage(&formatted, &rules, Some(&language));
    let counts: BTreeMap<String, u64> = personalized.counts.clone();
    profile.record_rule_usage(&counts);
    let duration_ms = duration_override
        .unwrap_or_else(|| js::round(numeric(result.get("duration"), 0.0) * 1000.0));
    let metadata = normalize_language_metadata(result);
    let backend = normalize_timings(result.get("timings").unwrap_or(&Value::Null));
    let mut merged = timings_map(timings);
    merged.extend(timings_map(backend.as_ref()));
    if let (Some(own), Some(reported)) = (
        timings.and_then(|t| t.preprocessing_ms),
        backend.as_ref().and_then(|t| t.preprocessing_ms),
    ) {
        merged.insert("preprocessingMs".into(), json!(own + reported));
    }
    let spoken = source == TranscriptSource::Dictation
        && settings.dictation_formatting == DictationFormatting::Spoken;
    let now = delulu_core::now_ms();
    Ok(TranscriptRecord {
        id: delulu_core::uuid(),
        created_at: now as f64,
        duration_ms,
        text: text.clone(),
        source_revision: Some(0.0),
        rewrite_source_revision: Some(None),
        personalized_text: Some(Some(if spoken {
            format_dictation(&text, &rules, settings.dictation_formatting, &language)
        } else {
            personalized.text
        })),
        dictation_formatting: Some(if spoken && (language == "en" || language == "nl") {
            DictationFormatting::Spoken
        } else {
            DictationFormatting::Preserve
        }),
        model: settings.model.into(),
        language: metadata
            .recognized_language
            .clone()
            .or(guessed)
            .unwrap_or_else(|| "und".into()),
        recognized_language: Some(metadata.recognized_language),
        recognized_languages: Some(metadata.recognized_languages),
        language_status: Some(metadata.language_status),
        requested_language: Some(Some(settings.language.clone())),
        speech_execution: normalize_speech_execution(
            result.get("speechExecution").unwrap_or(&Value::Null),
        ),
        source,
        source_name: Some(source_name),
        processing_time_ms: js::round(numeric(result.get("processingTime"), 0.0) * 1000.0),
        timings: normalize_timings(&Value::Object(merged)),
        delivery: Some(delivery_record(DeliveryState::Transcribed, None, None)),
        ..TranscriptRecord::default()
    })
}
