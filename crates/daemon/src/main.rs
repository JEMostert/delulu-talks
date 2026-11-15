//! `delulud`: the Delulu Talks daemon and its command line client.

use delulu_daemon::client::{Client, ClientError};
use delulu_daemon::instance::{BindError, Instance};
use delulu_daemon::server::{Daemon, Options};
use delulu_proto::api::{ErrorCode, Event, GetStateParams, SubscribeParams, ToggleParams, Topic};
use delulu_proto::state::DaemonMode;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage: delulud <command> [--socket <path>]

commands:
  daemon [--demo] [--still]   serve the API socket (--demo: canned state and a fake
                              engine; --still: demo without background changes)
  state                       print the state snapshot as JSON
  toggle                      start or stop dictation
  events [<topic>…]           print events as they arrive (default: all topics)

The socket defaults to $XDG_RUNTIME_DIR/delulu-talks/daemon.sock.";

struct Args {
    command: String,
    socket: Option<PathBuf>,
    demo: bool,
    still: bool,
    rest: Vec<String>,
}

fn parse(args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        command: String::new(),
        socket: None,
        demo: false,
        still: false,
        rest: Vec::new(),
    };
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                parsed.socket = Some(args.next().ok_or("--socket needs a path")?.into());
            }
            "--demo" => parsed.demo = true,
            "--still" => parsed.still = true,
            flag if flag.starts_with('-') => return Err(format!("unknown option {flag}")),
            _ if parsed.command.is_empty() => parsed.command = arg,
            _ => parsed.rest.push(arg),
        }
    }
    if parsed.command.is_empty() {
        return Err("missing command".into());
    }
    if (parsed.demo || parsed.still) && parsed.command != "daemon" {
        return Err("--demo and --still only apply to `daemon`".into());
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let mut raw = std::env::args().skip(1).peekable();
    match raw.peek().map(String::as_str) {
        Some("--version" | "-V") => {
            println!("delulud {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("--help" | "-h" | "help") | None => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        _ => {}
    }
    let args = match parse(raw) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("delulud: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let socket = match args
        .socket
        .clone()
        .map(Ok)
        .unwrap_or_else(delulu_daemon::default_socket)
    {
        Ok(socket) => socket,
        Err(e) => {
            eprintln!("delulud: {e}");
            return ExitCode::from(2);
        }
    };
    let result = match args.command.as_str() {
        "daemon" => return daemon(socket, &args),
        "state" => state(&socket),
        "toggle" => toggle(&socket),
        "events" => events(&socket, &args.rest),
        other => {
            eprintln!("delulud: unknown command {other}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("delulud: {e}");
            match e {
                ClientError::NotRunning(_) => ExitCode::from(3),
                ClientError::Api(e) if e.code == ErrorCode::NotAvailable => ExitCode::from(4),
                _ => ExitCode::FAILURE,
            }
        }
    }
}

fn daemon(socket: PathBuf, args: &Args) -> ExitCode {
    let mut instance = match Instance::bind(&socket) {
        Ok(instance) => instance,
        Err(e @ BindError::AlreadyRunning(_)) => {
            eprintln!("delulud: {e}");
            return ExitCode::from(3);
        }
        Err(e) => {
            eprintln!("delulud: cannot listen: {e}");
            return ExitCode::FAILURE;
        }
    };
    let opts = Options {
        mode: if args.demo {
            DaemonMode::Demo
        } else {
            DaemonMode::Normal
        },
        script: !args.still,
        ..Options::default()
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("delulud: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        let listener = tokio::net::UnixListener::from_std(
            instance
                .take_listener()
                .expect("fresh instance has a listener"),
        )?;
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        eprintln!(
            "delulud: listening on {} ({})",
            instance.path().display(),
            if args.demo { "demo" } else { "normal" }
        );
        let daemon = Daemon::new(opts);
        daemon
            .serve(listener, async {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                }
            })
            .await;
        std::io::Result::Ok(())
    });
    drop(runtime);
    // Removes the socket file while still holding the lock.
    drop(instance);
    match result {
        Ok(()) => {
            eprintln!("delulud: stopped");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("delulud: {e}");
            ExitCode::FAILURE
        }
    }
}

fn state(socket: &std::path::Path) -> Result<(), ClientError> {
    let mut client = Client::connect(socket, "cli")?;
    let state = client.call(GetStateParams {})?;
    println!(
        "{}",
        serde_json::to_string_pretty(&state).map_err(|e| ClientError::Protocol(e.to_string()))?
    );
    Ok(())
}

fn toggle(socket: &std::path::Path) -> Result<(), ClientError> {
    let mut client = Client::connect(socket, "cli")?;
    let reply = client.call(ToggleParams {})?;
    println!(
        "{}",
        serde_json::to_string(&reply).map_err(|e| ClientError::Protocol(e.to_string()))?
    );
    Ok(())
}

fn events(socket: &std::path::Path, topics: &[String]) -> Result<(), ClientError> {
    let topics = if topics.is_empty() {
        Topic::ALL.to_vec()
    } else {
        topics
            .iter()
            .map(
                |t| match serde_json::from_value(serde_json::Value::String(t.clone())) {
                    Ok(Topic::Unknown) | Err(_) => {
                        Err(ClientError::Protocol(format!("unknown topic {t}")))
                    }
                    Ok(topic) => Ok(topic),
                },
            )
            .collect::<Result<_, _>>()?
    };
    let mut client = Client::connect(socket, "cli")?;
    client.call(SubscribeParams { topics })?;
    client.set_timeout(None)?;
    loop {
        let event = client.next_event()?;
        println!(
            "{}",
            serde_json::to_string(&event).map_err(|e| ClientError::Protocol(e.to_string()))?
        );
        if event.event == Event::ShuttingDown {
            return Ok(());
        }
    }
}
