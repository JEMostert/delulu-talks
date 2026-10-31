//! Delulu FM: the optional radio station. Off until Settings shows it and Play starts it.
//! Dictation comes first: playback holds silent while recording, and no new writing,
//! music or speech step starts while you dictate or just after.
use super::*;
use delulu_radio::{
    model::{Draft, Request},
    music::{self, Composer, Song, Stage},
    voice::Voice,
    Backend, Direction, Item, Kind, Player, PlayerEvent, RadioError, Station,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Quiet time after dictation before the radio may start a GPU step.
const DICTATION_QUIET: Duration = Duration::from_secs(8);
/// A brief or script is a few hundred tokens; this only catches a stuck helper.
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// Progress of a song in the making is sent to the window at most this often.
const PROGRESS_EVERY: Duration = Duration::from_secs(1);

pub(crate) struct Radio {
    station: Option<Arc<Station>>,
    open_error: Option<String>,
    player: Player,
    pub(crate) composer: Composer,
    /// Where the song being made is; memory only.
    stage: Mutex<Option<Stage>>,
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
    music: MusicReadiness,
    /// The cleanup model and helper exist.
    writer: bool,
    voice: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicReadiness {
    /// The `delulu-music` helper is installed.
    engine: bool,
    /// The YuE2 model is downloaded.
    model: bool,
    /// The compute device the helper found, e.g. "Vulkan0 (NVIDIA GeForce RTX 5060 Ti)".
    device: Option<String>,
    /// False when only the processor is available (far too slow for songs).
    gpu: bool,
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
    /// Music only: overall 0..1 and the phase (score, composing, shaping, rendering).
    progress: Option<f32>,
    phase: Option<String>,
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
            composer: Composer::default(),
            stage: Mutex::new(None),
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

    pub(crate) fn station(&self) -> Result<&Arc<Station>, String> {
        self.station
            .as_ref()
            .ok_or_else(|| self.open_error.clone().unwrap_or_default())
    }
}

/// Start the production loop. It sleeps until the station goes on air.
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

/// Dictation phase changes: hold playback while recording, pause the music engine
/// while dictation needs the graphics card, remember the time.
pub(crate) fn on_phase(app: &tauri::AppHandle, phase: &str) {
    let Some(radio) = app.try_state::<Radio>() else {
        return;
    };
    let dictating = matches!(phase, "recording" | "transcribing");
    radio.composer.pause(dictating || phase == "loadingModel");
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
    let stage = radio
        .stage
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let making = s.job.as_ref().map(|j| Making {
        progress: stage.as_ref().map(|s| s.fraction),
        phase: stage.as_ref().map(|s| s.phase.clone()),
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
        making: if s.on_air { making } else { None },
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
    radio.composer.stop();
    emit(app);
}

/// Ask the helper which device it would use.
fn probe(helper: &Path) -> Option<(String, bool)> {
    let output = std::process::Command::new(helper)
        .arg("probe")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(line.lines().last()?).ok()?;
    Some((
        value["device"].as_str()?.to_string(),
        value["gpu"].as_bool().unwrap_or(false),
    ))
}

fn check(app: &tauri::AppHandle) -> Readiness {
    let radio = app.state::<Radio>();
    let s = app.state::<Shell>();
    let helper = music::helper_path();
    let found = helper.as_deref().and_then(probe);
    let readiness = Readiness {
        music: MusicReadiness {
            engine: helper.is_some(),
            model: delulu_stt::file_ready(&s.store.models_dir(), &crate::music::MUSIC_MODEL),
            gpu: found.as_ref().is_some_and(|f| f.1),
            device: found.map(|f| f.0),
        },
        writer: delulu_cleanup::helper_path().is_some()
            && delulu_stt::file_ready(&s.store.models_dir(), &cleanup::CLEANUP_MODEL),
        voice: radio.voice.ready(),
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

/// Stop playing and making. A song in the making stops; its words are kept.
#[tauri::command]
pub(crate) fn radio_off(app: tauri::AppHandle) -> Result<RadioView, String> {
    let radio = app.state::<Radio>();
    {
        let _control = radio.control();
        radio.listening.store(false, Ordering::SeqCst);
        radio.player.pause();
    }
    set_on_air(&app, false)?;
    radio.composer.stop();
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
    fn compose(
        &self,
        draft: &Draft,
        seed: u64,
        max_seconds: u32,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError> {
        let helper = music::helper_path().ok_or_else(|| {
            RadioError::Unavailable("The music engine (delulu-music) is not installed.".into())
        })?;
        let models = self.app.state::<Shell>().store.models_dir();
        if !delulu_stt::file_ready(&models, &crate::music::MUSIC_MODEL)
            || crate::music::changing(&self.app)
        {
            return Err(RadioError::Unavailable(
                "Download the music model in Settings → Models to make songs.".into(),
            ));
        }
        let radio = self.radio();
        let song = Song::new(draft, seed, max_seconds);
        let mut sent = Instant::now();
        // Off air, quitting or the model removed while the helper was starting.
        let cancelled = || {
            radio.stop.load(Ordering::SeqCst)
                || radio.station().map_or(true, |s| !s.on_air())
                || !delulu_stt::file_ready(&models, &crate::music::MUSIC_MODEL)
        };
        let result = radio.composer.compose(
            &helper,
            &models.join(music::MODEL_FILE),
            &song,
            out,
            &cancelled,
            &mut |stage| {
                *radio.stage.lock().unwrap_or_else(|e| e.into_inner()) = Some(stage);
                if sent.elapsed() >= PROGRESS_EVERY {
                    sent = Instant::now();
                    emit(&self.app);
                }
            },
        );
        *radio.stage.lock().unwrap_or_else(|e| e.into_inner()) = None;
        result.map(|report| music::provenance(&report))
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

/// Stop the production loop, the music engine and any speech child on quit.
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(radio) = app.try_state::<Radio>() {
        radio.stop.store(true, Ordering::SeqCst);
        radio.composer.stop();
        if let Ok(station) = radio.station() {
            station.wake();
        }
    }
}
