//! A small blocking client for the CLI and tests.

use delulu_proto::api::*;
use delulu_proto::PROTOCOL_VERSION;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
pub enum ClientError {
    /// No daemon listens on the socket.
    NotRunning(PathBuf),
    Io(io::Error),
    /// The daemon answered with an error.
    Api(ApiError),
    /// The daemon sent something this client cannot read.
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::NotRunning(path) => write!(
                f,
                "the daemon is not running (nothing listens on {})",
                path.display()
            ),
            ClientError::Io(e) => write!(f, "{e}"),
            ClientError::Api(e) => write!(f, "{e}"),
            ClientError::Protocol(e) => write!(f, "unexpected reply from the daemon: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<io::Error> for ClientError {
    fn from(e: io::Error) -> Self {
        ClientError::Io(e)
    }
}

pub struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
    /// Events that arrived while waiting for a reply.
    events: VecDeque<EventMessage>,
}

impl Client {
    /// Connects and says hello.
    pub fn connect(path: &Path, client: &str) -> Result<Self, ClientError> {
        let stream = UnixStream::connect(path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                ClientError::NotRunning(path.to_owned())
            }
            _ => ClientError::Io(e),
        })?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        let mut this = Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: stream,
            next_id: 0,
            events: VecDeque::new(),
        };
        this.call(HelloParams {
            protocol: PROTOCOL_VERSION,
            client: client.into(),
            client_version: Some(env!("CARGO_PKG_VERSION").into()),
        })?;
        Ok(this)
    }

    /// `None` waits forever.
    pub fn set_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.writer.set_read_timeout(timeout)
    }

    pub fn call<M: Method>(&mut self, params: M) -> Result<M::Result, ClientError> {
        self.next_id += 1;
        let id = self.next_id;
        let request = RequestMessage::new(id, &params.into_request());
        let mut line =
            serde_json::to_string(&request).map_err(|e| ClientError::Protocol(e.to_string()))?;
        line.push('\n');
        self.writer.write_all(line.as_bytes())?;
        loop {
            match self.read()? {
                ServerMessage::Event(event) => self.events.push_back(event),
                ServerMessage::Result(reply) if reply.id == id => {
                    return serde_json::from_value(reply.result)
                        .map_err(|e| ClientError::Protocol(e.to_string()));
                }
                ServerMessage::Error(reply) if reply.id == Some(id) || reply.id.is_none() => {
                    return Err(ClientError::Api(reply.error));
                }
                other => {
                    return Err(ClientError::Protocol(format!(
                        "reply for another request: {other:?}"
                    )))
                }
            }
        }
    }

    /// The next event, waiting for one if none is buffered.
    pub fn next_event(&mut self) -> Result<EventMessage, ClientError> {
        if let Some(event) = self.events.pop_front() {
            return Ok(event);
        }
        match self.read()? {
            ServerMessage::Event(event) => Ok(event),
            other => Err(ClientError::Protocol(format!(
                "unrequested reply: {other:?}"
            ))),
        }
    }

    fn read(&mut self) -> Result<ServerMessage, ClientError> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(ClientError::Io(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the daemon closed the connection",
            )));
        }
        serde_json::from_str(&line).map_err(|e| ClientError::Protocol(format!("{e}: {line}")))
    }
}
