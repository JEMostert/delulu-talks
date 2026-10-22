//! The agent side of the bridge (the `call` function of
//! `delulu-voice-mcp.mjs`): one request per connection, answered with one
//! JSON line. `bridge.json` is read on every call because the token changes
//! when the app restarts.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub const NOT_RUNNING: &str = "Delulu Talks isn't running, or agent voice is turned off in its Voice page.";
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(2_000);
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(30_000);
/// Waiting for speech covers the queue ahead of it as well as its own audio.
pub const WAIT_TIMEOUT: Duration = Duration::from_millis(15 * 60_000);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// A refusal or transport failure; `code` is the bridge error code, or
/// `VOICE_UNAVAILABLE` / `CANCELLED` / `INVALID_REQUEST` from the client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub message: String,
    pub code: String,
}

impl ClientError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { message: message.into(), code: code.into() }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(message, "VOICE_UNAVAILABLE")
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

struct Bridge {
    endpoint: String,
    token: String,
}

fn read_bridge(file: &Path) -> Result<Bridge, ClientError> {
    let text = std::fs::read_to_string(file).map_err(|_| ClientError::unavailable(NOT_RUNNING))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| ClientError::unavailable(NOT_RUNNING))?;
    match (
        value.get("protocol").and_then(Value::as_f64),
        value.get("endpoint").and_then(Value::as_str),
        value.get("token").and_then(Value::as_str),
    ) {
        (Some(1.0), Some(endpoint), Some(token)) => {
            Ok(Bridge { endpoint: endpoint.to_owned(), token: token.to_owned() })
        }
        _ => Err(ClientError::unavailable(
            "Delulu Talks wrote a bridge file this script does not understand. Update the agent setup from the Voice page.",
        )),
    }
}

/// Sends `method` with `params` and returns the result. Cancelling `cancel`
/// closes the connection; the app keeps anything it queued.
pub async fn call(
    bridge_file: &Path,
    method: &str,
    params: Value,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
) -> Result<Value, ClientError> {
    let bridge = read_bridge(bridge_file)?;
    let id = delulu_core::uuid();
    let request = json!({ "v": 1, "id": id, "token": bridge.token, "method": method, "params": params });
    let work = async {
        #[cfg(unix)]
        let stream = connect_unix(&bridge.endpoint).await?;
        #[cfg(windows)]
        let stream = connect_pipe(&bridge.endpoint).await?;
        exchange(stream, &id, &request, timeout).await
    };
    match cancel {
        None => work.await,
        Some(token) => tokio::select! {
            result = work => result,
            _ = token.cancelled() => Err(ClientError::new("Cancelled; nothing was lost.", "CANCELLED")),
        },
    }
}

#[cfg(unix)]
async fn connect_unix(endpoint: &str) -> Result<tokio::net::UnixStream, ClientError> {
    match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::UnixStream::connect(endpoint)).await {
        Ok(Ok(stream)) => Ok(stream),
        _ => Err(ClientError::unavailable(NOT_RUNNING)),
    }
}

#[cfg(windows)]
async fn connect_pipe(endpoint: &str) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, ClientError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => return Ok(client),
            // ERROR_PIPE_BUSY: every instance is taken; wait for one.
            Err(error) if error.raw_os_error() == Some(231) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => return Err(ClientError::unavailable(NOT_RUNNING)),
        }
    }
}

async fn exchange<S>(mut stream: S, id: &str, request: &Value, timeout: Duration) -> Result<Value, ClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut line = request.to_string();
    line.push('\n');
    let conversation = async {
        stream.write_all(line.as_bytes()).await.map_err(|_| ClientError::unavailable(NOT_RUNNING))?;
        let mut received: Vec<u8> = Vec::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = match stream.read(&mut buffer).await {
                Ok(0) => return Err(ClientError::unavailable("Delulu Talks closed the connection.")),
                Ok(count) => count,
                Err(_) => return Err(ClientError::unavailable(NOT_RUNNING)),
            };
            received.extend_from_slice(&buffer[..count]);
            if received.len() > MAX_RESPONSE_BYTES {
                return Err(ClientError::unavailable("Delulu Talks sent an oversized response."));
            }
            while let Some(newline) = received.iter().position(|byte| *byte == b'\n') {
                let raw: Vec<u8> = received.drain(..=newline).collect();
                let text = String::from_utf8_lossy(&raw[..newline]);
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let response: Value = serde_json::from_str(text)
                    .map_err(|_| ClientError::unavailable("Delulu Talks sent an unreadable response."))?;
                let matches = match response.get("id") {
                    Some(Value::String(value)) => value == id,
                    Some(Value::Null) | None => true,
                    _ => false,
                };
                if !matches {
                    continue;
                }
                if response.get("ok").and_then(Value::as_bool) == Some(true) {
                    return Ok(response.get("result").cloned().unwrap_or(Value::Null));
                }
                let error = response.get("error");
                let message = error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                    .unwrap_or("Delulu Talks refused the request.");
                let code = error.and_then(|error| error.get("code")).and_then(Value::as_str).unwrap_or("VOICE_UNAVAILABLE");
                return Err(ClientError::new(message, code));
            }
        }
    };
    match tokio::time::timeout(timeout, conversation).await {
        Ok(result) => result,
        Err(_) => Err(ClientError::unavailable("Delulu Talks did not answer in time.")),
    }
}
