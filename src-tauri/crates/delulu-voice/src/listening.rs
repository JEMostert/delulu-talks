//! The microphone for Talk (`electron/services/listening.ts`): one listening
//! session keeps the microphone and the speech model running, detects turns,
//! transcribes them in order and hands each finished turn to its owner
//! ([`ListeningService::on_heard`]).
//!
//! Capture is native ([`delulu_audio::ListenCapture`] behind
//! [`NativeListenBackend`]). The capture interrupts the player itself on
//! barge-in; this service then cancels synthesis and the queue through
//! [`SpeechOutput::interrupt_speech`].
//!
//! Every accepted recording is kept under the private `voice/pending-audio/`
//! until its owner has handled the turn ([`ListeningService::discard`]), so a
//! quit or a stop in between never loses it: the next start transcribes the
//! leftovers again before opening the microphone.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use delulu_audio::{ListenCapture, ListenConfig, ListenEvent as CaptureEvent, ListenState, Player};
use delulu_core::util::write_private_atomic;
use delulu_core::{now_ms, uuid, DomainError, DomainResult};
use delulu_domain::js;
use delulu_domain::listening::{
    ListenSessionInfo, ListenSessionState, ListenStatus, ListenUtteranceEvent, LISTEN_LIMITS,
};
use delulu_domain::AppSettings;
use delulu_runtime::SerialQueue;
use parking_lot::{Mutex, ReentrantMutex};
use serde_json::{json, Value};

use crate::host::{ListenTranscriber, VoiceProfile};
use crate::service::VoiceService;

const RECENT_UTTERANCES: usize = 20;
/// The private directory of accepted recordings.
pub const PENDING_AUDIO: &str = "pending-audio";
/// Failed retries before a leftover recording is given up.
const RECOVERY_ATTEMPTS: u64 = 3;
const CLIENT: &str = "delulu";
// Sounds people make while thinking or that recognizers emit for noise.
const NOT_A_TURN: [&str; 12] = ["", "uh", "um", "hm", "hmm", "mm", "mhm", "ah", "oh", "eh", "er", "huh"];

/// The parts of the voice service listening uses.
pub trait SpeechOutput: Send + Sync {
    /// Stop Delulu talking; returns the response ids that were cut off.
    fn interrupt_speech(&self) -> Vec<String>;
    /// Text Delulu said recently, to recognize its own voice.
    fn recently_spoken(&self) -> Vec<String>;
}

impl SpeechOutput for VoiceService {
    fn interrupt_speech(&self) -> Vec<String> {
        self.interrupt()
    }
    fn recently_spoken(&self) -> Vec<String> {
        VoiceService::recently_spoken(self, 60_000)
    }
}

/// Commands to the microphone owner (the TypeScript `ListenCommand`).
#[derive(Debug, Clone, PartialEq)]
pub enum CaptureCommand {
    Start {
        session_id: String,
        config: ListenConfig,
    },
    /// New tuning; a different device reopens the microphone.
    Configure {
        session_id: String,
        config: ListenConfig,
    },
    /// Dictation owns the microphone; ignore audio until resumed.
    Pause {
        session_id: String,
    },
    Resume {
        session_id: String,
    },
    Stop {
        session_id: String,
    },
}

/// Delivers capture events back to the listening service (replaces the
/// renderer's `listen:event`). Callable from any thread.
#[derive(Clone)]
pub struct CaptureEvents {
    inner: Weak<Inner>,
}

impl CaptureEvents {
    pub fn deliver(&self, session_id: &str, event: CaptureEvent) {
        if let Some(inner) = self.inner.upgrade() {
            ListeningService { inner }.capture_event(session_id, event);
        }
    }
}

/// Owns the microphone for listening.
pub trait ListenBackend: Send + Sync {
    /// Returns false when the microphone cannot be used right now.
    fn command(&self, command: CaptureCommand, events: &CaptureEvents) -> bool;
}

/// [`ListenBackend`] over [`ListenCapture`]. `player` is the echo reference
/// and is interrupted by the capture on barge-in.
pub struct NativeListenBackend {
    player: Option<Player>,
    capture: Mutex<Option<ListenCapture>>,
}

impl NativeListenBackend {
    pub fn new(player: Option<Player>) -> Self {
        Self { player, capture: Mutex::new(None) }
    }

    fn release(capture: ListenCapture) {
        // `stop` joins the capture thread, which may be the caller.
        let _ = std::thread::Builder::new().name("delulu-listen-stop".into()).spawn(move || capture.stop());
    }
}

impl ListenBackend for NativeListenBackend {
    fn command(&self, command: CaptureCommand, events: &CaptureEvents) -> bool {
        let mut current = self.capture.lock();
        let matches =
            |id: &str, current: &Option<ListenCapture>| current.as_ref().is_some_and(|c| c.session_id() == id);
        match command {
            CaptureCommand::Start { session_id, config } => {
                if let Some(previous) = current.take() {
                    Self::release(previous);
                }
                let events = events.clone();
                *current = Some(ListenCapture::start(session_id, config, self.player.clone(), move |id, event| {
                    events.deliver(id, event)
                }));
            }
            CaptureCommand::Configure { session_id, config } => {
                if matches(&session_id, &current) {
                    current.as_ref().expect("checked").configure(config);
                }
            }
            CaptureCommand::Pause { session_id } => {
                if matches(&session_id, &current) {
                    current.as_ref().expect("checked").pause();
                }
            }
            CaptureCommand::Resume { session_id } => {
                if matches(&session_id, &current) {
                    current.as_ref().expect("checked").resume();
                }
            }
            CaptureCommand::Stop { session_id } => {
                if matches(&session_id, &current) {
                    Self::release(current.take().expect("checked"));
                }
            }
        }
        true
    }
}

fn words(text: &str) -> Vec<String> {
    let cleaned: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphabetic() || c.is_numeric() || js::is_whitespace(c) || c == '\'' { c } else { ' ' })
        .collect();
    cleaned.split(js::is_whitespace).filter(|word| !word.is_empty()).map(str::to_owned).collect()
}

/// Whether a transcript is mostly words Delulu itself just said.
pub fn sounds_like_own_speech(text: &str, spoken: &[String]) -> bool {
    let heard = words(text);
    if heard.len() < 2 {
        return false;
    }
    spoken.iter().any(|said| {
        let vocabulary = words(said);
        let matched = heard.iter().filter(|word| vocabulary.contains(word)).count();
        matched as f64 / heard.len() as f64 >= 0.7
    })
}

/// Whether a transcript carries an actual turn rather than noise or a filler.
pub fn is_real_turn(text: &str) -> bool {
    let heard = words(text);
    !heard.is_empty() && !heard.iter().all(|word| NOT_A_TURN.contains(&word.as_str()))
}

/// What a listening session reports to its owner.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// A finished, transcribed turn. Once handled, pass `recording` to
    /// [`ListeningService::discard`]; to retry it at the next start instead,
    /// pass it to [`ListeningService::release`].
    Turn { turn: ListenUtteranceEvent, recording: Option<PathBuf> },
    /// The user talked over Delulu; these responses were cut off.
    BargeIn { response_ids: Vec<String> },
    /// Raw microphone level in dBFS.
    Level { db: f64 },
}

struct Session {
    id: String,
    state: ListenSessionState,
    started_at: u64,
    delivered: u64,
    user_speaking: bool,
    transcribing: u32,
    error: Option<String>,
    /// The response a barge-in cut off, until the user's utterance arrives.
    interrupted_response_id: Option<String>,
    /// Dictation owns the microphone for now.
    paused_for_dictation: bool,
}

impl Session {
    fn ended(&self) -> bool {
        matches!(self.state, ListenSessionState::Stopped | ListenSessionState::Failed)
    }

    fn info(&self) -> ListenSessionInfo {
        ListenSessionInfo {
            id: self.id.clone(),
            client: CLIENT.into(),
            state: self.state,
            started_at: self.started_at,
            acked_seq: self.delivered,
            last_seq: self.delivered,
            queued: 0,
            user_speaking: self.user_speaking,
            transcribing: self.transcribing > 0,
            waiters: 0,
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
struct State {
    session: Option<Session>,
    recent: Vec<ListenUtteranceEvent>,
    capturing: bool,
    /// Recordings handed to the owner and not yet discarded or released.
    outstanding: HashSet<PathBuf>,
}

impl State {
    fn active(&self) -> bool {
        self.session.as_ref().is_some_and(|session| {
            matches!(
                session.state,
                ListenSessionState::Starting | ListenSessionState::Listening | ListenSessionState::Paused
            )
        })
    }

    fn current(&mut self, session_id: &str) -> Option<&mut Session> {
        self.session.as_mut().filter(|session| session.id == session_id)
    }

    /// Ends the session and returns the capture command to send.
    fn end(&mut self, session_id: &str, state: ListenSessionState, reason: &str) -> Option<CaptureCommand> {
        let session = self.current(session_id)?;
        if session.ended() {
            return None;
        }
        session.state = state;
        session.user_speaking = false;
        if state == ListenSessionState::Failed {
            session.error = Some(reason.to_owned());
        }
        self.capturing = false;
        Some(CaptureCommand::Stop { session_id: session_id.to_owned() })
    }
}

type Listener = Arc<dyn Fn(&ListenStatus) + Send + Sync>;
type Owner = Arc<dyn Fn(Heard) + Send + Sync>;

struct Inner {
    profile: Arc<dyn VoiceProfile>,
    transcriber: Arc<dyn ListenTranscriber>,
    speech: Arc<dyn SpeechOutput>,
    backend: Arc<dyn ListenBackend>,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    publishing: ReentrantMutex<()>,
    listeners: Mutex<Vec<Listener>>,
    owner: Mutex<Option<Owner>>,
    commands: ReentrantMutex<()>,
    pending_transcriptions: AtomicUsize,
    transcriptions_done: tokio::sync::Notify,
    transcriptions: SerialQueue,
    /// Serializes starts, so recovery never runs twice at once.
    starting: tokio::sync::Mutex<()>,
}

/// The listening session. Cheap to clone; construct inside a Tokio runtime.
#[derive(Clone)]
pub struct ListeningService {
    inner: Arc<Inner>,
}

fn config(settings: &AppSettings) -> ListenConfig {
    let ms = |value: f64| value.clamp(0.0, u32::MAX as f64).round() as u32;
    ListenConfig {
        device_id: if settings.input_device_id.is_empty() {
            "default".into()
        } else {
            settings.input_device_id.clone()
        },
        sensitivity: settings.listen_sensitivity,
        silence_ms: ms(settings.listen_silence_ms),
        min_speech_ms: 200,
        pre_roll_ms: 500,
        barge_in: settings.listen_barge_in,
        barge_in_ms: ms(settings.listen_barge_in_ms),
        max_utterance_ms: LISTEN_LIMITS.max_utterance_ms as u32,
    }
}

fn remove_recording(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("json"));
}

impl ListeningService {
    pub fn new(
        profile: Arc<dyn VoiceProfile>,
        transcriber: Arc<dyn ListenTranscriber>,
        speech: Arc<dyn SpeechOutput>,
        backend: Arc<dyn ListenBackend>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                profile,
                transcriber,
                speech,
                backend,
                runtime: tokio::runtime::Handle::current(),
                state: Mutex::new(State::default()),
                publishing: ReentrantMutex::new(()),
                listeners: Mutex::new(Vec::new()),
                owner: Mutex::new(None),
                commands: ReentrantMutex::new(()),
                pending_transcriptions: AtomicUsize::new(0),
                transcriptions_done: tokio::sync::Notify::new(),
                transcriptions: SerialQueue::new(),
                starting: tokio::sync::Mutex::new(()),
            }),
        }
    }

    fn events(&self) -> CaptureEvents {
        CaptureEvents { inner: Arc::downgrade(&self.inner) }
    }

    fn command(&self, command: Option<CaptureCommand>) -> bool {
        match command {
            Some(command) => self.inner.backend.command(command, &self.events()),
            None => true,
        }
    }

    fn pending_directory(&self) -> PathBuf {
        self.inner.profile.paths().voice_dir().join(PENDING_AUDIO)
    }

    /// Who receives turns, barge-ins and levels (the talk loop).
    pub fn on_heard(&self, owner: impl Fn(Heard) + Send + Sync + 'static) {
        *self.inner.owner.lock() = Some(Arc::new(owner));
    }

    fn tell(&self, heard: Heard) {
        let owner = self.inner.owner.lock().clone();
        if let Some(owner) = owner {
            owner(heard);
        }
    }

    /// Called with every status change (`listen:statusChanged`).
    pub fn on_status(&self, listener: impl Fn(&ListenStatus) + Send + Sync + 'static) {
        self.inner.listeners.lock().push(Arc::new(listener));
    }

    /// A session is running and keeps the speech model loaded.
    pub fn active(&self) -> bool {
        self.inner.state.lock().active()
    }

    pub fn get_status(&self) -> ListenStatus {
        let state = self.inner.state.lock();
        let session = state.session.as_ref();
        let message = match session {
            None => "Not listening".to_owned(),
            Some(session) => match session.state {
                ListenSessionState::Listening if session.user_speaking => "Hearing you…".into(),
                ListenSessionState::Listening if session.transcribing > 0 => "Transcribing…".into(),
                ListenSessionState::Listening => "Listening".into(),
                ListenSessionState::Paused => "Paused while you dictate".into(),
                ListenSessionState::Starting => "Starting the microphone…".into(),
                ListenSessionState::Failed => session.error.clone().unwrap_or_else(|| "Listening failed".into()),
                ListenSessionState::Stopped => "Stopped".into(),
            },
        };
        ListenStatus {
            session: session.map(Session::info),
            recent: state.recent.clone(),
            capturing: state.capturing,
            message,
        }
    }

    fn publish(&self) {
        let _order = self.inner.publishing.lock();
        let status = self.get_status();
        let listeners: Vec<Listener> = self.inner.listeners.lock().clone();
        for listener in listeners {
            listener(&status);
        }
    }

    /// Start listening (or return the running session): loads the speech
    /// model, hands over leftover recordings, then opens the microphone.
    pub async fn start(&self) -> DomainResult<ListenSessionInfo> {
        let _starting = self.inner.starting.lock().await;
        let id = {
            let mut state = self.inner.state.lock();
            if state.active() {
                return Ok(state.session.as_ref().expect("active").info());
            }
            let id = format!("lsn_{}", &uuid().replace('-', "")[..16]);
            state.session = Some(Session {
                id: id.clone(),
                state: ListenSessionState::Starting,
                started_at: now_ms(),
                delivered: 0,
                user_speaking: false,
                transcribing: 0,
                error: None,
                interrupted_response_id: None,
                paused_for_dictation: false,
            });
            state.recent.clear();
            id
        };
        self.publish();
        // Load the speech model once; it stays loaded while the session runs.
        if let Err(error) = self.inner.transcriber.prepare(&self.inner.profile.settings()).await {
            let message = if error.message.is_empty() { "Speech is unavailable".to_owned() } else { error.message };
            return Err(self.fail_start(&id, &message));
        }
        self.recover(&id).await;
        let commands = self.inner.commands.lock();
        {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(&id) else {
                return Err(DomainError::failed("Listening stopped while it started"));
            };
            if session.state != ListenSessionState::Starting {
                return Ok(session.info());
            }
        }
        let settings = self.inner.profile.settings();
        if !self.command(Some(CaptureCommand::Start { session_id: id.clone(), config: config(&settings) })) {
            return Err(self.fail_start(&id, "Open Delulu Talks so it can use the microphone."));
        }
        drop(commands);
        let mut state = self.inner.state.lock();
        state.current(&id).map(|session| session.info()).ok_or_else(|| DomainError::failed("Listening stopped"))
    }

    fn fail_start(&self, id: &str, message: &str) -> DomainError {
        self.end(id, ListenSessionState::Failed, message);
        let error = self.inner.state.lock().current(id).and_then(|session| session.error.clone());
        DomainError::failed(error.unwrap_or_else(|| message.to_owned()))
    }

    /// Transcribes recordings an earlier session accepted but whose turns were
    /// never handled, oldest first, and hands them to the owner.
    async fn recover(&self, session_id: &str) {
        self.finish_transcriptions().await;
        let directory = self.pending_directory();
        let Ok(entries) = std::fs::read_dir(&directory) else { return };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "wav"))
            .collect();
        files.sort();
        for path in files {
            if self.inner.state.lock().outstanding.contains(&path) {
                continue;
            }
            let metadata_path = path.with_extension("json");
            let mut metadata: Value = std::fs::read(&metadata_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_else(|| json!({}));
            let duration_ms = metadata["durationMs"].as_u64().unwrap_or(0);
            match self.inner.transcriber.transcribe(&path, duration_ms).await {
                Ok(text) if is_real_turn(&text) => {
                    let turn = ListenUtteranceEvent {
                        seq: 0,
                        id: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
                        session_id: session_id.to_owned(),
                        text: js::trim(&text).to_owned(),
                        at: now_ms(),
                        duration_ms,
                        interrupted_response_id: metadata["interruptedResponseId"].as_str().map(str::to_owned),
                    };
                    self.deliver(session_id, turn, Some(path));
                }
                Ok(_) => remove_recording(&path),
                Err(_) => {
                    let attempts = metadata["attempts"].as_u64().unwrap_or(0) + 1;
                    log::warn!("could not transcribe a saved recording (attempt {attempts})");
                    if attempts >= RECOVERY_ATTEMPTS {
                        remove_recording(&path);
                    } else {
                        metadata["attempts"] = json!(attempts);
                        let _ = serde_json::to_vec(&metadata).map(|bytes| write_private_atomic(&metadata_path, &bytes));
                    }
                }
            }
        }
    }

    /// Hands a turn to the owner.
    fn deliver(&self, session_id: &str, turn: ListenUtteranceEvent, recording: Option<PathBuf>) {
        {
            let mut state = self.inner.state.lock();
            if let Some(path) = &recording {
                state.outstanding.insert(path.clone());
            }
            if let Some(session) = state.current(session_id) {
                session.delivered += 1;
                session.error = None;
            }
            state.recent.insert(0, turn.clone());
            state.recent.truncate(RECENT_UTTERANCES);
        }
        self.tell(Heard::Turn { turn, recording });
    }

    /// The owner handled the turn: delete its recording.
    pub fn discard(&self, recording: &Path) {
        self.inner.state.lock().outstanding.remove(recording);
        remove_recording(recording);
    }

    /// The owner dropped the turn unhandled: keep its recording for the next start.
    pub fn release(&self, recording: &Path) {
        self.inner.state.lock().outstanding.remove(recording);
    }

    /// Waits for transcriptions already accepted.
    pub async fn finish_transcriptions(&self) {
        loop {
            let done = self.inner.transcriptions_done.notified();
            tokio::pin!(done);
            done.as_mut().enable();
            if self.inner.pending_transcriptions.load(Ordering::SeqCst) == 0 {
                break;
            }
            done.await;
        }
    }

    /// Stop whatever session is running (Talk, tray, quitting).
    pub fn stop_active(&self, reason: &str) {
        let id = {
            let state = self.inner.state.lock();
            if !state.active() {
                return;
            }
            state.session.as_ref().map(|session| session.id.clone())
        };
        if let Some(id) = id {
            self.end(&id, ListenSessionState::Stopped, reason);
        }
    }

    fn end(&self, session_id: &str, state: ListenSessionState, reason: &str) {
        let _commands = self.inner.commands.lock();
        let command = self.inner.state.lock().end(session_id, state, reason);
        if command.is_some() {
            self.command(command);
            self.publish();
        }
    }

    /* -------------------------------------------------------------- */
    /* Capture events                                                  */
    /* -------------------------------------------------------------- */

    pub fn capture_event(&self, session_id: &str, event: CaptureEvent) {
        let mut failure = None;
        {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(session_id) else { return };
            if session.ended() {
                return;
            }
            match event {
                CaptureEvent::State { state: ListenState::Listening, .. } => {
                    session.state = if session.paused_for_dictation {
                        ListenSessionState::Paused
                    } else {
                        ListenSessionState::Listening
                    };
                    session.error = None;
                    state.capturing = true;
                }
                CaptureEvent::State { state: ListenState::Failed, message } => {
                    state.capturing = false;
                    failure = Some(message.unwrap_or_else(|| "The microphone stopped".into()));
                }
                CaptureEvent::State { state: ListenState::Stopped, .. } => {}
                CaptureEvent::SpeechStart { .. } => session.user_speaking = true,
                CaptureEvent::Discarded { .. } => session.user_speaking = false,
                CaptureEvent::Level { db } => {
                    drop(state);
                    return self.tell(Heard::Level { db });
                }
                CaptureEvent::BargeIn { .. } => {
                    drop(state);
                    return self.barge_in(session_id);
                }
                CaptureEvent::Utterance { wav, duration_ms, .. } => {
                    session.user_speaking = false;
                    drop(state);
                    self.transcribe(session_id, wav, duration_ms);
                }
            }
        }
        if let Some(message) = failure {
            self.end(session_id, ListenSessionState::Failed, &message);
        }
        self.publish();
    }

    fn barge_in(&self, session_id: &str) {
        // The capture already silenced playback; cancel synthesis and the queue.
        let response_ids = self.inner.speech.interrupt_speech();
        {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(session_id) else { return };
            session.user_speaking = true;
            session.interrupted_response_id = response_ids.first().cloned();
        }
        self.tell(Heard::BargeIn { response_ids });
        self.publish();
    }

    fn transcribe(&self, session_id: &str, wav: Vec<u8>, duration_ms: u64) {
        let interrupted_response_id = {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(session_id) else { return };
            session.transcribing += 1;
            session.interrupted_response_id.take()
        };
        self.inner.pending_transcriptions.fetch_add(1, Ordering::SeqCst);
        let this = self.clone();
        let session_id = session_id.to_owned();
        // Accepted audio lives outside the temporary dictation files, which
        // startup cleanup deletes, until its turn is handled.
        let turn_id = format!("turn_{:020}_{}", now_ms(), uuid().replace('-', ""));
        let directory = self.pending_directory();
        let path = directory.join(format!("{turn_id}.wav"));
        let saved = (|| -> DomainResult<()> {
            crate::service::create_private_dir(&directory)?;
            write_private_atomic(&path, &wav)?;
            let metadata = json!({ "durationMs": duration_ms, "interruptedResponseId": interrupted_response_id });
            write_private_atomic(&path.with_extension("json"), &serde_json::to_vec(&metadata)?)?;
            Ok(())
        })();
        // Transcribe in order so turns arrive as spoken.
        let task = self.inner.transcriptions.clone().run(move || async move {
            let result = match saved {
                Ok(()) => this.inner.transcriber.transcribe(&path, duration_ms).await,
                Err(error) => Err(error),
            };
            let spoken = this.inner.speech.recently_spoken();
            let turn = {
                let mut state = this.inner.state.lock();
                let active = state.active();
                let session = state.current(&session_id);
                let live = active && session.is_some();
                if let Some(session) = session {
                    session.transcribing = session.transcribing.saturating_sub(1);
                }
                match result {
                    Ok(text) => {
                        let text = js::trim(&text).to_owned();
                        let own = interrupted_response_id.is_none() && sounds_like_own_speech(&text, &spoken);
                        if !is_real_turn(&text) || own {
                            remove_recording(&path);
                            None
                        } else if live {
                            Some(ListenUtteranceEvent {
                                seq: 0,
                                session_id: session_id.clone(),
                                id: turn_id,
                                text,
                                at: now_ms(),
                                duration_ms,
                                interrupted_response_id,
                            })
                        } else {
                            // Stopped meanwhile: the recording waits for the next start.
                            None
                        }
                    }
                    Err(error) => {
                        // One failed transcription does not end the conversation;
                        // the recording is retried at the next start.
                        if let Some(session) = state.current(&session_id) {
                            session.error = Some(format!("Could not transcribe that: {}", error.message));
                        }
                        None
                    }
                }
            };
            if let Some(turn) = turn {
                this.deliver(&session_id, turn, Some(path));
            }
            this.publish();
            this.inner.pending_transcriptions.fetch_sub(1, Ordering::SeqCst);
            this.inner.transcriptions_done.notify_waiters();
        });
        self.inner.runtime.spawn(task);
    }

    /* -------------------------------------------------------------- */
    /* Coordination                                                    */
    /* -------------------------------------------------------------- */

    /// Dictation is about to open the microphone.
    pub fn pause_for_dictation(&self) {
        let command = {
            let mut state = self.inner.state.lock();
            if !state.active() {
                return;
            }
            let session = state.session.as_mut().expect("active");
            if session.paused_for_dictation {
                return;
            }
            session.paused_for_dictation = true;
            session.state = ListenSessionState::Paused;
            CaptureCommand::Pause { session_id: session.id.clone() }
        };
        self.command(Some(command));
        self.publish();
    }

    /// Dictation finished.
    pub fn resume_after_dictation(&self) {
        let command = {
            let mut state = self.inner.state.lock();
            let Some(session) = state.session.as_mut().filter(|session| session.paused_for_dictation) else { return };
            session.paused_for_dictation = false;
            if session.state != ListenSessionState::Paused {
                return;
            }
            session.state = ListenSessionState::Listening;
            CaptureCommand::Resume { session_id: session.id.clone() }
        };
        self.command(Some(command));
        self.publish();
    }

    /// Listening settings changed; apply them (including the microphone) to
    /// the running capture.
    pub fn settings_changed(&self, settings: &AppSettings) {
        let id = {
            let state = self.inner.state.lock();
            if !state.active() {
                return;
            }
            state.session.as_ref().map(|session| session.id.clone())
        };
        if let Some(session_id) = id {
            self.command(Some(CaptureCommand::Configure { session_id, config: config(settings) }));
        }
    }

    pub fn shutdown(&self) {
        self.stop_active("Delulu Talks closed");
    }
}
