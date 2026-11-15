//! The server in-process, spoken to over a real Unix socket.

use delulu_daemon::server::{Daemon, Options};
use delulu_proto::api::*;
use delulu_proto::state::{DaemonMode, HistoryEntry, HistoryPage};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::timeout;

struct Server {
    daemon: Daemon,
    path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn start(opts: Options) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("d.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let daemon = Daemon::new(opts);
    let serving = daemon.clone();
    tokio::spawn(async move { serving.serve(listener, std::future::pending()).await });
    Server {
        daemon,
        path,
        _dir: dir,
    }
}

struct Conn {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Conn {
    async fn open(server: &Server) -> Self {
        let (reader, writer) = UnixStream::connect(&server.path)
            .await
            .unwrap()
            .into_split();
        Self {
            reader: BufReader::new(reader),
            writer,
        }
    }
    async fn send_raw(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).await.unwrap();
    }
    async fn send(&mut self, value: Value) {
        let mut line = value.to_string();
        line.push('\n');
        self.send_raw(line.as_bytes()).await;
    }
    async fn recv(&mut self) -> Value {
        let mut line = String::new();
        let n = timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
            .await
            .expect("a reply within 5 s")
            .unwrap();
        assert!(n > 0, "connection closed");
        serde_json::from_str(&line).unwrap()
    }
    async fn hello(&mut self) {
        self.send(json!({"id": 0, "method": "hello", "params": {"protocol": 1, "client": "test"}}))
            .await;
        let reply = self.recv().await;
        assert_eq!(reply["result"]["protocol"], 1, "{reply}");
    }
}

fn demo() -> Options {
    Options {
        mode: DaemonMode::Demo,
        script: false,
        ..Options::default()
    }
}

#[tokio::test]
async fn bad_lines_get_error_replies_and_the_connection_survives() {
    let server = start(demo());
    let mut c = Conn::open(&server).await;

    c.send(json!({"id": 1, "method": "state.get"})).await;
    let reply = c.recv().await;
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["error"]["code"], "handshake_required");

    c.send_raw(b"this is not json\n").await;
    let reply = c.recv().await;
    assert_eq!(reply["id"], Value::Null);
    assert_eq!(reply["error"]["code"], "parse_error");

    c.send_raw(b"\xff\xfe\xfd\n").await;
    assert_eq!(c.recv().await["error"]["code"], "parse_error");

    // Bigger than the line limit, sent in pieces as a real peer would.
    let chunk = vec![b'x'; 1024 * 1024];
    for _ in 0..5 {
        c.send_raw(&chunk).await;
    }
    c.send_raw(b"\n").await;
    assert_eq!(c.recv().await["error"]["code"], "line_too_long");

    c.send(json!({"id": 2, "method": "no.such.method"})).await;
    let reply = c.recv().await;
    assert_eq!(
        (reply["id"].clone(), reply["error"]["code"].clone()),
        (json!(2), json!("unknown_method"))
    );

    // The same connection still works.
    c.hello().await;
    c.send(json!({"id": 3, "method": "state.get", "unknownField": true}))
        .await;
    let reply = c.recv().await;
    assert_eq!(reply["id"], 3);
    assert_eq!(reply["result"]["daemon"]["mode"], "demo");
}

#[tokio::test]
async fn version_mismatch_is_reported_clearly() {
    let server = start(demo());
    let mut c = Conn::open(&server).await;
    c.send(json!({"id": 1, "method": "hello", "params": {"protocol": 2, "client": "ui"}}))
        .await;
    let reply = c.recv().await;
    assert_eq!(reply["error"]["code"], "version_mismatch");
    assert_eq!(reply["error"]["data"], json!({"client": 2, "daemon": 1}));
    let message = reply["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("client speaks 2, daemon speaks 1"),
        "{message}"
    );
    // Without a successful hello nothing else is served.
    c.send(json!({"id": 2, "method": "state.get"})).await;
    assert_eq!(c.recv().await["error"]["code"], "handshake_required");
}

#[tokio::test]
async fn normal_mode_refuses_dictation_as_not_available() {
    let server = start(Options::default());
    let mut c = Conn::open(&server).await;
    c.hello().await;
    c.send(json!({"id": 1, "method": "dictation.toggle"})).await;
    assert_eq!(c.recv().await["error"]["code"], "not_available");
    c.send(json!({"id": 2, "method": "state.get"})).await;
    let state = c.recv().await;
    assert_eq!(state["result"]["dictation"]["available"], false);
    assert_eq!(state["result"]["settings"], Value::Null);
}

#[tokio::test]
async fn subscribers_get_their_topics_only_and_a_lagging_one_is_told() {
    let server = start(Options {
        event_capacity: 16,
        ..demo()
    });
    let mut c = Conn::open(&server).await;
    c.hello().await;
    c.send(
        json!({"id": 1, "method": "subscribe", "params": {"topics": ["levels", "future-topic"]}}),
    )
    .await;
    assert_eq!(c.recv().await["result"]["topics"], json!(["levels"]));

    // Not subscribed: never delivered.
    server.daemon.publish(Event::Download {
        download: serde_json::from_value(json!({
            "modelId": "m", "state": "running", "doneBytes": 1, "totalBytes": 2,
            "bytesPerSec": null, "error": null
        }))
        .unwrap(),
    });
    // 100 more without yielding: the connection cannot keep up. Its buffer holds 16,
    // and the unsubscribed event above took a slot too, so 85 are missed.
    for i in 0..100 {
        server.daemon.publish(Event::Level {
            level: i as f32 / 100.0,
        });
    }
    let first = c.recv().await;
    assert_eq!(
        first["event"],
        json!({"kind": "lagged", "missed": 85}),
        "{first}"
    );
    // Then the newest 16 follow, in order.
    for i in 84..100 {
        let event = c.recv().await;
        assert_eq!(event["event"]["kind"], "level");
        assert_eq!(event["seq"], i + 2, "seq counts every published event");
    }
}

#[tokio::test]
async fn a_subscriber_that_stops_reading_cannot_block_the_daemon() {
    let server = start(Options {
        event_capacity: 64,
        write_timeout: Duration::from_millis(300),
        ..demo()
    });
    let mut stuck = Conn::open(&server).await;
    stuck.hello().await;
    stuck
        .send(json!({"id": 1, "method": "subscribe", "params": {"topics": ["history"]}}))
        .await;
    stuck.recv().await;

    // ~40 MB of events, far beyond the socket buffer, published with yields so the
    // stuck connection's writer runs and blocks.
    let page = HistoryPage {
        query: None,
        offset: 0,
        total: 1,
        entries: vec![HistoryEntry {
            id: "x".into(),
            created_at: 0,
            text: "y".repeat(20_000),
            raw: None,
            topic: None,
            language: "en".into(),
            model: "m".into(),
            audio_ms: 0,
            stt_ms: 0,
            cleanup_ms: None,
            total_ms: 0,
        }],
    };
    let started = std::time::Instant::now();
    for _ in 0..2_000 {
        server.daemon.publish(Event::History { page: page.clone() });
        tokio::task::yield_now().await;
    }
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "publishing stalled"
    );

    // Another client is served promptly while the stuck one holds its buffer full.
    let mut other = Conn::open(&server).await;
    other.hello().await;
    other.send(json!({"id": 5, "method": "state.get"})).await;
    assert_eq!(other.recv().await["id"], 5);

    // The stuck connection was closed after the write timeout: draining it ends in EOF
    // long before 2,000 events arrive.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mut lines = 0;
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = timeout(Duration::from_secs(5), stuck.reader.read_line(&mut buf))
            .await
            .expect("the stuck connection ends")
            .unwrap_or(0);
        if n == 0 {
            break;
        }
        lines += 1;
    }
    assert!(
        lines < 2_000,
        "the stuck subscriber was dropped, got {lines} lines"
    );
    // And it is gone for good.
    let mut rest = Vec::new();
    let _ = stuck.reader.read_to_end(&mut rest).await;
    assert!(rest.is_empty());
}

#[tokio::test]
async fn demo_toggle_runs_a_whole_dictation_and_cancel_works_mid_way() {
    let server = start(demo());
    let mut watcher = Conn::open(&server).await;
    watcher.hello().await;
    watcher
        .send(
            json!({"id": 1, "method": "subscribe", "params": {"topics": ["dictation", "history"]}}),
        )
        .await;
    watcher.recv().await;

    let mut cli = Conn::open(&server).await;
    cli.hello().await;
    cli.send(json!({"id": 1, "method": "dictation.toggle"}))
        .await;
    assert_eq!(
        cli.recv().await["result"],
        json!({"phase": "recording", "job": 1})
    );
    cli.send(json!({"id": 2, "method": "dictation.toggle"}))
        .await;
    assert_eq!(cli.recv().await["result"]["phase"], "transcribing");
    // A third toggle while busy is refused, not queued.
    cli.send(json!({"id": 3, "method": "dictation.toggle"}))
        .await;
    assert_eq!(cli.recv().await["error"]["code"], "busy");

    let mut phases = Vec::new();
    let mut history = None;
    while history.is_none() {
        let event = watcher.recv().await;
        match event["event"]["kind"].as_str().unwrap() {
            "dictation" => phases.push(
                event["event"]["state"]["phase"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            ),
            "history" => history = Some(event),
            other => panic!("unsubscribed topic {other}"),
        }
    }
    assert_eq!(
        phases,
        ["recording", "transcribing", "cleaning", "inserting", "idle"]
    );
    let history = history.unwrap();
    let entry = &history["event"]["page"]["entries"][0];
    assert_eq!(
        entry["text"],
        "Can you check why the build fails on the ARM runner?"
    );

    // Cancel during transcription: back to idle, and the late engine result is dropped.
    cli.send(json!({"id": 4, "method": "dictation.toggle"}))
        .await;
    cli.recv().await;
    cli.send(json!({"id": 5, "method": "dictation.toggle"}))
        .await;
    cli.recv().await;
    cli.send(json!({"id": 6, "method": "dictation.cancel"}))
        .await;
    assert_eq!(
        cli.recv().await["result"],
        json!({"phase": "idle", "job": 2})
    );
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let state = server.daemon.snapshot();
    assert_eq!(
        state.dictation.phase,
        delulu_proto::state::DictationPhase::Idle
    );
    assert!(matches!(
        state.dictation.last,
        Some(delulu_proto::state::DictationOutcome::Cancelled { job: 2, .. })
    ));
}
