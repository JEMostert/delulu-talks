//! Port of `electron/voice/mcp.test.ts`, plus an end-to-end run of the MCP
//! server over in-memory pipes against a bridge started by `VoiceSystem`.
#![cfg(unix)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_audio::{ListenEvent as CaptureEvent, ListenState};
use delulu_core::{DomainError, RecordingSink};
use delulu_desktop::{ClipboardBackend, ClipboardSnapshot};
use delulu_domain::voice::{VoiceEngineId, VoiceSource, VoiceSpeakRequest, VOICE_AGENT_INSTRUCTIONS};
use delulu_voice::mcp::{cli, serve, CliOutput};
use delulu_voice::{SpeakReply, VoiceProfile, VoiceSystem, VoiceSystemConfig};
use parking_lot::Mutex;
use serde_json::{json, Value};
use support::{started_bridge_in, until, voice_fixture, FakeBackend, FakeTranscriber, StartedBridge, TestHandlers};
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
            "instructions": VOICE_AGENT_INSTRUCTIONS,
        })
    );
    server.notify("notifications/initialized").await;
    assert_eq!(server.request("ping", Value::Null).await["result"], json!({}));
    let tools = server.request("tools/list", Value::Null).await["result"]["tools"].clone();
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "speak",
            "stop_speaking",
            "voice_status",
            "listen_start",
            "listen_next",
            "listen_ack",
            "listen_status",
            "listen_stop",
            "coordinator_status",
            "coordinator_setup",
            "coordinator_load",
            "coordinator_unload",
            "coordinator_focus",
            "coordinator_submit",
            "agent_register",
            "agent_next",
            "agent_ack",
            "agent_unregister",
            "task_status",
            "task_update"
        ]
    );
    assert_eq!(tools[0]["inputSchema"]["required"], json!(["text"]));
    for tag in ["[laugh]", "[clear-throat]", "[long-pause]", "<whisper>", "<emphasis>"] {
        assert!(tools[0]["description"].as_str().unwrap().contains(tag));
    }
    assert!(tools[4]["description"].as_str().unwrap().contains("(default 50 s)"));

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
    let unknown = server.request("tools/call", json!({ "name": "sing", "arguments": {} })).await;
    assert_eq!(unknown["error"]["code"], -32602);
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
    assert!(init["result"]["instructions"].as_str().unwrap().contains("Delulu Talks was not reachable"));
    let speak = server.tool("speak", json!({ "text": "Hi" })).await;
    assert_eq!(
        speak["content"][0]["text"],
        "Delulu Talks isn't running, or agent voice is turned off in its Voice page."
    );
    assert_eq!(speak["isError"], true);
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
    assert!(run(&["--help"], &file, "").await.stdout.contains("Usage:"));
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
async fn the_cli_runs_a_listening_session_with_documented_exit_codes() {
    let b = bridge(|_| {}).await;
    let file = b.bridge_file();
    let parse = |text: &str| serde_json::from_str::<Value>(text.trim()).unwrap();
    let start = run(&["listen", "start", "--client", "claude"], &file, "").await;
    assert_eq!(start.code, 0);
    let id = parse(&start.stdout)["id"].as_str().unwrap().to_owned();

    let timeout = run(&["listen", "next", "--session", &id, "--timeout", "0.1"], &file, "").await;
    assert_eq!(timeout.code, 3);
    assert_eq!(parse(&timeout.stdout)["status"], "timeout");

    b.handlers.listen.say(&id, "Run the tests").await;
    let event = run(&["listen", "next", "--session", &id, "--timeout", "5"], &file, "").await;
    assert_eq!(event.code, 0);
    let event = parse(&event.stdout)["event"].clone();
    assert_eq!((event["seq"].clone(), event["text"].clone()), (json!(1), json!("Run the tests")));

    let ack = run(&["listen", "ack", "--session", &id, "--after", "1"], &file, "").await;
    assert_eq!(parse(&ack.stdout)["ackedSeq"], 1);
    assert_eq!(parse(&run(&["listen", "status"], &file, "").await.stdout)["session"]["queued"], 0);

    let say = run(&["say", "--response", "rsp_1", "On it."], &file, "").await;
    assert_eq!(say.code, 0);
    assert!(say.stdout.contains("rsp_1"));
    assert_eq!(b.handlers.speak_calls.lock().last().unwrap().0.response_id.as_deref(), Some("rsp_1"));

    run(&["listen", "stop", "--session", &id], &file, "").await;
    // The real service queues a `stopped` event (seq 2) before reporting the session stopped.
    let last = run(&["listen", "next", "--session", &id, "--after", "1"], &file, "").await;
    assert_eq!((last.code, parse(&last.stdout)["event"]["type"].clone()), (0, json!("stopped")));
    assert_eq!(run(&["listen", "next", "--session", &id, "--after", "2"], &file, "").await.code, 4);
    let missing = run(&["listen", "next", "--session", "nope"], &file, "").await;
    assert_eq!(missing.code, 1);
    assert_eq!(parse(&missing.stderr)["error"]["code"], "SESSION_NOT_FOUND");
    b.bridge.stop().await;
}

#[tokio::test]
async fn mcp_listen_tools_are_bounded_calls_over_one_session() {
    let b = bridge(|_| {}).await;
    let mut client = Mcp::start(b.bridge_file());
    client.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    let session = client.tool("listen_start", json!({ "client": "codex" })).await["structuredContent"].clone();
    let id = session["id"].as_str().unwrap().to_owned();
    let timeout = client.tool("listen_next", json!({ "sessionId": id, "timeoutSeconds": 0.1 })).await;
    assert_eq!(timeout["structuredContent"]["status"], "timeout");
    b.handlers.listen.say(&id, "Hello").await;
    let next = client.tool("listen_next", json!({ "sessionId": id, "timeoutSeconds": 5 })).await;
    let text: Value = serde_json::from_str(next["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["event"]["text"], "Hello");
    let busy = client.tool("listen_start", json!({ "client": "other" })).await;
    assert_eq!(busy["isError"], true);
    assert!(busy["content"][0]["text"].as_str().unwrap().contains("SESSION_BUSY"));
    b.bridge.stop().await;
}

/* End to end */

struct EmptyClipboard;

impl ClipboardBackend for EmptyClipboard {
    fn write_text(&self, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn read(&self) -> Result<ClipboardSnapshot, String> {
        Ok(ClipboardSnapshot::default())
    }
}

#[tokio::test]
async fn end_to_end_an_agent_speaks_and_listens_through_the_app_bridge() {
    let f = voice_fixture(|settings| settings.voice_agent_bridge = true, 250.0, true, true);
    let sink = RecordingSink::new();
    let backend = Arc::new(FakeBackend::default());
    let transcriber = Arc::new(FakeTranscriber::default());
    let system = VoiceSystem::with_parts(
        VoiceSystemConfig {
            profile: f.profile.clone(),
            transcriber: transcriber.clone(),
            sink: sink.clone(),
            clipboard: Arc::new(EmptyClipboard),
            app_version: "0.1.0".into(),
            on_tray_change: None,
        },
        f.service.clone(),
        backend.clone(),
    );
    system.start().await;
    let bridge_file = f.dir.path().join("voice").join("bridge.json");
    assert!(bridge_file.exists(), "the bridge publishes bridge.json in the profile");
    assert!(system.voice().get_status().bridge.listening);

    let mut agent = Mcp::start(bridge_file.clone());
    let init = agent.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    assert_eq!(init["result"]["serverInfo"]["version"], "0.1.0");
    let status = agent.tool("voice_status", json!({})).await;
    assert!(status["content"][0]["text"].as_str().unwrap().starts_with("Voice is on and Kokoro is ready."), "{status}");

    // speak with wait: synthesized by the (fake) worker, played, reported.
    let spoken = agent
        .tool(
            "speak",
            json!({ "text": "Done. All tests pass.", "wait": true, "agent": "Claude Code", "responseId": "rsp_1" }),
        )
        .await;
    assert_eq!(spoken["structuredContent"]["outcome"], "spoken");
    assert!(spoken["content"][0]["text"].as_str().unwrap().starts_with("Spoken ("), "{spoken}");
    assert_eq!(system.voice().get_status().recent[0].agent.as_deref(), Some("Claude Code"));
    assert!(!f.playback.played.lock().is_empty());

    // A listening turn: start, the user speaks, the agent collects it.
    let session = agent.tool("listen_start", json!({ "client": "claude-code" })).await["structuredContent"].clone();
    let id = session["id"].as_str().unwrap().to_owned();
    assert!(backend.commands.lock().iter().any(|c| matches!(c, delulu_voice::CaptureCommand::Start { .. })));
    system.listening().capture_event(&id, CaptureEvent::State { state: ListenState::Listening, message: None });
    transcriber.transcripts.lock().push_back("Can you run the unit tests?".into());
    system.listening().capture_event(
        &id,
        CaptureEvent::Utterance { wav: vec![0; 64], duration_ms: 900, speech_ms: 700, overlapped_playback: false },
    );
    let next = agent.tool("listen_next", json!({ "sessionId": id, "timeoutSeconds": 5 })).await;
    assert_eq!(next["structuredContent"]["event"]["text"], "Can you run the unit tests?");
    let seq = next["structuredContent"]["event"]["seq"].clone();

    // The CLI shares the bridge.
    let say = run(&["say", "--response", "rsp_2", "Running them now."], &bridge_file, "").await;
    assert_eq!(say.code, 0, "{say:?}");
    let stopped = agent.tool("listen_stop", json!({ "sessionId": id })).await;
    assert_eq!(stopped["structuredContent"]["state"], "stopped");
    let after = agent.tool("listen_next", json!({ "sessionId": id, "after": seq, "timeoutSeconds": 1 })).await;
    assert_eq!(after["structuredContent"]["status"], "event");
    assert_eq!(after["structuredContent"]["event"]["type"], "stopped");

    // Events reached the renderer channels.
    until(|| !sink.channel("listen:statusChanged").is_empty(), "listen events").await;
    assert!(sink.channel("voice:statusChanged").iter().any(|status| status["bridge"]["listening"] == true));

    // Turning the bridge off removes bridge.json; agents are told it is not running.
    let previous = f.profile.settings();
    f.profile.set(|settings| settings.voice_agent_bridge = false);
    system.settings_changed(&previous, &f.profile.settings()).await;
    assert!(!bridge_file.exists());
    let offline = agent.tool("speak", json!({ "text": "Hello?" })).await;
    assert_eq!(offline["isError"], true);
    system.shutdown().await;
}
