//! The talk loop: routing per turn, the tool executor, cancel confirmation,
//! helper fallback, briefings, the helper download and the app bridge.

mod support;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_audio::{ListenEvent as CaptureEvent, ListenState};
use delulu_core::{DomainError, DomainResult, RecordingSink};
use delulu_desktop::{ClipboardBackend, ClipboardSnapshot};
use delulu_domain::voice::{VoiceSource, VoiceSpeakRequest};
use delulu_domain::VoiceCoordinatorMode;
use delulu_voice::inbox::TaskState;
use delulu_voice::{
    BoxFuture, CaptureCommand, HelperInstall, HelperModel, HelperState, Talk, TalkPhase, TalkTurn, VoiceProfile,
    VoiceSystem, VoiceSystemConfig, VoiceTrayAction,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::{until, voice_fixture, FakeBackend, FakeTranscriber, VoiceFixture};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

/* Fakes */

struct FakeHelper {
    install: Mutex<HelperInstall>,
    decisions: Mutex<VecDeque<Value>>,
    /// `(text, context)` of every decide call.
    decided: Mutex<Vec<(String, Value)>>,
    /// `(call, result)` of every reply call; replies echo the result.
    replied: Mutex<Vec<(Value, String)>>,
    loads: Mutex<Vec<bool>>,
    unloads: AtomicUsize,
    /// When set, each decide call waits for a permit.
    hold: Mutex<Option<Arc<Semaphore>>>,
}

impl FakeHelper {
    fn new(installed: bool) -> Arc<Self> {
        Arc::new(Self {
            install: Mutex::new(HelperInstall { runtime: installed, weights: installed }),
            decisions: Mutex::new(VecDeque::new()),
            decided: Mutex::new(Vec::new()),
            replied: Mutex::new(Vec::new()),
            loads: Mutex::new(Vec::new()),
            unloads: AtomicUsize::new(0),
            hold: Mutex::new(None),
        })
    }
}

impl HelperModel for FakeHelper {
    fn load(&self, download: bool) -> BoxFuture<'_, DomainResult<()>> {
        self.loads.lock().push(download);
        if download {
            *self.install.lock() = HelperInstall { runtime: true, weights: true };
        }
        Box::pin(async { Ok(()) })
    }
    fn unload(&self) -> BoxFuture<'_, ()> {
        self.unloads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }
    fn installed(&self) -> BoxFuture<'_, HelperInstall> {
        let install = *self.install.lock();
        Box::pin(async move { install })
    }
    fn decide(&self, text: String, context: Value) -> BoxFuture<'_, DomainResult<Value>> {
        self.decided.lock().push((text, context));
        let next = self.decisions.lock().pop_front();
        let hold = self.hold.lock().clone();
        Box::pin(async move {
            if let Some(hold) = hold {
                hold.acquire().await.unwrap().forget();
            }
            next.ok_or_else(|| DomainError::failed("the helper worker exited"))
        })
    }
    fn reply(&self, _text: String, _context: Value, call: Value, result: String) -> BoxFuture<'_, DomainResult<Value>> {
        self.replied.lock().push((call, result.clone()));
        Box::pin(async move { Ok(json!({ "text": result, "elapsedMs": 3 })) })
    }
}

struct EmptyClipboard;

impl ClipboardBackend for EmptyClipboard {
    fn write_text(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn read(&self) -> Result<ClipboardSnapshot, String> {
        Ok(ClipboardSnapshot::default())
    }
}

struct Fixture {
    voice: VoiceFixture,
    system: VoiceSystem,
    sink: Arc<RecordingSink>,
    backend: Arc<FakeBackend>,
    transcriber: Arc<FakeTranscriber>,
    helper: Arc<FakeHelper>,
}

fn decision(tool: &str, args: Value) -> Value {
    json!({ "tool": tool, "args": args, "language": "en", "elapsedMs": 5 })
}

async fn fixture(helper_on: bool, installed: bool, autoplay: bool, bridge: bool) -> Fixture {
    let voice = voice_fixture(
        |settings| {
            settings.voice_coordinator_mode =
                if helper_on { VoiceCoordinatorMode::Lightweight } else { VoiceCoordinatorMode::Off };
            settings.voice_agent_bridge = bridge;
        },
        250.0,
        autoplay,
        true,
    );
    let sink = RecordingSink::new();
    let backend = Arc::new(FakeBackend::default());
    let transcriber = Arc::new(FakeTranscriber::default());
    let system = VoiceSystem::with_parts(
        VoiceSystemConfig {
            profile: voice.profile.clone(),
            transcriber: transcriber.clone(),
            sink: sink.clone(),
            clipboard: Arc::new(EmptyClipboard),
            app_version: "0.3.0".into(),
            on_tray_change: None,
        },
        voice.service.clone(),
        backend.clone(),
    );
    let helper = FakeHelper::new(installed);
    system.set_helper_model(helper.clone());
    system.start().await;
    Fixture { voice, system, sink, backend, transcriber, helper }
}

impl Fixture {
    fn talk(&self) -> &Talk {
        self.system.talk()
    }

    async fn agent(&self, name: &str) -> String {
        let params = json!({ "client": name.to_lowercase(), "name": name });
        let info = self.system.inbox().dispatch("agent.register", params, CancellationToken::new()).await.unwrap();
        info["id"].as_str().unwrap().to_owned()
    }

    /// The alias the helper sees for an agent right now.
    fn alias(&self, name: &str) -> String {
        let index = self.system.inbox().agents().iter().position(|agent| agent.name == name).unwrap();
        format!("agent_{}", index + 1)
    }

    fn decide(&self, value: Value) {
        self.helper.decisions.lock().push_back(value);
    }

    async fn inject(&self, text: &str) -> TalkTurn {
        self.talk().inject(text.into()).await.unwrap()
    }

    async fn next(&self, agent: &str, after: u64) -> Value {
        let params = json!({ "agentId": agent, "after": after, "timeoutMs": 0 });
        self.system.inbox().dispatch("agent.next", params, CancellationToken::new()).await.unwrap()
    }

    async fn update(&self, agent: &str, task: &str, state: &str, summary: &str) {
        let params = json!({ "agentId": agent, "taskId": task, "state": state, "summary": summary });
        self.system.inbox().dispatch("task.update", params, CancellationToken::new()).await.unwrap();
    }

    /// Talk on with the microphone listening.
    async fn start(&self) {
        let status = self.talk().start(false).await.unwrap();
        assert!(status.on, "{status:?}");
        let id = self.system.listening().get_status().session.unwrap().id;
        self.system
            .listening()
            .capture_event(&id, CaptureEvent::State { state: ListenState::Listening, message: None });
    }

    fn capture(&self, event: CaptureEvent) {
        let id = self.system.listening().get_status().session.unwrap().id;
        self.system.listening().capture_event(&id, event);
    }

    fn utterance(&self, text: &str) {
        self.transcriber.push(text);
        self.capture(CaptureEvent::Utterance {
            wav: vec![0; 64],
            duration_ms: 900,
            speech_ms: 700,
            overlapped_playback: false,
        });
    }

    /// Finished utterances as `(speaker, text)`, oldest first.
    async fn spoken(&self) -> Vec<(String, String)> {
        let service = self.voice.service.clone();
        until(move || !service.is_speaking(), "speech to finish").await;
        let mut recent: Vec<_> = self
            .voice
            .service
            .get_status()
            .recent
            .into_iter()
            .map(|item| (item.agent.unwrap_or_default(), item.text))
            .collect();
        recent.reverse();
        recent
    }

    fn open_tasks(&self) -> Vec<delulu_voice::inbox::Task> {
        self.system.inbox().open_tasks()
    }
}

/* Helper off */

#[tokio::test]
async fn helper_off_forwards_every_turn_verbatim_and_speaks_only_when_nobody_listens() {
    let f = fixture(false, false, true, false).await;
    let turn = f.inject("Draai de unit tests even.").await;
    assert_eq!(
        (turn.tool.as_deref(), turn.said.as_str(), turn.helper_ms),
        (Some("send_to_agent"), "Er luistert nu geen agent.", None)
    );
    assert!(f.open_tasks().is_empty());
    let agent = f.agent("Claude Code").await;
    let turn = f.inject("Run the unit tests, then fix what breaks.").await;
    assert_eq!(turn.said, "");
    let event = f.next(&agent, 0).await["event"].clone();
    assert_eq!(
        (event["type"].clone(), event["text"].clone()),
        (json!("task"), json!("Run the unit tests, then fix what breaks."))
    );
    // A second turn is a second task, never joined with the first.
    f.inject("Also update the changelog.").await;
    assert_eq!(f.open_tasks().len(), 2);
    assert!(f.helper.decided.lock().is_empty());
    assert_eq!(f.spoken().await, [("Delulu".to_owned(), "Er luistert nu geen agent.".to_owned())]);
    let status = f.talk().status();
    assert_eq!((status.helper.mode, status.helper.state), ("off", HelperState::Off));
    assert_eq!(status.turns.len(), 3);
}

#[tokio::test(start_paused = true)]
async fn an_agent_without_heartbeats_goes_away_and_the_user_hears_that_nobody_listens() {
    let f = fixture(false, false, true, false).await;
    let agent = f.agent("Claude Code").await;
    tokio::time::sleep(delulu_voice::inbox::AWAY_AFTER + Duration::from_secs(1)).await;
    assert!(!f.talk().status().agents[0].listening);
    let turn = f.inject("Run the tests.").await;
    assert_eq!(turn.said, "No agent is listening right now.");
    assert!(f.open_tasks().is_empty());
    assert_eq!(f.next(&agent, 0).await["status"], "timeout", "an away agent gets nothing");
}

/* Executor */

#[tokio::test]
async fn send_to_agent_creates_tasks_and_follow_ups_for_the_agent_the_helper_chose() {
    let f = fixture(true, true, true, false).await;
    let claude = f.agent("Claude Code").await;
    let codex = f.agent("Codex").await;
    f.decide(decision("send_to_agent", json!({ "agent": f.alias("Claude Code") })));
    let turn = f.inject("Run the unit tests.").await;
    assert_eq!((turn.said.as_str(), turn.tool.as_deref()), ("Sent to Claude Code.", Some("send_to_agent")));
    assert!(turn.helper_ms.is_some());
    let (text, context) = f.helper.decided.lock()[0].clone();
    assert_eq!(text, "Run the unit tests.");
    let labels: Vec<&str> =
        context["agents"].as_array().unwrap().iter().map(|a| a["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["Codex", "Claude Code"]);
    assert!(context["agents"][0]["id"].as_str().unwrap().starts_with("agent_"));
    assert_eq!(f.next(&claude, 0).await["event"]["text"], "Run the unit tests.");
    assert_eq!(f.next(&codex, 0).await["status"], "timeout");

    f.decide(decision("send_to_agent", json!({ "task": "task_1" })));
    let turn = f.inject("Only the fast ones.").await;
    assert_eq!(turn.said, "Passed it on to Claude Code.");
    let (_, context) = f.helper.decided.lock()[1].clone();
    assert_eq!(
        context["tasks"][0],
        json!({ "id": "task_1", "label": "Run the unit tests.", "agent": "Claude Code", "state": "queued" })
    );
    assert_eq!(
        context["recent"][0],
        json!({ "user": "Run the unit tests.", "tool": "send_to_agent", "said": "Sent to Claude Code.", "interrupted": false })
    );
    let event = f.next(&claude, 1).await["event"].clone();
    assert_eq!((event["type"].clone(), event["text"].clone()), (json!("message"), json!("Only the fast ones.")));
    let replied = f.helper.replied.lock().clone();
    assert_eq!(
        replied[1],
        (json!({ "tool": "send_to_agent", "args": { "task": "task_1" } }), "Passed it on to Claude Code.".to_owned())
    );
    assert_eq!(f.open_tasks().len(), 1);
}

#[tokio::test]
async fn status_reply_and_repeat_need_no_second_call_except_for_status() {
    let f = fixture(true, true, true, false).await;
    let agent = f.agent("Claude Code").await;
    f.decide(decision("task_status", json!({})));
    assert_eq!(f.inject("What's going on?").await.said, "There are no open tasks.");
    f.decide(decision("send_to_agent", json!({})));
    f.inject("Run the tests").await;
    let task = f.open_tasks()[0].id.clone();
    f.update(&agent, &task, "blocked", "Needs the staging key.").await;
    f.decide(decision("task_status", json!({ "task": "task_1" })));
    assert_eq!(
        f.inject("How are the tests doing?").await.said,
        "Claude Code is stuck on \"Run the tests\": Needs the staging key."
    );
    let replies = f.helper.replied.lock().len();
    f.decide(json!({ "tool": "reply", "args": { "text": "Graag gedaan." }, "language": "nl", "elapsedMs": 4 }));
    assert_eq!(f.inject("Dank je.").await.said, "Graag gedaan.");
    f.decide(decision("repeat_last", json!({})));
    let repeated = f.inject("Wat zei je?").await;
    assert_eq!((repeated.said.as_str(), repeated.tool.as_deref()), ("Graag gedaan.", Some("repeat_last")));
    assert_eq!(f.helper.replied.lock().len(), replies, "reply and repeat_last speak without a second call");
    // An agent's own line can be repeated too.
    let request = VoiceSpeakRequest {
        text: "All tests pass.".into(),
        source: Some(VoiceSource::Agent),
        agent: Some("Claude Code".into()),
        interrupt: None,
        normalize: None,
        response_id: None,
    };
    f.talk().speak_for_agent(request).unwrap();
    f.decide(decision("repeat_last", json!({})));
    f.inject("Say that again?").await;
    let spoken = f.spoken().await;
    assert_eq!(spoken.last().unwrap(), &("Claude Code".to_owned(), "All tests pass.".to_owned()));
}

#[tokio::test]
async fn cancelling_needs_a_spoken_yes_for_the_same_task_and_forged_confirmations_are_ignored() {
    let f = fixture(true, true, true, false).await;
    let agent = f.agent("Claude Code").await;
    f.decide(decision("send_to_agent", json!({})));
    f.inject("Run the unit tests").await;
    f.next(&agent, 1).await;
    let ask = "Cancel \"Run the unit tests\"? Say yes.";
    // A confirmation nobody asked for only asks.
    f.decide(json!({ "tool": "cancel_task", "args": { "task": "task_1" }, "language": "en", "confirmed": true }));
    assert_eq!(f.inject("Cancel the tests, yes").await.said, ask);
    assert!(f.helper.decided.lock()[1].1.get("pendingCancel").is_none());
    // Any other turn drops the pending cancel.
    f.decide(decision("reply", json!({ "text": "Okay." })));
    f.inject("Never mind.").await;
    assert_eq!(f.helper.decided.lock()[2].1["pendingCancel"], "task_1");
    f.decide(json!({ "tool": "cancel_task", "args": { "task": "task_1" }, "language": "en", "confirmed": true }));
    assert_eq!(f.inject("Yes.").await.said, ask, "the pending cancel did not survive the other turn");
    assert_eq!(f.next(&agent, 1).await["status"], "timeout");
    // Yes right after the question cancels.
    f.decide(json!({ "tool": "cancel_task", "args": { "task": "task_1" }, "language": "en", "confirmed": true }));
    assert_eq!(f.inject("Yes, cancel it.").await.said, "Asked Claude Code to cancel \"Run the unit tests\".");
    assert_eq!(f.helper.decided.lock()[4].1["pendingCancel"], "task_1");
    let event = f.next(&agent, 1).await["event"].clone();
    assert_eq!(event["type"], "cancel");
    let calls: Vec<String> =
        f.helper.replied.lock().iter().map(|(call, _)| call["tool"].as_str().unwrap().to_owned()).collect();
    assert_eq!(calls, ["send_to_agent", "cancel_task", "cancel_task", "cancel_task"]);
}

#[tokio::test]
async fn stop_speaking_and_stop_listening_act_on_speech_and_the_microphone() {
    let f = fixture(true, true, false, false).await;
    f.start().await;
    let request = VoiceSpeakRequest {
        text: "A long answer from the agent.".into(),
        source: Some(VoiceSource::Agent),
        agent: Some("Claude Code".into()),
        interrupt: None,
        normalize: None,
        response_id: None,
    };
    f.talk().speak_for_agent(request).unwrap();
    let service = f.voice.service.clone();
    until(move || service.is_speaking(), "speech").await;
    f.decide(decision("stop_speaking", json!({})));
    let turn = f.inject("Stop talking.").await;
    assert_eq!((turn.said.as_str(), turn.tool.as_deref()), ("", Some("stop_speaking")));
    assert!(!f.voice.service.is_speaking());
    assert!(f.talk().is_on());
    f.decide(decision("stop_listening", json!({})));
    f.inject("Stop listening.").await;
    assert!(!f.talk().is_on());
    assert!(matches!(f.backend.commands.lock().last(), Some(CaptureCommand::Stop { .. })));
    assert_eq!(f.helper.unloads.load(Ordering::SeqCst), 1, "stopping Talk unloads the helper");
    assert!(f.helper.replied.lock().is_empty());
}

/* Helper failures */

#[tokio::test]
async fn helper_output_outside_the_context_or_a_failed_call_forwards_the_words() {
    let f = fixture(true, true, true, false).await;
    let agent = f.agent("Claude Code").await;
    f.decide(decision("send_to_agent", json!({ "agent": "agent_9" })));
    let turn = f.inject("Fix the flaky test.").await;
    assert_eq!((turn.said.as_str(), turn.tool.as_deref()), ("", Some("send_to_agent")));
    assert!(turn.helper_ms.is_some());
    assert_eq!(f.talk().status().helper.state, HelperState::Failed);
    assert_eq!(f.next(&agent, 0).await["event"]["text"], "Fix the flaky test.");
    f.decide(decision("dance", json!({})));
    f.inject("And the slow one.").await;
    // No scripted decision: the worker call itself fails.
    f.inject("And the docs.").await;
    assert_eq!(f.open_tasks().len(), 3);
    f.decide(decision("reply", json!({ "text": "Sure." })));
    f.inject("Thanks.").await;
    assert_eq!(f.talk().status().helper.state, HelperState::Ready);
}

/* Routing */

#[tokio::test]
async fn two_quick_utterances_are_routed_one_at_a_time_in_order() {
    let f = fixture(true, true, true, false).await;
    f.agent("Claude Code").await;
    f.start().await;
    let hold = Arc::new(Semaphore::new(0));
    *f.helper.hold.lock() = Some(hold.clone());
    f.decide(decision("send_to_agent", json!({})));
    f.decide(decision("send_to_agent", json!({})));
    f.utterance("Fix the login bug.");
    f.utterance("Then update the changelog.");
    let helper = f.helper.clone();
    until(move || helper.decided.lock().len() == 1, "first decision").await;
    let talk = f.talk().clone();
    until(move || talk.status().phase == TalkPhase::Thinking, "thinking").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(f.helper.decided.lock().len(), 1, "the second turn waits for the first");
    hold.add_permits(2);
    let helper = f.helper.clone();
    until(move || helper.decided.lock().len() == 2, "second decision").await;
    let texts: Vec<String> = f.helper.decided.lock().iter().map(|(text, _)| text.clone()).collect();
    assert_eq!(texts, ["Fix the login bug.", "Then update the changelog."]);
    let talk = f.talk().clone();
    until(move || talk.status().turns.len() == 2, "both turns").await;
    let mut tasks: Vec<String> = f.open_tasks().into_iter().map(|task| task.text).collect();
    tasks.sort();
    assert_eq!(tasks, ["Fix the login bug.", "Then update the changelog."]);
    assert!(
        f.voice.dir.path().join("voice/pending-audio").read_dir().unwrap().next().is_none(),
        "handled recordings are gone"
    );
}

/* Speech and briefings */

#[tokio::test]
async fn delulu_never_interrupts_and_briefings_wait_for_a_pause_as_one_line() {
    let f = fixture(false, false, false, false).await;
    let agent = f.agent("Claude Code").await;
    f.start().await;
    f.inject("Run the tests").await;
    f.inject("Write the docs").await;
    let tasks = f.open_tasks();
    let speak = |text: &str| VoiceSpeakRequest {
        text: text.into(),
        source: Some(VoiceSource::Agent),
        agent: Some("Claude Code".into()),
        interrupt: Some(true),
        normalize: None,
        response_id: None,
    };
    f.talk().speak_for_agent(speak("Here is what I found.")).unwrap();
    let service = f.voice.service.clone();
    until(move || service.is_speaking(), "agent speech").await;
    // While Talk is on, an agent's interrupt flag is ignored.
    f.talk().speak_for_agent(speak("And one more thing.")).unwrap();
    assert_eq!(f.voice.service.get_status().queued, 1);
    f.update(&agent, &tasks[1].id, "completed", "All 212 pass.").await;
    f.update(&agent, &tasks[0].id, "blocked", "Needs a key.").await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(f.voice.playback.stops.lock().is_empty(), "nothing was cut off");
    let current = f.voice.service.get_status().current.unwrap();
    assert_eq!(current.agent.as_deref(), Some("Claude Code"));
    // The user starts talking as speech ends: the briefing keeps waiting.
    f.capture(CaptureEvent::SpeechStart { during_playback: false });
    f.voice.service.stop("test");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!f.voice.service.is_speaking());
    f.capture(CaptureEvent::Discarded { reason: "short".into() });
    let service = f.voice.service.clone();
    until(move || service.get_status().current.is_some_and(|c| c.agent.as_deref() == Some("Delulu")), "briefing").await;
    assert_eq!(
        f.voice.service.get_status().current.unwrap().text,
        "Claude Code finished \"Run the tests\": All 212 pass. Claude Code is stuck on \"Write the docs\": Needs a key."
    );
    assert_eq!(f.voice.playback.stops.lock().len(), 1, "only the test stopped speech");
    // Updates that are not completed, blocked or failed are not briefed.
    f.voice.service.stop("test");
    f.update(&agent, &tasks[0].id, "running", "Retrying.").await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!f.voice.service.is_speaking());
    let state = f.system.inbox().task(&tasks[0].id).unwrap().state;
    assert_eq!(state, TaskState::Running);
}

#[tokio::test]
async fn levels_reach_the_renderer_and_barge_in_marks_the_interrupted_line() {
    let f = fixture(true, true, false, false).await;
    f.start().await;
    f.capture(CaptureEvent::Level { db: -30.5 });
    assert_eq!(f.sink.channel("talk:level"), [json!({ "db": -30.5 })]);
    f.decide(decision("reply", json!({ "text": "Here is a long answer about the build." })));
    f.inject("Tell me about the build.").await;
    let service = f.voice.service.clone();
    until(move || service.is_speaking(), "Delulu speaking").await;
    f.capture(CaptureEvent::BargeIn { utterance_ids: Vec::new() });
    f.decide(decision("reply", json!({ "text": "Okay." })));
    f.inject("Wait.").await;
    let (_, context) = f.helper.decided.lock()[1].clone();
    assert_eq!(context["recent"][0]["interrupted"], true);
    assert!(f.sink.channel("talk:statusChanged").iter().any(|status| status["phase"] == "speaking"));
}

/* Starting */

#[tokio::test]
async fn starting_asks_for_the_download_once_then_loads_cached_files() {
    let f = fixture(true, false, true, false).await;
    assert_eq!(f.talk().status().helper.state, HelperState::Missing);
    let status = f.talk().start(false).await.unwrap();
    assert!(!status.on && status.needs_download);
    assert_eq!((status.phase, status.download_size), (TalkPhase::Off, "~1.7 GB"));
    assert!(f.backend.commands.lock().is_empty(), "the microphone stays closed");
    assert!(f.helper.loads.lock().is_empty());
    let status = f.talk().start(true).await.unwrap();
    assert!(status.on && !status.needs_download);
    assert_eq!(status.helper.state, HelperState::Ready);
    assert!(f.sink.channel("talk:statusChanged").iter().any(|status| status["phase"] == "downloading"));
    assert!(matches!(f.backend.commands.lock()[0], CaptureCommand::Start { .. }));
    let stopped = f.talk().stop("Stopped").await;
    assert_eq!((stopped.on, stopped.helper.state), (false, HelperState::Installed));
    f.talk().start(false).await.unwrap();
    assert_eq!(*f.helper.loads.lock(), [true, false]);
    // Turning the helper off while talking unloads it and keeps the microphone.
    let previous = f.voice.profile.settings();
    f.voice.profile.set(|settings| settings.voice_coordinator_mode = VoiceCoordinatorMode::Off);
    f.system.settings_changed(&previous, &f.voice.profile.settings()).await;
    let status = f.talk().status();
    assert!(status.on);
    assert_eq!((status.helper.mode, status.helper.state), ("off", HelperState::Off));
    assert_eq!(f.helper.unloads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn choosing_the_helper_while_talking_offers_the_download_without_closing_the_microphone() {
    let f = fixture(false, false, true, false).await;
    f.start().await;
    let previous = f.voice.profile.settings();
    f.voice.profile.set(|settings| settings.voice_coordinator_mode = VoiceCoordinatorMode::Lightweight);
    f.system.settings_changed(&previous, &f.voice.profile.settings()).await;
    let talk = f.talk().clone();
    until(move || talk.status().needs_download, "download offer").await;
    let status = f.talk().status();
    assert!(status.on && status.helper.state == HelperState::Missing);
    let status = f.talk().start(true).await.unwrap();
    assert!(status.on && !status.needs_download);
    assert_eq!(status.helper.state, HelperState::Ready);
    assert_eq!(*f.helper.loads.lock(), [true]);
    let starts = f.backend.commands.lock().iter().filter(|c| matches!(c, CaptureCommand::Start { .. })).count();
    assert_eq!(starts, 1, "the microphone stayed open");
}

/* End to end */

#[tokio::test]
async fn an_agent_gets_spoken_turns_through_the_app_bridge_and_the_tray_stops_talk() {
    let f = fixture(false, false, true, true).await;
    let bridge = f.voice.dir.path().join("voice").join("bridge.json");
    let call = move |method: &'static str, params: Value| {
        let bridge = bridge.clone();
        async move { delulu_voice::client::call(&bridge, method, params, Duration::from_secs(5), None).await.unwrap() }
    };
    let agent = call("agent.register", json!({ "client": "claude-code", "name": "Claude Code" })).await;
    let id = agent["id"].as_str().unwrap().to_owned();
    f.start().await;
    let waiter = {
        let call = call.clone();
        let id = id.clone();
        tokio::spawn(async move { call("agent.next", json!({ "agentId": id, "timeoutMs": 5000 })).await })
    };
    f.utterance("Can you run the unit tests?");
    let event = waiter.await.unwrap();
    assert_eq!(event["event"]["text"], "Can you run the unit tests?");
    let status = call("talk.status", json!({})).await;
    assert_eq!(status["agents"][0]["name"], "Claude Code");
    assert_eq!(status["turns"][0]["user"], "Can you run the unit tests?");
    let spoken = call("speak", json!({ "text": "Running them now.", "agent": "Claude Code", "wait": true })).await;
    assert_eq!(spoken["outcome"], "spoken");
    let injected = call("talk.inject", json!({ "text": "And the integration tests." })).await;
    assert_eq!(injected["tool"], "send_to_agent");
    let items = f.system.tray_items(&f.voice.profile.settings());
    assert_eq!(items[0].action, VoiceTrayAction::StopListening);
    f.system.tray_action(VoiceTrayAction::StopListening).await;
    assert!(!f.talk().is_on());
    assert!(!f.system.listening().active());
    f.system.shutdown().await;
}
