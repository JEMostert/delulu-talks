//! Local agent bridge (`electron/services/voiceBridge.ts`): coding agents
//! reach Delulu Voice through a Unix socket (a named pipe on Windows) that
//! only this user can open. `bridge.json` beside it holds the endpoint and a
//! per-start token; `delulu-talks mcp` reads it and sends newline-delimited
//! JSON requests.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use delulu_core::util::{create_private, truncate_utf16, utf16_len};
use delulu_core::{DomainError, DomainErrorCode};
use delulu_domain::js;
use delulu_domain::voice::{
    VoiceBridgeStatus, VoiceEngineId, VoiceQueued, VoiceSource, VoiceSpeakRequest, VoiceSpeakResult,
    VOICE_AGENT_INSTRUCTIONS, VOICE_LIMITS,
};
use parking_lot::Mutex;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::host::BoxFuture;
use crate::service::{create_private_dir, group_thousands};

pub const VOICE_BRIDGE_PROTOCOL: u64 = 1;
pub const VOICE_BRIDGE_FILE: &str = "bridge.json";
const SOCKET_FILE: &str = "agent.sock";
pub const MAX_LINE_BYTES: usize = 256 * 1024;
pub const MAX_CLIENTS: usize = 16;
pub const MAX_IN_FLIGHT: usize = 4;
const MAX_ID_BYTES: usize = 128;
const MAX_AGENT_CHARACTERS: usize = 64;
const MAX_ERROR_CHARACTERS: usize = 2_000;
// sun_path holds 108 bytes on Linux and 104 on macOS, including the NUL.
const MAX_SOCKET_PATH_BYTES: usize = 100;

/// What `status` and `hello` report to agents.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceBridgeSnapshot {
    pub enabled: bool,
    pub ready: bool,
    pub engine: VoiceEngineId,
    pub speaking: bool,
    pub queued: u64,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BridgeErrorCode {
    Unauthorized,
    InvalidRequest,
    VoiceUnavailable,
    Internal,
}

/// Handlers return this to choose the code an agent receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: BridgeErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(BridgeErrorCode::InvalidRequest, message)
    }
}

/// A handler that refuses (voice off, not set up) reports why, unchanged;
/// rejected arguments stay `INVALID_REQUEST`.
impl From<DomainError> for BridgeError {
    fn from(error: DomainError) -> Self {
        let code = match error.code {
            DomainErrorCode::InvalidRequest => BridgeErrorCode::InvalidRequest,
            _ => BridgeErrorCode::VoiceUnavailable,
        };
        Self::new(code, error.message)
    }
}

/// `speak` returns the queue position, or the result when `wait` is true.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SpeakReply {
    Queued(VoiceQueued),
    Done(VoiceSpeakResult),
}

pub type BridgeResult<T> = Result<T, BridgeError>;

/// Methods [`BridgeHandlers::dispatch`] serves: the agent inbox and the talk loop.
pub const INBOX_METHODS: [&str; 7] =
    ["agent.register", "agent.next", "agent.ack", "agent.unregister", "task.status", "task.update", "talk.status"];
/// Routes a finished utterance through the talk loop; debug builds only.
pub const INJECT_METHOD: &str = "talk.inject";

/// What the bridge calls; the app's implementation is in [`crate::system`].
pub trait BridgeHandlers: Send + Sync + 'static {
    fn speak(&self, request: VoiceSpeakRequest, wait: bool) -> BoxFuture<'static, BridgeResult<SpeakReply>>;
    fn stop(&self) -> BoxFuture<'static, BridgeResult<()>>;
    fn status(&self) -> VoiceBridgeSnapshot;
    /// One of [`INBOX_METHODS`] (or [`INJECT_METHOD`] in debug builds).
    /// `cancel` fires when the agent disconnects.
    fn dispatch(&self, method: String, params: Value, cancel: CancellationToken) -> BoxFuture<'static, BridgeResult<Value>>;
}

/// The socket path (or pipe name) for a voice directory.
pub fn bridge_endpoint(directory: &Path) -> String {
    let digest = hex::encode(Sha256::digest(directory.to_string_lossy().as_bytes()));
    let digest = &digest[..12];
    if cfg!(windows) {
        return format!(r"\\.\pipe\delulu-talks-voice-{digest}");
    }
    let socket = directory.join(SOCKET_FILE);
    if socket.as_os_str().len() <= MAX_SOCKET_PATH_BYTES {
        return socket.to_string_lossy().into_owned();
    }
    // A very long profile path cannot hold a socket; the token still guards it.
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join(format!("delulu-talks-voice-{digest}.sock")).to_string_lossy().into_owned()
}

fn same_token(expected: &str, actual: Option<&Value>) -> bool {
    let Some(Value::String(actual)) = actual else {
        return false;
    };
    // Hash first so different lengths still take the constant-time path.
    let (a, b) = (Sha256::digest(expected.as_bytes()), Sha256::digest(actual.as_bytes()));
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn failure(id: Option<&str>, code: BridgeErrorCode, message: &str) -> Value {
    json!({
        "v": VOICE_BRIDGE_PROTOCOL,
        "id": id,
        "ok": false,
        "error": { "code": code, "message": truncate_utf16(message, MAX_ERROR_CHARACTERS) },
    })
}

fn line(value: &Value) -> String {
    let mut text = serde_json::to_string(value).unwrap_or_else(|_| {
        failure(None, BridgeErrorCode::Internal, "Delulu Talks produced an unreadable response.").to_string()
    });
    text.push('\n');
    text
}

fn is_response_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn parse_speak(params: &Map<String, Value>) -> BridgeResult<(VoiceSpeakRequest, bool)> {
    let text = match params.get("text") {
        Some(Value::String(text)) if !js::trim(text).is_empty() => text.clone(),
        _ => return Err(BridgeError::invalid("speak needs nonempty text")),
    };
    if utf16_len(&text) > VOICE_LIMITS.request_characters {
        return Err(BridgeError::invalid(format!(
            "speak text is limited to {} characters",
            group_thousands(VOICE_LIMITS.request_characters)
        )));
    }
    let flag = |key: &str| -> BridgeResult<Option<bool>> {
        match params.get(key) {
            None => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(BridgeError::invalid(format!("{key} must be a boolean"))),
        }
    };
    let interrupt = flag("interrupt")?;
    let wait = flag("wait")?;
    let normalize = flag("normalize")?;
    let agent = match params.get("agent") {
        None => "",
        Some(Value::String(agent)) => agent.as_str(),
        Some(_) => return Err(BridgeError::invalid("agent must be text")),
    };
    let label = match truncate_utf16(js::trim(agent), MAX_AGENT_CHARACTERS) {
        "" => "Agent".to_owned(),
        label => label.to_owned(),
    };
    let response_id = match params.get("responseId") {
        None => None,
        Some(Value::String(id)) if is_response_id(id) => Some(id.clone()),
        Some(_) => {
            return Err(BridgeError::invalid("responseId must be 1–128 characters of letters, digits, _ . : or -"))
        }
    };
    Ok((
        VoiceSpeakRequest {
            text,
            source: Some(VoiceSource::Agent),
            agent: Some(label),
            interrupt,
            normalize,
            response_id,
        },
        wait == Some(true),
    ))
}

fn to_value<T: Serialize>(value: T) -> BridgeResult<Value> {
    serde_json::to_value(value).map_err(|error| BridgeError::new(BridgeErrorCode::Internal, error.to_string()))
}

enum Outgoing {
    Line(String),
    /// Write a final line and close.
    End(String),
}

struct Server {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

type StatusCallback = Box<dyn Fn(VoiceBridgeStatus) + Send + Sync>;

struct Shared {
    directory: PathBuf,
    app_version: String,
    handlers: Arc<dyn BridgeHandlers>,
    on_status: StatusCallback,
    token: Mutex<String>,
    status: Mutex<VoiceBridgeStatus>,
    running: Mutex<bool>,
    connections: Mutex<HashMap<u64, CancellationToken>>,
    next_connection: AtomicU64,
}

pub struct VoiceBridge {
    shared: Arc<Shared>,
    server: tokio::sync::Mutex<Option<Server>>,
}

impl VoiceBridge {
    pub fn new(
        directory: PathBuf,
        app_version: impl Into<String>,
        handlers: Arc<dyn BridgeHandlers>,
        on_status: impl Fn(VoiceBridgeStatus) + Send + Sync + 'static,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                directory,
                app_version: app_version.into(),
                handlers,
                on_status: Box::new(on_status),
                token: Mutex::new(String::new()),
                status: Mutex::new(VoiceBridgeStatus {
                    enabled: false,
                    listening: false,
                    clients: 0,
                    endpoint: None,
                    error: None,
                }),
                running: Mutex::new(false),
                connections: Mutex::new(HashMap::new()),
                next_connection: AtomicU64::new(1),
            }),
            server: tokio::sync::Mutex::new(None),
        }
    }

    pub fn status(&self) -> VoiceBridgeStatus {
        self.shared.status.lock().clone()
    }

    fn bridge_file(&self) -> PathBuf {
        self.shared.directory.join(VOICE_BRIDGE_FILE)
    }

    /// Starts listening; a running bridge is left alone.
    pub async fn start(&self) -> Result<(), String> {
        let mut server = self.server.lock().await;
        if server.is_some() {
            return Ok(());
        }
        let endpoint = bridge_endpoint(&self.shared.directory);
        self.shared.update(|status| {
            status.enabled = true;
            status.endpoint = Some(endpoint.clone());
            status.error = None;
        });
        match self.listen(&endpoint).await {
            Ok(started) => {
                *server = Some(started);
                *self.shared.running.lock() = true;
                self.shared.update(|status| {
                    status.listening = true;
                    status.error = None;
                });
                Ok(())
            }
            Err(message) => {
                self.shared.token.lock().clear();
                self.shared.update(|status| {
                    status.listening = false;
                    status.error = Some(message.clone());
                });
                Err(message)
            }
        }
    }

    async fn listen(&self, endpoint: &str) -> Result<Server, String> {
        let directory = &self.shared.directory;
        create_private_dir(directory).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, PermissionsExt};
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
            if let Ok(metadata) = std::fs::symlink_metadata(endpoint) {
                if !metadata.file_type().is_socket() {
                    return Err(format!(
                        "{endpoint} exists and is not a socket. Move it away and turn agent voice on again."
                    ));
                }
                if socket_answers(endpoint).await {
                    return Err("Another Delulu Talks instance already serves agent voice.".into());
                }
                let _ = std::fs::remove_file(endpoint);
            }
        }
        let mut token = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut token);
        let token = hex::encode(token);
        *self.shared.token.lock() = token.clone();
        let shutdown = CancellationToken::new();
        let task = serve(self.shared.clone(), endpoint, shutdown.clone())?;
        #[cfg(unix)]
        let published = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())
                .and_then(|()| self.write_bridge_file(endpoint, &token))
        };
        #[cfg(not(unix))]
        let published = self.write_bridge_file(endpoint, &token);
        // Publish the endpoint only once it accepts connections.
        if let Err(error) = published {
            shutdown.cancel();
            task.abort();
            let _ = task.await;
            #[cfg(unix)]
            let _ = std::fs::remove_file(endpoint);
            return Err(error);
        }
        Ok(Server { shutdown, task })
    }

    fn write_bridge_file(&self, endpoint: &str, token: &str) -> Result<(), String> {
        let mut suffix = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut suffix);
        let temporary = self.shared.directory.join(format!(".bridge-{}.tmp", hex::encode(suffix)));
        let contents = serde_json::to_string_pretty(&json!({
            "protocol": VOICE_BRIDGE_PROTOCOL,
            "endpoint": endpoint,
            "token": token,
            "pid": std::process::id(),
            "appVersion": self.shared.app_version,
        }))
        .map_err(|error| error.to_string())?;
        let result = (|| {
            let mut file = create_private(&temporary)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temporary, self.bridge_file())
        })();
        result.map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            error.to_string()
        })
    }

    pub async fn stop(&self) {
        let mut guard = self.server.lock().await;
        let server = guard.take();
        let had_server = server.is_some();
        #[cfg(not(unix))]
        let _ = had_server;
        *self.shared.running.lock() = false;
        if let Some(server) = server {
            server.shutdown.cancel();
            server.task.abort();
            let _ = server.task.await;
        }
        for (_, connection) in self.shared.connections.lock().drain() {
            connection.cancel();
        }
        // Leave a file written by a newer start alone.
        let token = std::mem::take(&mut *self.shared.token.lock());
        if let Ok(text) = std::fs::read_to_string(self.bridge_file()) {
            let saved: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if saved.get("token").and_then(Value::as_str) == Some(token.as_str()) {
                let _ = std::fs::remove_file(self.bridge_file());
            }
        }
        #[cfg(unix)]
        if had_server {
            use std::os::unix::fs::FileTypeExt;
            if let Some(endpoint) = self.shared.status.lock().endpoint.clone() {
                if std::fs::symlink_metadata(&endpoint).is_ok_and(|metadata| metadata.file_type().is_socket()) {
                    let _ = std::fs::remove_file(&endpoint);
                }
            }
        }
        self.shared.update(|status| {
            status.enabled = false;
            status.listening = false;
            status.clients = 0;
            status.endpoint = None;
        });
    }
}

/// Whether something is accepting connections at a Unix socket path.
#[cfg(unix)]
async fn socket_answers(path: &str) -> bool {
    matches!(
        tokio::time::timeout(std::time::Duration::from_millis(500), tokio::net::UnixStream::connect(path)).await,
        Ok(Ok(_))
    )
}

#[cfg(unix)]
fn serve(shared: Arc<Shared>, endpoint: &str, shutdown: CancellationToken) -> Result<JoinHandle<()>, String> {
    let listener = tokio::net::UnixListener::bind(endpoint).map_err(|error| error.to_string())?;
    Ok(tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => shared.accept(stream, shutdown.child_token()),
                    Err(error) => {
                        log::warn!("voice bridge accept failed: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                },
            }
        }
    }))
}

#[cfg(windows)]
fn serve(shared: Arc<Shared>, endpoint: &str, shutdown: CancellationToken) -> Result<JoinHandle<()>, String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let endpoint = endpoint.to_owned();
    let first = ServerOptions::new().first_pipe_instance(true).create(&endpoint).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            "Another Delulu Talks instance already serves agent voice.".to_owned()
        } else {
            error.to_string()
        }
    })?;
    Ok(tokio::spawn(async move {
        let mut server = first;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                connected = server.connect() => {
                    if let Err(error) = connected {
                        log::warn!("voice bridge accept failed: {error}");
                    }
                    let next = match ServerOptions::new().create(&endpoint) {
                        Ok(next) => next,
                        Err(error) => {
                            log::warn!("voice bridge could not create a pipe instance: {error}");
                            break;
                        }
                    };
                    let client = std::mem::replace(&mut server, next);
                    shared.accept(client, shutdown.child_token());
                }
            }
        }
    }))
}

impl Shared {
    fn update(&self, patch: impl FnOnce(&mut VoiceBridgeStatus)) {
        let next = {
            let mut status = self.status.lock();
            let mut next = status.clone();
            patch(&mut next);
            if next == *status {
                return;
            }
            *status = next.clone();
            next
        };
        (self.on_status)(next);
    }

    fn accept<S>(self: &Arc<Self>, stream: S, token: CancellationToken)
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let id = {
            let mut connections = self.connections.lock();
            if connections.len() >= MAX_CLIENTS {
                drop(connections);
                let refusal = line(&failure(
                    None,
                    BridgeErrorCode::InvalidRequest,
                    "Too many agent connections are open. Close one and retry.",
                ));
                tokio::spawn(async move {
                    let mut stream = stream;
                    let _ = stream.write_all(refusal.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
                return;
            }
            let id = self.next_connection.fetch_add(1, Ordering::Relaxed);
            connections.insert(id, token.clone());
            id
        };
        let clients = self.connections.lock().len() as u64;
        self.update(|status| status.clients = clients);
        let shared = self.clone();
        tokio::spawn(async move {
            shared.clone().connection(stream, token.clone()).await;
            // A disconnected waiter gives up; its event stays queued for the next one.
            token.cancel();
            let clients = {
                let mut connections = shared.connections.lock();
                connections.remove(&id);
                connections.len() as u64
            };
            if *shared.running.lock() {
                shared.update(|status| status.clients = clients);
            }
        });
    }

    async fn connection<S>(self: Arc<Self>, stream: S, token: CancellationToken)
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (sender, mut outgoing) = mpsc::unbounded_channel::<Outgoing>();
        let writer_token = token.clone();
        let writer_task = tokio::spawn(async move {
            loop {
                let message = tokio::select! {
                    _ = writer_token.cancelled() => break,
                    message = outgoing.recv() => message,
                };
                match message {
                    Some(Outgoing::Line(text)) => {
                        if writer.write_all(text.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    Some(Outgoing::End(text)) => {
                        let _ = writer.write_all(text.as_bytes()).await;
                        let _ = writer.shutdown().await;
                        break;
                    }
                    None => break,
                }
            }
            writer_token.cancel();
        });
        let in_flight = Arc::new(AtomicUsize::new(0));
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut ending = false;
        'read: loop {
            let read = tokio::select! {
                _ = token.cancelled() => break,
                read = reader.read(&mut buffer) => read,
            };
            let chunk = match read {
                Ok(0) | Err(_) => break,
                Ok(count) => &buffer[..count],
            };
            let mut offset = 0;
            while offset < chunk.len() {
                let newline = chunk[offset..].iter().position(|byte| *byte == b'\n').map(|index| offset + index);
                let end = newline.unwrap_or(chunk.len());
                let part = &chunk[offset..end];
                if pending.len() + part.len() > MAX_LINE_BYTES {
                    let _ = sender.send(Outgoing::End(line(&failure(
                        None,
                        BridgeErrorCode::InvalidRequest,
                        "Request line exceeds 256 KiB. Shorten the text and reconnect.",
                    ))));
                    ending = true;
                    break 'read;
                }
                pending.extend_from_slice(part);
                let Some(newline) = newline else { break };
                let text = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                offset = newline + 1;
                let text = js::trim(&text);
                if !text.is_empty() {
                    self.handle_line(text, &sender, &in_flight, &token);
                }
            }
        }
        drop(sender);
        if !ending {
            // The agent went away: waiting calls give up and nothing more is written.
            token.cancel();
        }
        let _ = writer_task.await;
    }

    fn handle_line(
        self: &Arc<Self>,
        text: &str,
        sender: &mpsc::UnboundedSender<Outgoing>,
        in_flight: &Arc<AtomicUsize>,
        connection: &CancellationToken,
    ) {
        let respond = |value: Value| {
            let _ = sender.send(Outgoing::Line(line(&value)));
        };
        let Ok(request) = serde_json::from_str::<Value>(text) else {
            return respond(failure(None, BridgeErrorCode::InvalidRequest, "Request is not valid JSON."));
        };
        let object = request.as_object();
        let id = object
            .and_then(|object| object.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= MAX_ID_BYTES)
            .map(str::to_owned);
        let version_ok = object.and_then(|object| object.get("v")).and_then(Value::as_f64) == Some(1.0);
        let (Some(object), true, Some(id)) = (object, version_ok, id.clone()) else {
            return respond(failure(
                id.as_deref(),
                BridgeErrorCode::InvalidRequest,
                &format!(
                    "Requests need v {VOICE_BRIDGE_PROTOCOL} and a string id of at most {MAX_ID_BYTES} bytes."
                ),
            ));
        };
        let token = self.token.lock().clone();
        if token.is_empty() || !same_token(&token, object.get("token")) {
            return respond(failure(
                Some(&id),
                BridgeErrorCode::Unauthorized,
                "The bridge token does not match. Delulu Talks may have restarted; read bridge.json again.",
            ));
        }
        let Some(method) = object.get("method").and_then(Value::as_str).map(str::to_owned) else {
            return respond(failure(Some(&id), BridgeErrorCode::InvalidRequest, "Requests need a method."));
        };
        let params = match object.get("params") {
            None => Map::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => {
                return respond(failure(Some(&id), BridgeErrorCode::InvalidRequest, "params must be an object."))
            }
        };
        if in_flight.load(Ordering::SeqCst) >= MAX_IN_FLIGHT {
            return respond(failure(
                Some(&id),
                BridgeErrorCode::InvalidRequest,
                &format!("At most {MAX_IN_FLIGHT} requests may wait on one connection."),
            ));
        }
        in_flight.fetch_add(1, Ordering::SeqCst);
        let shared = self.clone();
        let sender = sender.clone();
        let in_flight = in_flight.clone();
        let connection = connection.clone();
        tokio::spawn(async move {
            let response = match shared.dispatch(&method, &params, connection).await {
                Ok(result) => {
                    json!({ "v": VOICE_BRIDGE_PROTOCOL, "id": id, "ok": true, "result": result })
                }
                Err(error) => failure(Some(&id), error.code, &error.message),
            };
            in_flight.fetch_sub(1, Ordering::SeqCst);
            let _ = sender.send(Outgoing::Line(line(&response)));
        });
    }

    async fn dispatch(
        &self,
        method: &str,
        params: &Map<String, Value>,
        connection: CancellationToken,
    ) -> BridgeResult<Value> {
        let handlers = &self.handlers;
        match method {
            "hello" => Ok(json!({
                "app": "delulu-talks",
                "appVersion": self.app_version,
                "protocol": VOICE_BRIDGE_PROTOCOL,
                "instructions": VOICE_AGENT_INSTRUCTIONS,
                "status": to_value(handlers.status())?,
            })),
            "status" => to_value(handlers.status()),
            "speak" => {
                let (request, wait) = parse_speak(params)?;
                to_value(handlers.speak(request, wait).await?)
            }
            "stop" => {
                handlers.stop().await?;
                Ok(json!({ "stopped": true }))
            }
            method if INBOX_METHODS.contains(&method) || (cfg!(debug_assertions) && method == INJECT_METHOD) => {
                handlers.dispatch(method.into(), Value::Object(params.clone()), connection).await
            }
            method if method.starts_with("listen.") => Err(BridgeError::invalid(
                "Listening sessions were replaced by the agent inbox: use agent.register and agent.next.",
            )),
            method if method.starts_with("coordinator.") => {
                Err(BridgeError::invalid("The coordinator was replaced by Sonar: use talk.status and the agent inbox."))
            }
            other => Err(BridgeError::invalid(format!("Unknown method: {}", truncate_utf16(other, 64)))),
        }
    }
}
