//! Talk: the live conversation loop (`docs/voice-redesign.md`). Talk owns the
//! microphone; every finished utterance is routed at once, one at a time, in
//! order. With the local helper on, the helper picks exactly one tool per
//! turn ([`HelperModel::decide`]), the executor runs it against the agent
//! inbox, and for `send_to_agent`, `task_status` and `cancel_task` the helper
//! phrases the outcome ([`HelperModel::reply`]). With the helper off, or when
//! it fails, every turn goes to the active agent verbatim.
//!
//! The helper sees short aliases (`agent_N`, `task_N`) that are mapped back
//! to real ids; anything it returns outside the context it was sent counts as
//! a helper failure. The user's words reach agents unchanged; text the helper
//! writes is only ever spoken.
//!
//! Delulu never interrupts speech (only `stop_speaking` stops it). Agent
//! updates (completed, blocked, failed) are coalesced into one briefing that
//! waits for a pause. Utterance and task text is never logged.
//!
//! Events emitted through the sink: `talk:statusChanged` ([`TalkStatus`]) and
//! `talk:level` (`{"db": -42.0}`).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Instant;

use delulu_core::util::utf16_len;
use delulu_core::{emit, now_ms, uuid, DomainError, DomainErrorCode, DomainResult, SharedSink};
use delulu_domain::listening::{ListenSessionState, ListenStatus};
use delulu_domain::voice::{VoiceSource, VoiceSpeakRequest};
use delulu_domain::AppSettings;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};

use crate::host::{BoxFuture, VoiceProfile};
use crate::inbox::{AgentInfo, Cancel, Inbox, Sent, Task, TaskState, TaskUpdate};
use crate::listening::{Heard, ListeningService};
use crate::service::{summary, SpeakHandle, VoiceService};

/// What the first helper download fetches (runtime and weights).
pub const DOWNLOAD_SIZE: &str = "~1.7 GB";
const SPEAKER: &str = "Delulu";
const MEMORY: usize = 6;
const TURNS: usize = 6;
const CONTEXT_AGENTS: usize = 8;
const CONTEXT_TASKS: usize = 16;
/// Longest utterance the helper accepts; longer turns are forwarded as they are.
const HELPER_TEXT: usize = 2000;
const MAX_TEXT: usize = 8000;
const MAX_QUEUE: usize = 32;
const LABEL: usize = 60;
const SUMMARY: usize = 120;
const LISTED: usize = 3;

/// The local helper model (`delulu-speech::CoordinatorWorker` in the app).
pub trait HelperModel: Send + Sync {
    /// Cached files only unless `download`; `download` may install the runtime and fetch weights.
    fn load(&self, download: bool) -> BoxFuture<'_, DomainResult<()>>;
    fn unload(&self) -> BoxFuture<'_, ()>;
    /// Runtime and pinned weights are on disk (file checks only; no process, no network).
    fn installed(&self) -> BoxFuture<'_, HelperInstall>;
    fn decide(&self, text: String, context: Value) -> BoxFuture<'_, DomainResult<Value>>;
    fn reply(&self, text: String, context: Value, call: Value, result: String) -> BoxFuture<'_, DomainResult<Value>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperInstall {
    pub runtime: bool,
    pub weights: bool,
}

impl HelperInstall {
    fn complete(self) -> bool {
        self.runtime && self.weights
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TalkPhase {
    Off,
    Starting,
    Loading,
    Downloading,
    Listening,
    Hearing,
    Thinking,
    Speaking,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HelperState {
    Off,
    Missing,
    Installed,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkHelper {
    /// `off` or `lightweight`.
    pub mode: &'static str,
    pub state: HelperState,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkAgent {
    pub id: String,
    pub name: String,
    pub listening: bool,
    pub open_tasks: usize,
}

/// One handled turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkTurn {
    pub id: String,
    pub at: u64,
    /// The user's words.
    pub user: String,
    pub tool: Option<String>,
    /// What Delulu said ("" when nothing).
    pub said: String,
    /// Time spent in the helper; `None` when it was not used.
    pub helper_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkStatus {
    pub on: bool,
    pub phase: TalkPhase,
    pub message: String,
    pub helper: TalkHelper,
    /// Starting needs the one-time helper download; start again with `download`.
    pub needs_download: bool,
    pub download_size: &'static str,
    pub agents: Vec<TalkAgent>,
    /// The last turns, oldest first.
    pub turns: Vec<TalkTurn>,
}

/* ------------------------------------------------------------------ */
/* Tools, language and spoken lines                                    */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    SendToAgent,
    TaskStatus,
    CancelTask,
    StopSpeaking,
    StopListening,
    RepeatLast,
    Reply,
}

impl Tool {
    const ALL: [Tool; 7] = [
        Tool::SendToAgent,
        Tool::TaskStatus,
        Tool::CancelTask,
        Tool::StopSpeaking,
        Tool::StopListening,
        Tool::RepeatLast,
        Tool::Reply,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::SendToAgent => "send_to_agent",
            Self::TaskStatus => "task_status",
            Self::CancelTask => "cancel_task",
            Self::StopSpeaking => "stop_speaking",
            Self::StopListening => "stop_listening",
            Self::RepeatLast => "repeat_last",
            Self::Reply => "reply",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.name() == name)
    }

    fn args(self) -> &'static [&'static str] {
        match self {
            Self::SendToAgent => &["agent", "task"],
            Self::TaskStatus | Self::CancelTask => &["task"],
            Self::Reply => &["text"],
            Self::StopSpeaking | Self::StopListening | Self::RepeatLast => &[],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Lang {
    #[default]
    En,
    Nl,
}

const DUTCH: &[&str] = &[
    "de", "het", "een", "en", "ik", "jij", "je", "niet", "wat", "hoe", "waarom", "wanneer", "waar", "welke", "maar",
    "ook", "dat", "die", "dit", "voor", "naar", "met", "van", "zijn", "kan", "kun", "moet", "wil", "graag",
    "alsjeblieft", "bedankt", "dank", "ja", "nee", "nog", "even", "draai", "maak", "zet", "doe", "annuleer", "klaar",
    "taak", "taken", "alles", "geen", "heb", "hebt", "heeft", "er", "zo", "dan", "nu", "mijn", "wij", "ons", "bent",
    "wordt", "op", "te", "om", "uit", "aan", "bij", "als", "stoppen", "praten", "zeg", "laat", "eigenlijk",
];
const ENGLISH: &[&str] = &[
    "the", "a", "an", "and", "i", "you", "not", "what", "how", "why", "when", "where", "which", "but", "also", "that",
    "this", "for", "to", "with", "are", "can", "must", "want", "please", "thanks", "yes", "no", "still", "run",
    "make", "do", "cancel", "done", "task", "tasks", "everything", "have", "has", "there", "then", "now", "my", "our",
    "it", "be", "will", "would", "could", "should", "talking", "say", "let", "actually", "fix", "tell", "me",
];

/// The user's language when the helper is off: a tiny word score, ties keep `previous`.
fn detect_language(text: &str, previous: Lang) -> Lang {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphabetic()).filter(|word| !word.is_empty()).collect();
    let score = |list: &[&str]| words.iter().filter(|word| list.contains(word)).count();
    let (dutch, english) = (score(DUTCH), score(ENGLISH));
    match dutch.cmp(&english) {
        std::cmp::Ordering::Greater => Lang::Nl,
        std::cmp::Ordering::Less => Lang::En,
        std::cmp::Ordering::Equal => previous,
    }
}

fn label(text: &str) -> String {
    summary(text, LABEL)
}

/// A summary for a spoken sentence, without its final punctuation.
fn short_summary(text: &str) -> String {
    summary(text, SUMMARY).trim_end_matches(['.', '!', '?', ';', ':']).to_owned()
}

/// How a task stands, in a spoken sentence.
#[derive(Debug, Clone, PartialEq)]
struct TaskLine {
    agent: String,
    label: String,
    state: TaskState,
    summary: Option<String>,
}

impl TaskLine {
    fn new(task: &Task, agent: Option<&str>) -> Self {
        Self {
            agent: agent.unwrap_or("The agent").to_owned(),
            label: label(&task.text),
            state: task.state,
            summary: task.summary.as_deref().map(short_summary).filter(|summary| !summary.is_empty()),
        }
    }

    fn render(&self, lang: Lang) -> String {
        let Self { agent, label, state, summary } = self;
        let with = |base: String| match summary {
            Some(summary) => format!("{base}: {summary}."),
            None => format!("{base}."),
        };
        match (lang, state) {
            (Lang::En, TaskState::Queued) => format!("{agent} has not started \"{label}\" yet."),
            (Lang::En, TaskState::Accepted | TaskState::Running) => format!("{agent} is working on \"{label}\"."),
            (Lang::En, TaskState::Blocked) => with(format!("{agent} is stuck on \"{label}\"")),
            (Lang::En, TaskState::Completed) => with(format!("{agent} finished \"{label}\"")),
            (Lang::En, TaskState::Failed) => with(format!("{agent} could not finish \"{label}\"")),
            (Lang::En, TaskState::Cancelled) => format!("\"{label}\" was cancelled."),
            (Lang::Nl, TaskState::Queued) => format!("{agent} is nog niet begonnen aan \"{label}\"."),
            (Lang::Nl, TaskState::Accepted | TaskState::Running) => format!("{agent} werkt aan \"{label}\"."),
            (Lang::Nl, TaskState::Blocked) => with(format!("{agent} zit vast bij \"{label}\"")),
            (Lang::Nl, TaskState::Completed) => with(format!("{agent} is klaar met \"{label}\"")),
            (Lang::Nl, TaskState::Failed) => with(format!("{agent} kon \"{label}\" niet afmaken")),
            (Lang::Nl, TaskState::Cancelled) => format!("\"{label}\" is geannuleerd."),
        }
    }
}

/// A fixed spoken line. The English form is also the executor result the
/// helper rephrases.
#[derive(Debug, Clone, PartialEq)]
enum Line {
    Sent(String),
    PassedOn(String),
    NoAgent,
    /// Some tasks, and how many more were left out.
    Tasks(Vec<TaskLine>, usize),
    ConfirmCancel(String),
    CancelAsked { agent: String, label: String },
    Cancelled(String),
    Failed(String),
}

impl Line {
    fn render(&self, lang: Lang) -> String {
        let nl = lang == Lang::Nl;
        let text = match self {
            Self::Sent(agent) if nl => format!("Doorgestuurd naar {agent}."),
            Self::Sent(agent) => format!("Sent to {agent}."),
            Self::PassedOn(agent) if nl => format!("Doorgegeven aan {agent}."),
            Self::PassedOn(agent) => format!("Passed it on to {agent}."),
            Self::NoAgent if nl => "Er luistert nu geen agent.".into(),
            Self::NoAgent => "No agent is listening right now.".into(),
            Self::Tasks(tasks, _) if tasks.is_empty() && nl => "Er zijn geen open taken.".into(),
            Self::Tasks(tasks, _) if tasks.is_empty() => "There are no open tasks.".into(),
            Self::Tasks(tasks, more) => {
                let mut sentences: Vec<String> = tasks.iter().map(|task| task.render(lang)).collect();
                if *more > 0 {
                    sentences.push(if nl { format!("En nog {more}.") } else { format!("And {more} more.") });
                }
                sentences.join(" ")
            }
            Self::ConfirmCancel(label) if nl => format!("\"{label}\" annuleren? Zeg ja."),
            Self::ConfirmCancel(label) => format!("Cancel \"{label}\"? Say yes."),
            Self::CancelAsked { agent, label } if nl => format!("Ik heb {agent} gevraagd \"{label}\" te annuleren."),
            Self::CancelAsked { agent, label } => format!("Asked {agent} to cancel \"{label}\"."),
            Self::Cancelled(label) if nl => format!("\"{label}\" geannuleerd."),
            Self::Cancelled(label) => format!("Cancelled \"{label}\"."),
            Self::Failed(message) if nl => format!("Dat lukte niet: {}", summary(message, 200)),
            Self::Failed(message) => format!("That did not work: {}", summary(message, 200)),
        };
        summary(&text, 600)
    }
}

/// Sentences for tasks, at most [`LISTED`].
fn task_lines(tasks: impl Iterator<Item = TaskLine>) -> Line {
    let mut lines: Vec<TaskLine> = tasks.collect();
    let more = lines.len().saturating_sub(LISTED);
    lines.truncate(LISTED);
    Line::Tasks(lines, more)
}

/* ------------------------------------------------------------------ */
/* Helper calls                                                        */
/* ------------------------------------------------------------------ */

/// The aliases one context used.
#[derive(Default)]
struct Aliases {
    agents: Vec<(String, AgentInfo)>,
    tasks: Vec<(String, Task)>,
}

impl Aliases {
    fn agent(&self, alias: &str) -> Option<&AgentInfo> {
        self.agents.iter().find(|(id, _)| id == alias).map(|(_, agent)| agent)
    }
    fn task(&self, alias: &str) -> Option<&Task> {
        self.tasks.iter().find(|(id, _)| id == alias).map(|(_, task)| task)
    }
}

/// A validated helper decision, with real ids.
struct Call {
    tool: Tool,
    agent: Option<AgentInfo>,
    task: Option<Task>,
    text: Option<String>,
    confirmed: bool,
    language: Lang,
    /// The arguments as the helper sent them (aliases), for `reply`.
    args: Value,
}

fn helper_error(why: &str) -> DomainError {
    DomainError::new(DomainErrorCode::WorkerProtocol, format!("The helper returned {why}"))
}

fn spoken_text(value: Option<&Value>) -> DomainResult<String> {
    let text = value.and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if text.is_empty() || utf16_len(text) > 300 || text.contains(['\n', '\r']) {
        return Err(helper_error("text that cannot be spoken"));
    }
    Ok(text.to_owned())
}

/// Checks a decision against the context it was made for.
fn parse_call(decision: &Value, aliases: &Aliases) -> DomainResult<Call> {
    let tool =
        decision.get("tool").and_then(Value::as_str).and_then(Tool::parse).ok_or_else(|| helper_error("an unknown tool"))?;
    let args = decision.get("args").and_then(Value::as_object).ok_or_else(|| helper_error("no arguments"))?;
    let language = match decision.get("language").and_then(Value::as_str) {
        Some("en") => Lang::En,
        Some("nl") => Lang::Nl,
        _ => return Err(helper_error("an unknown language")),
    };
    let mut call = Call {
        tool,
        agent: None,
        task: None,
        text: None,
        confirmed: decision.get("confirmed") == Some(&Value::Bool(true)),
        language,
        args: Value::Object(args.clone()),
    };
    for (key, value) in args {
        if !tool.args().contains(&key.as_str()) {
            return Err(helper_error("an unexpected argument"));
        }
        match key.as_str() {
            "agent" => {
                let alias = value.as_str().unwrap_or_default();
                call.agent = Some(aliases.agent(alias).ok_or_else(|| helper_error("an unknown agent"))?.clone());
            }
            "task" => {
                let alias = value.as_str().unwrap_or_default();
                call.task = Some(aliases.task(alias).ok_or_else(|| helper_error("an unknown task"))?.clone());
            }
            _ => call.text = Some(spoken_text(Some(value))?),
        }
    }
    if (tool == Tool::CancelTask && call.task.is_none()) || (tool == Tool::Reply && call.text.is_none()) {
        return Err(helper_error("a call without its required argument"));
    }
    Ok(call)
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Off,
    Starting,
    Loading,
    Downloading,
    Live,
    Failed,
}

struct Helper {
    state: HelperState,
    message: String,
    loaded: bool,
    install: Option<HelperInstall>,
}

impl Helper {
    /// The state of a helper that is not loaded.
    fn idle(&mut self) {
        self.loaded = false;
        self.state = if self.install.is_some_and(HelperInstall::complete) {
            HelperState::Installed
        } else {
            HelperState::Missing
        };
        self.message.clear();
    }
}

struct Job {
    id: String,
    text: String,
    recording: Option<PathBuf>,
    /// The Talk session a microphone turn belongs to; `None` for injected turns.
    generation: Option<u64>,
    done: Option<oneshot::Sender<TalkTurn>>,
}

struct Memory {
    user: String,
    tool: &'static str,
    said: String,
    interrupted: bool,
    response: Option<String>,
}

struct State {
    on: bool,
    generation: u64,
    stage: Stage,
    message: String,
    helper: Helper,
    needs_download: bool,
    queue: VecDeque<Job>,
    routing: bool,
    turns: VecDeque<TalkTurn>,
    memory: VecDeque<Memory>,
    /// The task the user was asked to confirm cancelling, for the next turn only.
    pending_cancel: Option<String>,
    briefings: Vec<TaskLine>,
    language: Lang,
    /// The last line spoken by Delulu or an agent, with its speaker.
    last_line: Option<(String, String)>,
    shutting_down: bool,
}

struct Outcome {
    tool: Tool,
    said: String,
    speaker: String,
    helper_ms: Option<u64>,
    language: Lang,
}

enum Load {
    Ready,
    Failed,
    NeedsDownload,
    Stale,
}

struct Inner {
    profile: Arc<dyn VoiceProfile>,
    voice: VoiceService,
    listening: ListeningService,
    inbox: Inbox,
    sink: SharedSink,
    model: Mutex<Option<Arc<dyn HelperModel>>>,
    state: Mutex<State>,
    signal: Arc<Notify>,
    /// Serializes starts.
    gate: tokio::sync::Mutex<()>,
    /// Serializes helper loads.
    loading: tokio::sync::Mutex<()>,
    published: Mutex<Option<Value>>,
    runtime: tokio::runtime::Handle,
}

/// The live conversation loop. Cheap to clone; construct inside a Tokio runtime.
#[derive(Clone)]
pub struct Talk {
    inner: Arc<Inner>,
}

fn helper_on(settings: &AppSettings) -> bool {
    settings.voice_coordinator_mode.as_str() != "off"
}

fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

impl Talk {
    /// Owns `listening`: turns, barge-ins and levels come here.
    pub fn new(
        profile: Arc<dyn VoiceProfile>,
        voice: VoiceService,
        listening: ListeningService,
        inbox: Inbox,
        sink: SharedSink,
    ) -> Self {
        let talk = Self {
            inner: Arc::new(Inner {
                profile,
                voice,
                listening,
                inbox,
                sink,
                model: Mutex::new(None),
                state: Mutex::new(State {
                    on: false,
                    generation: 0,
                    stage: Stage::Off,
                    message: String::new(),
                    helper: Helper { state: HelperState::Missing, message: String::new(), loaded: false, install: None },
                    needs_download: false,
                    queue: VecDeque::new(),
                    routing: false,
                    turns: VecDeque::new(),
                    memory: VecDeque::new(),
                    pending_cancel: None,
                    briefings: Vec::new(),
                    language: Lang::En,
                    last_line: None,
                    shutting_down: false,
                }),
                signal: Arc::new(Notify::new()),
                gate: tokio::sync::Mutex::new(()),
                loading: tokio::sync::Mutex::new(()),
                published: Mutex::new(None),
                runtime: tokio::runtime::Handle::current(),
            }),
        };
        talk.attach();
        talk.spawn_router();
        talk
    }

    fn attach(&self) {
        let weak = Arc::downgrade(&self.inner);
        let upgrade = move || weak.upgrade().map(|inner| Talk { inner });
        let talk = upgrade.clone();
        self.inner.listening.on_heard(move |heard| {
            if let Some(talk) = talk() {
                talk.heard(heard);
            }
        });
        let talk = upgrade.clone();
        self.inner.listening.on_status(move |status| {
            if let Some(talk) = talk() {
                talk.listening_changed(status);
            }
        });
        let talk = upgrade.clone();
        self.inner.voice.on_status(move |_| {
            if let Some(talk) = talk() {
                talk.publish();
                talk.nudge();
            }
        });
        let talk = upgrade.clone();
        self.inner.inbox.on_change(move || {
            if let Some(talk) = talk() {
                talk.publish();
            }
        });
        let talk = upgrade;
        self.inner.inbox.on_update(move |update| {
            if let Some(talk) = talk() {
                talk.agent_update(update);
            }
        });
    }

    fn spawn_router(&self) {
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let signal = self.inner.signal.clone();
        self.inner.runtime.spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else { return };
                let talk = Talk { inner };
                let job = {
                    let mut state = talk.inner.state.lock();
                    let job = state.queue.pop_front();
                    state.routing = job.is_some();
                    job
                };
                match job {
                    Some(job) => {
                        talk.route(job).await;
                        talk.inner.state.lock().routing = false;
                        talk.publish();
                        talk.nudge();
                    }
                    None => {
                        drop(talk);
                        signal.notified().await;
                    }
                }
            }
        });
    }

    pub fn set_helper_model(&self, model: Arc<dyn HelperModel>) {
        *self.inner.model.lock() = Some(model);
    }

    fn model(&self) -> Option<Arc<dyn HelperModel>> {
        self.inner.model.lock().clone()
    }

    fn helper_mode(&self) -> bool {
        helper_on(&self.inner.profile.settings())
    }

    pub fn is_on(&self) -> bool {
        self.inner.state.lock().on
    }

    /* -------------------------------------------------------------- */
    /* Status                                                          */
    /* -------------------------------------------------------------- */

    pub fn status(&self) -> TalkStatus {
        let listen = self.inner.listening.get_status();
        let speaking = self.inner.voice.is_speaking();
        let agents = self
            .inner
            .inbox
            .agents()
            .into_iter()
            .map(|agent| TalkAgent {
                id: agent.id,
                name: agent.name,
                listening: agent.listening,
                open_tasks: agent.open_tasks,
            })
            .collect();
        let mode = if self.helper_mode() { "lightweight" } else { "off" };
        let state = self.inner.state.lock();
        let busy = state.routing || !state.queue.is_empty();
        let session = listen.session.as_ref();
        let (phase, message) = match state.stage {
            Stage::Off if state.needs_download => {
                (TalkPhase::Off, format!("The voice helper needs a one-time download ({DOWNLOAD_SIZE})"))
            }
            Stage::Off => (TalkPhase::Off, "Talk is off".to_owned()),
            Stage::Failed => (TalkPhase::Failed, state.message.clone()),
            Stage::Starting => (TalkPhase::Starting, state.message.clone()),
            Stage::Loading => (TalkPhase::Loading, state.message.clone()),
            Stage::Downloading => (TalkPhase::Downloading, state.message.clone()),
            Stage::Live => match session {
                Some(session) if session.state == ListenSessionState::Starting => {
                    (TalkPhase::Starting, listen.message.clone())
                }
                Some(session) if session.user_speaking => (TalkPhase::Hearing, "Hearing you…".to_owned()),
                Some(session) if session.transcribing => (TalkPhase::Thinking, "Thinking…".to_owned()),
                _ if busy => (TalkPhase::Thinking, "Thinking…".to_owned()),
                _ if speaking => (TalkPhase::Speaking, "Speaking".to_owned()),
                _ => (TalkPhase::Listening, listen.message.clone()),
            },
        };
        TalkStatus {
            on: state.on,
            phase,
            message,
            helper: TalkHelper {
                mode,
                state: if mode == "off" { HelperState::Off } else { state.helper.state },
                message: if mode == "off" { String::new() } else { state.helper.message.clone() },
            },
            needs_download: state.needs_download,
            download_size: DOWNLOAD_SIZE,
            agents,
            turns: state.turns.iter().cloned().collect(),
        }
    }

    /// Emits `talk:statusChanged` when the status changed.
    fn publish(&self) {
        let mut published = self.inner.published.lock();
        let Ok(value) = serde_json::to_value(self.status()) else { return };
        if published.as_ref() != Some(&value) {
            emit(self.inner.sink.as_ref(), "talk:statusChanged", &value);
            *published = Some(value);
        }
    }

    fn stale(&self, job: &Job) -> bool {
        let state = self.inner.state.lock();
        job.generation.is_some_and(|generation| generation != state.generation || !state.on)
    }

    /* -------------------------------------------------------------- */
    /* Start and stop                                                  */
    /* -------------------------------------------------------------- */

    /// Turns Talk on: loads the helper when it is selected (cached files, or
    /// the one-time download when `download`), then opens the microphone.
    /// A helper that is not installed and no `download` leaves Talk off with
    /// `needs_download`.
    pub async fn start(&self, download: bool) -> DomainResult<TalkStatus> {
        let _gate = self.inner.gate.lock().await;
        let generation = {
            let mut state = self.inner.state.lock();
            if state.shutting_down {
                return Err(DomainError::failed("Delulu Talks is shutting down"));
            }
            if state.on {
                drop(state);
                return Ok(self.status());
            }
            state.on = true;
            state.generation += 1;
            state.stage = Stage::Starting;
            state.message = "Starting…".into();
            state.needs_download = false;
            state.generation
        };
        self.publish();
        if self.helper_mode() {
            match self.load_helper(download, Some(generation), true).await {
                Load::NeedsDownload => {
                    {
                        let mut state = self.inner.state.lock();
                        if state.generation == generation {
                            state.on = false;
                            state.stage = Stage::Off;
                            state.message.clear();
                            state.needs_download = true;
                        }
                    }
                    self.publish();
                    return Ok(self.status());
                }
                Load::Stale => return Ok(self.status()),
                Load::Ready | Load::Failed => {}
            }
        }
        {
            let mut state = self.inner.state.lock();
            if state.generation != generation {
                drop(state);
                return Ok(self.status());
            }
            state.stage = Stage::Starting;
            state.message = "Starting the microphone…".into();
        }
        self.publish();
        let started = self.inner.listening.start().await;
        let current = self.inner.state.lock().generation == generation;
        match started {
            Ok(_) if current => {
                {
                    let mut state = self.inner.state.lock();
                    state.stage = Stage::Live;
                    state.message.clear();
                }
                self.publish();
                if !self.inner.listening.active() {
                    let message = self.inner.listening.get_status().message;
                    self.finish("The microphone stopped", Some(message)).await;
                }
                Ok(self.status())
            }
            Ok(_) => {
                self.inner.listening.stop_active("Talk stopped while starting");
                Ok(self.status())
            }
            Err(error) => {
                if current {
                    self.finish("Talk could not start", Some(error.message.clone())).await;
                }
                Err(error)
            }
        }
    }

    /// Turns Talk off: closes the microphone, drops turns not yet routed (their
    /// recordings are retried at the next start) and unloads the helper.
    pub async fn stop(&self, reason: &str) -> TalkStatus {
        self.finish(reason, None).await
    }

    async fn finish(&self, reason: &str, failure: Option<String>) -> TalkStatus {
        let (recordings, unload) = {
            let mut state = self.inner.state.lock();
            state.on = false;
            state.generation += 1;
            state.stage = if failure.is_some() { Stage::Failed } else { Stage::Off };
            state.message = failure.unwrap_or_default();
            state.pending_cancel = None;
            state.briefings.clear();
            let mut recordings = Vec::new();
            state.queue.retain_mut(|job| {
                if job.generation.is_none() {
                    return true;
                }
                recordings.extend(job.recording.take());
                false
            });
            let unload = state.helper.loaded;
            if unload {
                state.helper.idle();
            }
            (recordings, unload)
        };
        self.inner.listening.stop_active(reason);
        for recording in recordings {
            self.inner.listening.release(&recording);
        }
        if unload {
            if let Some(model) = self.model() {
                model.unload().await;
            }
        }
        self.publish();
        self.status()
    }

    /// Loads the helper once. `generation` ties the load to one Talk start;
    /// `staged` shows the load as the Talk phase.
    async fn load_helper(&self, download: bool, generation: Option<u64>, staged: bool) -> Load {
        let _loading = self.inner.loading.lock().await;
        let Some(model) = self.model() else {
            {
                let mut state = self.inner.state.lock();
                state.helper.state = HelperState::Failed;
                state.helper.message = "The voice helper is not available in this build.".into();
            }
            self.publish();
            return Load::Failed;
        };
        if self.inner.state.lock().helper.loaded {
            return Load::Ready;
        }
        let install = model.installed().await;
        let stale = |state: &State| generation.is_some_and(|generation| generation != state.generation);
        {
            let mut state = self.inner.state.lock();
            state.helper.install = Some(install);
            if stale(&state) {
                return Load::Stale;
            }
            if !install.complete() && !download {
                state.helper.state = HelperState::Missing;
                state.helper.message = format!("The voice helper needs a one-time download ({DOWNLOAD_SIZE}).");
                drop(state);
                self.publish();
                return Load::NeedsDownload;
            }
            state.helper.state = HelperState::Loading;
            state.helper.message.clear();
            if staged {
                if install.complete() {
                    state.stage = Stage::Loading;
                    state.message = "Loading the voice helper…".into();
                } else {
                    state.stage = Stage::Downloading;
                    state.message = format!("Downloading the voice helper ({DOWNLOAD_SIZE})…");
                }
            }
        }
        self.publish();
        let result = model.load(download).await;
        let stale = {
            let state = self.inner.state.lock();
            stale(&state) || !self.helper_mode()
        };
        if stale {
            if result.is_ok() {
                model.unload().await;
            }
            self.inner.state.lock().helper.idle();
            self.publish();
            return Load::Stale;
        }
        let load = {
            let mut state = self.inner.state.lock();
            match result {
                Ok(()) => {
                    state.helper.install = Some(HelperInstall { runtime: true, weights: true });
                    state.helper.loaded = true;
                    state.helper.state = HelperState::Ready;
                    state.helper.message.clear();
                    Load::Ready
                }
                Err(error) => {
                    log::warn!("the voice helper did not load ({:?})", error.code);
                    state.helper.state = HelperState::Failed;
                    state.helper.message = error.message;
                    Load::Failed
                }
            }
        };
        self.publish();
        load
    }

    /// Helper setup progress (the download).
    pub fn setup_progress(&self, message: &str) {
        {
            let mut state = self.inner.state.lock();
            if !matches!(state.stage, Stage::Downloading | Stage::Loading) {
                return;
            }
            state.message = message.to_owned();
        }
        self.publish();
    }

    /// Checks whether the helper is installed (file checks only).
    pub async fn refresh(&self) {
        if let Some(model) = self.model().filter(|_| self.helper_mode()) {
            let install = model.installed().await;
            let mut state = self.inner.state.lock();
            state.helper.install = Some(install);
            if !state.helper.loaded && state.helper.state != HelperState::Loading {
                state.helper.idle();
            }
        }
        self.publish();
    }

    /// The helper selection changed: load or unload it without closing the
    /// microphone. Without the helper installed, Talk carries on helper-off.
    pub async fn settings_changed(&self, previous: &AppSettings, saved: &AppSettings) {
        if helper_on(previous) == helper_on(saved) {
            return;
        }
        if !helper_on(saved) {
            let unload = {
                let mut state = self.inner.state.lock();
                state.needs_download = false;
                let unload = state.helper.loaded;
                state.helper.idle();
                unload
            };
            if unload {
                if let Some(model) = self.model() {
                    model.unload().await;
                }
            }
            self.publish();
            return;
        }
        let (on, generation) = {
            let state = self.inner.state.lock();
            (state.on, state.generation)
        };
        if on {
            let this = self.clone();
            self.inner.runtime.spawn(async move {
                if let Load::NeedsDownload = this.load_helper(false, Some(generation), false).await {
                    this.inner.state.lock().needs_download = true;
                    this.publish();
                }
            });
        } else {
            self.refresh().await;
        }
    }

    /// Quitting: stop and release the helper.
    pub async fn shutdown(&self) {
        self.inner.state.lock().shutting_down = true;
        self.finish("Delulu Talks closed", None).await;
    }

    /* -------------------------------------------------------------- */
    /* Input                                                           */
    /* -------------------------------------------------------------- */

    fn heard(&self, heard: Heard) {
        match heard {
            Heard::Turn { turn, recording } => {
                let queued = {
                    let mut state = self.inner.state.lock();
                    let accepted = state.on && state.queue.len() < MAX_QUEUE;
                    if accepted {
                        let generation = state.generation;
                        state.queue.push_back(Job {
                            id: turn.id,
                            text: turn.text,
                            recording: recording.clone(),
                            generation: Some(generation),
                            done: None,
                        });
                    }
                    accepted
                };
                if queued {
                    self.inner.signal.notify_one();
                    self.publish();
                } else if let Some(recording) = recording {
                    self.inner.listening.release(&recording);
                }
            }
            Heard::BargeIn { response_ids } => {
                let mut state = self.inner.state.lock();
                for memory in state.memory.iter_mut() {
                    if memory.response.as_ref().is_some_and(|id| response_ids.contains(id)) {
                        memory.interrupted = true;
                    }
                }
            }
            Heard::Level { db } => {
                if self.is_on() {
                    emit(self.inner.sink.as_ref(), "talk:level", &json!({ "db": db }));
                }
            }
        }
    }

    fn listening_changed(&self, status: &ListenStatus) {
        self.publish();
        self.nudge();
        let failed = status.session.as_ref().is_some_and(|session| session.state == ListenSessionState::Failed);
        let live = {
            let state = self.inner.state.lock();
            state.on && state.stage == Stage::Live
        };
        if failed && live {
            let message = status.message.clone();
            let this = self.clone();
            self.inner.runtime.spawn(async move {
                this.finish("The microphone stopped", Some(message)).await;
            });
        }
    }

    /// Development: routes `text` like a finished utterance, with or without
    /// the microphone open, and returns the handled turn.
    pub async fn inject(&self, text: String) -> DomainResult<TalkTurn> {
        let text = text.trim().to_owned();
        if text.is_empty() || utf16_len(&text) > MAX_TEXT {
            return Err(DomainError::invalid(format!("text must contain 1 to {MAX_TEXT} characters")));
        }
        if self.helper_mode() && !self.inner.state.lock().helper.loaded {
            self.load_helper(false, None, false).await;
        }
        let (done, receiver) = oneshot::channel();
        self.inner.state.lock().queue.push_back(Job {
            id: format!("turn_{}", uuid().replace('-', "")),
            text,
            recording: None,
            generation: None,
            done: Some(done),
        });
        self.inner.signal.notify_one();
        self.publish();
        receiver.await.map_err(|_| DomainError::failed("Talk closed before handling that turn"))
    }

    /* -------------------------------------------------------------- */
    /* Speaking                                                        */
    /* -------------------------------------------------------------- */

    /// Queues one of Delulu's lines behind whatever is playing.
    fn say(&self, text: &str, speaker: &str) -> Option<String> {
        let response_id = format!("delulu_{}", &uuid().replace('-', "")[..16]);
        self.inner.state.lock().last_line = Some((text.to_owned(), speaker.to_owned()));
        let request = VoiceSpeakRequest {
            text: text.to_owned(),
            source: Some(VoiceSource::Agent),
            agent: Some(speaker.to_owned()),
            interrupt: None,
            normalize: None,
            response_id: Some(response_id.clone()),
        };
        match self.inner.voice.enqueue(request) {
            Ok(_) => Some(response_id),
            Err(error) => {
                log::warn!("Talk could not speak: {}", error.message);
                None
            }
        }
    }

    /// An agent's `speak`: while Talk is on it queues behind current speech
    /// instead of interrupting it.
    pub fn speak_for_agent(&self, mut request: VoiceSpeakRequest) -> DomainResult<SpeakHandle> {
        if self.is_on() {
            request.interrupt = None;
        }
        let speaker = request.agent.clone().unwrap_or_else(|| "Agent".into());
        self.inner.state.lock().last_line = Some((request.text.clone(), speaker));
        self.inner.voice.enqueue(request)
    }

    fn stop_speaking(&self) {
        self.inner.state.lock().briefings.clear();
        self.inner.voice.stop("talk");
    }

    fn agent_update(&self, update: &TaskUpdate) {
        let state_changed = update.previous != update.task.state;
        if !state_changed || !matches!(update.task.state, TaskState::Completed | TaskState::Blocked | TaskState::Failed)
        {
            return;
        }
        {
            let mut state = self.inner.state.lock();
            if !state.on {
                return;
            }
            state.briefings.push(TaskLine::new(&update.task, Some(&update.agent)));
        }
        self.nudge();
    }

    /// Flushes briefings soon if they may be waiting for a pause.
    fn nudge(&self) {
        if self.inner.state.lock().briefings.is_empty() {
            return;
        }
        let this = self.clone();
        self.inner.runtime.spawn(async move { this.flush_briefings() });
    }

    /// Speaks queued briefings as one line once nobody talks and nothing is
    /// being transcribed, routed or played.
    fn flush_briefings(&self) {
        {
            let state = self.inner.state.lock();
            if !state.on || state.stage != Stage::Live || state.routing || !state.queue.is_empty() {
                return;
            }
            if state.briefings.is_empty() {
                return;
            }
        }
        let listen = self.inner.listening.get_status();
        if listen.session.as_ref().is_some_and(|session| session.user_speaking || session.transcribing)
            || self.inner.voice.is_speaking()
        {
            return;
        }
        let (briefings, language) = {
            let mut state = self.inner.state.lock();
            (std::mem::take(&mut state.briefings), state.language)
        };
        if briefings.is_empty() {
            return;
        }
        let line = task_lines(briefings.into_iter()).render(language);
        self.say(&line, SPEAKER);
        self.publish();
    }

    /* -------------------------------------------------------------- */
    /* Routing                                                         */
    /* -------------------------------------------------------------- */

    async fn route(&self, job: Job) {
        if self.stale(&job) {
            if let Some(recording) = &job.recording {
                self.inner.listening.release(recording);
            }
            return;
        }
        self.publish();
        let at = now_ms();
        let pending = self.inner.state.lock().pending_cancel.take();
        let model = self.model().filter(|_| {
            self.helper_mode() && self.inner.state.lock().helper.loaded && utf16_len(&job.text) <= HELPER_TEXT
        });
        let mut stop_after = false;
        let outcome = match model {
            Some(model) => {
                let clock = Instant::now();
                match self.with_helper(&model, &job, pending.as_deref(), &mut stop_after).await {
                    Ok(mut outcome) => {
                        outcome.helper_ms = Some(elapsed_ms(clock));
                        outcome
                    }
                    Err(error) => {
                        if self.stale(&job) {
                            if let Some(recording) = &job.recording {
                                self.inner.listening.release(recording);
                            }
                            return;
                        }
                        log::warn!("the voice helper failed on a turn ({:?}); forwarding it", error.code);
                        self.helper_failed("The helper failed on the last turn, so your words went to the agent unchanged.");
                        let mut outcome = self.forward(&job);
                        outcome.helper_ms = Some(elapsed_ms(clock));
                        outcome
                    }
                }
            }
            None => self.forward(&job),
        };
        let response = if outcome.said.is_empty() { None } else { self.say(&outcome.said, &outcome.speaker) };
        let turn = TalkTurn {
            id: job.id.clone(),
            at,
            user: job.text.clone(),
            tool: Some(outcome.tool.name().to_owned()),
            said: outcome.said.clone(),
            helper_ms: outcome.helper_ms,
        };
        {
            let mut state = self.inner.state.lock();
            state.language = outcome.language;
            state.memory.push_back(Memory {
                user: summary(&job.text, 300),
                tool: outcome.tool.name(),
                said: summary(&outcome.said, 300),
                interrupted: false,
                response,
            });
            while state.memory.len() > MEMORY {
                state.memory.pop_front();
            }
            state.turns.push_back(turn.clone());
            while state.turns.len() > TURNS {
                state.turns.pop_front();
            }
        }
        if let Some(recording) = &job.recording {
            self.inner.listening.discard(recording);
        }
        if let Some(done) = job.done {
            let _ = done.send(turn);
        }
        if stop_after {
            self.stop("Stopped by voice request").await;
        }
    }

    fn helper_failed(&self, message: &str) {
        {
            let mut state = self.inner.state.lock();
            state.helper.state = HelperState::Failed;
            state.helper.message = message.to_owned();
        }
        self.publish();
    }

    /// Helper off (or failed): the turn goes to the active agent verbatim.
    fn forward(&self, job: &Job) -> Outcome {
        let language = detect_language(&job.text, self.inner.state.lock().language);
        let said = match self.inner.inbox.submit(&job.text, None, &job.id) {
            Ok(Sent::NoListener { .. }) => Line::NoAgent.render(language),
            Ok(_) => String::new(),
            Err(error) => Line::Failed(error.message).render(language),
        };
        Outcome { tool: Tool::SendToAgent, said, speaker: SPEAKER.into(), helper_ms: None, language }
    }

    async fn with_helper(
        &self,
        model: &Arc<dyn HelperModel>,
        job: &Job,
        pending: Option<&str>,
        stop_after: &mut bool,
    ) -> DomainResult<Outcome> {
        let (context, aliases) = self.context(pending);
        let decision = model.decide(job.text.clone(), context.clone()).await?;
        if self.stale(job) {
            return Err(DomainError::cancelled("Talk stopped"));
        }
        let call = parse_call(&decision, &aliases)?;
        let outcome = |said: String| Outcome {
            tool: call.tool,
            said,
            speaker: SPEAKER.into(),
            helper_ms: None,
            language: call.language,
        };
        self.helper_recovered();
        Ok(match call.tool {
            Tool::Reply => outcome(call.text.clone().unwrap_or_default()),
            Tool::StopSpeaking => {
                self.stop_speaking();
                outcome(String::new())
            }
            Tool::StopListening => {
                *stop_after = true;
                outcome(String::new())
            }
            Tool::RepeatLast => {
                let last = self.inner.state.lock().last_line.clone();
                let (said, speaker) = last.unwrap_or_default();
                Outcome { speaker: if speaker.is_empty() { SPEAKER.into() } else { speaker }, ..outcome(said) }
            }
            Tool::SendToAgent | Tool::TaskStatus | Tool::CancelTask => {
                let line = self.execute(&call, job, pending);
                let result = line.render(Lang::En);
                let request = json!({ "tool": call.tool.name(), "args": call.args });
                let reply = model
                    .reply(job.text.clone(), context, request, result)
                    .await
                    .and_then(|reply| spoken_text(reply.get("text")));
                match reply {
                    Ok(text) => outcome(text),
                    Err(error) => {
                        log::warn!("the voice helper could not phrase a reply ({:?})", error.code);
                        self.helper_failed("The helper could not phrase the last answer.");
                        outcome(line.render(call.language))
                    }
                }
            }
        })
    }

    fn helper_recovered(&self) {
        let recovered = {
            let mut state = self.inner.state.lock();
            let failed = state.helper.loaded && state.helper.state == HelperState::Failed;
            if failed {
                state.helper.state = HelperState::Ready;
                state.helper.message.clear();
            }
            failed
        };
        if recovered {
            self.publish();
        }
    }

    fn agent_name(&self, id: &str) -> Option<String> {
        self.inner.inbox.agents().into_iter().find(|agent| agent.id == id).map(|agent| agent.name)
    }

    /// Runs `send_to_agent`, `task_status` or `cancel_task`.
    fn execute(&self, call: &Call, job: &Job, pending: Option<&str>) -> Line {
        let inbox = &self.inner.inbox;
        match call.tool {
            Tool::SendToAgent => {
                let sent = match &call.task {
                    Some(task) => inbox.follow_up(&task.id, &job.text, &job.id),
                    None => inbox.submit(&job.text, call.agent.as_ref().map(|agent| agent.id.as_str()), &job.id),
                };
                match sent {
                    Ok(Sent::Task { agent, .. }) => Line::Sent(agent.name),
                    Ok(Sent::Message { agent, .. }) => Line::PassedOn(agent.name),
                    Ok(Sent::NoListener { .. }) => Line::NoAgent,
                    Ok(Sent::Closed { task }) => {
                        task_lines(std::iter::once(TaskLine::new(&task, self.agent_name(&task.agent_id).as_deref())))
                    }
                    Err(error) => Line::Failed(error.message),
                }
            }
            Tool::TaskStatus => {
                let tasks: Vec<Task> = match &call.task {
                    Some(task) => vec![inbox.task(&task.id).unwrap_or_else(|| task.clone())],
                    None => inbox.open_tasks(),
                };
                let agents = inbox.agents();
                let name = |task: &Task| {
                    agents.iter().find(|agent| agent.id == task.agent_id).map(|agent| agent.name.clone())
                };
                task_lines(tasks.iter().map(|task| TaskLine::new(task, name(task).as_deref())))
            }
            Tool::CancelTask => {
                let task = call.task.as_ref().expect("validated");
                if !(call.confirmed && pending == Some(task.id.as_str())) {
                    self.inner.state.lock().pending_cancel = Some(task.id.clone());
                    return Line::ConfirmCancel(label(&task.text));
                }
                match inbox.cancel(&task.id) {
                    Ok(Cancel::Requested { task, agent }) => {
                        Line::CancelAsked { agent: agent.name, label: label(&task.text) }
                    }
                    Ok(Cancel::Closed { task, .. }) => Line::Cancelled(label(&task.text)),
                    Ok(Cancel::Finished { task }) => {
                        task_lines(std::iter::once(TaskLine::new(&task, self.agent_name(&task.agent_id).as_deref())))
                    }
                    Err(error) => Line::Failed(error.message),
                }
            }
            _ => unreachable!("only executor tools"),
        }
    }

    /// The helper's view: agents, open tasks and recent turns under short aliases.
    fn context(&self, pending: Option<&str>) -> (Value, Aliases) {
        let mut aliases = Aliases::default();
        let all = self.inner.inbox.agents();
        let mut labels: Vec<(String, String)> = Vec::new();
        let agents: Vec<Value> = all
            .iter()
            .take(CONTEXT_AGENTS)
            .enumerate()
            .map(|(index, agent)| {
                let base = summary(&agent.name, 100);
                let mut label = base.clone();
                let mut copy = 1;
                while labels.iter().any(|(_, taken)| *taken == label) {
                    copy += 1;
                    label = format!("{base} ({copy})");
                }
                labels.push((agent.id.clone(), label.clone()));
                let alias = format!("agent_{}", index + 1);
                aliases.agents.push((alias.clone(), agent.clone()));
                json!({ "id": alias, "label": label, "listening": agent.listening })
            })
            .collect();
        let tasks: Vec<Value> = self
            .inner
            .inbox
            .open_tasks()
            .into_iter()
            .take(CONTEXT_TASKS)
            .enumerate()
            .map(|(index, task)| {
                let alias = format!("task_{}", index + 1);
                let agent = labels
                    .iter()
                    .find(|(id, _)| *id == task.agent_id)
                    .map(|(_, label)| label.clone())
                    .or_else(|| all.iter().find(|agent| agent.id == task.agent_id).map(|agent| summary(&agent.name, 120)));
                let mut entry = json!({
                    "id": alias, "label": summary(&task.text, 120), "agent": agent, "state": task.state.as_str(),
                });
                if let Some(text) = task.summary.as_deref().map(|text| summary(text, 200)).filter(|text| !text.is_empty()) {
                    entry["summary"] = json!(text);
                }
                aliases.tasks.push((alias, task));
                entry
            })
            .collect();
        let state = self.inner.state.lock();
        let recent: Vec<Value> = state
            .memory
            .iter()
            .map(|memory| {
                json!({ "user": memory.user, "tool": memory.tool, "said": memory.said, "interrupted": memory.interrupted })
            })
            .collect();
        drop(state);
        let mut context = json!({ "agents": agents, "tasks": tasks, "recent": recent });
        if let Some((alias, _)) = pending.and_then(|id| aliases.tasks.iter().find(|(_, task)| task.id == id)) {
            context["pendingCancel"] = json!(alias);
        }
        (context, aliases)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dutch_and_english_and_keeps_the_previous_language_on_ties() {
        assert_eq!(detect_language("Draai de unit tests even.", Lang::En), Lang::Nl);
        assert_eq!(detect_language("Run the unit tests please.", Lang::Nl), Lang::En);
        assert_eq!(detect_language("Okay.", Lang::Nl), Lang::Nl);
    }

    #[test]
    fn executor_results_are_the_spoken_english_sentences() {
        let line = |state, summary: Option<&str>| TaskLine {
            agent: "Claude Code".into(),
            label: "Run the unit tests".into(),
            state,
            summary: summary.map(str::to_owned),
        };
        assert_eq!(Line::Sent("Claude Code".into()).render(Lang::En), "Sent to Claude Code.");
        assert_eq!(Line::PassedOn("Codex".into()).render(Lang::En), "Passed it on to Codex.");
        assert_eq!(Line::NoAgent.render(Lang::Nl), "Er luistert nu geen agent.");
        assert_eq!(
            Line::Tasks(vec![line(TaskState::Queued, None), line(TaskState::Blocked, Some("needs a key"))], 2)
                .render(Lang::En),
            "Claude Code has not started \"Run the unit tests\" yet. Claude Code is stuck on \"Run the unit tests\": needs a key. And 2 more."
        );
        assert_eq!(
            line(TaskState::Completed, Some("All 212 pass.")).render(Lang::En),
            "Claude Code finished \"Run the unit tests\": All 212 pass."
        );
        assert_eq!(line(TaskState::Cancelled, None).render(Lang::En), "\"Run the unit tests\" was cancelled.");
        assert_eq!(Line::Tasks(vec![], 0).render(Lang::En), "There are no open tasks.");
        assert_eq!(Line::ConfirmCancel("Run the unit tests".into()).render(Lang::En), "Cancel \"Run the unit tests\"? Say yes.");
        assert_eq!(
            Line::CancelAsked { agent: "Codex".into(), label: "Deploy".into() }.render(Lang::En),
            "Asked Codex to cancel \"Deploy\"."
        );
        assert_eq!(Line::Cancelled("Deploy".into()).render(Lang::En), "Cancelled \"Deploy\".");
    }
}
