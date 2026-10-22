//! Delulu Voice for coding agents: an MCP server (stdio) and a small CLI that
//! speak through a running Delulu Talks (`backend/voice/delulu-voice-mcp.mjs`).
//! The app binary runs it for `delulu-talks mcp …` before starting Tauri:
//!
//! ```text
//! MCP:  delulu-talks mcp
//! CLI:  delulu-talks mcp say [--wait] [--interrupt] [--agent NAME] [--response ID] <text…>
//!       delulu-talks mcp listen start|next|ack|status|stop …
//!       delulu-talks mcp stop | status | --help
//! ```
//!
//! `bridge.json` is read from the profile's voice directory;
//! `DELULU_VOICE_BRIDGE` overrides where it is read from.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::AppPaths;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::bridge::VOICE_BRIDGE_FILE;
use crate::client::{call, ClientError, REQUEST_TIMEOUT, WAIT_TIMEOUT};

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
// A waiting listen.next may take up to its own timeout; allow for the answer.
const LISTEN_MARGIN_MS: f64 = 15_000.0;
const MCP_LISTEN_SECONDS: u64 = 50;
const MAX_LISTEN_SECONDS: u64 = 3_600;
const DEFAULT_LISTEN_SECONDS: u64 = 600;
/// Exit codes for `listen next`.
const EXIT_EVENT: i32 = 0;
const EXIT_TIMEOUT: i32 = 3;
const EXIT_STOPPED: i32 = 4;

const FALLBACK_INSTRUCTIONS: &str = "You can talk to the user out loud with the speak tool. Speak only when work is done, when you are blocked, or when you need a decision: one to three short sentences, never code or logs. See the speak tool for expressive tags. Delulu Talks was not reachable when this session started; start it and turn on agent voice in its Voice page.";

const SPEAK_DESCRIPTION: &str = "Speak to the user out loud through Delulu Talks.

You are the lead agent and the only one who speaks; the user is your board. Speak when work is done, when you are blocked, when you need a decision, or when something important broke. Not for routine progress, and never once per subtask. Use one to three short sentences, like a colleague talking. Never read code, diffs, logs or long lists aloud; name the file or the outcome instead. Ask one clear question when you need a decision.

Expressive markup, used sparingly where a person really would:
- One-off sounds: [laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush]
- Pauses: [pause] [long-pause]
- Wrapping styles: <whisper>…</whisper> <happy>…</happy> <angry>…</angry> <surprised>…</surprised> <scared>…</scared> <sarcastic>…</sarcastic> <dramatic>…</dramatic> <narration>…</narration> <crying>…</crying>
- Pacing and volume: <slow>…</slow> <fast>…</fast> <soft>…</soft> <loud>…</loud> <emphasis>…</emphasis>
Example: \"[sigh] the build still fails on the cache path. Want me to try another way?\"

Returns once the speech is queued, unless wait is true.";

const USAGE: &str = "Delulu Voice: speak through Delulu Talks.

Usage:
  delulu-talks mcp                 Run as an MCP server on stdio
  delulu-talks mcp say [options] <text…>
      --wait          Wait until the speech has finished
      --interrupt     Stop current speech and clear the queue first
      --agent NAME    Name shown in Delulu's spoken history
      --response ID   Your id for this response; interruptions report it
      Use \"-\" as the text to read it from stdin.
  delulu-talks mcp stop            Stop speaking and clear the queue
  delulu-talks mcp status          Show whether Delulu can speak

Listening sessions (each prints one JSON object on stdout):
  listen start [--client NAME]         Start or reuse a session; prints its info ({\"id\": …})
  listen next --session ID [--after SEQ] [--timeout SECONDS]
                                       Wait for the next event after SEQ (default 600 s).
                                       Passing --after acknowledges SEQ and everything before;
                                       repeating it returns the same event again.
                                       Exit 0: {\"status\":\"event\",\"event\":{…}}
                                       Exit 3: {\"status\":\"timeout\"}  (start another waiter)
                                       Exit 4: {\"status\":\"stopped\"}  (the session ended)
  listen ack --session ID --after SEQ  Acknowledge up to SEQ without waiting
  listen status [--session ID]         {\"session\": … | null}
  listen stop --session ID             Stop listening; waiters return \"stopped\"
Errors exit 1 with {\"error\":{\"code\",\"message\"}} on stderr.
";

/// The MCP tool list, verbatim from the Node server.
pub fn tools() -> Value {
    let empty = || json!({ "type": "object", "properties": {}, "additionalProperties": false });
    json!([
        {
            "name": "speak",
            "title": "Speak out loud",
            "description": SPEAK_DESCRIPTION,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 15000,
                        "description": "What to say, with optional expressive markup.",
                    },
                    "interrupt": {
                        "type": "boolean",
                        "description": "Stop current speech and clear the queue first.",
                    },
                    "wait": {
                        "type": "boolean",
                        "description": "Wait until the speech has finished playing. Defaults to false.",
                    },
                    "agent": {
                        "type": "string",
                        "maxLength": 64,
                        "description": "Your display name in Delulu's spoken history.",
                    },
                    "responseId": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9_.:-]{1,128}$",
                        "description": "Your id for this spoken response. If the user talks over it, the interruption event reports this id. Generated when omitted.",
                    },
                },
                "required": ["text"],
                "additionalProperties": false,
            },
            "annotations": {
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            },
        },
        {
            "name": "stop_speaking",
            "title": "Stop speaking",
            "description": "Stop Delulu Talks speaking right away and clear anything queued.",
            "inputSchema": empty(),
            "annotations": { "readOnlyHint": false, "destructiveHint": false },
        },
        {
            "name": "voice_status",
            "title": "Voice status",
            "description": "Whether Delulu Talks can speak right now: voice on or off, the engine, and whether it is speaking or has speech queued.",
            "inputSchema": empty(),
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "listen_start",
            "title": "Start listening",
            "description": "Start (or reuse) a persistent listening session. Delulu keeps the microphone and speech model running across turns until listen_stop. Idempotent for the same client. Returns the session, including its id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "client": {
                        "type": "string",
                        "maxLength": 64,
                        "description": "Who owns the session, e.g. \"claude-code\". Another client cannot take it over.",
                    },
                },
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": false, "idempotentHint": true },
        },
        {
            "name": "listen_next",
            "title": "Wait for the user",
            "description": format!("Wait for the next event in a listening session and return it as JSON: {{\"status\":\"event\",\"event\":{{...}}}} for an utterance or an interruption, {{\"status\":\"timeout\"}} when nothing arrived (just call again), or {{\"status\":\"stopped\"}}. Pass after = the seq of the last event you processed: that acknowledges it and everything before; calling again with the same after returns the same event, so retries never lose input. An \"interrupted\" event means the user talked over your speech and is still speaking; do not repeat yourself, wait for the following \"utterance\" (it carries interruptedResponseId). The wait is bounded (default {MCP_LISTEN_SECONDS} s); the session keeps listening between calls."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" },
                    "after": { "type": "integer", "minimum": 0 },
                    "timeoutSeconds": { "type": "number", "minimum": 0, "maximum": MAX_LISTEN_SECONDS },
                },
                "required": ["sessionId"],
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": false, "idempotentHint": true },
        },
        {
            "name": "listen_ack",
            "title": "Acknowledge events",
            "description": "Acknowledge every event up to and including seq `after` without waiting, so they are not delivered again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" },
                    "after": { "type": "integer", "minimum": 0 },
                },
                "required": ["sessionId", "after"],
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": false, "idempotentHint": true },
        },
        {
            "name": "listen_status",
            "title": "Listening status",
            "description": "The active listening session (or the given one): state, queued events, cursor, whether the user is speaking.",
            "inputSchema": {
                "type": "object",
                "properties": { "sessionId": { "type": "string" } },
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "listen_stop",
            "title": "Stop listening",
            "description": "Stop a listening session: the microphone closes, waiting calls return stopped. Only when the user is done talking.",
            "inputSchema": {
                "type": "object",
                "properties": { "sessionId": { "type": "string" } },
                "required": ["sessionId"],
                "additionalProperties": false,
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false },
        },
    ])
}

/* ------------------------------------------------------------------ */
/* JavaScript value helpers                                            */
/* ------------------------------------------------------------------ */

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number(value)`.
fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => f64::from(u8::from(*value)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => number_from_str(text),
        Some(_) => f64::NAN,
    }
}

fn number_from_str(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    match text.parse::<f64>() {
        Ok(number) if !text.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => number,
        _ => f64::NAN,
    }
}

/// `String(number)` for the integers and decimals these messages show.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// `String(value)` for display.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

fn seconds(ms: Option<&Value>) -> String {
    let ms = number_of(ms);
    let ms = if ms.is_nan() { 0.0 } else { ms.max(0.0) };
    format!("{:.1} s", ms / 1000.0)
}

/// Turn a speak result into one or two sentences an agent can act on.
fn describe_speak(result: &Value) -> (String, bool) {
    let response_id = result.get("responseId").filter(|id| truthy(Some(id))).map(js_string);
    if let Some(position) = result.get("position").and_then(Value::as_f64) {
        let mut text =
            if position <= 0.0 { "Speaking now.".to_owned() } else { format!("Queued ({} ahead).", js_number(position)) };
        if let Some(id) = &response_id {
            text.push_str(&format!(" Response {id}."));
        }
        return (text, false);
    }
    let mut lines = Vec::new();
    let mut error = false;
    let duration = seconds(result.get("durationMs"));
    match result.get("outcome").and_then(Value::as_str) {
        Some("spoken") => lines.push(format!("Spoken ({duration}).")),
        Some("stopped") => lines.push(format!("Stopped after {duration}.")),
        Some("interrupted") => lines.push(format!(
            "Interrupted by the user after {duration}; collect their utterance with listen next."
        )),
        Some("failed") => {
            error = true;
            let reason = result.get("error").filter(|e| truthy(Some(e))).map(js_string);
            lines.push(format!("Speech failed: {}.", reason.unwrap_or_else(|| "unknown error".into())));
        }
        _ => {
            let outcome = match result.get("outcome") {
                None | Some(Value::Null) => "accepted".to_owned(),
                Some(value) => js_string(value),
            };
            lines.push(format!("Speech {outcome}."));
        }
    }
    let list = |key: &str, separator: &str| {
        result
            .get(key)
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .map(|items| items.iter().map(js_string).collect::<Vec<_>>().join(separator))
    };
    if let Some(warnings) = list("warnings", "; ") {
        lines.push(format!("Markup warnings: {warnings}."));
    }
    if let Some(unsupported) = list("unsupported", ", ") {
        lines.push(format!("Skipped by this voice: {unsupported}."));
    }
    if let Some(id) = response_id {
        lines.push(format!("Response {id}."));
    }
    (lines.join(" "), error)
}

fn describe_status(status: &Value) -> String {
    if !status.is_object() && !status.is_array() {
        return "Voice status unknown.".into();
    }
    let engine = match status.get("engine") {
        Some(Value::String(id)) if id == "kokoro" => "Kokoro".to_owned(),
        Some(Value::String(id)) if id == "chatterbox-turbo" => "Chatterbox Turbo".to_owned(),
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    };
    let mut parts = Vec::new();
    if !truthy(status.get("enabled")) {
        parts.push("Voice is turned off in Delulu Talks.".to_owned());
    } else if !truthy(status.get("ready")) {
        let name = if engine.is_empty() { "the voice" } else { engine.as_str() };
        parts.push(format!("Voice is on; {name} is not ready yet."));
    } else {
        parts.push(format!("Voice is on and {engine} is ready."));
    }
    if truthy(status.get("speaking")) {
        parts.push("Speaking now.".into());
    }
    let queued = status.get("queued").and_then(Value::as_f64).unwrap_or(0.0);
    if queued > 0.0 {
        let noun = if queued == 1.0 { "message" } else { "messages" };
        parts.push(format!("{} {noun} queued.", js_number(queued)));
    }
    if let Some(message) = status.get("message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty()) {
        parts.push(message.to_owned());
    }
    parts.join(" ")
}

/* ------------------------------------------------------------------ */
/* MCP server                                                          */
/* ------------------------------------------------------------------ */

struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn text_result(text: &str, is_error: bool) -> Map<String, Value> {
    let mut result = Map::new();
    result.insert("content".into(), json!([{ "type": "text", "text": text }]));
    if is_error {
        result.insert("isError".into(), Value::Bool(true));
    }
    result
}

fn json_result(value: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": value.to_string() }], "structuredContent": value })
}

fn listen_timeout(timeout_seconds: Option<&Value>) -> Duration {
    let seconds = number_of(timeout_seconds);
    let seconds = if seconds.is_finite() { seconds.max(0.0) } else { DEFAULT_LISTEN_SECONDS as f64 };
    Duration::from_millis((seconds * 1000.0 + LISTEN_MARGIN_MS) as u64)
}

/// Copies `keys` that are present in `from` (JSON drops `undefined`).
fn pick(from: &Map<String, Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = from.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

enum ToolError {
    Rpc(RpcError),
    Bridge(ClientError),
}

impl From<ClientError> for ToolError {
    fn from(error: ClientError) -> Self {
        Self::Bridge(error)
    }
}

async fn call_tool(bridge: &Path, params: Option<&Value>) -> Result<Value, RpcError> {
    let Some(name) = params.and_then(|params| params.get("name")).and_then(Value::as_str) else {
        return Err(RpcError::new(-32602, "tools/call needs a tool name."));
    };
    let args = match params.and_then(|params| params.get("arguments")) {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args.clone(),
        Some(_) => return Err(RpcError::new(-32602, "Tool arguments must be an object.")),
    };
    let outcome: Result<Value, ToolError> = async {
        match name {
            "speak" => {
                match args.get("text") {
                    Some(Value::String(text)) if !text.trim().is_empty() => {}
                    _ => return Err(ToolError::Rpc(RpcError::new(-32602, "speak needs nonempty text."))),
                }
                for key in ["interrupt", "wait"] {
                    if args.get(key).is_some_and(|value| !value.is_boolean()) {
                        return Err(ToolError::Rpc(RpcError::new(-32602, format!("{key} must be a boolean."))));
                    }
                }
                if args.get("agent").is_some_and(|value| !value.is_string()) {
                    return Err(ToolError::Rpc(RpcError::new(-32602, "agent must be text.")));
                }
                if args.get("responseId").is_some_and(|value| !value.is_string()) {
                    return Err(ToolError::Rpc(RpcError::new(-32602, "responseId must be text.")));
                }
                let wait = args.get("wait") == Some(&Value::Bool(true));
                let mut request = Map::new();
                request.insert("text".into(), args["text"].clone());
                request.insert("wait".into(), Value::Bool(wait));
                for key in ["interrupt", "agent", "responseId"] {
                    if let Some(value) = args.get(key) {
                        request.insert(key.into(), value.clone());
                    }
                }
                let timeout = if wait { WAIT_TIMEOUT } else { REQUEST_TIMEOUT };
                let result = call(bridge, "speak", Value::Object(request), timeout, None).await?;
                let (text, error) = describe_speak(&result);
                let mut reply = text_result(&text, error);
                reply.insert("structuredContent".into(), result);
                Ok(Value::Object(reply))
            }
            "listen_start" => {
                Ok(json_result(call(bridge, "listen.start", pick(&args, &["client"]), REQUEST_TIMEOUT, None).await?))
            }
            "listen_next" => {
                let timeout_seconds = match args.get("timeoutSeconds") {
                    None | Some(Value::Null) => json!(MCP_LISTEN_SECONDS),
                    Some(value) => value.clone(),
                };
                let mut request = pick(&args, &["sessionId"]);
                request["timeoutSeconds"] = timeout_seconds.clone();
                if let Some(after) = args.get("after") {
                    request["after"] = after.clone();
                }
                let timeout = listen_timeout(Some(&timeout_seconds));
                Ok(json_result(call(bridge, "listen.next", request, timeout, None).await?))
            }
            "listen_ack" => Ok(json_result(
                call(bridge, "listen.ack", pick(&args, &["sessionId", "after"]), REQUEST_TIMEOUT, None).await?,
            )),
            "listen_status" => Ok(json_result(
                call(bridge, "listen.status", pick(&args, &["sessionId"]), REQUEST_TIMEOUT, None).await?,
            )),
            "listen_stop" => Ok(json_result(
                call(bridge, "listen.stop", pick(&args, &["sessionId"]), REQUEST_TIMEOUT, None).await?,
            )),
            "stop_speaking" => {
                call(bridge, "stop", json!({}), REQUEST_TIMEOUT, None).await?;
                Ok(Value::Object(text_result("Stopped speaking and cleared the queue.", false)))
            }
            "voice_status" => {
                let status = call(bridge, "status", json!({}), REQUEST_TIMEOUT, None).await?;
                Ok(Value::Object(text_result(&describe_status(&status), false)))
            }
            other => Err(ToolError::Rpc(RpcError::new(-32602, format!("Unknown tool: {other}")))),
        }
    }
    .await;
    match outcome {
        Ok(value) => Ok(value),
        Err(ToolError::Rpc(error)) => Err(error),
        Err(ToolError::Bridge(error)) => {
            let text = if error.code.starts_with("SESSION_") {
                format!("{}: {}", error.code, error.message)
            } else {
                error.message.clone()
            };
            let mut reply = text_result(&text, true);
            reply.insert(
                "structuredContent".into(),
                json!({ "error": { "code": error.code, "message": error.message } }),
            );
            Ok(Value::Object(reply))
        }
    }
}

async fn initialize(bridge: &Path, params: Option<&Value>) -> Value {
    let requested = params.and_then(|params| params.get("protocolVersion")).and_then(Value::as_str);
    let mut instructions = FALLBACK_INSTRUCTIONS.to_owned();
    let mut version = "1".to_owned();
    // Delulu Talks may start later; tools report it then.
    if let Ok(hello) = call(bridge, "hello", json!({}), Duration::from_millis(1_500), None).await {
        if let Some(text) = hello.get("instructions").and_then(Value::as_str) {
            instructions = text.to_owned();
        }
        if let Some(text) = hello.get("appVersion").and_then(Value::as_str) {
            version = text.to_owned();
        }
    }
    let protocol = requested.filter(|version| PROTOCOL_VERSIONS.contains(version)).unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "delulu-voice", "title": "Delulu Voice", "version": version },
        "instructions": instructions,
    })
}

async fn handle_request(bridge: &Path, method: &str, params: Option<&Value>) -> Result<Value, RpcError> {
    match method {
        "initialize" => Ok(initialize(bridge, params).await),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(bridge, params).await,
        other => Err(RpcError::new(-32601, format!("Method not found: {other}"))),
    }
}

/// Returns a response, or `None` for notifications and stray responses.
async fn handle_message(bridge: &Path, message: &Value) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid request." } }));
    };
    let method = object.get("method").and_then(Value::as_str)?;
    let id = object.get("id").filter(|id| id.is_string() || id.is_number())?.clone();
    Some(match handle_request(bridge, method, object.get("params")).await {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": error.code, "message": error.message } }),
    })
}

/// Serves MCP over newline-delimited JSON-RPC until `input` closes and every
/// request in flight has been answered. Requests are handled concurrently.
pub async fn serve<R, W>(input: R, output: W, bridge: PathBuf)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(message) = receiver.recv().await {
            let mut line = message.to_string();
            line.push('\n');
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let bridge = Arc::new(bridge);
    let mut lines = input.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => {
                let _ = sender.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error." } }));
                continue;
            }
        };
        let sender = sender.clone();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            match message {
                Value::Array(batch) if batch.is_empty() => {
                    let _ = sender.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Empty batch." } }));
                }
                Value::Array(batch) => {
                    let replies = futures::future::join_all(batch.iter().map(|item| handle_message(&bridge, item))).await;
                    let replies: Vec<Value> = replies.into_iter().flatten().collect();
                    if !replies.is_empty() {
                        let _ = sender.send(Value::Array(replies));
                    }
                }
                message => {
                    if let Some(response) = handle_message(&bridge, &message).await {
                        let _ = sender.send(response);
                    }
                }
            }
        });
    }
    drop(sender);
    let _ = writer.await;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/// Captured CLI output.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn option(rest: &[String], name: &str) -> Option<String> {
    if let Some(index) = rest.iter().position(|value| value == name) {
        return rest.get(index + 1).cloned();
    }
    let prefix = format!("{name}=");
    rest.iter().find_map(|value| value.strip_prefix(&prefix).map(str::to_owned))
}

fn print_json(value: &Value, stream: &mut String) {
    stream.push_str(&value.to_string());
    stream.push('\n');
}

fn integer_option(rest: &[String], name: &str, required: bool) -> Result<Option<u64>, ClientError> {
    let Some(value) = option(rest, name) else {
        if required {
            return Err(ClientError::new(format!("{name} is required."), "INVALID_REQUEST"));
        }
        return Ok(None);
    };
    let number = number_from_str(&value);
    if !delulu_domain::js::is_safe_integer(number) || number < 0.0 {
        return Err(ClientError::new(format!("{name} must be a nonnegative integer."), "INVALID_REQUEST"));
    }
    Ok(Some(number as u64))
}

async fn listen_cli(bridge: &Path, rest: &[String], out: &mut CliOutput) -> Result<i32, ClientError> {
    let action = rest.first().map(String::as_str).unwrap_or("");
    let options = rest.get(1..).unwrap_or_default();
    let session = option(options, "--session");
    let need_session = || {
        session.clone().filter(|id| !id.is_empty()).ok_or_else(|| ClientError::new("--session ID is required.", "INVALID_REQUEST"))
    };
    match action {
        "start" => {
            let params = match option(options, "--client") {
                Some(client) => json!({ "client": client }),
                None => json!({}),
            };
            print_json(&call(bridge, "listen.start", params, REQUEST_TIMEOUT, None).await?, &mut out.stdout);
            Ok(0)
        }
        "next" => {
            let session_id = need_session()?;
            let after = integer_option(options, "--after", false)?;
            let timeout_seconds = match option(options, "--timeout") {
                None => DEFAULT_LISTEN_SECONDS as f64,
                Some(raw) => number_from_str(&raw),
            };
            if !timeout_seconds.is_finite() || !(0.0..=MAX_LISTEN_SECONDS as f64).contains(&timeout_seconds) {
                return Err(ClientError::new(
                    format!("--timeout must be between 0 and {MAX_LISTEN_SECONDS} seconds."),
                    "INVALID_REQUEST",
                ));
            }
            let mut params = json!({ "sessionId": session_id, "timeoutSeconds": timeout_seconds });
            if let Some(after) = after {
                params["after"] = json!(after);
            }
            // Being killed closes the connection; the app keeps the event queued.
            let timeout = listen_timeout(Some(&json!(timeout_seconds)));
            let result = call(bridge, "listen.next", params, timeout, None).await?;
            print_json(&result, &mut out.stdout);
            Ok(match result.get("status").and_then(Value::as_str) {
                Some("timeout") => EXIT_TIMEOUT,
                Some("stopped") => EXIT_STOPPED,
                _ => EXIT_EVENT,
            })
        }
        "ack" => {
            let session_id = need_session()?;
            let after = integer_option(options, "--after", true)?;
            let params = json!({ "sessionId": session_id, "after": after });
            print_json(&call(bridge, "listen.ack", params, REQUEST_TIMEOUT, None).await?, &mut out.stdout);
            Ok(0)
        }
        "status" => {
            let params = match session.filter(|id| !id.is_empty()) {
                Some(id) => json!({ "sessionId": id }),
                None => json!({}),
            };
            print_json(&call(bridge, "listen.status", params, REQUEST_TIMEOUT, None).await?, &mut out.stdout);
            Ok(0)
        }
        "stop" => {
            let params = json!({ "sessionId": need_session()? });
            print_json(&call(bridge, "listen.stop", params, REQUEST_TIMEOUT, None).await?, &mut out.stdout);
            Ok(0)
        }
        other => {
            let shown = if other.is_empty() { "undefined" } else { other };
            out.stderr.push_str(&format!("Unknown listen command: {shown}\n\n{USAGE}"));
            Ok(1)
        }
    }
}

async fn say(bridge: &Path, rest: &[String], stdin: &mut (dyn AsyncRead + Unpin + Send), out: &mut CliOutput) -> Result<i32, ClientError> {
    let mut wait = false;
    let mut interrupt = false;
    let mut agent: Option<String> = None;
    let mut response_id: Option<String> = None;
    let mut words: Vec<String> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        let value = &rest[index];
        if value == "--" {
            words.extend(rest[index + 1..].iter().cloned());
            break;
        }
        if value == "--wait" {
            wait = true;
        } else if value == "--interrupt" {
            interrupt = true;
        } else if value == "--agent" {
            index += 1;
            let Some(name) = rest.get(index) else {
                out.stderr.push_str("--agent needs a name.\n");
                return Ok(1);
            };
            agent = Some(name.clone());
        } else if let Some(name) = value.strip_prefix("--agent=") {
            agent = Some(name.to_owned());
        } else if value == "--response" {
            index += 1;
            let Some(id) = rest.get(index) else {
                out.stderr.push_str("--response needs an id.\n");
                return Ok(1);
            };
            response_id = Some(id.clone());
        } else if let Some(id) = value.strip_prefix("--response=") {
            response_id = Some(id.to_owned());
        } else if value.starts_with("--") && value.len() > 2 {
            out.stderr.push_str(&format!("Unknown option: {value}\n\n{USAGE}"));
            return Ok(1);
        } else {
            words.push(value.clone());
        }
        index += 1;
    }
    let text = if words.len() == 1 && words[0] == "-" {
        let mut bytes = Vec::new();
        let _ = stdin.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        words.join(" ")
    };
    if text.trim().is_empty() {
        out.stderr.push_str("Nothing to say.\n");
        return Ok(1);
    }
    let mut params = json!({ "text": text, "wait": wait });
    if interrupt {
        params["interrupt"] = json!(true);
    }
    if let Some(agent) = agent {
        params["agent"] = json!(agent);
    }
    if let Some(id) = response_id {
        params["responseId"] = json!(id);
    }
    let result = call(bridge, "speak", params, if wait { WAIT_TIMEOUT } else { REQUEST_TIMEOUT }, None).await?;
    let (text, error) = describe_speak(&result);
    let stream = if error { &mut out.stderr } else { &mut out.stdout };
    stream.push_str(&text);
    stream.push('\n');
    Ok(if error { 1 } else { 0 })
}

/// Runs one CLI command and captures its output.
pub async fn cli(args: &[String], bridge: &Path, stdin: &mut (dyn AsyncRead + Unpin + Send)) -> CliOutput {
    let mut out = CliOutput::default();
    let command = args.first().map(String::as_str).unwrap_or("");
    let rest = args.get(1..).unwrap_or_default();
    if command == "listen" {
        out.code = match listen_cli(bridge, rest, &mut out).await {
            Ok(code) => code,
            Err(error) => {
                print_json(&json!({ "error": { "code": error.code, "message": error.message } }), &mut out.stderr);
                1
            }
        };
        return out;
    }
    let result = match command {
        "--help" | "-h" | "help" => {
            out.stdout.push_str(USAGE);
            Ok(0)
        }
        "stop" => call(bridge, "stop", json!({}), REQUEST_TIMEOUT, None).await.map(|_| {
            out.stdout.push_str("Stopped speaking.\n");
            0
        }),
        "status" => call(bridge, "status", json!({}), REQUEST_TIMEOUT, None).await.map(|status| {
            out.stdout.push_str(&describe_status(&status));
            out.stdout.push('\n');
            0
        }),
        "say" => say(bridge, rest, stdin, &mut out).await,
        other => {
            out.stderr.push_str(&format!("Unknown command: {other}\n\n{USAGE}"));
            Ok(1)
        }
    };
    out.code = result.unwrap_or_else(|error| {
        out.stderr.push_str(&error.message);
        out.stderr.push('\n');
        1
    });
    out
}

/// Where `bridge.json` is read from: `DELULU_VOICE_BRIDGE`, else `default`.
pub fn bridge_file(default: PathBuf) -> PathBuf {
    match std::env::var_os("DELULU_VOICE_BRIDGE") {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => default,
    }
}

/// `delulu-talks mcp …`: `args` are the arguments after `mcp`. No arguments
/// serves MCP on stdio; otherwise runs the CLI. Blocks; returns the exit
/// code. Reads `bridge.json` from this build's profile (`Delulu Talks` for
/// release builds, `Delulu Talks Dev` for debug builds, or
/// `DELULU_USER_DATA_DIR`); use [`run_cli_with`] to pass the app's paths.
pub fn run_cli(args: Vec<String>) -> i32 {
    let paths = AppPaths::resolve(!cfg!(debug_assertions), PathBuf::new());
    run_cli_with(args, &paths)
}

/// [`run_cli`] with the app's resolved profile paths.
pub fn run_cli_with(args: Vec<String>, paths: &AppPaths) -> i32 {
    let bridge = bridge_file(paths.voice_dir().join(VOICE_BRIDGE_FILE));
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    runtime.block_on(async move {
        if args.is_empty() {
            serve(tokio::io::BufReader::new(tokio::io::stdin()), tokio::io::stdout(), bridge).await;
            return 0;
        }
        let output = cli(&args, &bridge, &mut tokio::io::stdin()).await;
        use std::io::Write;
        let _ = std::io::stdout().write_all(output.stdout.as_bytes());
        let _ = std::io::stderr().write_all(output.stderr.as_bytes());
        output.code
    })
}
