//! The socket server: connections, requests, subscriptions and the dictation
//! state machine.
//!
//! The machine's effects are carried out by an [`Effects`] implementation: the
//! fake engine in demo mode, the real dictation runtime (`crate::live`) with
//! `DELULU_DAEMON=1`, or none, in which case dictation requests are refused.
//!
//! All state lives in memory behind one mutex that is never held across an
//! `await`. Events go out through a bounded broadcast channel, so publishing
//! never waits for a subscriber: a connection that reads too slowly misses
//! events and gets one `lagged` event instead, and a connection whose socket
//! stops accepting writes for `write_timeout` is closed.

use crate::{demo, now_ms};
use delulu_core::dictation::{self as fsm, Dictation, Ignored, Input, Outcome, Step};
use delulu_proto::api::*;
use delulu_proto::framing::{Frame, LineDecoder};
use delulu_proto::state::*;
use serde_json::Value;
use std::collections::BTreeSet;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct Options {
    pub mode: DaemonMode,
    /// Demo only: run the scripted changes (download progress, radio, reports).
    pub script: bool,
    /// Events buffered per subscriber before it counts as lagging.
    pub event_capacity: usize,
    /// A write that takes longer closes the connection.
    pub write_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: DaemonMode::Normal,
            script: true,
            event_capacity: 1024,
            write_timeout: Duration::from_secs(5),
        }
    }
}

/// Carries out the dictation state machine's effects.
pub trait Effects: Send + Sync + 'static {
    /// Starts the work `effect` asks for and returns at once; results come back
    /// through [`Daemon::input`]. Called without the state lock held.
    fn run(&self, daemon: &Daemon, effect: fsm::Effect);
    /// The wire form of a finished dictation, and the History entry it added.
    /// Called with the state lock held, so it must not call into the daemon.
    fn record(&self, outcome: Outcome, now: u64) -> (DictationOutcome, Option<HistoryEntry>);
    /// A History page from the store; `None` serves it from the snapshot.
    fn history(&self, _params: &HistoryListParams) -> Option<HistoryPage> {
        None
    }
}

/// Entries per History page when a request does not say.
pub const HISTORY_PAGE: u32 = 50;

#[derive(Clone)]
struct Published {
    topic: Option<Topic>,
    line: Arc<str>,
}

struct Inner {
    state: AppState,
    machine: Dictation,
}

struct Shared {
    opts: Options,
    inner: Mutex<Inner>,
    events: broadcast::Sender<Published>,
    effects: OnceLock<Arc<dyn Effects>>,
    /// Held from a transition until its effects have started, so the effects of
    /// two inputs never interleave: a cancel cannot discard a recording before
    /// the start it follows has opened the microphone.
    order: Mutex<()>,
}

/// A running daemon's state. Cheap to clone.
#[derive(Clone)]
pub struct Daemon {
    shared: Arc<Shared>,
}

impl Daemon {
    pub fn new(opts: Options) -> Self {
        let state = match opts.mode {
            DaemonMode::Demo => demo::state(now_ms()),
            DaemonMode::Normal => normal_state(now_ms()),
        };
        let machine = Dictation::new(fsm::Config {
            cleanup: state.settings.as_ref().is_none_or(|s| s.cleanup),
        });
        let (events, _) = broadcast::channel(opts.event_capacity.max(1));
        let demo = opts.mode == DaemonMode::Demo;
        let daemon = Self {
            shared: Arc::new(Shared {
                opts,
                inner: Mutex::new(Inner { state, machine }),
                events,
                effects: OnceLock::new(),
                order: Mutex::new(()),
            }),
        };
        if demo {
            daemon.set_effects(Arc::new(demo::DemoEffects));
        }
        daemon
    }

    /// Gives dictation to `effects`. Only the first call counts.
    pub fn set_effects(&self, effects: Arc<dyn Effects>) {
        let _ = self.shared.effects.set(effects);
    }

    /// Feeds the dictation state machine, publishes the change and starts its
    /// effects. `Err` says why the input changed nothing. Effects must not call
    /// this themselves; they feed results from a task.
    pub fn input(&self, input: Input) -> Result<DictationReply, Ignored> {
        self.shared.input(input)
    }

    /// Changes the snapshot and publishes the events `f` returns, in order, as
    /// one step: no snapshot shows the change without its events.
    pub fn update(&self, f: impl FnOnce(&mut AppState) -> Vec<Event>) {
        let mut inner = self.shared.lock();
        for event in f(&mut inner.state) {
            self.shared.publish(&mut inner, event);
        }
    }

    /// Reads the snapshot without cloning it.
    pub fn read<R>(&self, f: impl FnOnce(&AppState) -> R) -> R {
        f(&self.shared.lock().state)
    }

    /// Reads or changes the state machine without feeding it an input.
    pub fn with_machine<R>(&self, f: impl FnOnce(&mut Dictation) -> R) -> R {
        f(&mut self.shared.lock().machine)
    }

    pub fn snapshot(&self) -> AppState {
        self.shared.lock().state.clone()
    }

    /// Sends `event` to every connection subscribed to its topic.
    pub fn publish(&self, event: Event) {
        let mut inner = self.shared.lock();
        self.shared.publish(&mut inner, event);
    }

    /// Accepts connections until `shutdown` resolves, then tells subscribers and returns.
    pub async fn serve(&self, listener: UnixListener, shutdown: impl Future<Output = ()>) {
        let script = (self.shared.opts.mode == DaemonMode::Demo && self.shared.opts.script)
            .then(|| tokio::spawn(run_script(Arc::clone(&self.shared))));
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        tokio::spawn(connection(Arc::clone(&self.shared), stream));
                    }
                    Err(e) => {
                        // EMFILE and friends: back off instead of spinning.
                        eprintln!("delulud: accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                },
                () = &mut shutdown => break,
            }
        }
        if let Some(script) = script {
            script.abort();
        }
        self.publish(Event::ShuttingDown);
        // Let connection tasks flush the goodbye; they end with the runtime.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Publishing under the state lock keeps `seq` order equal to send order and
    /// makes snapshots consistent with `seq`.
    fn publish(&self, inner: &mut Inner, event: Event) {
        inner.state.seq += 1;
        let topic = event.topic();
        let line = ServerMessage::Event(EventMessage {
            seq: inner.state.seq,
            event,
        })
        .to_line();
        // An error only means nobody is subscribed.
        let _ = self.events.send(Published {
            topic,
            line: line.into(),
        });
    }

    fn handle(self: &Arc<Self>, conn: &mut Conn, request: Request) -> Result<Value, ApiError> {
        if !conn.hello && !matches!(request, Request::Hello(_)) {
            return Err(ApiError::new(
                ErrorCode::HandshakeRequired,
                "send hello with the protocol version first",
            ));
        }
        match request {
            Request::Hello(params) => {
                check_protocol(params.protocol)?;
                conn.hello = true;
                to_value(HelloResult {
                    protocol: delulu_proto::PROTOCOL_VERSION,
                    daemon_version: env!("CARGO_PKG_VERSION").into(),
                    mode: self.opts.mode,
                    methods: METHODS.iter().map(|m| (*m).to_owned()).collect(),
                })
            }
            Request::GetState(_) => to_value(&self.lock().state),
            Request::Subscribe(params) => {
                // Under the lock, so no event falls between the reply and the stream.
                let _inner = self.lock();
                conn.topics
                    .extend(params.topics.into_iter().filter(|t| *t != Topic::Unknown));
                if !conn.topics.is_empty() && conn.events.is_none() {
                    conn.events = Some(self.events.subscribe());
                }
                to_value(Subscribed {
                    topics: conn.topics.iter().copied().collect(),
                })
            }
            Request::Unsubscribe(params) => {
                for topic in params.topics {
                    conn.topics.remove(&topic);
                }
                if conn.topics.is_empty() {
                    conn.events = None;
                }
                to_value(Subscribed {
                    topics: conn.topics.iter().copied().collect(),
                })
            }
            Request::Toggle(_) => self.dictation(Input::Toggle),
            Request::Cancel(_) => self.dictation(Input::Cancel),
            Request::HistoryList(params) => self.history(params),
        }
    }

    fn history(&self, params: HistoryListParams) -> Result<Value, ApiError> {
        if let Some(page) = self.effects.get().and_then(|e| e.history(&params)) {
            return to_value(page);
        }
        let inner = self.lock();
        let Some(page) = inner.state.history.as_ref() else {
            return Err(ApiError::new(
                ErrorCode::NotAvailable,
                "this daemon does not serve History",
            ));
        };
        // Demo mode: the snapshot's page is all there is.
        let query = params.query.as_deref().map(str::to_lowercase);
        let matching: Vec<&HistoryEntry> = page
            .entries
            .iter()
            .filter(|e| {
                query
                    .as_deref()
                    .is_none_or(|q| q.is_empty() || e.text.to_lowercase().contains(q))
            })
            .collect();
        let limit = if params.limit == 0 {
            HISTORY_PAGE
        } else {
            params.limit
        };
        to_value(HistoryPage {
            query: params.query.clone(),
            offset: params.offset,
            total: matching.len() as u32,
            entries: matching
                .into_iter()
                .skip(params.offset as usize)
                .take(limit as usize)
                .cloned()
                .collect(),
        })
    }

    fn dictation(self: &Arc<Self>, input: Input) -> Result<Value, ApiError> {
        if self.effects.get().is_none() {
            return Err(ApiError::new(
                ErrorCode::NotAvailable,
                "dictation does not run in the daemon yet; the Delulu Talks app handles it",
            ));
        }
        let cancel = input == Input::Cancel;
        if !cancel {
            let inner = self.lock();
            let dictation = &inner.state.dictation;
            // Stopping a recording is always allowed.
            if !dictation.available && dictation.phase == DictationPhase::Idle {
                return Err(ApiError::new(
                    ErrorCode::NotAvailable,
                    dictation
                        .unavailable_reason
                        .clone()
                        .unwrap_or_else(|| "dictation is not available".into()),
                ));
            }
        }
        match self.input(input) {
            Ok(reply) => to_value(reply),
            Err(Ignored::Busy) => Err(ApiError::new(
                ErrorCode::Busy,
                "the last dictation is still being processed",
            )),
            Err(_) if cancel => to_value(self.reply()),
            Err(reason) => Err(ApiError::new(
                ErrorCode::Internal,
                format!("dictation ignored the request: {reason:?}"),
            )),
        }
    }

    fn reply(&self) -> DictationReply {
        let inner = self.lock();
        DictationReply {
            phase: phase(inner.machine.phase()),
            job: inner.machine.job(),
        }
    }

    /// Feeds the state machine, publishes the change and starts its effects.
    fn input(self: &Arc<Self>, input: Input) -> Result<DictationReply, Ignored> {
        let _order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        let mut inner = self.lock();
        let (to, effects, outcome) = match inner.machine.handle(input) {
            Step::Ignored(reason) => return Err(reason),
            Step::Changed {
                to,
                effects,
                outcome,
                ..
            } => (to, effects, outcome),
        };
        let now = now_ms();
        let job = inner.machine.job();
        let dictation = &mut inner.state.dictation;
        dictation.phase = phase(to);
        dictation.job = job;
        dictation.phase_since = now;
        let mut history = None;
        if let Some(outcome) = outcome {
            let effects = self.effects.get().expect("outcomes need effects");
            let (last, entry) = effects.record(outcome, now);
            if let (Some(entry), Some(page)) = (entry, inner.state.history.as_mut()) {
                page.entries.insert(0, entry);
                page.entries.truncate(50);
                page.total += 1;
                history = Some(page.clone());
            }
            inner.state.dictation.last = Some(last);
        }
        let state = inner.state.dictation.clone();
        self.publish(&mut inner, Event::Dictation { state });
        if let Some(page) = history {
            self.publish(&mut inner, Event::History { page });
        }
        drop(inner);
        if let Some(runner) = self.effects.get() {
            let daemon = Daemon {
                shared: Arc::clone(self),
            };
            for effect in effects {
                runner.run(&daemon, effect);
            }
        }
        Ok(DictationReply {
            phase: phase(to),
            job,
        })
    }
}

impl demo::DemoEffects {
    /// Demo mode's stand-in for the microphone, engines and inserter.
    pub(crate) fn fake_engine(daemon: &Daemon, effect: fsm::Effect) {
        let shared = &daemon.shared;
        if let fsm::Effect::StartCapture { job } = effect {
            let shared = Arc::clone(shared);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(33));
                let mut frame = 0u64;
                loop {
                    frame += 1;
                    tick.tick().await;
                    let mut inner = shared.lock();
                    if inner.machine.job() != job || inner.machine.phase() != fsm::Phase::Recording
                    {
                        break;
                    }
                    let level = demo::level(frame);
                    shared.publish(&mut inner, Event::Level { level });
                }
            });
            return;
        }
        if let Some((delay, input)) = demo::engine_result(&effect) {
            let shared = Arc::clone(shared);
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                // Stale results (after a cancel) are ignored by the machine.
                let _ = shared.input(input);
            });
        }
    }
}

async fn run_script(shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.tick().await;
    let mut n = 0u64;
    loop {
        n += 1;
        tick.tick().await;
        let mut inner = shared.lock();
        for event in demo::tick(&mut inner.state, n, now_ms()) {
            shared.publish(&mut inner, event);
        }
    }
}

struct Conn {
    hello: bool,
    topics: BTreeSet<Topic>,
    events: Option<broadcast::Receiver<Published>>,
}

async fn connection(shared: Arc<Shared>, stream: UnixStream) {
    let timeout = shared.opts.write_timeout;
    let (mut reader, mut writer) = stream.into_split();
    let mut decoder = LineDecoder::default();
    let mut buf = vec![0u8; 16 * 1024];
    let mut conn = Conn {
        hello: false,
        topics: BTreeSet::new(),
        events: None,
    };
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => {
                let n = match read {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                for frame in decoder.push(&buf[..n]) {
                    let reply = match frame {
                        Frame::Line(line) => match parse_request(&line) {
                            Ok((id, request)) => ServerMessage::reply(id, shared.handle(&mut conn, request)),
                            Err((id, error)) => ServerMessage::Error(ErrorMessage { id, error }),
                        },
                        Frame::TooLong => error_line(ErrorCode::LineTooLong, format!(
                            "line longer than {} bytes dropped",
                            delulu_proto::framing::MAX_LINE_BYTES
                        )),
                        Frame::NotUtf8 => error_line(ErrorCode::ParseError, "line is not UTF-8"),
                    };
                    if write(&mut writer, &reply.to_line(), timeout).await.is_err() {
                        return;
                    }
                }
            }
            event = next_event(&mut conn.events) => {
                let line: Arc<str> = match event {
                    Ok(published) => {
                        if published.topic.is_some_and(|t| !conn.topics.contains(&t)) {
                            continue;
                        }
                        published.line
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        // Skip what is still buffered too and continue from now, so
                        // `seq` keeps growing on this connection and everything after
                        // the notice is newer than the snapshot the client re-reads.
                        let inner = shared.lock();
                        let buffered = conn.events.as_ref().map_or(0, |rx| rx.len() as u64);
                        conn.events = Some(shared.events.subscribe());
                        let seq = inner.state.seq;
                        drop(inner);
                        ServerMessage::Event(EventMessage {
                            seq,
                            event: Event::Lagged { missed: missed + buffered },
                        })
                        .to_line()
                        .into()
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                if write(&mut writer, &line, timeout).await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn next_event(
    events: &mut Option<broadcast::Receiver<Published>>,
) -> Result<Published, broadcast::error::RecvError> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

async fn write(writer: &mut OwnedWriteHalf, line: &str, timeout: Duration) -> Result<(), ()> {
    match tokio::time::timeout(timeout, writer.write_all(line.as_bytes())).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

fn error_line(code: ErrorCode, message: impl Into<String>) -> ServerMessage {
    ServerMessage::Error(ErrorMessage {
        id: None,
        error: ApiError::new(code, message),
    })
}

fn to_value(value: impl serde::Serialize) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(ErrorCode::Internal, e.to_string()))
}

pub use crate::wire::phase;

/// What a normal-mode skeleton daemon knows: itself, and that dictation is elsewhere.
fn normal_state(now: u64) -> AppState {
    AppState {
        seq: 0,
        daemon: DaemonInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: delulu_proto::PROTOCOL_VERSION,
            mode: DaemonMode::Normal,
            pid: std::process::id(),
            started_at: now,
        },
        dictation: DictationState {
            phase: DictationPhase::Idle,
            available: false,
            unavailable_reason: Some(
                "Dictation still runs in the Delulu Talks app; it moves to the daemon in a later release."
                    .into(),
            ),
            job: 0,
            phase_since: now,
            last: None,
            stt: WorkerStatus::off(),
            cleanup: WorkerStatus::off(),
        },
        hotkey: HotkeyState {
            bound: false,
            trigger: None,
            error: None,
            problem: None,
        },
        insert: InsertState {
            ready: false,
            error: None,
        },
        settings: None,
        history: None,
        vocabulary: None,
        models: None,
        radio: None,
        voice: None,
    }
}
