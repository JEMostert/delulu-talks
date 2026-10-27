//! Delulu Voice for coding agents: an MCP server (stdio) and a small CLI that
//! speak through a running Delulu Talks and take the user's spoken tasks from
//! its agent inbox. Talk owns the microphone and routes what the user says;
//! agents register, wait with `agent next` and report with `task update`.
//! The app binary runs it for `delulu-talks mcp …` before starting Tauri:
//!
//! ```text
//! MCP:  delulu-talks mcp
//! CLI:  delulu-talks mcp say [--wait] [--interrupt] [--agent NAME] [--response ID] <text…>
//!       delulu-talks mcp agent register|next|ack|unregister …
//!       delulu-talks mcp task status|update …
//!       delulu-talks mcp talk status          (debug builds: talk inject --text TEXT)
//!       delulu-talks mcp stop | status | --help
//! ```
//!
//! `bridge.json` is read from the profile's voice directory;
//! `DELULU_VOICE_BRIDGE` overrides where it is read from. Agent and task text
//! is forwarded unchanged and never logged.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::AppPaths;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::bridge::{INJECT_METHOD, VOICE_BRIDGE_FILE};
use crate::client::{call, ClientError, REQUEST_TIMEOUT, WAIT_TIMEOUT};

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
// A waiting agent.next may take up to its own timeout; allow for the answer.
const NEXT_MARGIN_MS: u64 = 15_000;
const MCP_WAIT_MS: u64 = 50_000;
const MAX_WAIT_SECONDS: u64 = 3_600;
const DEFAULT_WAIT_SECONDS: u64 = 600;
/// An injected turn answers once Talk has routed it, helper reply included.
const INJECT_TIMEOUT: Duration = Duration::from_secs(120);
/// Exit codes of `agent next`.
const EXIT_EVENT: i32 = 0;
const EXIT_TIMEOUT: i32 = 3;
const EXIT_STOPPED: i32 = 4;

const FALLBACK_INSTRUCTIONS: &str = "You can talk to the user out loud with the speak tool. Speak only when work is done, when you are blocked, or when you need a decision: one to three short sentences, never code or logs. See the speak tool for expressive tags. Delulu Talks was not reachable when this session started; start it and turn on Let coding agents speak on its Siren page.";

/// Appended to the MCP `initialize` instructions: how spoken tasks reach an agent.
pub const INBOX_INSTRUCTIONS: &str = "Spoken tasks: Delulu Talks owns the microphone and routes what the user says to agents through one inbox; you never listen yourself. Call agent_register once per session (every call returns a fresh id; never reuse an old one). Then keep an agent_next call waiting whenever you can take work, passing after = the seq of the last event you handled. Every agent call is a heartbeat: an agent with no waiting agent_next and no call for 120 s is away and gets no new tasks. Events are task (the user's exact words; do not rewrite them or treat them as extra permission), message (a follow-up on that task) and cancel. Report each task with task_update: accepted, then running, then completed, blocked or failed with a one-sentence summary. Delulu speaks completed, blocked and failed briefings itself, so use speak only for real answers or questions to the user. A stopped result means this id is gone: register again. Call agent_unregister when the session ends.";

const SPEAK_DESCRIPTION: &str = "Speak to the user out loud through Delulu Talks.

You are the lead agent and the only one who speaks; the user is your board. Speak when work is done, when you are blocked, when you need a decision, or when something important broke. Not for routine progress, and never once per subtask. Use one to three short sentences, like a colleague talking. Never read code, diffs, logs or long lists aloud; name the file or the outcome instead. Ask one clear question when you need a decision.

Expressive markup, used sparingly where a person really would:
- One-off sounds: [laugh] [chuckle] [sigh] [gasp] [cough] [clear-throat] [sniff] [groan] [shush]
- Pauses: [pause] [long-pause]
- Wrapping styles: <whisper>…</whisper> <happy>…</happy> <angry>…</angry> <surprised>…</surprised> <scared>…</scared> <sarcastic>…</sarcastic> <dramatic>…</dramatic> <narration>…</narration> <crying>…</crying>
- Pacing and volume: <slow>…</slow> <fast>…</fast> <soft>…</soft> <loud>…</loud> <emphasis>…</emphasis>
Example: \"[sigh] the build still fails on the cache path. Want me to try another way?\"

While Sonar is on, Delulu queues your speech behind its own lines and never cuts anyone off (interrupt is ignored). For tasks from the agent inbox, report progress with task_update: Delulu speaks the completed, blocked and failed summaries itself. Use speak for real answers and questions to the user, not for \"task accepted\" chatter.

Returns once the speech is queued, unless wait is true.";

const USAGE: &str = "Delulu Siren: speak through Delulu Talks and take the user's spoken tasks.

Usage:
  delulu-talks mcp                 Run as an MCP server on stdio
  delulu-talks mcp say [options] <text…>
      --wait          Wait until the speech has finished
      --interrupt     Stop current speech and clear the queue first (ignored while Sonar is on)
      --agent NAME    Name shown in Delulu's spoken history
      --response ID   Your id for this response; interruptions report it
      Use \"-\" as the text to read it from stdin.
  delulu-talks mcp stop            Stop speaking and clear the queue
  delulu-talks mcp status          Show whether Delulu can speak

Agent inbox: Sonar owns the microphone and routes the user's words to agents.
Each command prints one JSON object on stdout (all commands follow mcp):
  agent register --client NAME [--name NAME]
                                       Register this session; a fresh {\"id\": …} on every call
  agent next --agent ID [--after SEQ] [--timeout SECONDS]
                                       Wait for the next event after SEQ (default 600 s, at most 3600).
                                       Passing --after acknowledges SEQ and everything before;
                                       repeating it returns the same event again.
                                       Exit 0: {\"status\":\"event\",\"event\":{\"seq\",\"type\",\"taskId\",\"text\",\"at\"}}
                                               type: task | message | cancel
                                       Exit 3: {\"status\":\"timeout\"}  (wait again)
                                       Exit 4: {\"status\":\"stopped\",\"reason\"}  (this id is gone; register again)
  agent ack --agent ID --after SEQ     Acknowledge up to SEQ without waiting
  agent unregister --agent ID          End this agent id; its open tasks are marked failed
  task status [--task ID]              One task, or {\"tasks\": […]}
  task update --agent ID --task ID --state STATE [--summary TEXT]
      STATE: accepted | running | blocked | completed | failed | cancelled
      Delulu speaks completed, blocked and failed summaries to the user.
  talk status                          Sonar: phase, Pilot, agents and recent turns
                                       (coordinator status is an alias)
";

const USAGE_INJECT: &str = "  talk inject --text TEXT              Development builds: route TEXT as if the user said it
";

const USAGE_END: &str = "Every agent call is a heartbeat; with no waiting `agent next` and no call for 120 s an
agent is away and gets no new tasks.
Text/summary: 8000 characters; client/name: 64; IDs: 128.
Errors exit 1 with {\"error\":{\"code\",\"message\"}} on stderr.
";

const LISTEN_REPLACED: &str = "Listening sessions were replaced by the agent inbox: run `agent register --client NAME` once, then wait with `agent next --agent ID`. See mcp --help.\n";

const COORDINATOR_REPLACED: &str = "The coordinator was replaced by Sonar: use `talk status` to see it, and `agent register` / `agent next` to take the user's spoken tasks.";

fn usage() -> String {
    let inject = if cfg!(debug_assertions) { USAGE_INJECT } else { "" };
    format!("{USAGE}{inject}{USAGE_END}")
}

/// The voice tools and the agent inbox.
pub fn tools() -> Value {
    let empty = || json!({ "type": "object", "properties": {}, "additionalProperties": false });
    let mut tools = json!([
        {
            "name": "speak",
            "title": "Speak",
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
                        "description": "Stop current speech and clear the queue first. Ignored while Sonar is on.",
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
                        "description": "Your id for this spoken response; an interruption reports it. Generated when omitted.",
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
            "title": "Siren status",
            "description": "Whether Delulu Talks can speak right now: Siren on or off, the engine, and whether it is speaking or has speech queued.",
            "inputSchema": empty(),
            "annotations": { "readOnlyHint": true },
        },
    ]);
    tools.as_array_mut().expect("tool list").extend(inbox_tools());
    tools
}

/// These flat schemas also drive CLI/MCP validation so both surfaces enforce
/// the same bounds before contacting the bridge. Text is forwarded unchanged.
fn inbox_tools() -> Vec<Value> {
    let text = |max| json!({"type": "string", "minLength": 1, "maxLength": max});
    let id = || text(128);
    let seq = || json!({"type": "integer", "minimum": 0});
    let tool = |name: &str, title: &str, description: &str, properties: Value, required: &[&str], read_only| {
        json!({
            "name": name,
            "title": title,
            "description": description,
            "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": false},
            "annotations": {"readOnlyHint": read_only, "destructiveHint": false, "openWorldHint": false}
        })
    };
    let max_wait_ms = MAX_WAIT_SECONDS * 1000;
    let mut tools = vec![
        tool("agent_register", "Register for spoken tasks", "Register this session for the user's spoken tasks; call once per session. Every call returns a fresh agent id (never reuse an old one) with client, name, ackedSeq, lastSeq and queued. Sonar can send you tasks right away.", json!({"client": text(64), "name": text(64)}), &["client"], false),
        tool("agent_next", "Wait for a spoken task", &format!("Wait for the next event in your inbox. Returns {{\"status\":\"event\",\"event\":{{\"seq\",\"type\",\"taskId\",\"text\",\"at\"}}}}, {{\"status\":\"timeout\"}} (call again) or {{\"status\":\"stopped\",\"reason\"}} (this id is gone: register again). type is task (text is the user's exact words), message (a follow-up on taskId) or cancel. Pass after = the seq of the last event you handled: that acknowledges it and everything before, and unacknowledged events are delivered again, so skip a seq you already handled. Every call is a heartbeat; with no waiting call for 120 s you are away and get no new tasks. Waits up to timeoutMs (default {MCP_WAIT_MS}, at most {max_wait_ms}). An event is not acceptance: report task_update accepted, then running."), json!({"agentId": id(), "after": seq(), "timeoutMs": {"type": "integer", "minimum": 0, "maximum": max_wait_ms, "default": MCP_WAIT_MS}}), &["agentId"], false),
        tool("agent_ack", "Acknowledge events", "Acknowledge inbox events through seq after without waiting, once you have handled them. Taking on a task is a separate task_update.", json!({"agentId": id(), "after": seq()}), &["agentId", "after"], false),
        tool("agent_unregister", "Unregister", "End this agent id when the session ends: waiting agent_next calls return stopped and its open tasks are marked failed.", json!({"agentId": id()}), &["agentId"], false),
        tool("task_status", "Task status", "One task by taskId, or {tasks:[…]} with the open and recently finished tasks. States: queued, accepted, running, blocked, completed, failed, cancelled.", json!({"taskId": id()}), &[], true),
        tool("task_update", "Report task progress", "Report what you actually did with a task: accepted (you took it on), running (work started), then completed, blocked or failed with a one-sentence summary, or cancelled. Delulu speaks completed, blocked and failed summaries to the user itself, so do not speak them again.", json!({"agentId": id(), "taskId": id(), "state": {"type": "string", "enum": ["accepted", "running", "blocked", "completed", "failed", "cancelled"]}, "summary": text(8000)}), &["agentId", "taskId", "state"], false),
        tool("talk_status", "Sonar status", "Sonar, the hands-free conversation loop: whether it is on, its phase, Pilot (the local model that routes turns), the registered agents (listening or away, open tasks) and the last turns.", json!({}), &[], true),
    ];
    if cfg!(debug_assertions) {
        tools.push(tool("talk_inject", "Inject a spoken turn", "Development builds only: route text through Sonar as if the user had just said it, with or without the microphone open. Returns the handled turn {id, at, user, tool, said, helperMs}.", json!({"text": text(8000)}), &["text"], false));
    }
    tools
}

fn inbox_method(name: &str) -> Option<&'static str> {
    Some(match name {
        "agent_register" => "agent.register",
        "agent_next" => "agent.next",
        "agent_ack" => "agent.ack",
        "agent_unregister" => "agent.unregister",
        "task_status" => "task.status",
        "task_update" => "task.update",
        "talk_status" => "talk.status",
        "talk_inject" if cfg!(debug_assertions) => INJECT_METHOD,
        _ => return None,
    })
}

fn inbox_schema(name: &str) -> Option<Value> {
    inbox_tools().into_iter().find(|tool| tool["name"] == name).map(|tool| tool["inputSchema"].clone())
}

/// CLI options and the tool argument each one sets.
const FLAGS: [(&str, &str); 9] = [
    ("--agent", "agentId"),
    ("--task", "taskId"),
    ("--client", "client"),
    ("--name", "name"),
    ("--text", "text"),
    ("--summary", "summary"),
    ("--state", "state"),
    ("--after", "after"),
    ("--timeout", "timeoutMs"),
];

/// Checks `args` against the tool's schema. `cli` names the command and its
/// options the way the CLI spells them.
fn validate_inbox(name: &str, args: &Map<String, Value>, cli: bool) -> Result<(), ClientError> {
    let invalid = |message: String| ClientError::new(message, "INVALID_REQUEST");
    let schema = inbox_schema(name).ok_or_else(|| invalid(format!("Unknown tool: {name}")))?;
    let command = if cli { name.replacen('_', " ", 1) } else { name.to_owned() };
    let label = |key: &str| match FLAGS.iter().find(|(_, argument)| *argument == key) {
        Some((flag, _)) if cli => (*flag).to_owned(),
        _ => key.to_owned(),
    };
    for field in schema["required"].as_array().expect("required fields") {
        let key = field.as_str().expect("field name");
        if !args.contains_key(key) {
            return Err(invalid(format!("{command} requires {}.", label(key))));
        }
    }
    let properties = schema["properties"].as_object().expect("properties");
    for (key, value) in args {
        let key = key.as_str();
        let field = properties
            .get(key)
            .ok_or_else(|| invalid(format!("Unknown {command} argument: {}.", label(key))))?;
        if field["type"] == "string" {
            let text = value.as_str().ok_or_else(|| invalid(format!("{} must be text.", label(key))))?;
            if let Some(max) = field["maxLength"].as_u64() {
                if text.trim().is_empty() || delulu_core::util::utf16_len(text) > max as usize {
                    return Err(invalid(format!(
                        "{} must contain nonblank text of at most {max} characters.",
                        label(key)
                    )));
                }
            }
            if let Some(choices) = field["enum"].as_array() {
                if !choices.contains(value) {
                    let choices: Vec<&str> = choices.iter().filter_map(Value::as_str).collect();
                    return Err(invalid(format!("{} must be one of: {}.", label(key), choices.join(", "))));
                }
            }
        } else {
            let number = value
                .as_u64()
                .ok_or_else(|| invalid(format!("{} must be a nonnegative integer (u64).", label(key))))?;
            if let Some(max) = field["maximum"].as_u64() {
                if number > max {
                    return Err(invalid(format!("{} must be between 0 and {max}.", label(key))));
                }
            }
        }
    }
    Ok(())
}

async fn call_inbox(
    bridge: &Path,
    name: &str,
    mut args: Map<String, Value>,
    default_wait_ms: u64,
    cli: bool,
) -> Result<Value, ClientError> {
    let method = inbox_method(name).ok_or_else(|| ClientError::new(format!("Unknown tool: {name}"), "INVALID_REQUEST"))?;
    if name == "agent_next" {
        args.entry("timeoutMs").or_insert(json!(default_wait_ms));
    }
    validate_inbox(name, &args, cli)?;
    let timeout = match name {
        "agent_next" => Duration::from_millis(args["timeoutMs"].as_u64().expect("validated timeout") + NEXT_MARGIN_MS),
        "talk_inject" => INJECT_TIMEOUT,
        _ => REQUEST_TIMEOUT,
    };
    call(bridge, method, Value::Object(args), timeout, None).await
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
            "Interrupted by the user after {duration}; do not repeat it. If they were talking to you, their words arrive through agent_next."
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
        return "Siren status unknown.".into();
    }
    let engine = match status.get("engine") {
        Some(Value::String(id)) if id == "kokoro" => "Kokoro".to_owned(),
        Some(Value::String(id)) if id == "chatterbox-turbo" => "Chatterbox Turbo".to_owned(),
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(other),
    };
    let mut parts = Vec::new();
    if !truthy(status.get("enabled")) {
        parts.push("Siren is turned off in Delulu Talks.".to_owned());
    } else if !truthy(status.get("ready")) {
        let name = if engine.is_empty() { "the engine" } else { engine.as_str() };
        parts.push(format!("Siren is on; {name} is not ready yet."));
    } else {
        parts.push(format!("Siren is on and {engine} is ready."));
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
            name if inbox_method(name).is_some() => match call_inbox(bridge, name, args.clone(), MCP_WAIT_MS, false).await {
                Ok(value) => Ok(json_result(value)),
                Err(error) if error.code == "INVALID_REQUEST" => Err(ToolError::Rpc(RpcError::new(-32602, error.message))),
                Err(error) => Err(ToolError::Bridge(error)),
            },
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
            let mut reply = text_result(&error.message, true);
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
        "serverInfo": { "name": "delulu-voice", "title": "Delulu Siren", "version": version },
        "instructions": format!("{instructions}\n\n{INBOX_INSTRUCTIONS}"),
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

fn print_json(value: &Value, stream: &mut String) {
    stream.push_str(&value.to_string());
    stream.push('\n');
}

/// `agent …`, `task …` and `talk …`: strict options, one JSON object out.
/// Both `--key value` and `--key=value` keep the value text unchanged.
async fn inbox_cli(bridge: &Path, group: &str, rest: &[String], out: &mut CliOutput) -> Result<i32, ClientError> {
    let invalid = |message: String| ClientError::new(message, "INVALID_REQUEST");
    let action = rest.first().map(String::as_str).unwrap_or("");
    let name = format!("{group}_{action}");
    let Some(schema) = inbox_method(&name).and_then(|_| inbox_schema(&name)) else {
        let shown = if action.is_empty() { "(none)" } else { action };
        return Err(invalid(format!("Unknown {group} command: {shown}. See mcp --help.")));
    };
    let properties = schema["properties"].as_object().expect("properties");
    let mut args = Map::new();
    let mut index = 1;
    while index < rest.len() {
        let raw = &rest[index];
        let (flag, inline) = match raw.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_owned())),
            None => (raw.as_str(), None),
        };
        let key = FLAGS
            .iter()
            .find(|(known, key)| *known == flag && properties.contains_key(*key))
            .map(|(_, key)| *key)
            .ok_or_else(|| invalid(format!("Unknown {group} {action} option: {flag}.")))?;
        let value = match inline {
            Some(value) => value,
            None => {
                index += 1;
                rest.get(index)
                    .filter(|value| !value.starts_with("--"))
                    .cloned()
                    .ok_or_else(|| invalid(format!("{flag} requires a value.")))?
            }
        };
        if args.contains_key(key) {
            return Err(invalid(format!("{flag} was supplied more than once.")));
        }
        let value = match key {
            "after" => json!(value
                .parse::<u64>()
                .map_err(|_| invalid("--after must be a nonnegative integer (u64).".into()))?),
            "timeoutMs" => {
                let seconds =
                    value.parse::<f64>().map_err(|_| invalid("--timeout must be a number of seconds.".into()))?;
                if !seconds.is_finite() || !(0.0..=MAX_WAIT_SECONDS as f64).contains(&seconds) {
                    return Err(invalid(format!("--timeout must be between 0 and {MAX_WAIT_SECONDS} seconds.")));
                }
                json!((seconds * 1000.0).round() as u64)
            }
            _ => json!(value),
        };
        args.insert(key.into(), value);
        index += 1;
    }
    // Being killed closes the connection; the app keeps the event queued.
    let result = call_inbox(bridge, &name, args, DEFAULT_WAIT_SECONDS * 1000, true).await?;
    print_json(&result, &mut out.stdout);
    Ok(if name == "agent_next" {
        match result.get("status").and_then(Value::as_str) {
            Some("timeout") => EXIT_TIMEOUT,
            Some("stopped") => EXIT_STOPPED,
            _ => EXIT_EVENT,
        }
    } else {
        0
    })
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
            out.stderr.push_str(&format!("Unknown option: {value}\n\n{}", usage()));
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
        out.stderr.push_str(LISTEN_REPLACED);
        out.code = 1;
        return out;
    }
    if matches!(command, "agent" | "task" | "talk" | "coordinator") {
        let result = match command {
            "coordinator" if rest.first().is_some_and(|action| action == "status") => {
                inbox_cli(bridge, "talk", rest, &mut out).await
            }
            "coordinator" => Err(ClientError::new(COORDINATOR_REPLACED, "INVALID_REQUEST")),
            group => inbox_cli(bridge, group, rest, &mut out).await,
        };
        out.code = match result {
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
            out.stdout.push_str(&usage());
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
            out.stderr.push_str(&format!("Unknown command: {other}\n\n{}", usage()));
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
