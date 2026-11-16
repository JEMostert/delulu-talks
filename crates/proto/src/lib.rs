//! The Delulu Talks wire protocol.
//!
//! Two protocols live here:
//!
//! * [`api`]: daemon ⇄ clients (the UI window, the CLI, the pill). Newline-delimited
//!   JSON over a Unix socket at `$XDG_RUNTIME_DIR/delulu-talks/daemon.sock`.
//!   Requests carry ids, replies carry the same id, errors carry stable codes, and
//!   `subscribe` turns the connection into an event stream as well.
//! * [`worker`]: daemon ⇄ engine workers (`delulu-engine <role>`), over the worker's
//!   stdin/stdout.
//!
//! [`state`] holds the full application snapshot the UI renders. Its TypeScript
//! twin is generated into `ui/src/generated/proto.ts` by [`ts::typescript`].
//!
//! Compatibility rules for protocol 1: readers ignore unknown fields, new fields are
//! added with defaults, and anything that would break an older reader bumps
//! [`PROTOCOL_VERSION`].

pub mod api;
pub mod framing;
pub mod state;
pub mod ts;
pub mod worker;

/// The client API version. A client and daemon must agree on it in `hello`.
pub const PROTOCOL_VERSION: u32 = 1;

/// The `client` name the Delulu Talks window says in `hello`. While a window is
/// connected under this name it is a client and holds no shortcut, so the daemon
/// may bind the shortcut although the app's single-instance name is taken.
pub const APP_CLIENT: &str = "app";

/// Directory under `$XDG_RUNTIME_DIR` that holds the daemon socket.
pub const RUNTIME_SUBDIR: &str = "delulu-talks";
/// File name of the daemon socket.
pub const SOCKET_NAME: &str = "daemon.sock";

/// Where the daemon listens, given the value of `$XDG_RUNTIME_DIR`.
pub fn socket_path(runtime_dir: &std::path::Path) -> std::path::PathBuf {
    runtime_dir.join(RUNTIME_SUBDIR).join(SOCKET_NAME)
}
