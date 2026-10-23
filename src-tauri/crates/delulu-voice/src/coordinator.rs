//! Harness-neutral voice routing. Model output is metadata only; task text is
//! copied verbatim from the user. Inbox commits precede microphone acknowledgments.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::util::{truncate_utf16, utf16_len, uuid, write_private_atomic};
use delulu_core::{emit, DomainError, DomainResult, SharedSink};
use delulu_domain::listening::{ListenEvent, ListenNextResult, ListenStatus};
use delulu_domain::voice::{VoiceSource, VoiceSpeakRequest};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{BoxFuture, ListeningService, VoiceProfile, VoiceService};

pub trait CoordinatorModel: Send + Sync {
    fn load(&self, mode: String, setup: bool) -> BoxFuture<'_, DomainResult<()>>;
    fn unload(&self) -> BoxFuture<'_, ()>;
    fn classify(&self, text: String, context: Value) -> BoxFuture<'_, DomainResult<Value>>;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorStatus {
    pub mode: String,
    pub phase: String,
    pub message: String,
    pub model: Option<String>,
    pub registered_agents: usize,
    pub queued_tasks: usize,
    pub active_agent: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxEvent {
    seq: u64,
    #[serde(rename = "type")]
    kind: String,
    task_id: String,
    text: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    id: String,
    client: String,
    name: String,
    acked_seq: u64,
    last_seq: u64,
    events: Vec<InboxEvent>,
}
impl Agent {
    fn info(&self) -> Value {
        json!({"id": self.id,"client":self.client,"name":self.name,
            "ackedSeq":self.acked_seq,"lastSeq":self.last_seq,"queued":self.events.len()})
    }
    fn push(&mut self, kind: &str, task_id: &str, text: &str) -> DomainResult<()> {
        if self.events.len() >= 256 {
            return Err(failed("Agent inbox is full; acknowledge pending events first"));
        }
        self.last_seq += 1;
        self.events.push(InboxEvent {
            seq: self.last_seq,
            kind: kind.into(),
            task_id: task_id.into(),
            text: text.into(),
        });
        Ok(())
    }
    fn ack(&mut self, seq: u64) -> DomainResult<()> {
        if seq > self.last_seq {
            return Err(failed("Cannot acknowledge an event that has not been produced"));
        }
        self.acked_seq = self.acked_seq.max(seq);
        self.events.retain(|event| event.seq > self.acked_seq);
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    text: String,
    corrections: Vec<String>,
    agent_id: Option<String>,
    state: String,
    summary: Option<String>,
    request_id: String,
    cancel_requested: bool,
}
fn terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "cancelled")
}
#[derive(Clone, Serialize, Deserialize)]
struct Turn {
    id: String,
    text: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    agents: Vec<Agent>,
    tasks: Vec<Task>,
    active_agent: Option<String>,
    focused_task: Option<String>,
    pending: Vec<Turn>,
    unrouted: Vec<Turn>,
    processed_turns: Vec<String>,
    applied_requests: Vec<(String, String, String)>,
}
struct Inner {
    profile: Arc<dyn VoiceProfile>,
    voice: VoiceService,
    listening: ListeningService,
    sink: SharedSink,
    store: Mutex<Store>,
    store_error: Option<String>,
    status: Mutex<(String, String)>,
    model: Mutex<Option<Arc<dyn CoordinatorModel>>>,
    operations: tokio::sync::Mutex<()>,
    microphone_start: tokio::sync::Mutex<()>,
    shutting_down: AtomicBool,
    reader: Mutex<Option<(String, String, CancellationToken)>>,
    notify: Notify,
}
#[derive(Clone)]
pub struct Coordinator {
    inner: Arc<Inner>,
}
fn failed(message: impl Into<String>) -> DomainError {
    DomainError::failed(message)
}
fn encoded(value: impl Serialize) -> DomainResult<Value> {
    serde_json::to_value(value).map_err(|e| failed(e.to_string()))
}
fn required(params: &Value, key: &str, max: usize) -> DomainResult<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && utf16_len(v) <= max)
        .map(str::to_owned)
        .ok_or_else(|| failed(format!("{key} must contain 1 to {max} characters")))
}
fn optional(params: &Value, key: &str, max: usize) -> DomainResult<Option<String>> {
    if params.get(key).is_none() {
        Ok(None)
    } else {
        required(params, key, max).map(Some)
    }
}
impl Coordinator {
    pub fn new(
        profile: Arc<dyn VoiceProfile>,
        voice: VoiceService,
        listening: ListeningService,
        sink: SharedSink,
    ) -> Self {
        let path = profile.paths().voice_dir().join("coordinator.json");
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
            Err(e) => Err(e.to_string()),
        };
        let store_error = loaded.as_ref().err().cloned();
        Self {
            inner: Arc::new(Inner {
                profile,
                voice,
                listening,
                sink,
                store: Mutex::new(loaded.unwrap_or_default()),
                store_error,
                status: Mutex::new(("not-ready".into(), "Set up or load a local helper to start routing".into())),
                model: Mutex::new(None),
                operations: tokio::sync::Mutex::new(()),
                microphone_start: tokio::sync::Mutex::new(()),
                shutting_down: AtomicBool::new(false),
                reader: Mutex::new(None),
                notify: Notify::new(),
            }),
        }
    }
    pub fn enqueue_agent(&self, mut request: VoiceSpeakRequest) -> DomainResult<crate::SpeakHandle> {
        // One controller owns spoken briefings; a fresh reply replaces stale output.
        request.interrupt = Some(true);
        self.inner.voice.enqueue(request)
    }
    pub fn attach_listener(&self) {
        let weak = Arc::downgrade(&self.inner);
        self.inner.listening.on_coordinator_turn(move |turn| {
            let Some(inner) = weak.upgrade() else {
                return Err(failed("Voice controller is shutting down"));
            };
            let this = Self { inner };
            this.change(|s| {
                if !s.processed_turns.contains(&turn.id) && !s.pending.iter().any(|t| t.id == turn.id) {
                    s.pending.push(Turn { id: turn.id.clone(), text: turn.text.clone() });
                }
                Ok(())
            })
        });
    }
    pub fn set_model(&self, model: Arc<dyn CoordinatorModel>) {
        *self.inner.model.lock() = Some(model);
    }
    pub fn mode(&self) -> String {
        self.inner.profile.settings().voice_coordinator_mode.as_str().into()
    }
    pub fn enabled(&self) -> bool {
        self.mode() != "off"
    }
    pub fn status(&self) -> CoordinatorStatus {
        let mode = self.mode();
        let store = self.inner.store.lock();
        let (phase, message) = self.inner.status.lock().clone();
        CoordinatorStatus {
            phase: if mode == "off" {
                "off".into()
            } else if self.inner.store_error.is_some() {
                "failed".into()
            } else {
                phase
            },
            message: self
                .inner
                .store_error
                .clone()
                .map(|e| format!("Cannot read the coordinator inbox: {e}"))
                .unwrap_or_else(|| if mode == "off" { "Direct voice; local helper is off".into() } else { message }),
            model: match mode.as_str() {
                "lightweight" => Some("qwen35Small".into()),
                "conversational" => Some("qwen35Medium".into()),
                _ => None,
            },
            mode,
            registered_agents: store.agents.len(),
            queued_tasks: store.tasks.iter().filter(|t| t.state == "queued").count(),
            active_agent: store.active_agent.clone(),
        }
    }
    fn publish(&self) {
        emit(self.inner.sink.as_ref(), "voice:coordinatorStatusChanged", &self.status());
        self.inner.notify.notify_waiters();
    }
    pub fn setup_progress(&self, message: &str) {
        self.phase("loading", message);
    }
    fn phase(&self, phase: &str, message: impl Into<String>) {
        *self.inner.status.lock() = (phase.into(), message.into());
        self.publish();
    }
    fn change<T>(&self, change: impl FnOnce(&mut Store) -> DomainResult<T>) -> DomainResult<T> {
        if let Some(error) = &self.inner.store_error {
            return Err(failed(format!("Cannot read coordinator inbox: {error}")));
        }
        let mut guard = self.inner.store.lock();
        let mut next = guard.clone();
        let result = change(&mut next)?;
        let bytes = serde_json::to_vec(&next).map_err(|e| failed(e.to_string()))?;
        crate::service::create_private_dir(&self.inner.profile.paths().voice_dir())
            .map_err(|e| failed(e.to_string()))?;
        write_private_atomic(&self.inner.profile.paths().voice_dir().join("coordinator.json"), &bytes)
            .map_err(|e| failed(format!("Could not save coordinator inbox: {e}")))?;
        *guard = next;
        drop(guard);
        self.publish();
        Ok(result)
    }
    pub async fn load(&self, setup: bool) -> DomainResult<()> {
        let _gate = self.inner.operations.lock().await;
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(failed("Delulu Talks is shutting down"));
        }
        let mode = self.mode();
        if mode == "off" {
            return Err(failed("Select a local helper first"));
        }
        let model = self.inner.model.lock().clone().ok_or_else(|| failed("Coordinator runtime unavailable"))?;
        self.phase(
            "loading",
            if setup {
                "Setting up the local helper; this may download model files"
            } else {
                "Loading cached local helper"
            },
        );
        match model.load(mode.clone(), setup).await {
            Ok(()) if self.mode() == mode && !self.inner.shutting_down.load(Ordering::SeqCst) => {
                self.phase("ready", "Local helper ready; start the microphone to talk");
                Ok(())
            }
            Ok(()) => {
                model.unload().await;
                self.phase("not-ready", "Helper selection changed; load the selected helper");
                Ok(())
            }
            Err(error) => {
                self.phase("failed", &error.message);
                Err(error)
            }
        }
    }
    pub async fn shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        self.unload().await;
    }
    pub async fn unload(&self) {
        self.stop_listening();
        // Invalidate readiness before stopping the process so late routes cannot execute.
        self.phase("not-ready", "Local helper unloaded; accepted tasks remain in agent inboxes");
        let model = self.inner.model.lock().clone();
        if let Some(model) = &model {
            model.unload().await;
        }
        let _gate = self.inner.operations.lock().await;
        self.stop_listening();
        if let Some(model) = model {
            model.unload().await;
        }
        self.phase("not-ready", "Local helper unloaded; accepted tasks remain in agent inboxes");
    }
    pub fn stop_reader(&self) {
        if let Some((_, _, token)) = self.inner.reader.lock().take() {
            token.cancel();
        }
    }
    fn drain_completed(&self) -> DomainResult<()> {
        let turns = self.inner.listening.pending_utterances();
        if turns.is_empty() {
            return Ok(());
        }
        self.change(|s| {
            for turn in &turns {
                if !s.processed_turns.contains(&turn.id) && !s.pending.iter().any(|t| t.id == turn.id) {
                    s.pending.push(Turn { id: turn.id.clone(), text: turn.text.clone() });
                    s.pending.sort_by(|a, b| a.id.cmp(&b.id));
                }
            }
            Ok(())
        })?;
        if let Some(last) = turns.last() {
            self.inner.listening.ack(&last.session_id, last.seq).map_err(|e| e.into_domain())?;
        }
        Ok(())
    }
    pub fn stop_listening(&self) {
        if self.inner.listening.get_status().session.as_ref().is_some_and(|s| s.client == "delulu-coordinator") {
            self.inner.listening.stop_active("Local helper microphone stopped");
            self.stop_reader();
            if let Err(error) = self.drain_completed() {
                self.phase("failed", error.message);
            }
        }
    }
    pub async fn start_listening(&self) -> DomainResult<ListenStatus> {
        let _start = self.inner.microphone_start.lock().await;
        self.drain_completed()?;
        if self.status().phase != "ready" || self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(failed("Load the selected local helper before starting the microphone"));
        }
        if !self.inner.listening.active() {
            self.inner.listening.recover_coordinator_audio().await?;
        }
        let session = self.inner.listening.start("delulu-coordinator").await.map_err(|e| e.into_domain())?;
        if !self.enabled() || self.status().phase != "ready" {
            self.inner.listening.stop_active("Local helper was unloaded while opening the microphone");
            self.drain_completed()?;
            return Err(failed("Local helper was unloaded while opening the microphone"));
        }
        let mut reader = self.inner.reader.lock();
        if reader.as_ref().is_some_and(|(_, id, _)| id != &session.id) {
            if let Some((_, _, old)) = reader.take() {
                old.cancel();
            }
        }
        if reader.is_none() {
            let token = CancellationToken::new();
            let reader_id = uuid();
            *reader = Some((reader_id.clone(), session.id.clone(), token.clone()));
            let this = self.clone();
            tokio::spawn(async move {
                let result = this.read_turns(session.id, token.clone()).await;
                let owns_reader =
                    this.inner.reader.lock().as_ref().is_some_and(|(current, _, _)| current == &reader_id);
                if let Err(error) = result {
                    if owns_reader && !token.is_cancelled() {
                        this.phase("failed", error.message);
                        this.inner.listening.stop_active("Coordinator stopped after an error");
                        if let Err(error) = this.drain_completed() {
                            log::error!("Cannot preserve completed voice turns: {}", error.message);
                        }
                    }
                }
                let mut reader = this.inner.reader.lock();
                if reader.as_ref().is_some_and(|(current, _, _)| current == &reader_id) {
                    reader.take();
                }
            });
        }
        Ok(self.inner.listening.get_status())
    }
    async fn read_turns(&self, id: String, cancel: CancellationToken) -> DomainResult<()> {
        // Pending turns survived a previous failure/restart. Retry before consuming new audio.
        self.flush_turns(&cancel).await?;
        let mut after = None;
        loop {
            let has_pending = !self.inner.store.lock().pending.is_empty();
            let next = self
                .inner
                .listening
                .next(&id, after, if has_pending { 1000 } else { 30_000 }, Some(cancel.clone()))
                .await;
            if cancel.is_cancelled() {
                break;
            }
            match next.map_err(|e| e.into_domain())? {
                ListenNextResult::Event { event, .. } => {
                    let seq = event.seq();
                    match event {
                        ListenEvent::Utterance(event) => {
                            self.change(|s| {
                                if !s.processed_turns.contains(&event.id) && !s.pending.iter().any(|t| t.id == event.id)
                                {
                                    if s.pending.len() >= 32 {
                                        return Err(failed("Too many pending turns; reload the helper to retry"));
                                    }
                                    s.pending.push(Turn { id: event.id, text: event.text });
                                }
                                Ok(())
                            })?;
                        }
                        ListenEvent::Stopped(_) => {
                            self.flush_turns(&cancel).await?;
                            break;
                        }
                        ListenEvent::Interrupted(_) => {}
                    }
                    // Only acknowledge after a durable copy exists.
                    after = Some(seq);
                }
                ListenNextResult::Timeout { .. } => {
                    let status = self.inner.listening.get_status();
                    if !status.session.as_ref().is_some_and(|s| s.user_speaking || s.transcribing) {
                        self.flush_turns(&cancel).await?;
                    }
                }
                ListenNextResult::Stopped { .. } => {
                    self.flush_turns(&cancel).await?;
                    break;
                }
            }
        }
        Ok(())
    }
    fn context(&self) -> Value {
        let store = self.inner.store.lock();
        let tasks: Vec<Value> = store
            .tasks
            .iter()
            .filter(|t| !terminal(&t.state))
            .rev()
            .take(32)
            .map(|t| json!({"id":t.id,"label":truncate_utf16(&t.text.replace(['\n','\r']," "),256)}))
            .collect();
        let mut context = json!({"tasks":tasks,"agents":store.agents.iter().map(|a|json!({"id":a.id,"label":a.name})).collect::<Vec<_>>()});
        if let Some(id) = store
            .focused_task
            .as_ref()
            .filter(|id| context["tasks"].as_array().unwrap().iter().any(|t| t["id"].as_str() == Some(id)))
        {
            context["focusedTaskId"] = json!(id);
        }
        if let Some(id) = &store.active_agent {
            context["activeAgentId"] = json!(id);
        }
        context
    }
    async fn flush_turns(&self, cancel: &CancellationToken) -> DomainResult<()> {
        let mut pending = self.inner.store.lock().pending.clone();
        // Keep a long turn available for recovery, without poisoning later turns.
        if pending.first().is_some_and(|t| utf16_len(&t.text) > 8000) {
            self.change(|s| {
                if s.unrouted.len() >= 32 {
                    return Err(failed("Unrouted voice storage is full; inspect task.status before continuing"));
                }
                let turn = s.pending.remove(0);
                s.processed_turns.push(turn.id.clone());
                s.unrouted.push(turn);
                Ok(())
            })?;
            self.brief(
                "That turn is too long to route. Its original words are saved under unrouted turns in task status."
                    .into(),
            );
            return Ok(());
        }
        let mut size = 0;
        let count = pending
            .iter()
            .take_while(|turn| {
                size += utf16_len(&turn.text) + usize::from(size > 0);
                size <= 8000
            })
            .count();
        pending.truncate(count);
        if pending.is_empty() || cancel.is_cancelled() {
            return Ok(());
        }
        let text = pending.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join("\n");
        let request_id = pending[0].id.clone();
        if utf16_len(&text) > 8000 {
            return Err(failed("Voice turn is too long to route; original words were saved in the inbox"));
        }
        let model = self.inner.model.lock().clone().ok_or_else(|| failed("Load the local helper first"))?;
        let context = self.context();
        let route = tokio::select! {_=cancel.cancelled()=>return Ok(()),route=model.classify(text.clone(),context.clone())=>route?};
        if cancel.is_cancelled() || !self.enabled() || self.status().phase != "ready" {
            return Ok(());
        }
        delulu_runtime::protocol::validate_coordinator_route(&route).map_err(DomainError::invalid)?;
        for (key, list) in [("taskId", "tasks"), ("agentId", "agents")] {
            if let Some(id) = route[key].as_str() {
                if !context[list].as_array().unwrap().iter().any(|entry| entry["id"].as_str() == Some(id)) {
                    return Err(failed("Helper returned an unknown target"));
                }
            }
        }
        let message = match route["intent"].as_str().unwrap_or_default() {
            "delegate" => {
                let result = self.submit(&text, route["agentId"].as_str(), &request_id, route["taskId"].as_str())?;
                if result["agentId"].is_null() {
                    "Saved your task. Connect an agent to receive it.".into()
                } else {
                    "Queued for your agent.".into()
                }
            }
            "status" => {
                if route["taskId"].is_null() {
                    if let Some(agent) = route["agentId"].as_str() {
                        self.agent_brief(agent)
                    } else {
                        self.task_brief(None)
                    }
                } else {
                    self.task_brief(route["taskId"].as_str())
                }
            }
            "stop_speaking" => {
                self.inner.voice.stop("coordinator");
                String::new()
            }
            "stop_listening" => {
                self.inner.listening.stop_active("Stopped by voice request");
                "Microphone stopped.".into()
            }
            "cancel_task" => self.request_cancel(route["taskId"].as_str())?,
            _ => {
                let command = text.trim().to_lowercase();
                if ["cancel", "abort", "annuleer"].iter().any(|word| command.starts_with(word)) {
                    "Which task should I cancel? Name the task.".into()
                } else {
                    "I'm listening. You can give your agent a task or ask for its status.".into()
                }
            }
        };
        self.change(|s| {
            for turn in &pending {
                s.processed_turns.push(turn.id.clone());
            }
            s.pending.retain(|turn| !pending.iter().any(|old| old.id == turn.id));
            if s.processed_turns.len() > 512 {
                s.processed_turns.drain(..s.processed_turns.len() - 512);
            }
            Ok(())
        })?;
        if !message.is_empty() {
            self.brief(message);
        }
        Ok(())
    }
    fn brief(&self, text: String) {
        let _ = self.inner.voice.enqueue(VoiceSpeakRequest {
            text,
            source: Some(VoiceSource::Agent),
            agent: Some("Delulu".into()),
            interrupt: Some(true),
            normalize: None,
            response_id: Some(format!("coord_{}", uuid())),
        });
    }
    fn agent_brief(&self, id: &str) -> String {
        let store = self.inner.store.lock();
        let Some(agent) = store.agents.iter().find(|a| a.id == id) else {
            return "That agent is no longer registered.".into();
        };
        let tasks: Vec<_> =
            store.tasks.iter().filter(|task| task.agent_id.as_deref() == Some(id) && !terminal(&task.state)).collect();
        if tasks.is_empty() {
            format!("{} has no active tasks.", agent.name)
        } else {
            format!(
                "{} has {} queued, {} accepted, {} running, and {} blocked tasks.",
                agent.name,
                tasks.iter().filter(|t| t.state == "queued").count(),
                tasks.iter().filter(|t| t.state == "accepted").count(),
                tasks.iter().filter(|t| t.state == "running").count(),
                tasks.iter().filter(|t| t.state == "blocked").count()
            )
        }
    }
    fn task_brief(&self, id: Option<&str>) -> String {
        let s = self.inner.store.lock();
        let id = id.or(s.focused_task.as_deref());
        let task = id.and_then(|id| s.tasks.iter().find(|t| t.id == id)).or_else(|| s.tasks.last());
        match task {
            Some(task) => format!(
                "Your task is {}.{}",
                task.state,
                task.summary.as_ref().map(|v| format!(" {}", truncate_utf16(v, 400))).unwrap_or_default()
            ),
            None => "There are no tasks yet.".into(),
        }
    }
    fn submit(&self, text: &str, agent: Option<&str>, request: &str, task: Option<&str>) -> DomainResult<Value> {
        self.change(|s| {
            if let Some((_, id, original)) = s.applied_requests.iter().find(|(key, _, _)| key == request) {
                if original != text {
                    return Err(failed("requestId was already used for different text"));
                }
                return encoded(
                    s.tasks
                        .iter()
                        .find(|t| &t.id == id)
                        .ok_or_else(|| failed("This request has expired from task history"))?,
                );
            }
            if s.applied_requests.len() >= 2048 {
                s.applied_requests.remove(0);
            }
            let explicit_agent = agent.map(str::to_owned);
            let agent = explicit_agent.clone();
            if agent.as_ref().is_some_and(|id| !s.agents.iter().any(|a| &a.id == id)) {
                return Err(failed("Unknown agent"));
            }
            if let Some(task_id) = task {
                let target = s
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == task_id && !terminal(&t.state))
                    .ok_or_else(|| failed("Task is no longer active"))?;
                if agent.is_some() && agent != target.agent_id {
                    return Err(failed("A correction must go to the task's assigned agent"));
                }
                if target.corrections.len() >= 64 {
                    return Err(failed("Too many corrections for this task"));
                }
                target.corrections.push(text.into());
                let result = encoded(&*target)?;
                if let Some(id) = &target.agent_id {
                    s.agents
                        .iter_mut()
                        .find(|a| &a.id == id)
                        .ok_or_else(|| failed("Task agent is unavailable"))?
                        .push("message", task_id, text)?;
                }
                s.applied_requests.push((request.into(), task_id.into(), text.into()));
                return Ok(result);
            }
            let agent = explicit_agent.or_else(|| s.active_agent.clone());
            if s.tasks.iter().filter(|t| !terminal(&t.state)).count() >= 32 {
                return Err(failed("32 tasks are already active; finish or cancel one first"));
            }
            if s.tasks.len() >= 256 {
                let removable = s.tasks.iter().position(|t| {
                    terminal(&t.state) && !s.agents.iter().any(|a| a.events.iter().any(|e| e.task_id == t.id))
                });
                if let Some(index) = removable {
                    s.tasks.remove(index);
                } else {
                    return Err(failed("Task history is full; acknowledge agent inboxes first"));
                }
            }
            let task = Task {
                id: format!("task_{}", uuid()),
                text: text.into(),
                corrections: vec![],
                agent_id: agent.clone(),
                state: "queued".into(),
                summary: None,
                request_id: request.into(),
                cancel_requested: false,
            };
            if let Some(id) = &agent {
                s.agents.iter_mut().find(|a| &a.id == id).unwrap().push("task", &task.id, text)?;
            }
            s.focused_task = Some(task.id.clone());
            let result = encoded(&task)?;
            s.applied_requests.push((request.into(), task.id.clone(), text.into()));
            s.tasks.push(task);
            Ok(result)
        })
    }
    fn request_cancel(&self, id: Option<&str>) -> DomainResult<String> {
        // Never infer cancellation from focus alone: ambiguous requests need a target.
        let Some(id) = id else {
            return Ok("Which task should I cancel? Name the task.".into());
        };
        self.change(|s| {
            let task = s
                .tasks
                .iter_mut()
                .find(|t| t.id == id && !terminal(&t.state))
                .ok_or_else(|| failed("Task is no longer active"))?;
            if !task.cancel_requested {
                if let Some(agent) = &task.agent_id {
                    s.agents
                        .iter_mut()
                        .find(|a| &a.id == agent)
                        .ok_or_else(|| failed("Task agent unavailable"))?
                        .push("cancel", id, "")?;
                } else {
                    task.state = "cancelled".into();
                }
                task.cancel_requested = true;
            }
            Ok(if task.state == "cancelled" {
                "Cancelled the queued task."
            } else {
                "Cancellation requested. Your agent has not confirmed stopping yet."
            }
            .into())
        })
    }
    pub async fn dispatch(&self, method: &str, params: Value, cancel: CancellationToken) -> DomainResult<Value> {
        match method {
            "coordinator.status" => encoded(self.status()),
            "coordinator.setup" | "coordinator.load" => {
                self.load(method == "coordinator.setup").await?;
                encoded(self.status())
            }
            "coordinator.unload" => {
                self.unload().await;
                encoded(self.status())
            }
            "coordinator.focus" => {
                let id = required(&params, "agentId", 128)?;
                self.change(|s| {
                    if !s.agents.iter().any(|a| a.id == id) {
                        return Err(failed("Unknown agent"));
                    }
                    s.active_agent = Some(id.clone());
                    for task in s.tasks.iter_mut().filter(|t| t.agent_id.is_none() && t.state == "queued") {
                        let a = s.agents.iter_mut().find(|a| a.id == id).unwrap();
                        a.push("task", &task.id, &task.text)?;
                        for correction in &task.corrections {
                            a.push("message", &task.id, correction)?;
                        }
                        task.agent_id = Some(id.clone());
                    }
                    Ok(json!({"agentId":id}))
                })
            }
            "coordinator.submit" => {
                let text = required(&params, "text", 8000)?;
                let agent = optional(&params, "agentId", 128)?;
                let request = optional(&params, "requestId", 128)?.unwrap_or_else(uuid);
                self.submit(&text, agent.as_deref(), &request, None)
            }
            "agent.register" => {
                let client = required(&params, "client", 64)?;
                let name = optional(&params, "name", 64)?.unwrap_or_else(|| client.clone());
                self.change(|s| {
                    if let Some(a) = s.agents.iter().find(|a| a.client == client) {
                        return Ok(a.info());
                    }
                    if s.agents.len() >= 32 {
                        return Err(failed("At most 32 agents may register"));
                    }
                    let agent = Agent {
                        id: format!("agent_{}", uuid()),
                        client,
                        name,
                        acked_seq: 0,
                        last_seq: 0,
                        events: vec![],
                    };
                    let info = agent.info();
                    s.agents.push(agent);
                    Ok(info)
                })
            }
            "agent.next" => {
                let id = required(&params, "agentId", 128)?;
                let timeout = params
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .filter(|n| *n <= 3_600_000)
                    .ok_or_else(|| failed("timeoutMs must be an integer between 0 and 3600000"))?;
                if let Some(seq) = params.get("after") {
                    let seq = seq.as_u64().ok_or_else(|| failed("after must be a nonnegative integer"))?;
                    self.change(|s| {
                        s.agents.iter_mut().find(|a| a.id == id).ok_or_else(|| failed("Unknown agent"))?.ack(seq)
                    })?;
                }
                let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
                loop {
                    let notified = self.inner.notify.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    let event = {
                        let s = self.inner.store.lock();
                        let Some(a) = s.agents.iter().find(|a| a.id == id) else {
                            return Ok(json!({"status":"stopped","reason":"Agent unregistered"}));
                        };
                        a.events.first().cloned()
                    };
                    if let Some(event) = event {
                        return Ok(json!({"status":"event","event":event}));
                    }
                    tokio::select! {_=cancel.cancelled()=>return Ok(json!({"status":"stopped","reason":"disconnected"})),_=tokio::time::sleep_until(deadline)=>return Ok(json!({"status":"timeout"})),_=notified=>{}}
                }
            }
            "agent.ack" => {
                let id = required(&params, "agentId", 128)?;
                let after = params
                    .get("after")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| failed("after must be a nonnegative integer"))?;
                self.change(|s| {
                    let a = s.agents.iter_mut().find(|a| a.id == id).ok_or_else(|| failed("Unknown agent"))?;
                    a.ack(after)?;
                    Ok(a.info())
                })
            }
            "agent.unregister" => {
                let id = required(&params, "agentId", 128)?;
                self.change(|s| {
                    if s.tasks.iter().any(|t| t.agent_id.as_deref() == Some(&id) && !terminal(&t.state)) {
                        return Err(failed("Finish or cancel this agent's tasks before unregistering"));
                    }
                    let index = s.agents.iter().position(|a| a.id == id).ok_or_else(|| failed("Unknown agent"))?;
                    if !s.agents[index].events.is_empty() {
                        return Err(failed("Acknowledge the remaining inbox events before unregistering"));
                    }
                    s.agents.remove(index);
                    if s.active_agent.as_ref() == Some(&id) {
                        s.active_agent = None;
                    }
                    Ok(json!({"unregistered":true}))
                })
            }
            "task.status" => {
                let id = optional(&params, "taskId", 128)?;
                let s = self.inner.store.lock();
                if let Some(id) = id {
                    encoded(s.tasks.iter().find(|t| t.id == id).ok_or_else(|| failed("Unknown task"))?)
                } else {
                    Ok(json!({"tasks":s.tasks,"pendingTurns":s.pending,"unroutedTurns":s.unrouted}))
                }
            }
            "task.update" => {
                let id = required(&params, "taskId", 128)?;
                let agent = required(&params, "agentId", 128)?;
                let state = required(&params, "state", 16)?;
                let summary = optional(&params, "summary", 8000)?;
                if !matches!(state.as_str(), "accepted" | "running" | "blocked" | "completed" | "failed" | "cancelled")
                {
                    return Err(failed("Invalid task state"));
                }
                let result = self.change(|s| {
                    let task = s
                        .tasks
                        .iter_mut()
                        .find(|t| t.id == id && t.agent_id.as_ref() == Some(&agent))
                        .ok_or_else(|| failed("Task is not assigned to this agent"))?;
                    if terminal(&task.state) && task.state != state {
                        return Err(failed("A finished task cannot change state"));
                    }
                    if task.state != "queued" && state == "accepted" && task.state != "accepted" {
                        return Err(failed("Task has already advanced beyond accepted"));
                    }
                    let changed = task.state != state || task.summary != summary;
                    task.state = state.clone();
                    task.summary = summary.clone();
                    Ok((encoded(task)?, changed))
                })?;
                if result.1 && self.enabled() && matches!(state.as_str(), "blocked" | "completed" | "failed") {
                    self.brief(self.task_brief(Some(&id)));
                }
                Ok(result.0)
            }
            _ => Err(failed("Unknown coordinator operation")),
        }
    }
}
