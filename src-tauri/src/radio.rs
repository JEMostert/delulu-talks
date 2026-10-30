//! Delulu FM: the optional radio station. Off until Settings shows it and Play starts it.
//! Dictation comes first: playback holds silent while recording, and no new writing,
//! music or speech step starts while you dictate or just after.
use super::*;
use delulu_radio::{
    comfy::{self, Comfy, ComfyReadiness, JobState, SubmitError},
    model::{Draft, Request},
    voice::Voice,
    Backend, Direction, Item, Kind, Player, PlayerEvent, RadioError, Station,
};
use std::path::{Path, PathBuf};

/// Quiet time after dictation before the radio may start a GPU step.
const DICTATION_QUIET: Duration = Duration::from_secs(8);
/// A brief or script is a few hundred tokens; this only catches a stuck helper.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) struct Radio {
    station: Option<Arc<Station>>,
    open_error: Option<String>,
    player: Player,
    comfy: Comfy,
    voice: Voice,
    /// Play was pressed: start playing as soon as something is ready.
    listening: AtomicBool,
    /// Held while the playback intent is read or changed and the matching player
    /// command is sent, so a Pause can never land between them.
    control: Mutex<()>,
    readiness: Mutex<Option<Readiness>>,
    last_dictation: Mutex<Option<Instant>>,
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readiness {
    comfy: ComfyReadiness,
    /// The cleanup model and helper exist.
    writer: bool,
    voice: bool,
    install_command: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemView {
    id: String,
    kind: Kind,
    title: String,
    subtitle: String,
    lyrics: Option<String>,
    script: Option<String>,
    seconds: f64,
    request: Option<String>,
    replay: bool,
    imported: bool,
}

impl From<&Item> for ItemView {
    fn from(i: &Item) -> Self {
        ItemView {
            id: i.id.clone(),
            kind: i.kind,
            title: i.title.clone(),
            subtitle: i.subtitle.clone(),
            lyrics: i.lyrics.clone(),
            script: i.script.clone(),
            seconds: i.seconds,
            request: i.request.clone(),
            replay: i.is_replay(),
            imported: i.provenance.contains_key("importedFrom"),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Making {
    kind: Kind,
    /// writing, music, voice
    step: &'static str,
    title: Option<String>,
    request: Option<String>,
    since: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RadioView {
    available: bool,
    error: Option<String>,
    on_air: bool,
    playing: bool,
    held: bool,
    volume: f32,
    now: Option<ItemView>,
    position: f64,
    queue: Vec<ItemView>,
    history: Vec<ItemView>,
    making: Option<Making>,
    last_error: Option<String>,
    requests: Vec<Request>,
    direction: Direction,
    last_song_seconds: Option<f64>,
    last_song_audio_seconds: Option<f64>,
    readiness: Option<Readiness>,
}

impl Radio {
    pub(crate) fn new(app: &tauri::AppHandle, root: PathBuf) -> Radio {
        let events = app.clone();
        let player = Player::new(move |event| on_player(&events, event));
        let (station, open_error) = match Station::open(&root) {
            Ok(s) => (Some(Arc::new(s)), None),
            Err(e) => (
                None,
                Some(format!("Delulu FM could not open its data: {e}")),
            ),
        };
        if let Some(s) = &station {
            player.set_volume(s.snapshot().volume);
        }
        Radio {
            station,
            open_error,
            player,
            comfy: Comfy::from_env(),
            voice: Voice::new(),
            listening: AtomicBool::new(false),
            control: Mutex::new(()),
            readiness: Mutex::new(None),
            last_dictation: Mutex::new(None),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn control(&self) -> std::sync::MutexGuard<'_, ()> {
        self.control.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn station(&self) -> Result<&Arc<Station>, String> {
        self.station
            .as_ref()
            .ok_or_else(|| self.open_error.clone().unwrap_or_default())
    }
}

/// Start the production loop. It sleeps until the station goes on air, except to
/// collect a song already submitted to ComfyUI before a restart.
pub(crate) fn start(app: &tauri::AppHandle) {
    let radio = app.state::<Radio>();
    let Some(station) = radio.station.clone() else {
        return;
    };
    let stop = radio.stop.clone();
    let backend = AppBackend { app: app.clone() };
    std::thread::Builder::new()
        .name("radio".into())
        .spawn(move || station.run(&backend, &stop))
        .expect("spawn radio");
}

/// Dictation phase changes: hold playback while recording, remember the time.
pub(crate) fn on_phase(app: &tauri::AppHandle, phase: &str) {
    let Some(radio) = app.try_state::<Radio>() else {
        return;
    };
    let dictating = matches!(phase, "recording" | "transcribing");
    if dictating {
        *radio
            .last_dictation
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }
    let hold = phase == "recording";
    if radio.player.held() != hold {
        radio.player.hold(hold);
        emit(app);
    }
}

fn on_player(app: &tauri::AppHandle, event: PlayerEvent) {
    match event {
        PlayerEvent::Ended(id) => {
            let radio = app.state::<Radio>();
            let Ok(station) = radio.station() else { return };
            let _control = radio.control();
            if station.snapshot().now.as_ref().map(|i| &i.id) == Some(&id) {
                let next = station.advance();
                if radio.listening.load(Ordering::SeqCst) {
                    play_item(app, next, false);
                } else {
                    // Paused just as the track ended: stay paused on the next one.
                    radio.player.pause();
                }
            }
        }
        PlayerEvent::Failed(message) => {
            eprintln!("radio playback: {message}");
            app.state::<Radio>()
                .listening
                .store(false, Ordering::SeqCst);
            let _ = app.emit("radio-error", message);
        }
    }
    emit(app);
}

/// Play `item` (already `now`), or wait for one if there is none. `fresh` restarts it.
fn play_item(app: &tauri::AppHandle, item: Option<Item>, fresh: bool) {
    let radio = app.state::<Radio>();
    let Ok(station) = radio.station() else { return };
    let Some(item) = item else {
        radio.player.stop();
        return;
    };
    let current = radio.player.position().map(|p| p.id);
    if current.as_deref() == Some(item.id.as_str()) && !fresh {
        radio.player.resume();
    } else {
        match station.load_audio(&item) {
            Ok(audio) => radio.player.play(&item.id, audio),
            Err(e) => {
                eprintln!("radio: {} unplayable: {e}", item.id);
                let next = station.advance();
                if next.as_ref().is_some_and(|n| n.id != item.id) {
                    play_item(app, next, true);
                }
                return;
            }
        }
    }
    preload(app);
}

/// Keep the next ready item decoded in the player for a gapless change.
fn preload(app: &tauri::AppHandle) {
    let radio = app.state::<Radio>();
    let Ok(station) = radio.station() else { return };
    if let Some(next) = station.next_up() {
        if radio.player.preloaded().as_deref() != Some(next.id.as_str()) {
            if let Ok(audio) = station.load_audio(&next) {
                radio.player.preload(&next.id, audio);
            }
        }
    }
}

fn view(app: &tauri::AppHandle) -> RadioView {
    let radio = app.state::<Radio>();
    let readiness = radio
        .readiness
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Ok(station) = radio.station() else {
        return RadioView {
            available: false,
            error: radio.open_error.clone(),
            on_air: false,
            playing: false,
            held: false,
            volume: 0.8,
            now: None,
            position: 0.0,
            queue: Vec::new(),
            history: Vec::new(),
            making: None,
            last_error: None,
            requests: Vec::new(),
            direction: Direction::default(),
            last_song_seconds: None,
            last_song_audio_seconds: None,
            readiness,
        };
    };
    let s = station.snapshot();
    let position = radio.player.position();
    let now_id = s.now.as_ref().map(|i| i.id.as_str());
    let making = s.job.as_ref().map(|j| Making {
        kind: j.kind,
        step: match (&j.draft, j.kind) {
            (None, _) => "writing",
            (Some(_), Kind::Song) => "music",
            (Some(_), Kind::Break) => "voice",
        },
        title: j.draft.as_ref().map(|d| d.title.clone()),
        request: j.request.as_ref().map(|r| r.text.clone()),
        since: j.step_started_at,
    });
    let pending: Vec<Request> = s.requests.iter().rev().take(4).rev().cloned().collect();
    RadioView {
        available: true,
        error: None,
        on_air: s.on_air,
        playing: radio.player.playing(),
        held: radio.player.held(),
        volume: s.volume,
        position: position
            .filter(|p| Some(p.id.as_str()) == now_id)
            .map_or(0.0, |p| p.seconds),
        now: s.now.as_ref().map(ItemView::from),
        queue: s.queue.iter().map(ItemView::from).collect(),
        history: s.history.iter().take(12).map(ItemView::from).collect(),
        making: if s.on_air || s.job.as_ref().is_some_and(|j| j.submitted) {
            making
        } else {
            None
        },
        last_error: s.last_error.clone(),
        requests: pending,
        direction: s.direction.clone(),
        last_song_seconds: s.stats.last_song_seconds,
        last_song_audio_seconds: s.stats.last_song_audio_seconds,
        readiness,
    }
}

fn emit(app: &tauri::AppHandle) {
    let _ = app.emit("radio", view(app));
}

/// The cleanup helper stays loaded for the station while it is on air.
fn set_on_air(app: &tauri::AppHandle, on: bool) -> Result<(), String> {
    let radio = app.state::<Radio>();
    radio.station()?.set_on_air(on);
    app.state::<Shell>()
        .radio_writer
        .store(on, Ordering::SeqCst);
    cleanup::sync(app);
    Ok(())
}

/// Settings turned Delulu FM off: stop playing and making.
pub(crate) fn disable(app: &tauri::AppHandle) {
    let radio = app.state::<Radio>();
    {
        let _control = radio.control();
        radio.listening.store(false, Ordering::SeqCst);
        radio.player.stop();
    }
    let _ = set_on_air(app, false);
    emit(app);
}

fn check(app: &tauri::AppHandle) -> Readiness {
    let radio = app.state::<Radio>();
    let s = app.state::<Shell>();
    let readiness = Readiness {
        comfy: radio.comfy.readiness(),
        writer: delulu_cleanup::helper_path().is_some()
            && delulu_stt::file_ready(&s.store.models_dir(), &cleanup::CLEANUP_MODEL),
        voice: radio.voice.ready(),
        install_command: comfy::install_command(),
    };
    *radio.readiness.lock().unwrap_or_else(|e| e.into_inner()) = Some(readiness.clone());
    readiness
}

fn enabled(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<Shell>().store.settings().radio {
        Ok(())
    } else {
        Err("Turn on Delulu FM in Settings first.".into())
    }
}

#[tauri::command]
pub(crate) fn get_radio(app: tauri::AppHandle) -> RadioView {
    view(&app)
}

#[tauri::command]
pub(crate) async fn check_radio(app: tauri::AppHandle) -> Result<RadioView, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || check(&a))
        .await
        .map_err(|e| e.to_string())?;
    // A service that came back lets waiting production continue now.
    if let Ok(station) = app.state::<Radio>().station() {
        station.wake();
    }
    Ok(view(&app))
}

#[tauri::command]
pub(crate) fn radio_play(app: tauri::AppHandle) -> Result<RadioView, String> {
    enabled(&app)?;
    set_on_air(&app, true)?;
    let radio = app.state::<Radio>();
    {
        let _control = radio.control();
        radio.listening.store(true, Ordering::SeqCst);
        let item = radio.station()?.ensure_now();
        play_item(&app, item, false);
    }
    Ok(view(&app))
}

#[tauri::command]
pub(crate) fn radio_pause(app: tauri::AppHandle) -> RadioView {
    let radio = app.state::<Radio>();
    {
        let _control = radio.control();
        radio.listening.store(false, Ordering::SeqCst);
        radio.player.pause();
    }
    view(&app)
}

/// Stop playing and stop making new items. A song already in ComfyUI is still collected.
#[tauri::command]
pub(crate) fn radio_off(app: tauri::AppHandle) -> Result<RadioView, String> {
    let radio = app.state::<Radio>();
    {
        let _control = radio.control();
        radio.listening.store(false, Ordering::SeqCst);
        radio.player.pause();
    }
    set_on_air(&app, false)?;
    Ok(view(&app))
}

#[tauri::command]
pub(crate) fn radio_skip(app: tauri::AppHandle) -> Result<RadioView, String> {
    enabled(&app)?;
    let radio = app.state::<Radio>();
    let _control = radio.control();
    let next = radio.station()?.advance();
    if radio.listening.load(Ordering::SeqCst) {
        play_item(&app, next, true);
    } else {
        radio.player.stop();
    }
    Ok(view(&app))
}

#[tauri::command]
pub(crate) fn radio_volume(app: tauri::AppHandle, volume: f32) -> Result<(), String> {
    let radio = app.state::<Radio>();
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        0.8
    };
    radio.station()?.set_volume(volume);
    radio.player.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub(crate) fn radio_direction(
    app: tauri::AppHandle,
    direction: Direction,
) -> Result<RadioView, String> {
    app.state::<Radio>().station()?.set_direction(direction);
    Ok(view(&app))
}

#[tauri::command]
pub(crate) fn radio_request(app: tauri::AppHandle, text: String) -> Result<RadioView, String> {
    enabled(&app)?;
    app.state::<Radio>()
        .station()?
        .request(&text)
        .map_err(|e| e.to_string())?;
    Ok(view(&app))
}

struct AppBackend {
    app: tauri::AppHandle,
}

impl AppBackend {
    fn radio(&self) -> tauri::State<'_, Radio> {
        self.app.state::<Radio>()
    }
}

impl Backend for AppBackend {
    fn write(&self, prompt: String, max_tokens: u32, seed: u32) -> Result<String, RadioError> {
        let sampling = delulu_cleanup::Sampling {
            seed,
            temperature: 0.9,
            top_p: 0.95,
        };
        cleanup::generate(&self.app, prompt, max_tokens, sampling, WRITE_TIMEOUT)
    }
    fn may_start(&self) -> bool {
        let phase = status_value(&self.app.state::<Shell>()).phase;
        let quiet = self
            .radio()
            .last_dictation
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none_or(|t| t.elapsed() > DICTATION_QUIET);
        quiet
            && !matches!(
                phase.as_str(),
                "recording" | "transcribing" | "loadingModel"
            )
    }
    fn voice_ready(&self) -> bool {
        self.radio().voice.ready()
    }
    fn speak(&self, text: &str, out: &Path) -> Result<(), RadioError> {
        let stop = self.radio().stop.clone();
        self.radio()
            .voice
            .speak(text, out, &move || stop.load(Ordering::SeqCst))
    }
    fn write_workflow(
        &self,
        path: &Path,
        draft: &Draft,
        seed: u64,
        max_seconds: u32,
        prefix: &str,
    ) -> Result<(), RadioError> {
        self.radio()
            .comfy
            .write_workflow(path, draft, seed, max_seconds, prefix)
    }
    fn submit(&self, workflow: &Path) -> Result<String, SubmitError> {
        self.radio().comfy.submit(workflow)
    }
    fn find_submitted(&self, workflow: &Path, prefix: &str) -> Result<Option<String>, RadioError> {
        self.radio().comfy.find_submitted(workflow, prefix)
    }
    fn status(&self, prompt_id: &str) -> Result<JobState, RadioError> {
        self.radio().comfy.status(prompt_id)
    }
    fn cancel(&self, prompt_id: &str) {
        self.radio().comfy.cancel(prompt_id);
    }
    fn download(&self, prompt_id: &str, dir: &Path) -> Result<Vec<PathBuf>, RadioError> {
        self.radio().comfy.download(prompt_id, dir)
    }
    fn changed(&self) {
        let radio = self.radio();
        // Something new is ready: start it if Play is waiting, else keep it preloaded.
        {
            let _control = radio.control();
            if radio.listening.load(Ordering::SeqCst) && radio.player.position().is_none() {
                if let Ok(station) = radio.station() {
                    let item = station.ensure_now();
                    play_item(&self.app, item, false);
                }
            } else {
                preload(&self.app);
            }
        }
        emit(&self.app);
    }
}

/// Stop the production loop and any speech child on quit.
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(radio) = app.try_state::<Radio>() {
        radio.stop.store(true, Ordering::SeqCst);
        if let Ok(station) = radio.station() {
            station.wake();
        }
    }
}
