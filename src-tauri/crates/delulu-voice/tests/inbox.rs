//! The durable agent inbox: per-session ids, liveness, storage and bounds.

use std::time::Duration;

use delulu_voice::inbox::{Cancel, Inbox, Sent, TaskState, AWAY_AFTER, COMPACT_AFTER, MAX_AGENTS, MAX_REQUESTS};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

async fn call(inbox: &Inbox, method: &str, params: Value) -> Value {
    inbox.dispatch(method, params, CancellationToken::new()).await.unwrap()
}

async fn register(inbox: &Inbox, client: &str) -> String {
    call(inbox, "agent.register", json!({ "client": client, "name": client })).await["id"].as_str().unwrap().to_owned()
}

fn task_id(sent: &Sent) -> String {
    match sent {
        Sent::Task { task, .. } | Sent::Message { task, .. } => task.id.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn every_session_gets_its_own_inbox_even_for_the_same_client() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let first = register(&inbox, "claude-code").await;
    let second = register(&inbox, "claude-code").await;
    assert_ne!(first, second);
    let sent = inbox.submit("Run the tests", Some(&first), "req-1").unwrap();
    assert!(matches!(&sent, Sent::Task { agent, .. } if agent.id == first));
    let other = call(&inbox, "agent.next", json!({ "agentId": second, "timeoutMs": 0 })).await;
    assert_eq!(other["status"], "timeout", "the other session never sees that task");
    let mine = call(&inbox, "agent.next", json!({ "agentId": first, "timeoutMs": 0 })).await;
    assert_eq!(mine["event"]["text"], "Run the tests");
}

#[tokio::test(start_paused = true)]
async fn agents_without_a_call_go_away_and_get_no_new_work_but_a_waiter_keeps_listening() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let quiet = register(&inbox, "codex").await;
    let waiting = register(&inbox, "claude-code").await;
    let waiter = {
        let inbox = inbox.clone();
        let id = waiting.clone();
        tokio::spawn(async move { call(&inbox, "agent.next", json!({ "agentId": id, "timeoutMs": 600_000 })).await })
    };
    tokio::time::sleep(AWAY_AFTER + Duration::from_secs(1)).await;
    let agents = inbox.agents();
    let listening = |id: &str| agents.iter().find(|agent| agent.id == id).unwrap().listening;
    assert!(!listening(&quiet));
    assert!(listening(&waiting));
    assert!(matches!(inbox.submit("Deploy", Some(&quiet), "req-1").unwrap(), Sent::NoListener { agent: Some(_) }));
    // Unnamed work goes to the agent that is still listening.
    let sent = inbox.submit("Deploy", None, "req-2").unwrap();
    assert!(matches!(&sent, Sent::Task { agent, .. } if agent.id == waiting));
    assert_eq!(waiter.await.unwrap()["event"]["text"], "Deploy");
    tokio::time::sleep(AWAY_AFTER + Duration::from_secs(1)).await;
    assert!(matches!(inbox.submit("More", None, "req-3").unwrap(), Sent::NoListener { agent: None }));
}

#[tokio::test]
async fn the_log_replays_after_reopening_and_heartbeats_are_not_stored() {
    let dir = tempfile::tempdir().unwrap();
    let (agent, task) = {
        let inbox = Inbox::open(dir.path().to_path_buf());
        let agent = register(&inbox, "claude-code").await;
        let task = task_id(&inbox.submit("Run the tests", None, "req-1").unwrap());
        inbox.follow_up(&task, "Only the unit tests", "req-2").unwrap();
        call(&inbox, "agent.next", json!({ "agentId": agent, "after": 1, "timeoutMs": 0 })).await;
        call(
            &inbox,
            "task.update",
            json!({ "agentId": agent, "taskId": task, "state": "blocked", "summary": "Needs a key." }),
        )
        .await;
        (agent, task)
    };
    let reopened = Inbox::open(dir.path().to_path_buf());
    let saved = reopened.task(&task).unwrap();
    assert_eq!((saved.state, saved.summary.as_deref(), saved.messages), (TaskState::Blocked, Some("Needs a key."), 1));
    let agents = reopened.agents();
    assert_eq!(agents.len(), 1);
    assert!(!agents[0].listening, "liveness starts over after a restart");
    // The unacknowledged follow-up is still waiting after the acknowledged task.
    let next = call(&reopened, "agent.next", json!({ "agentId": agent, "timeoutMs": 0 })).await;
    assert_eq!((next["event"]["seq"].clone(), next["event"]["type"].clone()), (json!(2), json!("message")));
    // A repeated request returns the same task instead of a duplicate.
    assert_eq!(task_id(&reopened.submit("Run the tests", None, "req-1").unwrap()), task);
    assert!(!dir.path().join("inbox.json").exists(), "nothing rewrote the snapshot");
}

#[tokio::test]
async fn work_is_synced_but_acknowledgments_and_updates_are_only_appended() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let agent = register(&inbox, "claude-code").await;
    let task = task_id(&inbox.submit("Run the tests", None, "req-1").unwrap());
    let before = inbox.log_stats();
    assert_eq!((before.lines, before.syncs), (2, 2));
    call(&inbox, "agent.ack", json!({ "agentId": agent, "after": 1 })).await;
    call(&inbox, "task.update", json!({ "agentId": agent, "taskId": task, "state": "running" })).await;
    for _ in 0..5 {
        // Heartbeats and repeated acknowledgments write nothing.
        call(&inbox, "agent.next", json!({ "agentId": agent, "after": 1, "timeoutMs": 0 })).await;
    }
    let after = inbox.log_stats();
    assert_eq!((after.lines, after.syncs), (4, 2));
}

#[tokio::test]
async fn the_log_is_compacted_and_dedupe_keeps_only_bounded_hashes() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let agent = register(&inbox, "claude-code").await;
    let mut seq = 0;
    let mut last = String::new();
    // Three log lines per round: well past one compaction.
    let rounds = COMPACT_AFTER / 3 + 10;
    for index in 0..rounds {
        last = task_id(&inbox.submit(&format!("Private task text {index}"), None, &format!("req-{index}")).unwrap());
        seq += 1;
        call(&inbox, "agent.ack", json!({ "agentId": agent, "after": seq })).await;
        call(&inbox, "task.update", json!({ "agentId": agent, "taskId": last, "state": "completed" })).await;
    }
    let stats = inbox.log_stats();
    assert!(stats.lines < COMPACT_AFTER, "compacted: {} lines", stats.lines);
    let snapshot: Value = serde_json::from_slice(&std::fs::read(dir.path().join("inbox.json")).unwrap()).unwrap();
    let requests = snapshot["requests"].as_array().unwrap();
    assert!(requests.len() <= MAX_REQUESTS);
    assert!(requests
        .iter()
        .all(|request| request.get("text").is_none() && request["hash"].as_str().unwrap().len() == 16));
    // The oldest request id has been forgotten; a reused id makes new work.
    assert!(matches!(inbox.submit("Private task text 0", None, "req-0").unwrap(), Sent::Task { .. }));
    assert!(inbox.submit("Different words", None, &format!("req-{}", rounds - 1)).is_err());
    let reopened = Inbox::open(dir.path().to_path_buf());
    assert_eq!(reopened.task(&last).unwrap().state, TaskState::Completed);
}

#[tokio::test]
async fn a_torn_last_log_line_is_dropped_and_the_log_compacted() {
    let dir = tempfile::tempdir().unwrap();
    let task = {
        let inbox = Inbox::open(dir.path().to_path_buf());
        register(&inbox, "claude-code").await;
        task_id(&inbox.submit("Run the tests", None, "req-1").unwrap())
    };
    let log = dir.path().join("inbox.log");
    let mut bytes = std::fs::read(&log).unwrap();
    bytes.extend_from_slice(br#"{"n":3,"op":"upd"#);
    std::fs::write(&log, bytes).unwrap();
    let reopened = Inbox::open(dir.path().to_path_buf());
    assert!(reopened.task(&task).is_some());
    assert_eq!(std::fs::read(&log).unwrap().len(), 0);
    register(&reopened, "codex").await;
    assert_eq!(Inbox::open(dir.path().to_path_buf()).agents().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn registering_beyond_the_limit_forgets_the_longest_away_agent_without_work() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let busy = register(&inbox, "busy").await;
    inbox.submit("Keep me", Some(&busy), "req-1").unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let idle = register(&inbox, "idle").await;
    for index in 2..MAX_AGENTS {
        tokio::time::sleep(Duration::from_secs(1)).await;
        register(&inbox, &format!("agent-{index}")).await;
    }
    tokio::time::sleep(AWAY_AFTER * 2).await;
    register(&inbox, "newcomer").await;
    let ids: Vec<String> = inbox.agents().into_iter().map(|agent| agent.id).collect();
    assert_eq!(ids.len(), MAX_AGENTS);
    assert!(ids.contains(&busy), "an agent with open work is kept");
    assert!(!ids.contains(&idle));
}

#[tokio::test]
async fn cancelling_asks_a_listening_agent_and_closes_work_of_an_unregistered_one() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = Inbox::open(dir.path().to_path_buf());
    let agent = register(&inbox, "claude-code").await;
    let task = task_id(&inbox.submit("Run the tests", None, "req-1").unwrap());
    assert!(matches!(inbox.cancel(&task).unwrap(), Cancel::Requested { .. }));
    let next = call(&inbox, "agent.next", json!({ "agentId": agent, "after": 1, "timeoutMs": 0 })).await;
    assert_eq!((next["event"]["type"].clone(), next["event"]["taskId"].clone()), (json!("cancel"), json!(task)));
    assert_eq!(inbox.task(&task).unwrap().state, TaskState::Queued, "only the agent reports it stopped");
    call(&inbox, "task.update", json!({ "agentId": agent, "taskId": task, "state": "cancelled" })).await;
    assert!(matches!(inbox.cancel(&task).unwrap(), Cancel::Finished { .. }));

    let other = task_id(&inbox.submit("Write the docs", None, "req-2").unwrap());
    call(&inbox, "agent.unregister", json!({ "agentId": agent })).await;
    assert_eq!(inbox.task(&other).unwrap().state, TaskState::Failed, "a session that ends closes its work");
    let gone = call(&inbox, "agent.next", json!({ "agentId": agent, "timeoutMs": 0 })).await;
    assert_eq!(gone["status"], "stopped");
}
