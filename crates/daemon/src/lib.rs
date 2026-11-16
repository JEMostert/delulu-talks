//! The Delulu Talks daemon (`delulud daemon`) and its command line client.
//!
//! It serves the protocol from `delulu-proto` on a Unix socket and runs the
//! dictation state machine from `delulu-core`. With `DELULU_DAEMON=1` it owns
//! dictation end to end ([`live`] over [`desktop`]): shortcut, microphone,
//! speech recognition, cleanup, typing and History. Without the flag dictation
//! still lives in the desktop app; in `--demo` mode a fake engine drives the
//! machine so the UI can run against the real protocol.

pub mod client;
pub mod demo;
pub mod desktop;
pub mod instance;
pub mod live;
pub mod logger;
pub mod server;
pub mod wire;

use std::path::PathBuf;

/// The socket path: `$XDG_RUNTIME_DIR/delulu-talks/daemon.sock`.
pub fn default_socket() -> Result<PathBuf, String> {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) if !dir.is_empty() => Ok(delulu_proto::socket_path(dir.as_ref())),
        _ => Err("XDG_RUNTIME_DIR is not set; pass --socket <path>".into()),
    }
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
