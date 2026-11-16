//! The real [`Platform`]: the microphone, Whisper on its own thread, the cleanup
//! helper process, the portals (shortcut and typing) and the recording pill.

use crate::live::{BoxFuture, Platform, Reporter};
use crate::wire;
use delulu_core::gesture::KeyEvent;
use delulu_desktop::hotkey::{Hotkey, HotkeyStatus, DEFAULT_TRIGGER};
use delulu_desktop::insert::{InsertStatus, Inserter};
use delulu_desktop::APP_ID;
use delulu_dictation::cleanup::{Cleaned, Supervisor, Want, CLEANUP_MODEL};
use delulu_dictation::stop::{self, InsertResult, Recorded};
use delulu_dictation::stt::{engine_thread, ready_model, EngineHost, EngineJob};
use delulu_overlay::{Pill, PillState};
use delulu_proto::state::{WorkerState, WorkerStatus};
use delulu_store::{InsertMode, Store};
use delulu_stt::{Language, Transcript};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

const NO_PORTALS: &str = "Portals disabled for unattended tests";

pub struct DesktopPlatform {
    store: Arc<Store>,
    recorder: delulu_audio::Recorder,
    inserter: Inserter,
    hotkey: tokio::sync::Mutex<Option<Hotkey>>,
    pill: Option<Pill>,
    /// `DELULU_NO_PORTALS=1`: no shortcut, no typing permission, copy only.
    no_portals: bool,
    engine: OnceLock<mpsc::Sender<EngineJob>>,
    cleanup: OnceLock<Arc<Supervisor>>,
    report: OnceLock<Reporter>,
    /// The speech model loaded or loading, so a refresh only reloads on change.
    speech_model: Arc<std::sync::Mutex<Option<String>>>,
}

impl DesktopPlatform {
    pub fn new(store: Arc<Store>) -> Self {
        let save = Arc::clone(&store);
        let inserter = Inserter::new(
            store.state().remote_desktop_token,
            Box::new(move |token| {
                let mut state = save.state();
                state.remote_desktop_token = token;
                if let Err(e) = save.save_state(&state) {
                    eprintln!("delulud: save the typing permission token: {e}");
                }
            }),
        );
        let pill = match pill_program() {
            Some(program) => Some(Pill::with_program(program)),
            None => {
                eprintln!(
                    "delulud: the Delulu Talks app (delulu-talks) was not found, so there is no recording pill; set DELULU_APP to its path"
                );
                None
            }
        };
        Self {
            store,
            recorder: delulu_audio::Recorder::new(),
            inserter,
            hotkey: tokio::sync::Mutex::new(None),
            pill,
            no_portals: std::env::var("DELULU_NO_PORTALS").as_deref() == Ok("1"),
            engine: OnceLock::new(),
            cleanup: OnceLock::new(),
            report: OnceLock::new(),
            speech_model: Arc::default(),
        }
    }

    /// Loads the selected speech model, or any downloaded one, unless it is the
    /// one already loaded or loading.
    fn load_speech(&self) {
        let (Some(report), Some(engine), Some(cleanup)) =
            (self.report.get(), self.engine.get(), self.cleanup.get())
        else {
            return;
        };
        let settings = self.store.settings();
        match ready_model(&self.store.models_dir(), &settings.model) {
            Some(id) => {
                {
                    let mut current = self.speech_model.lock().unwrap_or_else(|e| e.into_inner());
                    if current.as_deref() == Some(id.as_str()) {
                        return;
                    }
                    *current = Some(id.clone());
                }
                // Whisper loads first; cleanup frees the GPU and starts once it has settled.
                cleanup.whisper_loading();
                report.stt(WorkerStatus {
                    state: WorkerState::Loading,
                    model: Some(id.clone()),
                    device: None,
                    error: None,
                    progress: None,
                });
                let _ = engine.send(EngineJob::Load(id));
            }
            None => {
                let loaded = self
                    .speech_model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_some();
                if !loaded {
                    report.stt(error_status(
                        Some(settings.model),
                        "No speech model is downloaded; download one in the Delulu Talks window"
                            .into(),
                    ));
                    cleanup.whisper_settled(want(&self.store));
                }
            }
        }
    }

    fn cleanup(&self) -> Option<&Arc<Supervisor>> {
        self.cleanup.get()
    }
}

/// What the cleanup supervisor should do, from the settings and files now.
fn want(store: &Store) -> Want {
    let settings = store.settings();
    Want {
        enabled: settings.cleanup,
        first_run_done: store.state().first_run_done,
        model_ok: settings.cleanup_model_ok,
        file_ready: delulu_stt::file_ready(&store.models_dir(), &CLEANUP_MODEL),
    }
}

/// The binary whose `--pill` mode draws the recording pill: `$DELULU_APP`, the
/// app next to this binary, or the installed app.
fn pill_program() -> Option<PathBuf> {
    let from_env = std::env::var_os("DELULU_APP").map(PathBuf::from);
    let next_to_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("delulu-talks")));
    let installed = Some(PathBuf::from("/usr/bin/delulu-talks"));
    [from_env, next_to_exe, installed]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}

/// The engine thread's view of the daemon.
struct Host {
    store: Arc<Store>,
    cleanup: Arc<Supervisor>,
    report: Reporter,
    speech_model: Arc<std::sync::Mutex<Option<String>>>,
}

impl EngineHost for Host {
    fn models_dir(&self) -> PathBuf {
        self.store.models_dir()
    }
    fn before_load(&self) {
        // Whisper never competes with a retired cleanup helper for GPU memory.
        self.cleanup.wait_released(Duration::from_secs(5));
    }
    fn loaded(&self, id: String, result: Result<String, String>) {
        if result.is_err() {
            // Nothing is loaded now; the next refresh tries again.
            *self.speech_model.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        self.report.stt(match result {
            Ok(backend) => WorkerStatus {
                state: WorkerState::Ready,
                model: Some(id),
                device: Some(backend),
                error: None,
                progress: None,
            },
            Err(error) => WorkerStatus {
                state: WorkerState::Error,
                model: Some(id),
                device: None,
                error: Some(error),
                progress: None,
            },
        });
        self.cleanup.whisper_settled(want(&self.store));
    }
}

impl Platform for DesktopPlatform {
    fn start_engines(&self, report: Reporter) {
        let settings = self.store.settings();
        let models_dir = self.store.models_dir();
        let cleanup_report = report.clone();
        let vocabulary = Arc::clone(&self.store);
        let cleanup = Supervisor::new(
            settings.cleanup,
            delulu_stt::file_ready(&models_dir, &CLEANUP_MODEL),
            models_dir.clone(),
            Box::new(move |status| cleanup_report.cleanup(wire::cleanup_worker(&status))),
            Box::new(move || vocabulary.vocabulary().active_terms()),
        );
        cleanup.watch();
        report.cleanup(wire::cleanup_worker(&cleanup.status()));
        let _ = self.cleanup.set(Arc::clone(&cleanup));

        let (tx, rx) = mpsc::channel();
        let _ = self.engine.set(tx.clone());
        let _ = self.report.set(report.clone());
        let host = Host {
            store: Arc::clone(&self.store),
            cleanup: Arc::clone(&cleanup),
            report: report.clone(),
            speech_model: Arc::clone(&self.speech_model),
        };
        if let Err(e) = std::thread::Builder::new()
            .name("stt".into())
            .spawn(move || engine_thread(host, rx))
        {
            report.stt(error_status(
                None,
                format!("could not start the speech engine: {e}"),
            ));
            return;
        }
        self.load_speech();
    }

    fn start_capture(
        &self,
        device: Option<&str>,
        level: Box<dyn Fn(f32) + Send>,
    ) -> Result<(), String> {
        self.recorder
            .start(device, level)
            .map_err(|e| e.to_string())
    }

    fn stop_capture(&self) -> Recorded {
        match self.recorder.stop() {
            Ok(clip) => Ok(clip.samples),
            Err(e @ delulu_audio::AudioError::NoDevice(_)) => Err(("No microphone", e.to_string())),
            Err(e) => Err(("Mic error", e.to_string())),
        }
    }

    fn discard_capture(&self) {
        self.recorder.cancel();
    }

    fn transcribe(
        &self,
        samples: Vec<f32>,
        language: Language,
        prompt: Option<String>,
    ) -> BoxFuture<'_, Result<Transcript, String>> {
        Box::pin(async move {
            let (reply, rx) = tokio::sync::oneshot::channel();
            self.engine
                .get()
                .ok_or("The speech engine has not started")?
                .send(EngineJob::Transcribe(samples, language, prompt, reply))
                .map_err(|_| "The speech engine thread stopped".to_string())?;
            rx.await.map_err(|e| e.to_string())?
        })
    }

    fn clean(
        &self,
        enabled: bool,
        language: String,
        raw: String,
        vocabulary: Vec<String>,
    ) -> BoxFuture<'_, Cleaned> {
        Box::pin(async move {
            match self.cleanup() {
                Some(cleanup) => {
                    cleanup
                        .clean(enabled, &language, raw, move || vocabulary)
                        .await
                }
                None => delulu_dictation::cleanup::choose(
                    raw,
                    delulu_dictation::cleanup::CleanResult::Skipped,
                    0,
                ),
            }
        })
    }

    fn deliver(&self, text: String, mode: InsertMode, held: bool) -> BoxFuture<'_, InsertResult> {
        Box::pin(
            async move { stop::deliver(&self.inserter, &text, mode, held, self.no_portals).await },
        )
    }

    fn app_running(&self) -> BoxFuture<'_, bool> {
        Box::pin(app_running())
    }

    fn bind_hotkey(
        &self,
        events: tokio::sync::mpsc::UnboundedSender<KeyEvent>,
        on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> BoxFuture<'_, HotkeyStatus> {
        Box::pin(async move {
            if self.no_portals {
                return HotkeyStatus {
                    bound: false,
                    trigger: None,
                    error: Some(NO_PORTALS.into()),
                };
            }
            let mut slot = self.hotkey.lock().await;
            let (hotkey, status) = Hotkey::bind(DEFAULT_TRIGGER, events, on_status).await;
            *slot = hotkey;
            status
        })
    }

    fn prepare_insert(&self) -> BoxFuture<'_, InsertStatus> {
        Box::pin(async move {
            if self.no_portals {
                return InsertStatus {
                    ready: false,
                    error: Some(NO_PORTALS.into()),
                };
            }
            self.inserter.prepare().await
        })
    }

    fn configure_hotkey(&self) -> BoxFuture<'_, Option<Result<(), String>>> {
        Box::pin(async move {
            let mut slot = self.hotkey.lock().await;
            if let Some(hotkey) = slot.as_ref().filter(|h| h.status().bound) {
                return Some(hotkey.configure().await);
            }
            if let Some(hotkey) = slot.take() {
                hotkey.close().await;
            }
            None
        })
    }

    fn settings_changed(&self, old: &delulu_store::Settings, new: &delulu_store::Settings) {
        if old.model != new.model {
            self.load_speech();
        }
        if old.cleanup != new.cleanup || old.cleanup_model_ok != new.cleanup_model_ok {
            if let Some(cleanup) = self.cleanup() {
                cleanup.sync(want(&self.store));
            }
        }
        if !new.overlay {
            self.pill(PillState::Hidden, None);
        }
    }

    fn refresh_models(&self) {
        self.load_speech();
        if let Some(cleanup) = self.cleanup() {
            cleanup.sync(want(&self.store));
        }
    }

    fn start_cleanup(&self) {
        if let Some(cleanup) = self.cleanup() {
            cleanup.start(want(&self.store));
        }
    }

    fn cancel_cleanup(&self) {
        if let Some(cleanup) = self.cleanup() {
            cleanup.cancel_download();
        }
    }

    fn pill(&self, state: PillState, label: Option<&str>) {
        if let Some(pill) = &self.pill {
            pill.show(state, label);
        }
    }

    fn pill_level(&self, rms: f32) {
        if let Some(pill) = &self.pill {
            pill.level(rms);
        }
    }
}

fn error_status(model: Option<String>, error: String) -> WorkerStatus {
    WorkerStatus {
        state: WorkerState::Error,
        model,
        device: None,
        error: Some(error),
        progress: None,
    }
}

/// The D-Bus name the app's single-instance plugin holds while it runs.
pub fn app_bus_name() -> String {
    format!("{APP_ID}.SingleInstance")
}

/// Whether the Delulu Talks app is running, by the single-instance name it holds
/// on the session bus. When the bus cannot be asked, assume it is not.
async fn app_running() -> bool {
    let check = async {
        let connection = zbus::Connection::session().await?;
        let proxy = zbus::fdo::DBusProxy::new(&connection).await?;
        let name = zbus::names::BusName::try_from(app_bus_name())
            .map_err(|e| zbus::Error::Failure(e.to_string()))?;
        proxy.name_has_owner(name).await.map_err(zbus::Error::from)
    };
    match check.await {
        Ok(running) => running,
        Err(e) => {
            eprintln!("delulud: could not check whether the app is running: {e}");
            false
        }
    }
}
