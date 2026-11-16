//! The window as a client of the dictation daemon (`delulud`).
//!
//! When a daemon that runs dictation answers at start-up, or when
//! `DELULU_DAEMON=1` is set, the window does not run dictation itself: it opens
//! no store, no microphone and no portal, and binds no shortcut. Every command
//! the UI sends goes to the daemon's API, and the daemon's events come back as
//! the events the UI already listens to, in the shapes it already knows. The UI
//! cannot tell the two modes apart, except that Delulu FM is unavailable here
//! until it moves into the daemon (work package C5).
//!
//! Without the flag and without a daemon, the window runs dictation itself as
//! before ([`Mode::App`]).

use crate::ipc::apply_autostart;
use crate::state::Status;
use crate::{radio, tray};
use delulu_desktop::insert::Inserter;
use delulu_dictation::cleanup::{CleanupStatus, CLEANUP_MODEL};
use delulu_proto::api::*;
use delulu_proto::state::{self as proto, AppState, DictationOutcome, DictationPhase, WorkerState};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

/// Shown while no daemon answers.
pub(crate) const DAEMON_DOWN: &str = "The Delulu Talks daemon is not running. Start it with: systemctl --user start app-com.joran.delulu-talks@daemon — or in a terminal: DELULU_DAEMON=1 delulud daemon";
const RADIO_UNAVAILABLE: &str = "Delulu FM is not available while the daemon runs dictation (DELULU_DAEMON=1). It moves into the daemon in a later release.";
/// Ordinary requests; asking for permissions waits for the user instead.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// The window runs dictation itself, as before.
    App,
    /// The window is the daemon's client.
    Client,
}

/// What answered on the daemon socket at start-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Probe {
    /// A daemon that runs dictation.
    Dictation,
    /// A daemon that leaves dictation to the app (started without the flag).
    Skeleton,
    Nothing,
}

/// One dictation path, whatever the start order: a daemon that runs dictation
/// always wins, so the window never binds the shortcut next to it (on KDE both
/// would get every press and type twice). With the flag the window waits for
/// the daemon instead of falling back to its own path.
pub(crate) fn decide(flag: bool, probe: Probe) -> Mode {
    match (probe, flag) {
        (Probe::Dictation, _) | (_, true) => Mode::Client,
        _ => Mode::App,
    }
}

pub(crate) fn socket() -> Option<PathBuf> {
    delulu_daemon::default_socket().ok()
}

/// Asks the daemon socket, briefly, who is there.
pub(crate) fn probe(socket: Option<&std::path::Path>) -> Probe {
    let Some(socket) = socket else {
        return Probe::Nothing;
    };
    let ask = || -> std::io::Result<Probe> {
        let stream = std::os::unix::net::UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(Duration::from_millis(500)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        let hello = RequestMessage::new(
            0,
            &HelloParams {
                protocol: delulu_proto::PROTOCOL_VERSION,
                client: "app-probe".into(),
                client_version: Some(env!("CARGO_PKG_VERSION").into()),
            }
            .into_request(),
        );
        let mut line = serde_json::to_string(&hello).map_err(std::io::Error::other)?;
        line.push('\n');
        (&stream).write_all(line.as_bytes())?;
        let mut reply = String::new();
        BufReader::new(&stream).read_line(&mut reply)?;
        Ok(match serde_json::from_str::<ServerMessage>(&reply) {
            Ok(ServerMessage::Result(r)) => match serde_json::from_value::<HelloResult>(r.result) {
                Ok(hello) if hello.dictation => Probe::Dictation,
                _ => Probe::Skeleton,
            },
            // A daemon of another protocol version: let the window run alone.
            _ => Probe::Skeleton,
        })
    };
    ask().unwrap_or(Probe::Nothing)
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, ApiError>>>>>;

struct Line {
    id: u64,
    text: String,
    reply: oneshot::Sender<Result<Value, ApiError>>,
}

/// The connection to the daemon, the latest snapshot, and the UI's view of it.
pub(crate) struct Client {
    socket: Option<PathBuf>,
    sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Line>>>,
    next_id: std::sync::atomic::AtomicU64,
    state: Mutex<Option<AppState>>,
    /// The dictation the UI was last told about, so each one is told once.
    told: Mutex<u64>,
    /// `--toggle` started the window: toggle once dictation is available.
    pending_toggle: AtomicBool,
    /// The Whisper model download runs here: it only writes model files.
    download: Arc<AtomicBool>,
    downloading: Arc<AtomicBool>,
    /// For "Copy": the clipboard needs no portal.
    clipboard: std::sync::OnceLock<Inserter>,
}

impl Client {
    pub(crate) fn new(socket: Option<PathBuf>, toggle: bool) -> Self {
        Self {
            socket,
            sender: Mutex::new(None),
            next_id: std::sync::atomic::AtomicU64::new(1),
            state: Mutex::new(None),
            told: Mutex::new(0),
            pending_toggle: AtomicBool::new(toggle),
            download: Arc::new(AtomicBool::new(false)),
            downloading: Arc::new(AtomicBool::new(false)),
            clipboard: std::sync::OnceLock::new(),
        }
    }

    fn snapshot(&self) -> Option<AppState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Sends one request and waits for its reply.
    async fn call<M: Method>(&self, params: M) -> Result<M::Result, String> {
        self.call_within(params, Some(CALL_TIMEOUT)).await
    }

    async fn call_within<M: Method>(
        &self,
        params: M,
        timeout: Option<Duration>,
    ) -> Result<M::Result, String> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let request = RequestMessage::new(id, &params.into_request());
        let mut text = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        text.push('\n');
        let (reply, answer) = oneshot::channel();
        let sent = self
            .sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|tx| tx.send(Line { id, text, reply }).is_ok());
        if !sent {
            return Err(DAEMON_DOWN.into());
        }
        let answer = match timeout {
            Some(limit) => tokio::time::timeout(limit, answer)
                .await
                .map_err(|_| "The daemon did not answer in time".to_string())?,
            None => answer.await,
        };
        let value = answer
            .map_err(|_| DAEMON_DOWN.to_string())?
            .map_err(|e| e.message)?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }
}

fn client(app: &tauri::AppHandle) -> State<'_, Client> {
    app.state::<Client>()
}

/// Keeps a connection to the daemon open, reconnecting after it goes away.
pub(crate) async fn connect_forever(app: tauri::AppHandle) {
    let mut was_connected = true;
    loop {
        let stream = match &client(&app).socket {
            Some(socket) => tokio::net::UnixStream::connect(socket).await.ok(),
            None => None,
        };
        if let Some(stream) = stream {
            eprintln!("delulu-talks: connected to the daemon");
            serve(&app, stream).await;
            eprintln!("delulu-talks: the daemon went away; reconnecting");
            was_connected = true;
        }
        if was_connected {
            was_connected = false;
            *client(&app).state.lock().unwrap_or_else(|e| e.into_inner()) = None;
            publish(&app);
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// One connection: hello, subscribe, snapshot, then events until it closes.
async fn serve(app: &tauri::AppHandle, stream: tokio::net::UnixStream) {
    let (reader, mut writer) = stream.into_split();
    let pending: Pending = Arc::default();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Line>();
    *client(app).sender.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let writes = Arc::clone(&pending);
    let writer_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            writes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(line.id, line.reply);
            if writer.write_all(line.text.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let reads = Arc::clone(&pending);
    let events = app.clone();
    let reader_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<ServerMessage>(&line) {
                Ok(ServerMessage::Result(r)) => {
                    if let Some(reply) = reads
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&r.id)
                    {
                        let _ = reply.send(Ok(r.result));
                    }
                }
                Ok(ServerMessage::Error(e)) => {
                    let reply = e
                        .id
                        .and_then(|id| reads.lock().unwrap_or_else(|e| e.into_inner()).remove(&id));
                    if let Some(reply) = reply {
                        let _ = reply.send(Err(e.error));
                    }
                }
                Ok(ServerMessage::Event(event)) => on_event(&events, event),
                Err(e) => eprintln!("delulu-talks: unreadable line from the daemon: {e}"),
            }
        }
    });
    let c = client(app);
    let ready = async {
        c.call(HelloParams {
            protocol: delulu_proto::PROTOCOL_VERSION,
            client: delulu_proto::APP_CLIENT.into(),
            client_version: Some(env!("CARGO_PKG_VERSION").into()),
        })
        .await?;
        c.call(SubscribeParams {
            topics: vec![
                Topic::Dictation,
                Topic::Hotkey,
                Topic::Insert,
                Topic::Settings,
                Topic::History,
                Topic::Vocabulary,
                Topic::Levels,
            ],
        })
        .await?;
        let state = c.call(GetStateParams {}).await?;
        *c.state.lock().unwrap_or_else(|e| e.into_inner()) = Some(state);
        Ok::<_, String>(())
    };
    match ready.await {
        Ok(()) => {
            // Outcomes from before this window connected are not news.
            if let Some(state) = c.snapshot() {
                *c.told.lock().unwrap_or_else(|e| e.into_inner()) = state.dictation.job;
            }
            publish(app);
            let _ = app.emit("cleanup-status", cleanup_status(c.snapshot().as_ref()));
            let _ = reader_task.await;
        }
        Err(e) => {
            eprintln!("delulu-talks: the daemon refused the window: {e}");
            reader_task.abort();
            // Let a version mismatch show instead of retrying many times a second.
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    *c.sender.lock().unwrap_or_else(|e| e.into_inner()) = None;
    writer_task.abort();
    for (_, reply) in pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        let _ = reply.send(Err(ApiError::new(ErrorCode::Internal, DAEMON_DOWN)));
    }
}

fn on_event(app: &tauri::AppHandle, message: EventMessage) {
    let c = client(app);
    let mut refresh = false;
    {
        let mut state = c.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(state) = state.as_mut() else {
            return;
        };
        if message.seq <= state.seq && !matches!(message.event, Event::Lagged { .. }) {
            return;
        }
        state.seq = message.seq;
        match message.event.clone() {
            Event::Dictation { state: d } => state.dictation = d,
            Event::Hotkey { state: h } => state.hotkey = h,
            Event::Insert { state: i } => state.insert = i,
            Event::Settings { settings } => state.settings = Some(settings),
            Event::History { page } => state.history = Some(page),
            Event::Vocabulary { vocabulary } => state.vocabulary = Some(vocabulary),
            Event::Lagged { .. } => refresh = true,
            _ => {}
        }
    }
    match message.event {
        Event::Level { level } => {
            let _ = app.emit("mic-level", rms(level));
        }
        Event::Dictation { .. } => {
            publish(app);
            let _ = app.emit("cleanup-status", cleanup_status(c.snapshot().as_ref()));
            tell_outcome(app);
            toggle_if_pending(app);
        }
        Event::History { .. } => tell_outcome(app),
        Event::Hotkey { .. } | Event::Insert { .. } | Event::Settings { .. } => publish(app),
        _ => {}
    }
    if refresh {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(state) = client(&app).call(GetStateParams {}).await {
                *client(&app).state.lock().unwrap_or_else(|e| e.into_inner()) = Some(state);
                publish(&app);
            }
        });
    }
}

/// The UI's meter takes a raw level and applies the same curve the daemon did.
fn rms(level: f32) -> f32 {
    if level > 0.0 {
        10f32.powf((level * 54.0 - 60.0) / 20.0)
    } else {
        0.0
    }
}

fn data_dir() -> String {
    dirs::data_dir()
        .map(|d| d.join("delulu-talks").to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn models_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join("delulu-talks")
        .join("models")
}

/// Sends the status to the window and the tray.
fn publish(app: &tauri::AppHandle) {
    let status = status(client(app).snapshot().as_ref(), data_dir());
    let _ = app.emit("status", status.clone());
    tray::set_icon(app, &status.phase);
}

/// The app's status, from the daemon's snapshot (`None`: no daemon).
pub(crate) fn status(state: Option<&AppState>, data_dir: String) -> Status {
    let Some(state) = state else {
        return Status {
            phase: "error".into(),
            message: Some(DAEMON_DOWN.into()),
            hotkey: delulu_desktop::hotkey::HotkeyStatus {
                bound: false,
                trigger: None,
                error: Some(DAEMON_DOWN.into()),
            },
            insert: delulu_desktop::insert::InsertStatus {
                ready: false,
                error: Some(DAEMON_DOWN.into()),
            },
            backend: None,
            model: None,
            data_dir,
        };
    };
    let d = &state.dictation;
    let first_run_done = state.setup.is_none_or(|s| s.first_run_done);
    let (phase, message) = match d.phase {
        DictationPhase::Recording => ("recording", None),
        DictationPhase::Transcribing | DictationPhase::Cleaning | DictationPhase::Inserting => {
            ("transcribing", None)
        }
        DictationPhase::Idle if !first_run_done => ("needsSetup", None),
        DictationPhase::Idle if !d.available => match d.stt.state {
            WorkerState::Off | WorkerState::Starting | WorkerState::Loading => (
                "loadingModel",
                Some("Preparing GPU (first run only)".to_string()),
            ),
            _ => ("error", d.unavailable_reason.clone()),
        },
        DictationPhase::Idle => match &d.last {
            Some(DictationOutcome::Failed { error, .. }) => ("error", Some(error.clone())),
            Some(DictationOutcome::Done {
                history_error: Some(error),
                ..
            }) => ("error", Some(error.clone())),
            _ => ("idle", None),
        },
    };
    Status {
        phase: phase.into(),
        message,
        hotkey: delulu_desktop::hotkey::HotkeyStatus {
            bound: state.hotkey.bound,
            trigger: state.hotkey.trigger.clone(),
            error: state.hotkey.error.clone(),
        },
        insert: delulu_desktop::insert::InsertStatus {
            ready: state.insert.ready,
            error: state.insert.error.clone(),
        },
        backend: d.stt.device.clone(),
        model: d.stt.model.clone(),
        data_dir,
    }
}

/// The app's cleanup status, from the daemon's cleanup worker.
pub(crate) fn cleanup_status(state: Option<&AppState>) -> CleanupStatus {
    let off = CleanupStatus {
        state: "off",
        done_bytes: 0,
        total_bytes: CLEANUP_MODEL.bytes,
        error: None,
        backend: None,
    };
    let Some(state) = state else {
        return off;
    };
    let w = &state.dictation.cleanup;
    let enabled = state.settings.as_ref().is_some_and(|s| s.cleanup);
    let progress = w.progress;
    CleanupStatus {
        state: match w.state {
            WorkerState::Off if enabled => "missing",
            WorkerState::Off => "off",
            WorkerState::Loading if progress.is_some() => "downloading",
            WorkerState::Starting | WorkerState::Loading => "loading",
            WorkerState::Ready | WorkerState::Busy | WorkerState::Paused => "ready",
            WorkerState::Error => "error",
        },
        done_bytes: progress.map_or(0, |p| p.done_bytes),
        total_bytes: progress.map_or(CLEANUP_MODEL.bytes, |p| p.total_bytes),
        error: w.error.clone(),
        backend: w.device.clone(),
    }
}

/// Tells the UI how the last dictation ended, once, like the app's own
/// `transcript` event: the entry and how it was delivered.
fn tell_outcome(app: &tauri::AppHandle) {
    let c = client(app);
    let Some(state) = c.snapshot() else {
        return;
    };
    let Some(last) = &state.dictation.last else {
        return;
    };
    let mut told = c.told.lock().unwrap_or_else(|e| e.into_inner());
    let event = match last {
        DictationOutcome::Done {
            job,
            delivery,
            history_id: Some(id),
            ..
        } if *job > *told => {
            // The History event carries the saved entry; it follows the outcome.
            let Some(entry) = state
                .history
                .as_ref()
                .and_then(|p| p.entries.iter().find(|e| &e.id == id))
            else {
                return;
            };
            *told = *job;
            serde_json::json!({ "entry": entry, "insert": insert_result(delivery) })
        }
        DictationOutcome::Failed {
            job,
            during: DictationPhase::Inserting,
            error,
            text: Some(text),
            at,
        } if *job > *told => {
            *told = *job;
            // Not typed: the recovery card offers the text.
            serde_json::json!({
                "entry": {
                    "id": "", "createdAt": at, "text": text, "language": "", "model": "",
                    "audioMs": 0, "sttMs": 0, "totalMs": 0
                },
                "insert": { "kind": "failed", "reason": error }
            })
        }
        other => {
            let job = match other {
                DictationOutcome::Done { job, .. }
                | DictationOutcome::NothingHeard { job, .. }
                | DictationOutcome::Cancelled { job, .. }
                | DictationOutcome::Failed { job, .. } => *job,
            };
            // Saved nowhere (History failed) or nothing to show.
            if !matches!(
                other,
                DictationOutcome::Done {
                    history_id: Some(_),
                    ..
                }
            ) {
                *told = (*told).max(job);
            }
            return;
        }
    };
    drop(told);
    let _ = app.emit("transcript", event);
}

fn insert_result(delivery: &proto::Delivery) -> Value {
    match delivery {
        proto::Delivery::Typed => serde_json::json!({ "kind": "pasted" }),
        proto::Delivery::Copied { reason } => {
            serde_json::json!({ "kind": "copied", "reason": reason })
        }
        proto::Delivery::Skipped => serde_json::json!({ "kind": "copied", "reason": null }),
    }
}

fn toggle_if_pending(app: &tauri::AppHandle) {
    let c = client(app);
    let available = c.snapshot().is_some_and(|s| s.dictation.available);
    if available && c.pending_toggle.swap(false, Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = client(&app).call(ToggleParams {}).await;
        });
    }
}

/// `--toggle` from a second launch.
pub(crate) fn toggle(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = client(&app).call(ToggleParams {}).await {
            eprintln!("delulu-talks: toggle: {e}");
        }
    });
}

// ------------------------------------------------------------------ settings

/// The app's settings view: the store's shape plus the first-run flag.
fn settings_view(state: &AppState) -> Result<Value, String> {
    let wire = state.settings.as_ref().ok_or(DAEMON_DOWN)?;
    let setup = state.setup.unwrap_or(proto::Setup {
        first_run_done: true,
        cleanup_model_ok: true,
    });
    let mut settings = delulu_store::Settings::default();
    delulu_daemon::wire::apply_settings(wire, &mut settings);
    settings.cleanup_model_ok = setup.cleanup_model_ok;
    let mut value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    value["firstRunDone"] = Value::Bool(setup.first_run_done);
    Ok(value)
}

fn snapshot_or_down(app: &tauri::AppHandle) -> Result<AppState, String> {
    client(app)
        .snapshot()
        .ok_or_else(|| DAEMON_DOWN.to_string())
}

#[tauri::command(rename = "get_status")]
pub(crate) fn cmd_get_status(app: tauri::AppHandle) -> Status {
    status(client(&app).snapshot().as_ref(), data_dir())
}

#[tauri::command(rename = "get_settings")]
pub(crate) fn cmd_get_settings(app: tauri::AppHandle) -> Result<Value, String> {
    settings_view(&snapshot_or_down(&app)?)
}

#[tauri::command(rename = "set_settings")]
pub(crate) async fn cmd_set_settings(
    app: tauri::AppHandle,
    settings: delulu_store::Settings,
) -> Result<Value, String> {
    let before = snapshot_or_down(&app)?;
    let saved = client(&app)
        .call(SettingsSetParams {
            settings: delulu_daemon::wire::settings(&settings),
        })
        .await?;
    let old_login = before.settings.as_ref().map(|s| s.start_at_login);
    if old_login != Some(saved.start_at_login) {
        apply_autostart(&app, saved.start_at_login)?;
    }
    let mut state = before;
    state.settings = Some(saved);
    settings_view(&state)
}

#[tauri::command(rename = "list_models")]
pub(crate) fn cmd_list_models() -> Vec<Value> {
    let dir = models_dir();
    delulu_stt::models()
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "label": m.label,
                "engine": m.engine.as_str(),
                "bytes": m.bytes,
                "downloaded": delulu_stt::is_downloaded(&dir, m.id),
            })
        })
        .collect()
}

/// Downloads a Whisper model into the models folder, then tells the daemon.
#[tauri::command(rename = "download_model")]
pub(crate) fn cmd_download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let model = delulu_stt::model_info(&id).ok_or("Unknown model")?;
    let total = model.bytes;
    let c = client(&app);
    if c.downloading.swap(true, Ordering::SeqCst) {
        return Err("Download already in progress".into());
    }
    let cancel = c.download.clone();
    cancel.store(false, Ordering::SeqCst);
    let downloading = c.downloading.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = |done: u64, total: u64, finished: bool, error: Option<String>| {
            serde_json::json!({
                "id": id, "doneBytes": done, "totalBytes": total,
                "finished": finished, "error": error
            })
        };
        let mut report = |done, total| {
            let _ = app.emit("model-download", progress(done, total, false, None));
        };
        let result = delulu_models::download(&models_dir(), model, &mut report, &cancel);
        downloading.store(false, Ordering::SeqCst);
        let (finished, error) = match result {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let done = if finished { total } else { 0 };
        let _ = app.emit("model-download", progress(done, total, finished, error));
        if finished {
            tauri::async_runtime::block_on(async {
                let _ = client(&app).call(ModelsRefreshParams {}).await;
            });
        }
    });
    Ok(())
}

#[tauri::command(rename = "cancel_download")]
pub(crate) fn cmd_cancel_download(app: tauri::AppHandle) {
    client(&app).download.store(true, Ordering::SeqCst);
}

#[tauri::command(rename = "start_mic_test")]
pub(crate) async fn cmd_start_mic_test(app: tauri::AppHandle) -> Result<(), String> {
    client(&app)
        .call(MicTestParams { on: true })
        .await
        .map(|_| ())
}

#[tauri::command(rename = "stop_mic_test")]
pub(crate) async fn cmd_stop_mic_test(app: tauri::AppHandle) {
    let _ = client(&app).call(MicTestParams { on: false }).await;
}

async fn toggle_when(app: &tauri::AppHandle, phase: DictationPhase) -> Result<(), String> {
    let c = client(app);
    if c.snapshot().is_some_and(|s| s.dictation.phase == phase) {
        c.call(ToggleParams {}).await?;
    }
    Ok(())
}

#[tauri::command(rename = "start_dictation")]
pub(crate) async fn cmd_start_dictation(app: tauri::AppHandle) -> Result<(), String> {
    toggle_when(&app, DictationPhase::Idle).await
}

#[tauri::command(rename = "stop_dictation")]
pub(crate) async fn cmd_stop_dictation(app: tauri::AppHandle) -> Result<(), String> {
    toggle_when(&app, DictationPhase::Recording).await
}

/// The first-run permission step: the daemon asks the desktop for the shortcut
/// and the typing permission, and owns both sessions.
#[tauri::command(rename = "prepare_insert")]
pub(crate) async fn cmd_prepare_insert(
    app: tauri::AppHandle,
) -> Result<delulu_desktop::insert::InsertStatus, String> {
    // No time limit: the desktop's dialogs wait for the user.
    let permissions = client(&app)
        .call_within(PermissionsRequestParams {}, None)
        .await?;
    Ok(delulu_desktop::insert::InsertStatus {
        ready: permissions.insert.ready,
        error: permissions.insert.error,
    })
}

#[tauri::command(rename = "change_hotkey")]
pub(crate) async fn cmd_change_hotkey(app: tauri::AppHandle) -> Result<(), String> {
    client(&app)
        .call_within(HotkeyConfigureParams {}, None)
        .await
        .map(|_| ())
}

#[tauri::command(rename = "finish_first_run")]
pub(crate) async fn cmd_finish_first_run(app: tauri::AppHandle) -> Result<(), String> {
    client(&app).call(SetupFinishParams {}).await.map(|_| ())
}

// ------------------------------------------------------------------ history

#[tauri::command(rename = "get_history")]
pub(crate) async fn cmd_get_history(
    app: tauri::AppHandle,
    query: Option<String>,
    limit: usize,
) -> Result<Vec<proto::HistoryEntry>, String> {
    let page = client(&app)
        .call(HistoryListParams {
            query,
            offset: 0,
            limit: limit.min(u32::MAX as usize) as u32,
        })
        .await?;
    Ok(page.entries)
}

#[tauri::command(rename = "delete_history")]
pub(crate) async fn cmd_delete_history(app: tauri::AppHandle, id: String) -> Result<(), String> {
    client(&app)
        .call(HistoryDeleteParams { id })
        .await
        .map(|_| ())
}

#[tauri::command(rename = "clear_history")]
pub(crate) async fn cmd_clear_history(app: tauri::AppHandle) -> Result<(), String> {
    client(&app).call(HistoryClearParams {}).await.map(|_| ())
}

#[tauri::command(rename = "copy_text")]
pub(crate) fn cmd_copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    client(&app)
        .clipboard
        .get_or_init(|| Inserter::new(None, Box::new(|_| {})))
        .copy(&text)
        .map_err(|e| e.to_string())
}

/// `raw` types what was said before cleanup, when the entry has it.
#[tauri::command(rename = "reinsert")]
pub(crate) async fn cmd_reinsert(app: tauri::AppHandle, id: String, raw: Option<bool>) -> Value {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    // Let focus go back to the window the text is for.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let raw = raw.unwrap_or(false);
    match client(&app).call(HistoryReinsertParams { id, raw }).await {
        Ok(delivery) => insert_result(&delivery),
        Err(reason) => serde_json::json!({ "kind": "failed", "reason": reason }),
    }
}

// ------------------------------------------------------------------ cleanup

#[tauri::command(rename = "get_cleanup_status")]
pub(crate) fn cmd_get_cleanup_status(app: tauri::AppHandle) -> CleanupStatus {
    cleanup_status(client(&app).snapshot().as_ref())
}

#[tauri::command(rename = "start_cleanup")]
pub(crate) async fn cmd_start_cleanup(app: tauri::AppHandle) -> Result<(), String> {
    client(&app).call(CleanupStartParams {}).await.map(|_| ())
}

#[tauri::command(rename = "cancel_cleanup_download")]
pub(crate) async fn cmd_cancel_cleanup_download(app: tauri::AppHandle) {
    let _ = client(&app).call(CleanupCancelParams {}).await;
}

// ------------------------------------------------------------------ vocabulary

/// The app's vocabulary view: shelves, presets and term counts.
fn vocabulary_view(v: proto::Vocabulary) -> Value {
    serde_json::json!({
        "version": 1,
        "shelves": v.shelves,
        "presets": v.presets,
        "activeTerms": v.active_terms,
        "usedTerms": v.used_terms,
    })
}

async fn change(app: &tauri::AppHandle, change: VocabularyChangeParams) -> Result<Value, String> {
    client(app).call(change).await.map(vocabulary_view)
}

#[tauri::command(rename = "get_vocabulary")]
pub(crate) async fn cmd_get_vocabulary(app: tauri::AppHandle) -> Result<Value, String> {
    client(&app)
        .call(VocabularyGetParams {})
        .await
        .map(vocabulary_view)
}

#[tauri::command(rename = "add_shelf")]
pub(crate) async fn cmd_add_shelf(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::AddShelf { name }).await
}

#[tauri::command(rename = "add_preset_shelf")]
pub(crate) async fn cmd_add_preset_shelf(
    app: tauri::AppHandle,
    key: String,
) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::AddPreset { key }).await
}

#[tauri::command(rename = "rename_shelf")]
pub(crate) async fn cmd_rename_shelf(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::RenameShelf { id, name }).await
}

#[tauri::command(rename = "delete_shelf")]
pub(crate) async fn cmd_delete_shelf(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::DeleteShelf { id }).await
}

#[tauri::command(rename = "set_shelf_enabled")]
pub(crate) async fn cmd_set_shelf_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::SetEnabled { id, enabled }).await
}

#[tauri::command(rename = "add_terms")]
pub(crate) async fn cmd_add_terms(
    app: tauri::AppHandle,
    id: String,
    text: String,
) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::AddTerms { id, text }).await
}

#[tauri::command(rename = "remove_term")]
pub(crate) async fn cmd_remove_term(
    app: tauri::AppHandle,
    id: String,
    term: String,
) -> Result<Value, String> {
    change(&app, VocabularyChangeParams::RemoveTerm { id, term }).await
}

// ------------------------------------------------------------------ Delulu FM

fn fm_off() -> radio::RadioView {
    radio::unavailable(Some(RADIO_UNAVAILABLE.into()), None)
}

#[tauri::command(rename = "get_radio")]
pub(crate) fn cmd_get_radio() -> radio::RadioView {
    fm_off()
}
#[tauri::command(rename = "check_radio")]
pub(crate) fn cmd_check_radio() -> radio::RadioView {
    fm_off()
}
#[tauri::command(rename = "radio_pause")]
pub(crate) fn cmd_radio_pause() -> radio::RadioView {
    fm_off()
}
#[tauri::command(rename = "radio_play")]
pub(crate) fn cmd_radio_play() -> Result<radio::RadioView, String> {
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "radio_off")]
pub(crate) fn cmd_radio_off() -> Result<radio::RadioView, String> {
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "radio_skip")]
pub(crate) fn cmd_radio_skip() -> Result<radio::RadioView, String> {
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "radio_volume")]
pub(crate) fn cmd_radio_volume(volume: f32) -> Result<(), String> {
    let _ = volume;
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "radio_direction")]
pub(crate) fn cmd_radio_direction(direction: Value) -> Result<radio::RadioView, String> {
    let _ = direction;
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "radio_request")]
pub(crate) fn cmd_radio_request(text: String) -> Result<radio::RadioView, String> {
    let _ = text;
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "get_music_model")]
pub(crate) fn cmd_get_music_model() -> Value {
    serde_json::json!({
        "state": "missing",
        "label": delulu_models::YUE2_3B.label,
        "license": delulu_models::YUE2_3B.license,
        "doneBytes": 0,
        "totalBytes": delulu_models::YUE2_3B.bytes,
        "error": RADIO_UNAVAILABLE,
    })
}
#[tauri::command(rename = "download_music_model")]
pub(crate) fn cmd_download_music_model() -> Result<Value, String> {
    Err(RADIO_UNAVAILABLE.into())
}
#[tauri::command(rename = "cancel_music_download")]
pub(crate) fn cmd_cancel_music_download() {}
#[tauri::command(rename = "delete_music_model")]
pub(crate) fn cmd_delete_music_model() -> Result<Value, String> {
    Err(RADIO_UNAVAILABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use delulu_daemon::server::{Daemon, Options};
    use delulu_proto::state::DaemonMode;

    #[test]
    fn a_daemon_that_runs_dictation_always_makes_the_window_its_client() {
        // (flag set for the window, what answers on the socket) → mode
        let matrix = [
            (false, Probe::Nothing, Mode::App),
            (false, Probe::Skeleton, Mode::App),
            (false, Probe::Dictation, Mode::Client),
            (true, Probe::Nothing, Mode::Client),
            (true, Probe::Skeleton, Mode::Client),
            (true, Probe::Dictation, Mode::Client),
        ];
        for (flag, probe, mode) in matrix {
            assert_eq!(decide(flag, probe), mode, "flag {flag}, {probe:?}");
        }
    }

    /// A daemon on a temporary socket, served from its own thread.
    fn daemon(mode: DaemonMode) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::UnixListener::from_std(listener).unwrap();
                let daemon = Daemon::new(Options {
                    mode,
                    script: false,
                    ..Options::default()
                });
                daemon.serve(listener, std::future::pending()).await;
            });
        });
        (dir, path)
    }

    #[test]
    fn the_probe_tells_a_dictation_daemon_from_one_that_leaves_it_to_the_app() {
        // The demo daemon runs (fake) dictation; a normal one without the flag does not.
        let (_a, dictation) = daemon(DaemonMode::Demo);
        let (_b, skeleton) = daemon(DaemonMode::Normal);
        assert_eq!(probe(Some(&dictation)), Probe::Dictation);
        assert_eq!(probe(Some(&skeleton)), Probe::Skeleton);
        let gone = tempfile::tempdir().unwrap();
        assert_eq!(probe(Some(&gone.path().join("d.sock"))), Probe::Nothing);
        assert_eq!(probe(None), Probe::Nothing);
    }

    #[test]
    fn the_window_says_when_the_daemon_is_not_running() {
        let down = status(None, String::new());
        assert_eq!(down.phase, "error");
        assert!(down.message.unwrap().contains("delulud daemon"));
    }

    #[test]
    fn the_status_follows_the_daemon() {
        let mut state = delulu_daemon::demo::state(delulu_daemon::now_ms());
        assert_eq!(status(Some(&state), String::new()).phase, "idle");
        state.dictation.phase = DictationPhase::Cleaning;
        assert_eq!(status(Some(&state), String::new()).phase, "transcribing");
        state.dictation.phase = DictationPhase::Idle;
        state.dictation.last = Some(DictationOutcome::Done {
            job: 1,
            at: 0,
            text: "x".into(),
            raw: None,
            delivery: proto::Delivery::Typed,
            cleanup_error: None,
            history_id: None,
            history_error: Some("Not saved to History: disk full".into()),
        });
        let unsaved = status(Some(&state), String::new());
        assert_eq!(
            (unsaved.phase.as_str(), unsaved.message.as_deref()),
            ("error", Some("Not saved to History: disk full"))
        );
        state.dictation.available = false;
        state.dictation.stt.state = WorkerState::Loading;
        assert_eq!(status(Some(&state), String::new()).phase, "loadingModel");
        state.setup = Some(proto::Setup {
            first_run_done: false,
            cleanup_model_ok: false,
        });
        assert_eq!(status(Some(&state), String::new()).phase, "needsSetup");
    }

    #[test]
    fn cleanup_shows_missing_downloading_and_off_like_the_app() {
        let mut state = delulu_daemon::demo::state(delulu_daemon::now_ms());
        state.dictation.cleanup = proto::WorkerStatus::off();
        state.settings.as_mut().unwrap().cleanup = true;
        assert_eq!(cleanup_status(Some(&state)).state, "missing");
        state.settings.as_mut().unwrap().cleanup = false;
        assert_eq!(cleanup_status(Some(&state)).state, "off");
        state.dictation.cleanup.state = WorkerState::Loading;
        state.dictation.cleanup.progress = Some(proto::Progress {
            done_bytes: 5,
            total_bytes: 10,
        });
        let downloading = cleanup_status(Some(&state));
        assert_eq!(
            (
                downloading.state,
                downloading.done_bytes,
                downloading.total_bytes
            ),
            ("downloading", 5, 10)
        );
    }
}
