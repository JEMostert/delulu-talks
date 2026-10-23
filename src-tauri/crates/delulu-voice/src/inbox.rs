//! The single durable agent inbox. Every `agent.register` gets a fresh id, so
//! two sessions of one client never share work. Agents collect `task`,
//! `message` and `cancel` events with bounded `agent.next` calls; every agent
//! call is a heartbeat. An agent listens while a `next` call waits and for
//! [`AWAY_AFTER`] after its last call; away agents get no new work.
//!
//! Storage: `voice/inbox.json` (snapshot) and `voice/inbox.log` (append-only
//! JSON lines replayed over it). Creating work is synced; acknowledgments and
//! task updates are appended without a sync; heartbeats are never written.
//! The log is compacted into the snapshot once it passes [`COMPACT_AFTER`]
//! lines. Request de-duplication keeps ids and text hashes, never texts.

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use delulu_core::util::{utf16_len, write_private_atomic};
use delulu_core::{now_ms, uuid, DomainError, DomainResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// Without a call for this long, an agent is away.
pub const AWAY_AFTER: Duration = Duration::from_secs(120);
/// Log lines before the store is compacted into a fresh snapshot.
pub const COMPACT_AFTER: usize = 1000;
pub const MAX_AGENTS: usize = 32;
pub const MAX_OPEN_TASKS: usize = 32;
pub const MAX_TASKS: usize = 256;
pub const MAX_EVENTS: usize = 256;
pub const MAX_REQUESTS: usize = 256;
const MAX_WAIT_MS: u64 = 3_600_000;
const DEFAULT_WAIT_MS: u64 = 50_000;
const SNAPSHOT: &str = "inbox.json";
const LOG: &str = "inbox.log";
const RECENT_CLOSED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Task,
    Message,
    Cancel,
}

/// One delivery to an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEvent {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: EventKind,
    pub task_id: String,
    /// The user's exact words (empty for `cancel`).
    pub text: String,
    pub at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Queued,
    Accepted,
    Running,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Blocked => "blocked",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_open(self) -> bool {
        !matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// States an agent may report (`task.update`).
    fn reported(value: &str) -> Option<Self> {
        Some(match value {
            "accepted" => Self::Accepted,
            "running" => Self::Running,
            "blocked" => Self::Blocked,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// The user's exact words.
    pub text: String,
    pub agent_id: String,
    pub state: TaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Follow-up messages sent for this task.
    #[serde(default)]
    pub messages: u32,
    #[serde(default)]
    pub cancel_requested: bool,
}

/// An agent as the talk loop sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub client: String,
    pub name: String,
    pub listening: bool,
    pub open_tasks: usize,
}

/// A state or summary change an agent reported.
#[derive(Debug, Clone)]
pub struct TaskUpdate {
    pub task: Task,
    pub previous: TaskState,
    pub agent: String,
}

/// What [`Inbox::submit`] and [`Inbox::follow_up`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum Sent {
    /// A new task, or the one an identical earlier request created.
    Task { task: Task, agent: AgentInfo },
    /// A follow-up message on an open task.
    Message { task: Task, agent: AgentInfo },
    /// Nothing was sent: nobody, or not the agent that would get it, is listening.
    NoListener { agent: Option<AgentInfo> },
    /// The task already finished; nothing was sent.
    Closed { task: Task },
}

/// What [`Inbox::cancel`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum Cancel {
    /// The agent was asked to stop; it reports `cancelled` when it has.
    Requested { task: Task, agent: AgentInfo },
    /// The agent is away, so the task was closed as cancelled right away.
    Closed { task: Task, agent: Option<AgentInfo> },
    /// The task had already finished.
    Finished { task: Task },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRecord {
    id: String,
    client: String,
    name: String,
    registered_at: u64,
    acked_seq: u64,
    last_seq: u64,
    events: Vec<InboxEvent>,
}

impl AgentRecord {
    fn info(&self) -> Value {
        json!({
            "id": self.id, "client": self.client, "name": self.name,
            "ackedSeq": self.acked_seq, "lastSeq": self.last_seq, "queued": self.events.len(),
        })
    }

    fn push(&mut self, kind: EventKind, task_id: &str, text: &str, at: u64) {
        self.last_seq += 1;
        self.events.push(InboxEvent { seq: self.last_seq, kind, task_id: task_id.into(), text: text.into(), at });
    }
}

/// A submission's id with the task it made and a hash of its text.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Request {
    id: String,
    task: String,
    hash: String,
    #[serde(default)]
    message: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    /// The last log record folded into this state.
    n: u64,
    agents: Vec<AgentRecord>,
    tasks: Vec<Task>,
    requests: VecDeque<Request>,
}

/// One log line. Replaying the same ops over the same snapshot rebuilds the
/// same store, so the live path and recovery share [`apply`].
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Op {
    Register { agent: AgentRecord },
    Unregister { agent_id: String, at: u64 },
    Task { task: Task, request: Request },
    Message { task_id: String, text: String, request: Request, at: u64 },
    Cancel { task_id: String, close: bool, at: u64 },
    Ack { agent_id: String, after: u64 },
    Update { task_id: String, state: TaskState, summary: Option<String>, at: u64 },
}

#[derive(Serialize, Deserialize)]
struct Record {
    n: u64,
    #[serde(flatten)]
    op: Op,
}

const LEFT: &str = "The agent session ended before finishing.";

fn apply(store: &mut Store, op: Op) {
    match op {
        Op::Register { agent } => store.agents.push(agent),
        Op::Unregister { agent_id, at } => {
            store.agents.retain(|agent| agent.id != agent_id);
            for task in store.tasks.iter_mut().filter(|task| task.agent_id == agent_id && task.state.is_open()) {
                task.state = TaskState::Failed;
                task.summary = Some(LEFT.into());
                task.updated_at = at;
            }
        }
        Op::Task { task, request } => {
            if store.tasks.len() >= MAX_TASKS {
                if let Some(index) = store.tasks.iter().position(|task| !task.state.is_open()) {
                    store.tasks.remove(index);
                }
            }
            if let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == task.agent_id) {
                agent.push(EventKind::Task, &task.id, &task.text, task.created_at);
            }
            store.tasks.push(task);
            remember(store, request);
        }
        Op::Message { task_id, text, request, at } => {
            if let Some(task) = store.tasks.iter_mut().find(|task| task.id == task_id) {
                task.messages += 1;
                task.updated_at = at;
                if let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == task.agent_id) {
                    agent.push(EventKind::Message, &task_id, &text, at);
                }
            }
            remember(store, request);
        }
        Op::Cancel { task_id, close, at } => {
            if let Some(task) = store.tasks.iter_mut().find(|task| task.id == task_id) {
                task.cancel_requested = true;
                task.updated_at = at;
                if close {
                    task.state = TaskState::Cancelled;
                }
                if let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == task.agent_id) {
                    agent.push(EventKind::Cancel, &task_id, "", at);
                }
            }
        }
        Op::Ack { agent_id, after } => {
            if let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == agent_id) {
                agent.acked_seq = agent.acked_seq.max(after.min(agent.last_seq));
                let acked = agent.acked_seq;
                agent.events.retain(|event| event.seq > acked);
            }
        }
        Op::Update { task_id, state, summary, at } => {
            if let Some(task) = store.tasks.iter_mut().find(|task| task.id == task_id) {
                task.state = state;
                if summary.is_some() {
                    task.summary = summary;
                }
                task.updated_at = at;
            }
        }
    }
}

fn remember(store: &mut Store, request: Request) {
    store.requests.push_back(request);
    while store.requests.len() > MAX_REQUESTS {
        store.requests.pop_front();
    }
}

fn text_hash(text: &str) -> String {
    hex::encode(&Sha256::digest(text.as_bytes())[..8])
}

fn short_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid().replace('-', "")[..16])
}

/// The append-only log, opened lazily.
struct Log {
    path: PathBuf,
    file: Option<File>,
    lines: usize,
    syncs: u64,
}

/// Log counters, for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogStats {
    /// Lines since the last compaction.
    pub lines: usize,
    /// Appends synced to disk since the inbox was opened.
    pub syncs: u64,
}

impl Log {
    fn append(&mut self, record: &Record, sync: bool) -> std::io::Result<()> {
        if self.file.is_none() {
            let mut options = OpenOptions::new();
            options.append(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            self.file = Some(options.open(&self.path)?);
        }
        let file = self.file.as_mut().expect("opened");
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        file.write_all(&line)?;
        if sync {
            file.sync_data()?;
            self.syncs += 1;
        }
        self.lines += 1;
        Ok(())
    }

    fn truncate(&mut self) -> std::io::Result<()> {
        match &self.file {
            Some(file) => file.set_len(0)?,
            None if self.path.exists() => File::options().write(true).open(&self.path)?.set_len(0)?,
            None => {}
        }
        self.lines = 0;
        Ok(())
    }
}

#[derive(Default)]
struct Live {
    seen: Option<Instant>,
    waiting: usize,
    /// An away check is scheduled.
    timer: bool,
}

impl Live {
    fn listening(&self) -> bool {
        self.waiting > 0 || self.seen.is_some_and(|seen| seen.elapsed() < AWAY_AFTER)
    }
}

struct State {
    store: Store,
    log: Log,
    live: HashMap<String, Live>,
    /// The agent the user last gave work to; not persisted.
    focus: Option<String>,
}

impl State {
    fn listening(&self, id: &str) -> bool {
        self.live.get(id).is_some_and(Live::listening)
    }

    fn agent_info(&self, agent: &AgentRecord) -> AgentInfo {
        AgentInfo {
            id: agent.id.clone(),
            client: agent.client.clone(),
            name: agent.name.clone(),
            listening: self.listening(&agent.id),
            open_tasks: self
                .store
                .tasks
                .iter()
                .filter(|task| task.agent_id == agent.id && task.state.is_open())
                .count(),
        }
    }

    fn info(&self, id: &str) -> Option<AgentInfo> {
        self.store.agents.iter().find(|agent| agent.id == id).map(|agent| self.agent_info(agent))
    }

    /// Listening first, then the most recently seen.
    fn agents(&self) -> Vec<AgentInfo> {
        let now = Instant::now();
        let mut agents: Vec<_> = self
            .store
            .agents
            .iter()
            .map(|agent| {
                let live = self.live.get(&agent.id);
                let seen = live.and_then(|live| if live.waiting > 0 { Some(now) } else { live.seen });
                (self.agent_info(agent), seen)
            })
            .collect();
        agents.sort_by(|(a, a_seen), (b, b_seen)| b.listening.cmp(&a.listening).then(b_seen.cmp(a_seen)));
        agents.into_iter().map(|(agent, _)| agent).collect()
    }

    fn active(&self) -> Option<AgentInfo> {
        if let Some(focus) = self.focus.as_deref().filter(|id| self.listening(id)) {
            return self.info(focus);
        }
        self.agents().into_iter().find(|agent| agent.listening)
    }

    fn task(&self, id: &str) -> Option<&Task> {
        self.store.tasks.iter().find(|task| task.id == id)
    }

    fn room_for_event(&self, agent: &str) -> DomainResult<()> {
        match self.store.agents.iter().find(|record| record.id == agent) {
            Some(record) if record.events.len() >= MAX_EVENTS => {
                Err(DomainError::busy("That agent has too many unread events; it must acknowledge them first."))
            }
            _ => Ok(()),
        }
    }

    /// The earlier outcome of a repeated request, if any.
    fn repeated(&self, request: &str, hash: &str) -> DomainResult<Option<Sent>> {
        let Some(earlier) = self.store.requests.iter().find(|earlier| earlier.id == request) else {
            return Ok(None);
        };
        if earlier.hash != hash {
            return Err(DomainError::invalid("requestId was already used for different text"));
        }
        let task = self.task(&earlier.task).cloned().ok_or_else(|| DomainError::failed("That request has expired"))?;
        let Some(agent) = self.info(&task.agent_id) else {
            return Ok(Some(Sent::NoListener { agent: None }));
        };
        Ok(Some(if earlier.message { Sent::Message { task, agent } } else { Sent::Task { task, agent } }))
    }
}

type Listener = Arc<dyn Fn() + Send + Sync>;
type UpdateListener = Arc<dyn Fn(&TaskUpdate) + Send + Sync>;

struct Inner {
    directory: PathBuf,
    state: Mutex<State>,
    notify: Notify,
    listeners: Mutex<Vec<Listener>>,
    updates: Mutex<Vec<UpdateListener>>,
    runtime: tokio::runtime::Handle,
}

/// The agent inbox. Cheap to clone; construct inside a Tokio runtime.
#[derive(Clone)]
pub struct Inbox {
    inner: Arc<Inner>,
}

fn storage(error: std::io::Error) -> DomainError {
    DomainError::failed(format!("Could not save the agent inbox: {error}"))
}

fn text_param(params: &Value, key: &str, max: usize) -> DomainResult<Option<String>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() && utf16_len(value) <= max => Ok(Some(value.clone())),
        Some(_) => Err(DomainError::invalid(format!("{key} must contain 1 to {max} characters"))),
    }
}

fn required(params: &Value, key: &str, max: usize) -> DomainResult<String> {
    text_param(params, key, max)?.ok_or_else(|| DomainError::invalid(format!("{key} is required")))
}

fn integer(params: &Value, key: &str) -> DomainResult<Option<u64>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            value.as_u64().map(Some).ok_or_else(|| DomainError::invalid(format!("{key} must be a nonnegative integer")))
        }
    }
}

fn unknown_agent() -> DomainError {
    DomainError::invalid("Unknown agent. Register again with agent.register.")
}

fn encoded(value: impl Serialize) -> DomainResult<Value> {
    serde_json::to_value(value).map_err(|error| DomainError::failed(error.to_string()))
}

impl Inbox {
    /// Opens (or creates) the inbox in `directory`. An unreadable snapshot is
    /// set aside as `inbox.json.corrupt-<time>` and the inbox starts empty.
    pub fn open(directory: PathBuf) -> Self {
        let snapshot = directory.join(SNAPSHOT);
        let mut store = match std::fs::read(&snapshot) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                log::warn!("agent inbox snapshot is unreadable ({error}); starting a new one");
                let _ = std::fs::rename(&snapshot, directory.join(format!("{SNAPSHOT}.corrupt-{}", now_ms())));
                Store::default()
            }),
            Err(_) => Store::default(),
        };
        let path = directory.join(LOG);
        let mut lines = 0;
        let mut damaged = false;
        if let Ok(bytes) = std::fs::read(&path) {
            damaged = !bytes.is_empty() && !bytes.ends_with(b"\n");
            for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
                let Ok(record) = serde_json::from_slice::<Record>(line) else {
                    damaged = true;
                    break;
                };
                lines += 1;
                if record.n > store.n {
                    apply(&mut store, record.op);
                    store.n = record.n;
                }
            }
        }
        let inbox = Self {
            inner: Arc::new(Inner {
                directory,
                state: Mutex::new(State {
                    store,
                    log: Log { path, file: None, lines, syncs: 0 },
                    live: HashMap::new(),
                    focus: None,
                }),
                notify: Notify::new(),
                listeners: Mutex::new(Vec::new()),
                updates: Mutex::new(Vec::new()),
                runtime: tokio::runtime::Handle::current(),
            }),
        };
        if damaged {
            // A torn last line would swallow the next append.
            log::warn!("agent inbox log ends in a damaged record; compacting");
            let mut state = inbox.inner.state.lock();
            if let Err(error) = inbox.compact(&mut state) {
                log::error!("could not compact the agent inbox: {error}");
            }
        }
        inbox
    }

    /// Called after any change (agents, liveness, tasks).
    pub fn on_change(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.inner.listeners.lock().push(Arc::new(listener));
    }

    /// Called when an agent reports a new state or summary.
    pub fn on_update(&self, listener: impl Fn(&TaskUpdate) + Send + Sync + 'static) {
        self.inner.updates.lock().push(Arc::new(listener));
    }

    /// Registered agents, listening first, then the most recently seen.
    pub fn agents(&self) -> Vec<AgentInfo> {
        self.inner.state.lock().agents()
    }

    /// Who gets work nobody named: the focused agent if it listens, else the
    /// most recently seen listening agent.
    pub fn active_agent(&self) -> Option<AgentInfo> {
        self.inner.state.lock().active()
    }

    /// Open tasks, newest first.
    pub fn open_tasks(&self) -> Vec<Task> {
        let state = self.inner.state.lock();
        state.store.tasks.iter().rev().filter(|task| task.state.is_open()).cloned().collect()
    }

    pub fn task(&self, id: &str) -> Option<Task> {
        self.inner.state.lock().task(id).cloned()
    }

    pub fn log_stats(&self) -> LogStats {
        let state = self.inner.state.lock();
        LogStats { lines: state.log.lines, syncs: state.log.syncs }
    }

    fn changed(&self) {
        self.inner.notify.notify_waiters();
        let listeners: Vec<Listener> = self.inner.listeners.lock().clone();
        for listener in listeners {
            listener();
        }
    }

    fn compact(&self, state: &mut State) -> std::io::Result<()> {
        crate::service::create_private_dir(&self.inner.directory)?;
        let bytes = serde_json::to_vec(&state.store)?;
        write_private_atomic(&self.inner.directory.join(SNAPSHOT), &bytes)?;
        state.log.truncate()
    }

    /// Appends `op` (synced when it creates work) and applies it.
    fn commit(&self, state: &mut State, op: Op, sync: bool) -> DomainResult<()> {
        if state.log.file.is_none() {
            crate::service::create_private_dir(&self.inner.directory).map_err(storage)?;
        }
        let record = Record { n: state.store.n + 1, op };
        state.log.append(&record, sync).map_err(storage)?;
        state.store.n = record.n;
        apply(&mut state.store, record.op);
        if state.log.lines >= COMPACT_AFTER {
            if let Err(error) = self.compact(state) {
                log::warn!("could not compact the agent inbox: {error}");
            }
        }
        Ok(())
    }

    /// Records a call from `id` and schedules the check that marks it away.
    fn heartbeat(&self, state: &mut State, id: &str) {
        let live = state.live.entry(id.to_owned()).or_default();
        live.seen = Some(Instant::now());
        if !live.timer {
            live.timer = true;
            let weak = Arc::downgrade(&self.inner);
            self.inner.runtime.spawn(away_check(weak, id.to_owned()));
        }
    }

    /// Queues the user's exact words as a new task for `agent`, or for the
    /// active agent when `None`. `request` makes retries return the same task.
    pub fn submit(&self, text: &str, agent: Option<&str>, request: &str) -> DomainResult<Sent> {
        let hash = text_hash(text);
        let sent = {
            let mut state = self.inner.state.lock();
            if let Some(earlier) = state.repeated(request, &hash)? {
                return Ok(earlier);
            }
            let target = match agent {
                Some(id) => Some(state.info(id).ok_or_else(unknown_agent)?),
                None => state.active(),
            };
            let target = match target {
                Some(target) if target.listening => target,
                target => return Ok(Sent::NoListener { agent: target }),
            };
            if state.store.tasks.iter().filter(|task| task.state.is_open()).count() >= MAX_OPEN_TASKS {
                return Err(DomainError::busy(format!(
                    "{MAX_OPEN_TASKS} tasks are already open; finish or cancel one first"
                )));
            }
            state.room_for_event(&target.id)?;
            let at = now_ms();
            let task = Task {
                id: short_id("task"),
                text: text.to_owned(),
                agent_id: target.id.clone(),
                state: TaskState::Queued,
                summary: None,
                created_at: at,
                updated_at: at,
                messages: 0,
                cancel_requested: false,
            };
            let request = Request { id: request.to_owned(), task: task.id.clone(), hash, message: false };
            self.commit(&mut state, Op::Task { task: task.clone(), request }, true)?;
            state.focus = Some(target.id.clone());
            let agent = state.info(&target.id).unwrap_or(target);
            Sent::Task { task, agent }
        };
        self.changed();
        Ok(sent)
    }

    /// Sends the user's exact words as a follow-up on an open task, to the
    /// task's agent.
    pub fn follow_up(&self, task_id: &str, text: &str, request: &str) -> DomainResult<Sent> {
        let hash = text_hash(text);
        let sent = {
            let mut state = self.inner.state.lock();
            if let Some(earlier) = state.repeated(request, &hash)? {
                return Ok(earlier);
            }
            let task = state.task(task_id).cloned().ok_or_else(|| DomainError::invalid("Unknown task"))?;
            if !task.state.is_open() {
                return Ok(Sent::Closed { task });
            }
            let agent = state.info(&task.agent_id);
            let Some(agent) = agent.filter(|agent| agent.listening) else {
                return Ok(Sent::NoListener { agent: state.info(&task.agent_id) });
            };
            state.room_for_event(&agent.id)?;
            let request = Request { id: request.to_owned(), task: task.id.clone(), hash, message: true };
            let op = Op::Message { task_id: task.id.clone(), text: text.to_owned(), request, at: now_ms() };
            self.commit(&mut state, op, true)?;
            state.focus = Some(agent.id.clone());
            let task = state.task(task_id).cloned().unwrap_or(task);
            Sent::Message { task, agent }
        };
        self.changed();
        Ok(sent)
    }

    /// Asks the task's agent to stop. An away agent cannot stop anything, so
    /// its task is closed as cancelled (the request still waits in its inbox).
    pub fn cancel(&self, task_id: &str) -> DomainResult<Cancel> {
        let outcome = {
            let mut state = self.inner.state.lock();
            let task = state.task(task_id).cloned().ok_or_else(|| DomainError::invalid("Unknown task"))?;
            if !task.state.is_open() {
                return Ok(Cancel::Finished { task });
            }
            let agent = state.info(&task.agent_id);
            let listening = agent.as_ref().is_some_and(|agent| agent.listening);
            if listening && task.cancel_requested {
                return Ok(Cancel::Requested { task, agent: agent.expect("listening") });
            }
            if agent.is_some() {
                state.room_for_event(&task.agent_id)?;
            }
            self.commit(&mut state, Op::Cancel { task_id: task.id.clone(), close: !listening, at: now_ms() }, true)?;
            let task = state.task(task_id).cloned().unwrap_or(task);
            match agent {
                Some(agent) if listening => Cancel::Requested { task, agent },
                agent => Cancel::Closed { task, agent },
            }
        };
        self.changed();
        Ok(outcome)
    }

    /// The `agent.*` and `task.*` bridge methods. `cancel` fires when the
    /// agent disconnects.
    pub async fn dispatch(&self, method: &str, params: Value, cancel: CancellationToken) -> DomainResult<Value> {
        match method {
            "agent.register" => self.register(&params),
            "agent.next" => self.next(&params, cancel).await,
            "agent.ack" => {
                let id = required(&params, "agentId", 128)?;
                let after = integer(&params, "after")?.ok_or_else(|| DomainError::invalid("after is required"))?;
                let info = {
                    let mut state = self.inner.state.lock();
                    self.acknowledge(&mut state, &id, after)?;
                    self.heartbeat(&mut state, &id);
                    state.store.agents.iter().find(|agent| agent.id == id).map(AgentRecord::info)
                };
                self.changed();
                info.ok_or_else(unknown_agent)
            }
            "agent.unregister" => {
                let id = required(&params, "agentId", 128)?;
                {
                    let mut state = self.inner.state.lock();
                    if !state.store.agents.iter().any(|agent| agent.id == id) {
                        return Err(unknown_agent());
                    }
                    self.commit(&mut state, Op::Unregister { agent_id: id.clone(), at: now_ms() }, true)?;
                    state.live.remove(&id);
                    if state.focus.as_deref() == Some(&id) {
                        state.focus = None;
                    }
                }
                self.changed();
                Ok(json!({ "unregistered": true }))
            }
            "task.status" => {
                let state = self.inner.state.lock();
                match text_param(&params, "taskId", 128)? {
                    Some(id) => encoded(state.task(&id).ok_or_else(|| DomainError::invalid("Unknown task"))?),
                    None => {
                        let tasks = &state.store.tasks;
                        let open = tasks.iter().filter(|task| task.state.is_open());
                        let closed = tasks.iter().rev().filter(|task| !task.state.is_open()).take(RECENT_CLOSED);
                        let mut listed: Vec<&Task> = open.chain(closed).collect();
                        listed.sort_by_key(|task| task.created_at);
                        Ok(json!({ "tasks": encoded(listed)? }))
                    }
                }
            }
            "task.update" => self.update(&params),
            other => Err(DomainError::invalid(format!("Unknown inbox method: {other}"))),
        }
    }

    fn register(&self, params: &Value) -> DomainResult<Value> {
        let client = required(params, "client", 64)?;
        let name = text_param(params, "name", 64)?.unwrap_or_else(|| client.clone());
        let info = {
            let mut state = self.inner.state.lock();
            if state.store.agents.len() >= MAX_AGENTS {
                // Make room by forgetting the longest-away agent without open work.
                let evict = state
                    .agents()
                    .into_iter()
                    .rev()
                    .find(|agent| !agent.listening && agent.open_tasks == 0)
                    .ok_or_else(|| DomainError::busy(format!("{MAX_AGENTS} agents are registered and active")))?;
                self.commit(&mut state, Op::Unregister { agent_id: evict.id.clone(), at: now_ms() }, true)?;
                state.live.remove(&evict.id);
            }
            let agent = AgentRecord {
                id: short_id("agent"),
                client,
                name: name.trim().to_owned(),
                registered_at: now_ms(),
                acked_seq: 0,
                last_seq: 0,
                events: Vec::new(),
            };
            let info = agent.info();
            let id = agent.id.clone();
            self.commit(&mut state, Op::Register { agent }, true)?;
            self.heartbeat(&mut state, &id);
            info
        };
        self.changed();
        Ok(info)
    }

    fn acknowledge(&self, state: &mut State, id: &str, after: u64) -> DomainResult<()> {
        let agent = state.store.agents.iter().find(|agent| agent.id == id).ok_or_else(unknown_agent)?;
        if after > agent.last_seq {
            return Err(DomainError::invalid("Cannot acknowledge an event that was never delivered"));
        }
        if after > agent.acked_seq {
            self.commit(state, Op::Ack { agent_id: id.to_owned(), after }, false)?;
        }
        Ok(())
    }

    async fn next(&self, params: &Value, cancel: CancellationToken) -> DomainResult<Value> {
        let id = required(params, "agentId", 128)?;
        let timeout = integer(params, "timeoutMs")?.unwrap_or(DEFAULT_WAIT_MS);
        if timeout > MAX_WAIT_MS {
            return Err(DomainError::invalid(format!("timeoutMs must be between 0 and {MAX_WAIT_MS}")));
        }
        let after = integer(params, "after")?;
        let stopped = || json!({ "status": "stopped", "reason": "This agent is not registered. Register again with agent.register." });
        {
            let mut state = self.inner.state.lock();
            if !state.store.agents.iter().any(|agent| agent.id == id) {
                return Ok(stopped());
            }
            if let Some(after) = after {
                self.acknowledge(&mut state, &id, after)?;
            }
            self.heartbeat(&mut state, &id);
        }
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let mut waiting: Option<Waiting> = None;
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let state = self.inner.state.lock();
                let Some(agent) = state.store.agents.iter().find(|agent| agent.id == id) else {
                    return Ok(stopped());
                };
                if let Some(event) = agent.events.first() {
                    return Ok(json!({ "status": "event", "event": encoded(event)? }));
                }
            }
            if timeout == 0 || cancel.is_cancelled() {
                return Ok(json!({ "status": "timeout" }));
            }
            if waiting.is_none() {
                waiting = Some(Waiting::start(self.clone(), &id));
            }
            tokio::select! {
                _ = cancel.cancelled() => return Ok(json!({ "status": "stopped", "reason": "disconnected" })),
                _ = tokio::time::sleep_until(deadline) => return Ok(json!({ "status": "timeout" })),
                _ = notified => {}
            }
        }
    }

    fn update(&self, params: &Value) -> DomainResult<Value> {
        let task_id = required(params, "taskId", 128)?;
        let agent_id = required(params, "agentId", 128)?;
        let state_name = required(params, "state", 16)?;
        let next = TaskState::reported(&state_name).ok_or_else(|| {
            DomainError::invalid("state must be accepted, running, blocked, completed, failed or cancelled")
        })?;
        let summary = text_param(params, "summary", 8000)?;
        let (task, update) = {
            let mut state = self.inner.state.lock();
            let agent = state.info(&agent_id).ok_or_else(unknown_agent)?;
            let task = state
                .task(&task_id)
                .filter(|task| task.agent_id == agent_id)
                .cloned()
                .ok_or_else(|| DomainError::invalid("That task is not assigned to this agent"))?;
            if !task.state.is_open() && task.state != next {
                return Err(DomainError::invalid("A finished task cannot change state"));
            }
            if next == TaskState::Accepted && !matches!(task.state, TaskState::Queued | TaskState::Accepted) {
                return Err(DomainError::invalid("The task has already advanced beyond accepted"));
            }
            let changed = task.state != next || (summary.is_some() && summary != task.summary);
            if changed {
                let op = Op::Update { task_id: task_id.clone(), state: next, summary, at: now_ms() };
                self.commit(&mut state, op, false)?;
            }
            self.heartbeat(&mut state, &agent_id);
            let updated = state.task(&task_id).cloned().unwrap_or(task.clone());
            let update =
                changed.then(|| TaskUpdate { task: updated.clone(), previous: task.state, agent: agent.name.clone() });
            (updated, update)
        };
        self.changed();
        if let Some(update) = update {
            let listeners: Vec<UpdateListener> = self.inner.updates.lock().clone();
            for listener in listeners {
                listener(&update);
            }
        }
        encoded(task)
    }
}

/// A waiting `agent.next` call: the agent listens until it ends.
struct Waiting {
    inbox: Inbox,
    id: String,
}

impl Waiting {
    fn start(inbox: Inbox, id: &str) -> Self {
        inbox.inner.state.lock().live.entry(id.to_owned()).or_default().waiting += 1;
        inbox.changed();
        Self { inbox, id: id.to_owned() }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        {
            let mut state = self.inbox.inner.state.lock();
            if let Some(live) = state.live.get_mut(&self.id) {
                live.waiting = live.waiting.saturating_sub(1);
            }
            if state.store.agents.iter().any(|agent| agent.id == self.id) {
                self.inbox.heartbeat(&mut state, &self.id);
            }
        }
        self.inbox.changed();
    }
}

/// Publishes a change once `id` has been quiet for [`AWAY_AFTER`].
async fn away_check(inner: Weak<Inner>, id: String) {
    loop {
        let due = {
            let Some(inner) = inner.upgrade() else { return };
            let state = inner.state.lock();
            match state.live.get(&id).and_then(|live| live.seen) {
                Some(seen) => seen + AWAY_AFTER,
                None => return,
            }
        };
        tokio::time::sleep_until(due + Duration::from_millis(10)).await;
        let Some(inner) = inner.upgrade() else { return };
        {
            let mut state = inner.state.lock();
            let Some(live) = state.live.get_mut(&id) else { return };
            if live.seen.is_some_and(|seen| seen + AWAY_AFTER > Instant::now()) {
                continue;
            }
            live.timer = false;
        }
        Inbox { inner }.changed();
        return;
    }
}
