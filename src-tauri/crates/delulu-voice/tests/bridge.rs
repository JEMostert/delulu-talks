//! Port of `electron/services/voiceBridge.test.ts` (Unix socket transport).
#![cfg(unix)]

mod support;

use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::DomainError;
use delulu_domain::voice::{VoiceSource, VoiceSpeakRequest, VOICE_AGENT_INSTRUCTIONS};
use delulu_voice::{BridgeError, BridgeErrorCode, SpeakReply, VoiceBridge};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::{snapshot, started_bridge, started_bridge_in, until, TestHandlers};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::oneshot;

/// A line-oriented client that collects responses by id.
struct Client {
    writer: OwnedWriteHalf,
    lines: Arc<Mutex<Vec<Value>>>,
    closed: Arc<Mutex<bool>>,
}

impl Client {
    async fn connect(endpoint: &str) -> Self {
        let (reader, writer) = UnixStream::connect(endpoint).await.unwrap().into_split();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(Mutex::new(false));
        let (sink, done) = (lines.clone(), closed.clone());
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                sink.lock().push(serde_json::from_str::<Value>(&line).unwrap());
            }
            *done.lock() = true;
        });
        Self { writer, lines, closed }
    }

    async fn send(&mut self, value: Value) {
        self.raw(&format!("{value}\n")).await;
    }

    async fn raw(&mut self, text: &str) {
        let _ = self.writer.write_all(text.as_bytes()).await;
    }

    async fn next_where(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..1000 {
            {
                let mut lines = self.lines.lock();
                if let Some(index) = lines.iter().position(&predicate) {
                    return lines.remove(index);
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no matching line");
    }

    async fn response(&self, id: &str) -> Value {
        self.next_where(|line| line["id"] == id).await
    }

    async fn closed(&self) {
        let closed = self.closed.clone();
        until(move || *closed.lock(), "connection close").await;
    }
}

async fn request(client: &mut Client, token: &str, id: &str, method: &str, params: Value) -> Value {
    client.send(json!({ "v": 1, "id": id, "token": token, "method": method, "params": params })).await;
    client.response(id).await
}

fn mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn bridge_json_is_private_published_after_listening_and_removed_on_stop() {
    let b = started_bridge("9.9.9").await;
    let path = b.bridge_file();
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(&b.root.path().join("voice")), 0o700);
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["protocol"], 1);
    assert_eq!(file["appVersion"], "9.9.9");
    assert!(b.token.len() == 64 && b.token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(b.endpoint, b.root.path().join("voice").join("agent.sock").to_string_lossy());
    assert!(std::fs::symlink_metadata(&b.endpoint).unwrap().file_type().is_socket());
    assert_eq!(mode(std::path::Path::new(&b.endpoint)), 0o600);
    let status = b.bridge.status();
    assert!(status.enabled && status.listening && status.clients == 0 && status.error.is_none());
    assert_eq!(status.endpoint.as_deref(), Some(b.endpoint.as_str()));
    b.bridge.start().await.unwrap();
    let again: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(again["token"], b.token.as_str());
    b.bridge.stop().await;
    assert!(!path.exists());
    assert!(!std::path::Path::new(&b.endpoint).exists());
    let status = b.bridge.status();
    assert!(!status.enabled && !status.listening && status.endpoint.is_none() && status.error.is_none());
    assert!(!b.statuses.lock().last().unwrap().listening);
}

#[tokio::test]
async fn each_start_issues_a_new_token() {
    let b = started_bridge("1").await;
    b.bridge.stop().await;
    b.bridge.start().await.unwrap();
    let next: Value = serde_json::from_str(&std::fs::read_to_string(b.bridge_file()).unwrap()).unwrap();
    assert_ne!(next["token"], b.token.as_str());
    b.bridge.stop().await;
}

#[tokio::test]
async fn requests_without_the_current_token_are_refused() {
    let b = started_bridge("1").await;
    let mut agent = Client::connect(&b.endpoint).await;
    agent.send(json!({ "v": 1, "id": "a", "method": "speak", "params": { "text": "Hi" } })).await;
    agent.send(json!({ "v": 1, "id": "b", "token": "0".repeat(64), "method": "speak", "params": { "text": "Hi" } })).await;
    agent.send(json!({ "v": 1, "id": "c", "token": 42, "method": "status" })).await;
    for id in ["a", "b", "c"] {
        assert_eq!(agent.response(id).await["error"]["code"], "UNAUTHORIZED");
    }
    assert!(b.handlers.speak_calls.lock().is_empty());
    b.bridge.stop().await;
}

#[tokio::test]
async fn hello_speak_stop_and_status_round_trip() {
    let b = started_bridge("9.9.9").await;
    let mut agent = Client::connect(&b.endpoint).await;
    let hello = request(&mut agent, &b.token, "h", "hello", json!({})).await;
    assert_eq!(
        hello,
        json!({
            "v": 1, "id": "h", "ok": true,
            "result": {
                "app": "delulu-talks", "appVersion": "9.9.9", "protocol": 1,
                "instructions": VOICE_AGENT_INSTRUCTIONS,
                "status": serde_json::to_value(snapshot()).unwrap(),
            },
        })
    );
    let queued = request(&mut agent, &b.token, "q", "speak", json!({ "text": "Done. [laugh]", "agent": "  Claude Code  " })).await;
    assert_eq!(queued["result"], json!({ "id": "u1", "responseId": "r1", "position": 1 }));
    let waited = request(
        &mut agent,
        &b.token,
        "w",
        "speak",
        json!({ "text": "Done.", "wait": true, "interrupt": true, "normalize": false }),
    )
    .await;
    assert_eq!(waited["result"]["outcome"], "spoken");
    assert_eq!(waited["result"]["durationMs"], 4200);
    let base = VoiceSpeakRequest {
        text: "Done. [laugh]".into(),
        source: Some(VoiceSource::Agent),
        agent: Some("Claude Code".into()),
        interrupt: None,
        normalize: None,
        response_id: None,
    };
    assert_eq!(
        *b.handlers.speak_calls.lock(),
        vec![
            (base.clone(), false),
            (
                VoiceSpeakRequest {
                    text: "Done.".into(),
                    agent: Some("Agent".into()),
                    interrupt: Some(true),
                    normalize: Some(false),
                    ..base
                },
                true
            ),
        ]
    );
    assert_eq!(request(&mut agent, &b.token, "s", "stop", json!({})).await["result"], json!({ "stopped": true }));
    assert_eq!(b.handlers.stops.load(std::sync::atomic::Ordering::SeqCst), 1);
    let status = request(&mut agent, &b.token, "t", "status", json!({})).await;
    assert_eq!(status["result"], serde_json::to_value(snapshot()).unwrap());
    b.bridge.stop().await;
}

#[tokio::test]
async fn invalid_requests_get_specific_errors_without_reaching_handlers() {
    let b = started_bridge("1").await;
    let mut agent = Client::connect(&b.endpoint).await;
    let token = b.token.clone();
    agent.raw("{not json\n").await;
    assert_eq!(
        agent.next_where(|_| true).await["error"],
        json!({ "code": "INVALID_REQUEST", "message": "Request is not valid JSON." })
    );
    agent.send(json!({ "v": 2, "id": "v", "token": token, "method": "status" })).await;
    assert_eq!(agent.response("v").await["error"]["code"], "INVALID_REQUEST");
    agent.send(json!({ "v": 1, "id": "x".repeat(129), "token": token, "method": "status" })).await;
    assert_eq!(agent.next_where(|line| line["id"].is_null()).await["error"]["code"], "INVALID_REQUEST");
    let send = |id: &str, method: &str, params: Value| json!({ "v": 1, "id": id, "token": token, "method": method, "params": params });
    agent.send(send("m", "dance", json!({}))).await;
    assert_eq!(agent.response("m").await["error"]["message"], "Unknown method: dance");
    agent.send(send("p", "speak", json!(["Hi"]))).await;
    assert_eq!(agent.response("p").await["error"]["code"], "INVALID_REQUEST");
    agent.send(send("e", "speak", json!({ "text": "   " }))).await;
    assert_eq!(agent.response("e").await["error"]["code"], "INVALID_REQUEST");
    agent.send(send("l", "speak", json!({ "text": "a".repeat(15_001) }))).await;
    assert!(agent.response("l").await["error"]["message"].as_str().unwrap().contains("15,000"));
    agent.send(send("b", "speak", json!({ "text": "Hi", "wait": "yes" }))).await;
    assert_eq!(agent.response("b").await["error"]["message"], "wait must be a boolean");
    agent.send(send("g", "speak", json!({ "text": "Hi", "agent": 7 }))).await;
    assert_eq!(agent.response("g").await["error"]["code"], "INVALID_REQUEST");
    assert!(b.handlers.speak_calls.lock().is_empty());
    // The connection survives malformed input.
    agent.send(send("ok", "status", json!({}))).await;
    assert_eq!(agent.response("ok").await["ok"], true);
    b.bridge.stop().await;
}

#[tokio::test]
async fn handler_refusals_reach_the_agent_as_voice_unavailable() {
    let handlers = TestHandlers::new();
    *handlers.speak.lock() = Some(Arc::new(|_, _| {
        Box::pin(async { Err(DomainError::failed("Voice is turned off in Delulu Talks.").into()) })
    }));
    *handlers.stop_error.lock() = Some(BridgeError::new(BridgeErrorCode::InvalidRequest, "Nothing to stop."));
    let b = started_bridge_in(tempfile::tempdir().unwrap(), "1", handlers).await;
    let mut agent = Client::connect(&b.endpoint).await;
    let speak = request(&mut agent, &b.token, "s", "speak", json!({ "text": "Hi" })).await;
    assert_eq!(speak["error"], json!({ "code": "VOICE_UNAVAILABLE", "message": "Voice is turned off in Delulu Talks." }));
    assert_eq!(request(&mut agent, &b.token, "t", "stop", json!({})).await["error"]["code"], "INVALID_REQUEST");
    b.bridge.stop().await;
}

#[tokio::test]
async fn responses_may_complete_out_of_order_and_in_flight_requests_are_capped() {
    let handlers = TestHandlers::new();
    type Releases = Arc<Mutex<Vec<(String, oneshot::Sender<()>)>>>;
    let releases: Releases = Arc::new(Mutex::new(Vec::new()));
    let held = releases.clone();
    *handlers.speak.lock() = Some(Arc::new(move |request: VoiceSpeakRequest, _| {
        let (release, wait) = oneshot::channel();
        held.lock().push((request.text.clone(), release));
        Box::pin(async move {
            let _ = wait.await;
            Ok(SpeakReply::Queued(
                serde_json::from_value(json!({ "id": request.text, "responseId": "r1", "position": request.text.parse::<u64>().unwrap() }))
                    .unwrap(),
            ))
        })
    }));
    let b = started_bridge_in(tempfile::tempdir().unwrap(), "1", handlers).await;
    let mut agent = Client::connect(&b.endpoint).await;
    for id in ["1", "2", "3", "4", "5"] {
        agent.send(json!({ "v": 1, "id": id, "token": b.token, "method": "speak", "params": { "text": id } })).await;
    }
    assert!(agent.response("5").await["error"]["message"].as_str().unwrap().contains("At most 4"));
    until(|| releases.lock().len() == 4, "four handlers").await;
    let release = |text: &str| {
        let mut held = releases.lock();
        let index = held.iter().position(|(id, _)| id == text).unwrap();
        let _ = held.remove(index).1.send(());
    };
    release("4");
    assert_eq!(agent.response("4").await["result"], json!({ "id": "4", "responseId": "r1", "position": 4 }));
    release("1");
    assert_eq!(agent.response("1").await["result"]["position"], 1);
    release("2");
    release("3");
    agent.response("2").await;
    agent.response("3").await;
    b.bridge.stop().await;
}

#[tokio::test]
async fn an_oversized_request_line_closes_the_connection_with_an_error() {
    let b = started_bridge("1").await;
    let mut agent = Client::connect(&b.endpoint).await;
    agent.raw(&"x".repeat(256 * 1024 + 10)).await;
    let line = agent.next_where(|_| true).await;
    assert_eq!((line["id"].clone(), line["ok"].clone()), (Value::Null, Value::Bool(false)));
    assert!(line["error"]["message"].as_str().unwrap().contains("256 KiB"));
    agent.closed().await;
    b.bridge.stop().await;
}

#[tokio::test]
async fn connections_beyond_the_cap_are_refused_and_counted_clients_update() {
    let b = started_bridge("1").await;
    let mut agents = Vec::new();
    for _ in 0..16 {
        agents.push(Client::connect(&b.endpoint).await);
    }
    until(|| b.bridge.status().clients == 16, "16 clients").await;
    let extra = Client::connect(&b.endpoint).await;
    assert!(extra.next_where(|_| true).await["error"]["message"].as_str().unwrap().contains("Too many"));
    extra.closed().await;
    assert_eq!(b.bridge.status().clients, 16);
    assert!(b.statuses.lock().iter().any(|status| status.clients == 16));
    drop(agents);
    until(|| b.bridge.status().clients == 0, "clients to leave").await;
    b.bridge.stop().await;
}

#[tokio::test]
async fn stop_destroys_open_connections() {
    let b = started_bridge("1").await;
    let agent = Client::connect(&b.endpoint).await;
    until(|| b.bridge.status().clients == 1, "client").await;
    b.bridge.stop().await;
    agent.closed().await;
}

#[tokio::test]
async fn a_stale_socket_is_replaced_but_a_live_one_or_a_regular_file_is_not() {
    let root = tempfile::tempdir().unwrap();
    let voice = root.path().join("voice");
    std::fs::create_dir(&voice).unwrap();
    let socket = voice.join("agent.sock");
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    assert!(std::fs::symlink_metadata(&socket).unwrap().file_type().is_socket());
    let b = started_bridge_in(root, "1", TestHandlers::new()).await;
    assert!(b.bridge.status().listening);

    let second = VoiceBridge::new(voice.clone(), "1", TestHandlers::new(), |_| {});
    let error = second.start().await.unwrap_err();
    assert!(error.contains("Another Delulu Talks"));
    let status = second.status();
    assert!(!status.listening && status.enabled);
    assert!(status.error.unwrap().contains("Another Delulu Talks"));
    b.bridge.stop().await;

    std::fs::write(&socket, "not a socket").unwrap();
    let third = VoiceBridge::new(voice.clone(), "1", TestHandlers::new(), |_| {});
    assert!(third.start().await.unwrap_err().contains("is not a socket"));
    assert_eq!(std::fs::read_to_string(&socket).unwrap(), "not a socket");
}

#[tokio::test]
async fn listening_sessions_deliver_events_after_the_cursor_until_acknowledged() {
    let b = started_bridge("1").await;
    let listen = &b.handlers.listen;
    let mut agent = Client::connect(&b.endpoint).await;
    let token = b.token.clone();
    let session = request(&mut agent, &token, "s", "listen.start", json!({ "client": "claude" })).await["result"].clone();
    let id = session["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("lsn_"));
    // Idempotent for the same client, refused for another.
    assert_eq!(request(&mut agent, &token, "s2", "listen.start", json!({ "client": "claude" })).await["result"]["id"], id.as_str());
    assert_eq!(
        request(&mut agent, &token, "s3", "listen.start", json!({ "client": "codex" })).await["error"]["code"],
        "SESSION_BUSY"
    );
    // Speech between waits stays queued.
    listen.say(&id, "First").await;
    let first = request(&mut agent, &token, "n1", "listen.next", json!({ "sessionId": id, "timeoutSeconds": 5 })).await;
    assert_eq!((first["result"]["event"]["seq"].clone(), first["result"]["event"]["text"].clone()), (json!(1), json!("First")));
    let utterance_id = first["result"]["event"]["id"].clone();
    // A retry without advancing the cursor gets the same event again.
    let retry = request(&mut agent, &token, "n2", "listen.next", json!({ "sessionId": id, "timeoutSeconds": 5 })).await;
    assert_eq!(retry["result"]["event"]["id"], utterance_id);
    // Passing after acknowledges it; nothing new yet, so the wait times out.
    let empty =
        request(&mut agent, &token, "n3", "listen.next", json!({ "sessionId": id, "after": 1, "timeoutSeconds": 0.05 })).await;
    assert_eq!(empty["result"]["status"], "timeout");
    assert_eq!((empty["result"]["session"]["ackedSeq"].clone(), empty["result"]["session"]["queued"].clone()), (json!(1), json!(0)));

    listen.barge_in(&id, &["rsp_9"]);
    listen.say(&id, "Wait").await;
    let interrupted =
        request(&mut agent, &token, "n4", "listen.next", json!({ "sessionId": id, "after": 1, "timeoutSeconds": 5 })).await;
    assert_eq!(interrupted["result"]["event"]["type"], "interrupted");
    assert_eq!(interrupted["result"]["event"]["responseId"], "rsp_9");
    let acked = request(&mut agent, &token, "a", "listen.ack", json!({ "sessionId": id, "after": 2 })).await;
    assert_eq!(acked["result"]["ackedSeq"], 2);
    assert_eq!(request(&mut agent, &token, "st", "listen.status", json!({})).await["result"]["session"]["queued"], 1);

    assert_eq!(
        request(&mut agent, &token, "x", "listen.next", json!({ "sessionId": "nope" })).await["error"]["code"],
        "SESSION_NOT_FOUND"
    );
    assert_eq!(
        request(&mut agent, &token, "y", "listen.next", json!({ "sessionId": id, "after": -1 })).await["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(
        request(&mut agent, &token, "z", "speak", json!({ "text": "Hi", "responseId": "bad id!" })).await["error"]["code"],
        "INVALID_REQUEST"
    );
    request(&mut agent, &token, "stop", "listen.stop", json!({ "sessionId": id })).await;
    let stopped =
        request(&mut agent, &token, "n5", "listen.next", json!({ "sessionId": id, "after": 4, "timeoutSeconds": 5 })).await;
    assert_eq!(stopped["result"]["status"], "stopped");
    b.bridge.stop().await;
}

#[tokio::test]
async fn a_disconnected_waiter_is_aborted_and_loses_nothing() {
    let b = started_bridge("1").await;
    let mut owner = Client::connect(&b.endpoint).await;
    let session = request(&mut owner, &b.token, "s", "listen.start", json!({})).await["result"].clone();
    let id = session["id"].as_str().unwrap().to_owned();
    let mut waiter = Client::connect(&b.endpoint).await;
    waiter
        .send(json!({ "v": 1, "id": "w", "token": b.token, "method": "listen.next", "params": { "sessionId": id, "timeoutSeconds": 30 } }))
        .await;
    let service = b.handlers.listen.service.clone();
    until(|| service.status(None).unwrap().unwrap().waiters == 1, "waiter").await;
    drop(waiter);
    until(|| service.status(None).unwrap().unwrap().waiters == 0, "waiter to leave").await;
    b.handlers.listen.say(&id, "Still here").await;
    let next = request(&mut owner, &b.token, "n", "listen.next", json!({ "sessionId": id, "timeoutSeconds": 5 })).await;
    assert_eq!(next["result"]["event"]["text"], "Still here");
    b.bridge.stop().await;
}
