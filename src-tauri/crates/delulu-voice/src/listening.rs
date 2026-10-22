//! Persistent listening sessions (`electron/services/listening.ts`). The app
//! owns the microphone, the speech model and the transcript queue; agents
//! collect events with short `next` calls that can time out, be cancelled or
//! be retried without losing anything.
//!
//! Capture is native ([`delulu_audio::ListenCapture`] behind
//! [`NativeListenBackend`]) instead of the renderer's `listen:command` /
//! `listen:event` IPC. The capture interrupts the player itself on barge-in;
//! this service then cancels synthesis and the queue through
//! [`SpeechOutput::interrupt_speech`].

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use delulu_audio::{ListenCapture, ListenConfig, ListenEvent as CaptureEvent, ListenState, Player};
use delulu_core::util::{create_private, truncate_utf16};
use delulu_core::{now_ms, uuid};
use delulu_domain::js;
use delulu_domain::listening::{
    ListenEvent, ListenInterruptedEvent, ListenNextResult, ListenSessionInfo, ListenSessionState, ListenStatus,
    ListenStoppedEvent, ListenUtteranceEvent, LISTEN_LIMITS,
};
use delulu_domain::AppSettings;
use delulu_runtime::SerialQueue;
use parking_lot::{Mutex, ReentrantMutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::host::{ListenTranscriber, VoiceProfile};
use crate::service::VoiceService;

const RECENT_UTTERANCES: usize = 20;
// Sounds people make while thinking or that recognizers emit for noise.
const NOT_A_TURN: [&str; 12] = ["", "uh", "um", "hm", "hmm", "mm", "mhm", "ah", "oh", "eh", "er", "huh"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenErrorCode {
    SessionBusy,
    SessionNotFound,
    Unavailable,
}

impl ListenErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionBusy => "SESSION_BUSY",
            Self::SessionNotFound => "SESSION_NOT_FOUND",
            Self::Unavailable => "UNAVAILABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenError {
    pub code: ListenErrorCode,
    pub message: String,
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ListenError {}

impl ListenError {
    fn new(code: ListenErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// The IPC form (`listen:start` from the Voice page): a plain error.
    pub fn into_domain(self) -> delulu_core::DomainError {
        delulu_core::DomainError::failed(self.message).with_cause("ListenError", None)
    }
}

/// The parts of the voice service a listening session uses.
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
    Start { session_id: String, config: ListenConfig },
    Configure { session_id: String, config: ListenConfig },
    /// Dictation owns the microphone; ignore audio until resumed.
    Pause { session_id: String },
    Resume { session_id: String },
    Stop { session_id: String },
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

/// Owns the microphone for listening sessions.
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
        let matches = |id: &str, current: &Option<ListenCapture>| current.as_ref().is_some_and(|c| c.session_id() == id);
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

struct Session {
    id: String,
    client: String,
    state: ListenSessionState,
    started_at: u64,
    events: Vec<ListenEvent>,
    acked_seq: u64,
    last_seq: u64,
    waiters: HashMap<u64, oneshot::Sender<ListenNextResult>>,
    user_speaking: bool,
    transcribing: u32,
    error: Option<String>,
    /// The response a barge-in cut off, until the user's utterance arrives.
    interrupted_response_id: Option<String>,
    /// Dictation owns the microphone for now.
    paused_for_dictation: bool,
    transcriptions: SerialQueue,
}

impl Session {
    fn ended(&self) -> bool {
        matches!(self.state, ListenSessionState::Stopped | ListenSessionState::Failed)
    }

    fn info(&self) -> ListenSessionInfo {
        ListenSessionInfo {
            id: self.id.clone(),
            client: self.client.clone(),
            state: self.state,
            started_at: self.started_at,
            acked_seq: self.acked_seq,
            last_seq: self.last_seq,
            queued: self.events.iter().filter(|event| event.seq() > self.acked_seq).count() as u64,
            user_speaking: self.user_speaking,
            transcribing: self.transcribing > 0,
            waiters: self.waiters.len() as u64,
            error: self.error.clone(),
        }
    }

    fn acknowledge(&mut self, after: u64) {
        let cursor = after.min(self.last_seq);
        if cursor <= self.acked_seq {
            return;
        }
        self.acked_seq = cursor;
        self.events.retain(|event| event.seq() > cursor);
    }

    fn first_pending(&self) -> Option<ListenEvent> {
        self.events.iter().find(|event| event.seq() > self.acked_seq).cloned()
    }
}

fn not_found() -> ListenError {
    ListenError::new(
        ListenErrorCode::SessionNotFound,
        "That listening session does not exist. Start a new one with listen start.",
    )
}

#[derive(Default)]
struct State {
    session: Option<Session>,
    recent: Vec<ListenUtteranceEvent>,
    capturing: bool,
}

impl State {
    fn active(&self) -> bool {
        self.session.as_ref().is_some_and(|session| {
            matches!(session.state, ListenSessionState::Starting | ListenSessionState::Listening | ListenSessionState::Paused)
        })
    }

    fn find(&mut self, session_id: &str) -> Result<&mut Session, ListenError> {
        self.session.as_mut().filter(|session| session.id == session_id).ok_or_else(not_found)
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
        self.push(
            session_id,
            ListenEvent::Stopped(ListenStoppedEvent {
                seq: 0,
                session_id: session_id.to_owned(),
                reason: reason.to_owned(),
                at: now_ms(),
            }),
        );
        Some(CaptureCommand::Stop { session_id: session_id.to_owned() })
    }

    fn push(&mut self, session_id: &str, mut event: ListenEvent) {
        let Some(session) = self.session.as_mut().filter(|session| session.id == session_id) else { return };
        session.last_seq += 1;
        let seq = session.last_seq;
        match &mut event {
            ListenEvent::Utterance(item) => item.seq = seq,
            ListenEvent::Interrupted(item) => item.seq = seq,
            ListenEvent::Stopped(item) => item.seq = seq,
        }
        session.events.push(event.clone());
        // Bound memory; acknowledged events are already gone.
        let acked = session.acked_seq;
        let unacked: Vec<u64> = session.events.iter().map(ListenEvent::seq).filter(|seq| *seq > acked).collect();
        if unacked.len() > LISTEN_LIMITS.queue {
            let drop = unacked[0];
            session.events.retain(|item| item.seq() != drop);
        }
        if let ListenEvent::Utterance(utterance) = event {
            self.recent.insert(0, utterance);
            self.recent.truncate(RECENT_UTTERANCES);
        }
        let session = self.session.as_mut().expect("still present");
        // Every waiter gets the first event after the shared cursor.
        if let Some(first) = session.first_pending() {
            let waiters: Vec<_> = session.waiters.drain().map(|(_, waiter)| waiter).collect();
            let info = session.info();
            for waiter in waiters {
                let _ = waiter.send(ListenNextResult::Event { event: first.clone(), session: info.clone() });
            }
        }
    }
}

type Listener = Arc<dyn Fn(&ListenStatus) + Send + Sync>;

struct Inner {
    profile: Arc<dyn VoiceProfile>,
    transcriber: Arc<dyn ListenTranscriber>,
    speech: Arc<dyn SpeechOutput>,
    backend: Arc<dyn ListenBackend>,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    publishing: ReentrantMutex<()>,
    listeners: Mutex<Vec<Listener>>,
    waiter_ids: AtomicU64,
}

/// Persistent listening sessions. Cheap to clone; construct inside a Tokio runtime.
#[derive(Clone)]
pub struct ListeningService {
    inner: Arc<Inner>,
}

fn config(settings: &AppSettings) -> ListenConfig {
    let ms = |value: f64| value.clamp(0.0, u32::MAX as f64).round() as u32;
    ListenConfig {
        device_id: if settings.input_device_id.is_empty() { "default".into() } else { settings.input_device_id.clone() },
        sensitivity: settings.listen_sensitivity,
        silence_ms: ms(settings.listen_silence_ms),
        min_speech_ms: 200,
        pre_roll_ms: 500,
        barge_in: settings.listen_barge_in,
        barge_in_ms: ms(settings.listen_barge_in_ms),
        max_utterance_ms: LISTEN_LIMITS.max_utterance_ms as u32,
    }
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
                waiter_ids: AtomicU64::new(1),
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

    /// Start listening, or return the running session started by this client.
    pub async fn start(&self, client: &str) -> Result<ListenSessionInfo, ListenError> {
        let name = match truncate_utf16(js::trim(client), 64) {
            "" => "agent".to_owned(),
            name => name.to_owned(),
        };
        let settings = self.inner.profile.settings();
        let id = {
            let mut state = self.inner.state.lock();
            if state.active() {
                let current = state.session.as_ref().expect("active");
                if current.client == name {
                    return Ok(current.info());
                }
                return Err(ListenError::new(
                    ListenErrorCode::SessionBusy,
                    format!(
                        "Delulu is already listening for {}. Stop that session first; one microphone serves one conversation.",
                        current.client
                    ),
                ));
            }
            let id = format!("lsn_{}", &uuid().replace('-', "")[..16]);
            state.session = Some(Session {
                id: id.clone(),
                client: name,
                state: ListenSessionState::Starting,
                started_at: now_ms(),
                events: Vec::new(),
                acked_seq: 0,
                last_seq: 0,
                waiters: HashMap::new(),
                user_speaking: false,
                transcribing: 0,
                error: None,
                interrupted_response_id: None,
                paused_for_dictation: false,
                transcriptions: SerialQueue::new(),
            });
            state.recent.clear();
            id
        };
        self.publish();
        // Load the speech model once; it stays loaded while the session runs.
        if let Err(error) = self.inner.transcriber.prepare(&settings).await {
            let message = if error.message.is_empty() { "Speech is unavailable".to_owned() } else { error.message };
            return Err(self.fail_start(&id, &message));
        }
        {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(&id) else {
                return Ok(state.session.as_ref().map(Session::info).expect("a session exists"));
            };
            if session.state != ListenSessionState::Starting {
                return Ok(session.info());
            }
        }
        if !self.command(Some(CaptureCommand::Start { session_id: id.clone(), config: config(&settings) })) {
            return Err(self.fail_start(&id, "Open Delulu Talks so it can use the microphone."));
        }
        let mut state = self.inner.state.lock();
        state.find(&id).map(|session| session.info())
    }

    fn fail_start(&self, id: &str, message: &str) -> ListenError {
        self.end(id, ListenSessionState::Failed, message);
        let error = self.inner.state.lock().current(id).and_then(|session| session.error.clone());
        ListenError::new(ListenErrorCode::Unavailable, error.unwrap_or_else(|| message.to_owned()))
    }

    /// Wait for the next event after the cursor; `after` acknowledges up to it.
    /// Cancelling `cancel` ends the wait with a timeout and leaves the event queued.
    pub async fn next(
        &self,
        session_id: &str,
        after: Option<u64>,
        timeout_ms: u64,
        cancel: Option<CancellationToken>,
    ) -> Result<ListenNextResult, ListenError> {
        let (waiter, receiver) = {
            let mut state = self.inner.state.lock();
            let session = state.find(session_id)?;
            if let Some(after) = after {
                session.acknowledge(after);
            }
            if let Some(event) = session.first_pending() {
                return Ok(ListenNextResult::Event { event, session: session.info() });
            }
            if session.ended() {
                return Ok(ListenNextResult::Stopped {
                    reason: session.error.clone().unwrap_or_else(|| "The listening session ended".into()),
                    session: session.info(),
                });
            }
            let timeout_ms = timeout_ms.min(LISTEN_LIMITS.max_wait_seconds * 1000);
            if timeout_ms == 0 || cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Ok(ListenNextResult::Timeout { session: session.info() });
            }
            let waiter = self.inner.waiter_ids.fetch_add(1, Ordering::Relaxed);
            let (sender, receiver) = oneshot::channel();
            session.waiters.insert(waiter, sender);
            (waiter, (receiver, timeout_ms))
        };
        self.publish();
        let (mut receiver, timeout_ms) = receiver;
        let cancelled = async {
            match &cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! {
            result = &mut receiver => result.ok(),
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => None,
            _ = cancelled => None,
        };
        if let Some(result) = result {
            self.publish();
            return Ok(result);
        }
        // A cancelled or timed-out waiter leaves its event queued for the next one.
        let result = {
            let mut state = self.inner.state.lock();
            let session = state.current(session_id);
            if let Some(session) = session {
                session.waiters.remove(&waiter);
            }
            match receiver.try_recv() {
                Ok(result) => result,
                Err(_) => match state.current(session_id) {
                    Some(session) => ListenNextResult::Timeout { session: session.info() },
                    None => return Err(not_found()),
                },
            }
        };
        self.publish();
        Ok(result)
    }

    pub fn ack(&self, session_id: &str, after: u64) -> Result<ListenSessionInfo, ListenError> {
        let info = {
            let mut state = self.inner.state.lock();
            let session = state.find(session_id)?;
            session.acknowledge(after);
            session.info()
        };
        self.publish();
        Ok(info)
    }

    pub fn status(&self, session_id: Option<&str>) -> Result<Option<ListenSessionInfo>, ListenError> {
        let mut state = self.inner.state.lock();
        match session_id {
            Some(id) => Ok(Some(state.find(id)?.info())),
            None => Ok(state.session.as_ref().map(Session::info)),
        }
    }

    pub fn stop(&self, session_id: &str, reason: &str) -> Result<ListenSessionInfo, ListenError> {
        self.inner.state.lock().find(session_id)?;
        self.end(session_id, ListenSessionState::Stopped, reason);
        let mut state = self.inner.state.lock();
        Ok(state.find(session_id)?.info())
    }

    /// Stop whatever session is running (Voice page, tray, quitting).
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
        let responses = self.inner.speech.interrupt_speech();
        let response_id = responses.into_iter().next();
        {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(session_id) else { return };
            session.user_speaking = true;
            session.interrupted_response_id = response_id.clone();
            state.push(
                session_id,
                ListenEvent::Interrupted(ListenInterruptedEvent {
                    seq: 0,
                    session_id: session_id.to_owned(),
                    response_id,
                    at: now_ms(),
                }),
            );
        }
        self.publish();
    }

    fn transcribe(&self, session_id: &str, wav: Vec<u8>, duration_ms: u64) {
        let (queue, interrupted_response_id) = {
            let mut state = self.inner.state.lock();
            let Some(session) = state.current(session_id) else { return };
            session.transcribing += 1;
            (session.transcriptions.clone(), session.interrupted_response_id.take())
        };
        let this = self.clone();
        let session_id = session_id.to_owned();
        // Transcribe in order so turns arrive as spoken.
        let task = queue.run(move || async move {
            let directory = this.inner.profile.paths().audio_cache();
            let path = directory.join(format!("dictation-{}-{}.wav", now_ms(), uuid()));
            let result = async {
                std::fs::create_dir_all(&directory)?;
                create_private(&path)?.write_all(&wav)?;
                this.inner.transcriber.transcribe(&path, duration_ms).await
            }
            .await;
            let _ = std::fs::remove_file(&path);
            let spoken = this.inner.speech.recently_spoken();
            {
                let mut state = this.inner.state.lock();
                let active = state.active();
                if let Some(session) = state.current(&session_id) {
                    session.transcribing = session.transcribing.saturating_sub(1);
                }
                match result {
                    Ok(text) => {
                        let text = js::trim(&text).to_owned();
                        let own = || sounds_like_own_speech(&text, &spoken);
                        if active
                            && state.current(&session_id).is_some()
                            && is_real_turn(&text)
                            && (interrupted_response_id.is_some() || !own())
                        {
                            if let Some(session) = state.current(&session_id) {
                                session.error = None;
                            }
                            state.push(
                                &session_id,
                                ListenEvent::Utterance(ListenUtteranceEvent {
                                    seq: 0,
                                    session_id: session_id.clone(),
                                    id: format!("utt_{}", &uuid().replace('-', "")[..16]),
                                    text,
                                    at: now_ms(),
                                    duration_ms,
                                    interrupted_response_id,
                                }),
                            );
                        }
                    }
                    Err(error) => {
                        // One failed transcription does not end the conversation.
                        if let Some(session) = state.current(&session_id) {
                            session.error = Some(format!("Could not transcribe that: {}", error.message));
                        }
                    }
                }
            }
            this.publish();
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

    /// Listening settings changed; apply them to the running capture.
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
