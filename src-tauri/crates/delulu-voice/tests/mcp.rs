//! Port of `electron/voice/mcp.test.ts`: the MCP server over in-memory pipes
//! and the CLI, against a bridge whose `agent.*` / `task.*` run a real inbox.
#![cfg(unix)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::DomainError;
use delulu_domain::voice::{VoiceEngineId, VoiceSource, VoiceSpeakRequest, VOICE_AGENT_INSTRUCTIONS};
use delulu_voice::mcp::{cli, serve, CliOutput, INBOX_INSTRUCTIONS};
use delulu_voice::SpeakReply;
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::{started_bridge_in, talk_status, StartedBridge, TestHandlers};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

/// An MCP client talking to `serve` over in-memory stdio-like pipes.
struct Mcp {
    input: DuplexStream,
    received: Arc<Mutex<Vec<Value>>>,
    next: AtomicU64,
}

impl Mcp {
    fn start(bridge: PathBuf) -> Self {
        let (input, server_input) = tokio::io::duplex(1 << 20);
        let (server_output, output) = tokio::io::duplex(1 << 20);
        tokio::spawn(serve(BufReader::new(server_input), server_output, bridge));
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                sink.lock().push(serde_json::from_str::<Value>(&line).unwrap());
            }
        });
        Self { input, received, next: AtomicU64::new(1) }
    }

    async fn raw(&mut self, line: &str) {
        self.input.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }

    async fn notify(&mut self, method: &str) {
        self.raw(&json!({ "jsonrpc": "2.0", "method": method }).to_string()).await;
    }

    async fn wait_for(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..2000 {
            if let Some(found) = self.received.lock().iter().find(|message| predicate(message)) {
                return found.clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no matching MCP message");
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.raw(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()).await;
        self.wait_for(|message| message["id"] == id).await
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({ "name": name, "arguments": arguments })).await["result"].clone()
    }

    /// The JSON-RPC error code a tool call answers with.
    async fn tool_error(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({ "name": name, "arguments": arguments })).await["error"]["code"].clone()
    }
}

/// The bridge fixture from mcp.test.ts.
async fn bridge(patch: impl FnOnce(&mut delulu_voice::VoiceBridgeSnapshot)) -> StartedBridge {
    let handlers = TestHandlers::new();
    {
        let mut snapshot = handlers.snapshot.lock();
        *snapshot = delulu_voice::VoiceBridgeSnapshot {
            enabled: true,
            ready: true,
            engine: VoiceEngineId::ChatterboxTurbo,
            speaking: true,
            queued: 1,
            message: "Speaking for Claude Code".into(),
        };
        patch(&mut snapshot);
    }
    *handlers.speak.lock() = Some(Arc::new(|request: VoiceSpeakRequest, wait| {
        Box::pin(async move {
            if request.text.contains("fail") {
                return Err(DomainError::failed("Voice is turned off in Delulu Talks.").into());
            }
            let response_id = request.response_id.unwrap_or_else(|| "rsp_auto".into());
            Ok(if wait {
                SpeakReply::Done(
                    serde_json::from_value(json!({
                        "id": "u", "responseId": response_id, "outcome": "spoken", "durationMs": 4200,
                        "timestamps": [], "warnings": ["Unknown tag [dance] was skipped"], "unsupported": ["[laugh]"],
                    }))
                    .unwrap(),
                )
            } else {
                SpeakReply::Queued(
                    serde_json::from_value(json!({ "id": "u", "responseId": response_id, "position": 2 })).unwrap(),
                )
            })
        })
    }));
    started_bridge_in(tempfile::tempdir().unwrap(), "0.17.0", handlers).await
}

fn speak_request(text: &str, agent: &str) -> VoiceSpeakRequest {
    VoiceSpeakRequest {
        text: text.into(),
        source: Some(VoiceSource::Agent),
        agent: Some(agent.into()),
        interrupt: None,
        normalize: None,
        response_id: None,
    }
}

async fn run(args: &[&str], bridge: &Path, input: &str) -> CliOutput {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let mut stdin = input.as_bytes();
    cli(&args, bridge, &mut stdin).await
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text.trim()).unwrap_or_else(|_| panic!("not one JSON object: {text}"))
}

#[tokio::test]
async fn mcp_server_initializes_from_the_bridge_and_exposes_the_voice_tools() {
    let b = bridge(|_| {}).await;
    let mut server = Mcp::start(b.bridge_file());
    let init = server
        .request("initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }))
        .await;
    assert_eq!(
        init["result"],
        json!({
            "protocolVersion": "2025-03-26",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "delulu-voice", "title": "Delulu Voice", "version": "0.17.0" },
            "instructions": format!("{VOICE_AGENT_INSTRUCTIONS}\n\n{INBOX_INSTRUCTIONS}"),
        })
    );
    server.notify("notifications/initialized").await;
    assert_eq!(server.request("ping", Value::Null).await["result"], json!({}));
    let tools = server.request("tools/list", Value::Null).await["result"]["tools"].clone();
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    let mut expected = vec![
        "speak",
        "stop_speaking",
        "voice_status",
        "agent_register",
        "agent_next",
        "agent_ack",
        "agent_unregister",
        "task_status",
        "task_update",
        "talk_status",
    ];
    if cfg!(debug_assertions) {
        expected.push("talk_inject");
    }
    assert_eq!(names, expected);
    assert_eq!(tools[0]["inputSchema"]["required"], json!(["text"]));
    for tag in ["[laugh]", "[clear-throat]", "[long-pause]", "<whisper>", "<emphasis>"] {
        assert!(tools[0]["description"].as_str().unwrap().contains(tag));
    }
    assert!(tools[4]["description"].as_str().unwrap().contains("default 50000"));
    assert_eq!(tools[4]["inputSchema"]["properties"]["timeoutMs"]["maximum"], 3_600_000);

    let queued = server.tool("speak", json!({ "text": "Done, all tests pass. [chuckle]", "agent": "Claude Code" })).await;
    assert_eq!(queued["content"], json!([{ "type": "text", "text": "Queued (2 ahead). Response rsp_auto." }]));
    let waited = server.tool("speak", json!({ "text": "Done.", "wait": true, "interrupt": true })).await;
    assert_eq!(
        waited["content"][0]["text"],
        "Spoken (4.2 s). Markup warnings: Unknown tag [dance] was skipped. Skipped by this voice: [laugh]. Response rsp_auto."
    );
    assert_eq!(
        *b.handlers.speak_calls.lock(),
        vec![
            (speak_request("Done, all tests pass. [chuckle]", "Claude Code"), false),
            (VoiceSpeakRequest { interrupt: Some(true), ..speak_request("Done.", "Agent") }, true),
        ]
    );
    let refused = server.tool("speak", json!({ "text": "this will fail" })).await;
    assert_eq!(refused["content"], json!([{ "type": "text", "text": "Voice is turned off in Delulu Talks." }]));
    assert_eq!(refused["isError"], true);
    let stopped = server.tool("stop_speaking", json!({})).await;
    assert_eq!(stopped["content"][0]["text"], "Stopped speaking and cleared the queue.");
    assert_eq!(b.handlers.stops.load(Ordering::SeqCst), 1);
    let status = server.request("tools/call", json!({ "name": "voice_status" })).await;
    assert_eq!(
        status["result"]["content"][0]["text"],
        "Voice is on and Chatterbox Turbo is ready. Speaking now. 1 message queued. Speaking for Claude Code"
    );
    b.bridge.stop().await;
}

#[tokio::test]
async fn mcp_errors_use_json_rpc_codes() {
    let b = bridge(|_| {}).await;
    let mut server = Mcp::start(b.bridge_file());
    let init = server.request("initialize", json!({ "protocolVersion": "1999-01-01" })).await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(server.request("resources/list", Value::Null).await["error"]["code"], -32601);
    let empty = server.request("tools/call", json!({ "name": "speak", "arguments": { "text": "" } })).await;
    assert_eq!(empty["error"]["code"], -32602);
    let flag = server.request("tools/call", json!({ "name": "speak", "arguments": { "text": "Hi", "wait": "no" } })).await;
    assert_eq!(flag["error"]["code"], -32602);
    for retired in ["sing", "listen_start", "coordinator_status"] {
        assert_eq!(server.tool_error(retired, json!({})).await, -32602, "{retired}");
    }
    server.raw("{oops").await;
    server.wait_for(|message| message["error"]["code"] == -32700).await;
    server.raw("[]").await;
    server.wait_for(|message| message["error"]["message"] == "Empty batch.").await;
    b.bridge.stop().await;
}

#[tokio::test]
async fn mcp_server_still_initializes_when_delulu_talks_is_not_running() {
    let root = tempfile::tempdir().unwrap();
    let mut server = Mcp::start(root.path().join("bridge.json"));
    let init = server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    assert_eq!(init["result"]["serverInfo"]["version"], "1");
    let instructions = init["result"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("Delulu Talks was not reachable"));
    assert!(instructions.ends_with(INBOX_INSTRUCTIONS));
    let speak = server.tool("speak", json!({ "text": "Hi" })).await;
    assert_eq!(
        speak["content"][0]["text"],
        "Delulu Talks isn't running, or agent voice is turned off in its Voice page."
    );
    assert_eq!(speak["isError"], true);
}

#[tokio::test]
async fn mcp_agent_next_waits_by_default_and_arguments_are_validated() {
    let b = bridge(|_| {}).await;
    let mut server = Mcp::start(b.bridge_file());
    server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    let agent = server.tool("agent_register", json!({ "client": "codex", "name": "Codex" })).await["structuredContent"].clone();
    let id = agent["id"].as_str().unwrap().to_owned();

    // No timeoutMs: the call keeps waiting (50 s by default) until a task arrives.
    let call = json!({ "jsonrpc": "2.0", "id": "wait", "method": "tools/call", "params": { "name": "agent_next", "arguments": { "agentId": id } } });
    server.raw(&call.to_string()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!server.received.lock().iter().any(|message| message["id"] == "wait"));
    b.handlers.inbox.submit("Run the tests", None, "req-1").unwrap();
    let next = server.wait_for(|message| message["id"] == "wait").await["result"].clone();
    assert_eq!(next["structuredContent"]["status"], "event");
    assert_eq!(next["structuredContent"]["event"]["text"], "Run the tests");
    let text: Value = serde_json::from_str(next["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text, next["structuredContent"]);

    for (name, arguments) in [
        ("agent_next", json!({ "agentId": id, "timeoutMs": 3_600_001 })),
        ("agent_next", json!({ "agentId": id, "after": -1 })),
        ("agent_next", json!({ "agentId": id, "after": 1.5 })),
        ("agent_next", json!({ "agentId": id, "sessionId": "ses_1" })),
        ("agent_next", json!({})),
        ("agent_register", json!({ "client": " " })),
        ("agent_register", json!({ "client": "x".repeat(65) })),
        ("task_update", json!({ "agentId": id, "taskId": "task_1", "state": "done" })),
        ("talk_status", json!({ "verbose": true })),
    ] {
        assert_eq!(server.tool_error(name, arguments.clone()).await, -32602, "{name} {arguments}");
    }
    assert_eq!(server.tool("talk_status", json!({})).await["structuredContent"], talk_status());
    if cfg!(debug_assertions) {
        let turn = server.tool("talk_inject", json!({ "text": "Hoe gaat het?" })).await;
        assert_eq!(turn["structuredContent"]["user"], "Hoe gaat het?");
        assert_eq!(*b.handlers.injected.lock(), vec!["Hoe gaat het?".to_owned()]);
    }
    b.bridge.stop().await;
}

#[tokio::test]
async fn cli_says_reads_stdin_stops_and_reports_status() {
    let b = bridge(|snapshot| {
        snapshot.speaking = false;
        snapshot.queued = 0;
        snapshot.message = String::new();
    })
    .await;
    let file = b.bridge_file();
    assert_eq!(
        run(&["say", "--agent", "Codex", "Build", "is", "green."], &file, "").await,
        CliOutput { code: 0, stdout: "Queued (2 ahead). Response rsp_auto.\n".into(), stderr: String::new() }
    );
    let waited = run(&["say", "--wait", "--interrupt", "-"], &file, "From stdin [sigh]\n").await;
    assert_eq!(waited.code, 0);
    assert!(waited.stdout.starts_with("Spoken (4.2 s)."));
    assert_eq!(
        *b.handlers.speak_calls.lock(),
        vec![
            (speak_request("Build is green.", "Codex"), false),
            (VoiceSpeakRequest { interrupt: Some(true), ..speak_request("From stdin [sigh]\n", "Agent") }, true),
        ]
    );
    let stop = run(&["stop"], &file, "").await;
    assert_eq!((stop.code, stop.stdout.as_str()), (0, "Stopped speaking.\n"));
    assert_eq!(b.handlers.stops.load(Ordering::SeqCst), 1);
    assert_eq!(run(&["status"], &file, "").await.stdout, "Voice is on and Chatterbox Turbo is ready.\n");
    let help = run(&["--help"], &file, "").await.stdout;
    assert!(help.contains("Usage:") && help.contains("agent next --agent ID"));
    assert!(!help.contains("listen start"));
    let unknown = run(&["sing"], &file, "").await;
    assert_eq!(unknown.code, 1);
    assert!(unknown.stderr.contains("Unknown command: sing"));
    assert_eq!(run(&["say"], &file, "").await.stderr, "Nothing to say.\n");
    b.bridge.stop().await;
}

#[tokio::test]
async fn cli_explains_when_delulu_talks_is_not_running() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        run(&["say", "Hello"], &root.path().join("bridge.json"), "").await,
        CliOutput {
            code: 1,
            stdout: String::new(),
            stderr: "Delulu Talks isn't running, or agent voice is turned off in its Voice page.\n".into(),
        }
    );
}

#[tokio::test]
async fn the_cli_runs_the_agent_inbox_with_documented_exit_codes() {
    let b = bridge(|_| {}).await;
    let file = b.bridge_file();
    let first = run(&["agent", "register", "--client", "claude-code"], &file, "").await;
    assert_eq!(first.code, 0, "{first:?}");
    let first = parse(&first.stdout);
    let second = parse(&run(&["agent", "register", "--client", "claude-code", "--name=Claude Code"], &file, "").await.stdout);
    assert_ne!(first["id"], second["id"], "every registration is a fresh agent");
    assert_eq!((first["name"].clone(), second["name"].clone()), (json!("claude-code"), json!("Claude Code")));
    assert_eq!((second["ackedSeq"].clone(), second["queued"].clone()), (json!(0), json!(0)));
    let (first, id) = (first["id"].as_str().unwrap().to_owned(), second["id"].as_str().unwrap().to_owned());

    let gone = run(&["agent", "unregister", "--agent", &first], &file, "").await;
    assert_eq!((gone.code, parse(&gone.stdout)), (0, json!({ "unregistered": true })));
    let stopped = run(&["agent", "next", "--agent", &first, "--timeout", "0.1"], &file, "").await;
    assert_eq!((stopped.code, parse(&stopped.stdout)["status"].clone()), (4, json!("stopped")));
    assert_eq!(run(&["agent", "next", "--agent", "agent_nope", "--timeout", "0.1"], &file, "").await.code, 4);

    let timeout = run(&["agent", "next", "--agent", &id, "--timeout", "0.1"], &file, "").await;
    assert_eq!((timeout.code, parse(&timeout.stdout)), (3, json!({ "status": "timeout" })));

    // The agent listens right after registering, so Talk's task reaches it.
    b.handlers.inbox.submit("Run the tests", None, "req-1").unwrap();
    let event = run(&["agent", "next", "--agent", &id, "--timeout", "5"], &file, "").await;
    assert_eq!(event.code, 0, "{event:?}");
    let event = parse(&event.stdout)["event"].clone();
    assert_eq!((event["seq"].clone(), event["type"].clone(), event["text"].clone()), (json!(1), json!("task"), json!("Run the tests")));
    let task = event["taskId"].as_str().unwrap().to_owned();
    // Unacknowledged events are delivered again; --after acknowledges them.
    assert_eq!(parse(&run(&["agent", "next", "--agent", &id, "--timeout", "0"], &file, "").await.stdout)["event"], event);
    let ack = parse(&run(&["agent", "ack", "--agent", &id, "--after", "1"], &file, "").await.stdout);
    assert_eq!((ack["ackedSeq"].clone(), ack["queued"].clone()), (json!(1), json!(0)));
    assert_eq!(run(&["agent", "next", "--agent", &id, "--after", "1", "--timeout", "0.1"], &file, "").await.code, 3);

    let accepted = run(&["task", "update", "--agent", &id, "--task", &task, "--state", "accepted"], &file, "").await;
    assert_eq!((accepted.code, parse(&accepted.stdout)["state"].clone()), (0, json!("accepted")));
    let summary = "All 214 tests pass.";
    let done = run(&["task", "update", "--agent", &id, "--task", &task, "--state", "completed", "--summary", summary], &file, "").await;
    assert_eq!(parse(&done.stdout)["summary"], summary);
    assert_eq!(parse(&run(&["task", "status", "--task", &task], &file, "").await.stdout)["state"], "completed");
    let all = parse(&run(&["task", "status"], &file, "").await.stdout);
    assert_eq!(all["tasks"].as_array().unwrap().len(), 1);
    b.bridge.stop().await;
}

#[tokio::test]
async fn the_cli_shows_talk_and_injects_turns() {
    let b = bridge(|_| {}).await;
    let file = b.bridge_file();
    for command in [["talk", "status"], ["coordinator", "status"]] {
        let status = run(&command, &file, "").await;
        assert_eq!((status.code, parse(&status.stdout)), (0, talk_status()), "{command:?}");
    }
    if cfg!(debug_assertions) {
        let turn = run(&["talk", "inject", "--text", "Run the unit tests."], &file, "").await;
        assert_eq!((turn.code, parse(&turn.stdout)["user"].clone()), (0, json!("Run the unit tests.")));
        assert_eq!(*b.handlers.injected.lock(), vec!["Run the unit tests.".to_owned()]);
    }
    b.bridge.stop().await;
}

#[tokio::test]
async fn the_cli_rejects_retired_commands_and_invalid_arguments() {
    let b = bridge(|_| {}).await;
    let file = b.bridge_file();
    let listen = run(&["listen", "start", "--client", "claude-code"], &file, "").await;
    assert_eq!((listen.code, listen.stdout.as_str(), listen.stderr.lines().count()), (1, "", 1));
    assert!(listen.stderr.contains("agent register") && listen.stderr.contains("agent next"));
    assert_eq!(run(&["listen"], &file, "").await.stderr, listen.stderr);

    for (args, needle) in [
        (&["coordinator", "submit", "--text", "Hi"][..], "talk status"),
        (&["agent", "fly"][..], "Unknown agent command: fly"),
        (&["agent", "next"][..], "agent next requires --agent"),
        (&["agent", "next", "--agent", "a", "--timeout", "3601"][..], "--timeout must be between 0 and 3600"),
        (&["agent", "next", "--agent", "a", "--agent", "b"][..], "--agent was supplied more than once"),
        (&["agent", "next", "--agent"][..], "--agent requires a value"),
        (&["agent", "next", "--agent", "a", "--after", "-1"][..], "--after must be a nonnegative integer"),
        (&["agent", "register", "--client", "x", "--task", "t"][..], "Unknown agent register option: --task"),
        (&["agent", "register", "--client", &"x".repeat(65)][..], "--client must contain nonblank text of at most 64"),
        (&["task", "update", "--agent", "a", "--task", "t", "--state", "done"][..], "--state must be one of"),
        (&["talk", "status", "--verbose"][..], "Unknown talk status option: --verbose"),
    ] {
        let out = run(args, &file, "").await;
        assert_eq!(out.code, 1, "{args:?}");
        let error = parse(&out.stderr)["error"].clone();
        assert_eq!(error["code"], "INVALID_REQUEST", "{args:?}");
        assert!(error["message"].as_str().unwrap().contains(needle), "{args:?}: {error}");
    }
    // The inbox's own refusals arrive the same way.
    let unknown = run(&["agent", "ack", "--agent", "agent_nope", "--after", "0"], &file, "").await;
    assert_eq!((unknown.code, parse(&unknown.stderr)["error"]["code"].clone()), (1, json!("INVALID_REQUEST")));
    b.bridge.stop().await;
}
