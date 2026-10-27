use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub(crate) phase: String,
    pub(crate) message: Option<String>,
    pub(crate) hotkey: delulu_hotkey::HotkeyStatus,
    pub(crate) insert: delulu_insert::InsertStatus,
    pub(crate) backend: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) data_dir: String,
}
pub(crate) struct Shell {
    pub(crate) store: Arc<Store>,
    pub(crate) status: Mutex<Status>,
    pub(crate) recorder: delulu_audio::Recorder,
    pub(crate) inserter: Inserter,
    pub(crate) hotkey: tokio::sync::Mutex<Option<Hotkey>>,
    pub(crate) gesture: Mutex<Gesture>,
    pub(crate) engine: mpsc::Sender<EngineJob>,
    pub(crate) download: Arc<AtomicBool>,
    pub(crate) downloading: Arc<AtomicBool>,
    pub(crate) events: tokio::sync::mpsc::UnboundedSender<KeyEvent>,
    pub(crate) no_portals: bool,
    pub(crate) last_release: Mutex<Option<Instant>>,
    pub(crate) mic: AtomicBool,
    /// `--toggle` started the app: start recording once the model is ready.
    pub(crate) pending_toggle: AtomicBool,
    pub(crate) pill: Pill,
}
pub(crate) enum EngineJob {
    Load(String),
    Transcribe(
        Vec<f32>,
        String,
        tokio::sync::oneshot::Sender<Result<delulu_stt::Transcript, String>>,
    ),
}
pub(crate) fn status_value(s: &Shell) -> Status {
    s.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
pub(crate) fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut Status)) {
    let s = app.state::<Shell>();
    let value = {
        let mut status = s.status.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut status);
        status.clone()
    };
    eprintln!(
        "status {}{}",
        value.phase,
        value
            .message
            .as_deref()
            .map(|m| format!(": {m}"))
            .unwrap_or_default()
    );
    let _ = app.emit("status", value.clone());
    tray::set_icon(app, &value.phase);
}
pub(crate) fn phase(app: &tauri::AppHandle, value: &str, message: Option<String>) {
    if value == "error" {
        app.state::<Shell>()
            .gesture
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset();
    }
    update(app, |s| {
        s.phase = value.into();
        s.message = message;
    });
}
pub(crate) fn ready_phase(s: &Shell) -> &'static str {
    if s.store.state().first_run_done {
        "idle"
    } else {
        "needsSetup"
    }
}
