//! Delulu FM: the optional radio station. Off until Settings shows it and Play starts it.
//! Dictation comes first: playback holds silent while recording, and no new writing,
//! music or speech step starts while you dictate or just after.
use super::*;
use delulu_radio::{
    mix::{self, GenreLock},
    model::{AceLm, Draft, Music, MusicEngine, Request},
    music::{self, Composer, Order, Stage},
    voice::Voice,
    Backend, Feedback, Item, Kind, Mix, Player, PlayerEvent, RadioError, Station,
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
    /// The music settings the song being made started with; memory only.
    composing: Mutex<Option<Music>>,
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
    /// The `delulu-engine` binary, which runs the music helper, is installed.
    engine: bool,

    /// Which of ACE-Step's files are downloaded.
    ace: AceReadiness,
    /// The compute device the helper found, e.g. "Vulkan0 (NVIDIA GeForce RTX 5060 Ti)".
    device: Option<String>,
    /// False when only the processor is available (far too slow for songs).
    gpu: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AceReadiness {
    /// Text encoder, turbo DiT and VAE.
    turbo: bool,
    xl: bool,
    lm_small: bool,
    lm_large: bool,
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
    /// The genre and mood it was drawn with; null for requests, breaks and
    /// songs from before the mix.
    genre: Option<String>,
    mood: Option<String>,
    /// The genre came from outside the listener's pool.
    surprise: bool,
    feedback: Option<Feedback>,
    /// Kept out of clean-up (listed under `saved`).
    saved: bool,
}

impl ItemView {
    fn new(i: &Item, saved: &[Item]) -> Self {
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
            genre: i.genre.clone(),
            mood: i.mood.clone(),
            surprise: i.surprise,
            feedback: i.feedback,
            saved: saved.iter().any(|s| s.file == i.file),
        }
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct LengthLimits {
    min: u32,
    max: u32,
}

const LENGTH_LIMITS: LengthLimits = LengthLimits {
    min: delulu_radio::model::MIN_SONG_SECONDS,
    max: delulu_radio::model::MAX_SONG_SECONDS,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StationView {
    id: String,
    name: String,
    builtin: bool,
    /// The mix sounds like this station now.
    active: bool,
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
    /// What the song being made was drawn to be (songs only).
    genre: Option<String>,
    mood: Option<String>,
    surprise: bool,
    /// Music only: overall 0..1 and the phase (score, composing, shaping, rendering).
    progress: Option<f32>,
    phase: Option<String>,
    /// ACE-Step's first song with this engine build: the graphics driver prepares
    /// its shaders first, which takes a few minutes once.
    preparing: bool,
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
    mix: Mix,
    stations: Vec<StationView>,
    /// Saved songs, newest first.
    saved: Vec<ItemView>,
    lock: Option<GenreLock>,
    /// Songs a lock lasts when `radio_lock` gets no count.
    lock_songs: u32,
    /// Genre (lowercase) → draw weight from likes and dislikes; absent = 1.
    weights: BTreeMap<String, f32>,
    /// The song lengths the mix may ask for, in seconds; both engines reach them.
    length_limits: LengthLimits,
    last_song_seconds: Option<f64>,
    last_song_audio_seconds: Option<f64>,
    readiness: Option<Readiness>,
    music: Music,
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
            composing: Mutex::new(None),
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

    /// The music settings of the song being made, if one is.
    pub(crate) fn composing(&self) -> Option<Music> {
        self.composing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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
            if let Some(next) = station.advance_from(&id) {
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
                let next = station.advance_from(&item.id).flatten();
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

/// The station cannot run; `error` says why.
pub(crate) fn unavailable(error: Option<String>, readiness: Option<Readiness>) -> RadioView {
    RadioView {
        available: false,
        error,
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
        mix: Mix::default(),
        stations: Vec::new(),
        saved: Vec::new(),
        lock: None,
        lock_songs: mix::LOCK_SONGS,
        weights: BTreeMap::new(),
        length_limits: LENGTH_LIMITS,
        last_song_seconds: None,
        last_song_audio_seconds: None,
        readiness,
        music: Music::default(),
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
        return unavailable(radio.open_error.clone(), readiness);
    };
    let s = station.snapshot();
    let position = radio.player.position();
    let now_id = s.now.as_ref().map(|i| i.id.as_str());
    let stage = radio
        .stage
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let composing = radio.composing();
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
        genre: j.draw.as_ref().and_then(|d| d.genre.clone()),
        mood: j.draw.as_ref().and_then(|d| d.mood.clone()),
        surprise: j.draw.as_ref().is_some_and(|d| d.surprise),
        // From the song being made: the station's engine may have changed since.
        preparing: j.kind == Kind::Song
            && composing.is_some()
            && s.music.ace_warm.as_deref() != Some(warm_key().as_str()),
    });
    let pending: Vec<Request> = s.requests.iter().rev().take(4).rev().cloned().collect();
    let all = station.stations();
    let active = Station::active_station(&all, &s.mix);
    let view_item = |i: &Item| ItemView::new(i, &s.saved);
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
        now: s.now.as_ref().map(view_item),
        queue: s.queue.iter().map(view_item).collect(),
        history: s.history.iter().take(12).map(view_item).collect(),
        making: if s.on_air { making } else { None },
        last_error: s.last_error.clone(),
        requests: pending,
        mix: s.mix.clone(),
        stations: all
            .into_iter()
            .map(|st| StationView {
                active: active.as_deref() == Some(st.id.as_str()),
                id: st.id,
                name: st.name,
                builtin: st.builtin,
            })
            .collect(),
        // Without words: the list rides on every progress event.
        saved: s
            .saved
            .iter()
            .map(|i| ItemView {
                lyrics: None,
                script: None,
                ..view_item(i)
            })
            .collect(),
        lock: s.lock.clone(),
        lock_songs: mix::LOCK_SONGS,
        weights: s.weights.clone(),
        length_limits: LENGTH_LIMITS,
        last_song_seconds: s.stats.last_song_seconds,
        last_song_audio_seconds: s.stats.last_song_audio_seconds,
        readiness,
        music: s.music.clone(),
    }
}

/// The engine ships with the app, so the app's version names its build.
fn warm_key() -> String {
    music::warm_key(env!("CARGO_PKG_VERSION"))
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

/// Which music models are installed, for the readiness checklist.
fn model_readiness(dir: &Path) -> AceReadiness {
    AceReadiness {
        xl: delulu_models::ACE_STEP_XL_TURBO.installed(dir),
        turbo: delulu_models::ACE_STEP_TURBO.installed(dir),
        lm_small: delulu_models::ACE_STEP_LM_SMALL.installed(dir),
        lm_large: delulu_models::ACE_STEP_LM_LARGE.installed(dir),
    }
}

/// A music model was downloaded or deleted: correct the checklist now rather
/// than at the next check.
pub(crate) fn models_changed(app: &tauri::AppHandle) {
    let radio = app.state::<Radio>();
    {
        // Read under the lock, like `check`, so neither stores an older view.
        let mut readiness = radio.readiness.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = readiness.as_mut() {
            r.music.ace = model_readiness(&app.state::<Shell>().store.models_dir());
        }
    }
    emit(app);
}

fn check(app: &tauri::AppHandle) -> Readiness {
    let radio = app.state::<Radio>();
    let s = app.state::<Shell>();
    let helper = music::helper_path();
    let found = helper.as_deref().and_then(probe);
    // Asks `delulu status`: before the lock, which the window's view also takes.
    let voice = radio.voice.ready();
    // The model files are read under the lock, like `models_changed`, so a check
    // that started before a download or delete finished cannot store older facts.
    let mut cached = radio.readiness.lock().unwrap_or_else(|e| e.into_inner());
    let ace = model_readiness(&s.store.models_dir());
    let readiness = Readiness {
        music: MusicReadiness {
            engine: helper.is_some(),
            ace,
            gpu: found.as_ref().is_some_and(|f| f.1),
            device: found.map(|f| f.0),
        },
        writer: delulu_cleanup::helper_path().is_some()
            && delulu_stt::file_ready(&s.store.models_dir(), &cleanup::CLEANUP_MODEL),
        voice,
    };
    *cached = Some(readiness.clone());
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
    skip(&app)?;
    Ok(view(&app))
}

fn skip(app: &tauri::AppHandle) -> Result<(), String> {
    let radio = app.state::<Radio>();
    let _control = radio.control();
    let next = radio.station()?.advance();
    play_next(app, next);
    Ok(())
}

/// After an advance, under the control lock: play `next` if listening.
fn play_next(app: &tauri::AppHandle, next: Option<Item>) {
    let radio = app.state::<Radio>();
    if radio.listening.load(Ordering::SeqCst) {
        play_item(app, next, true);
    } else {
        radio.player.stop();
    }
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

/// Run `f` on the station and answer with the new view; the window hears it too.
fn with_station(
    app: &tauri::AppHandle,
    f: impl FnOnce(&Station) -> Result<(), RadioError>,
) -> Result<RadioView, String> {
    f(app.state::<Radio>().station()?).map_err(|e| e.to_string())?;
    emit(app);
    Ok(view(app))
}

/// Replace the mix (pools, surprise, choices, host, language, theme). Applies to
/// songs not written yet.
#[tauri::command]
pub(crate) fn radio_mix(app: tauri::AppHandle, mix: Mix) -> Result<RadioView, String> {
    with_station(&app, |s| s.set_mix(mix).map(|_| ()))
}

/// Roll a random mix on the station, so the window and any other client agree.
#[tauri::command]
pub(crate) fn radio_shuffle(app: tauri::AppHandle) -> Result<RadioView, String> {
    with_station(&app, |s| s.shuffle().map(|_| ()))
}

/// Save the mix as a station; a station of the listener's with that name is updated.
#[tauri::command]
pub(crate) fn radio_station_save(app: tauri::AppHandle, name: String) -> Result<RadioView, String> {
    with_station(&app, |s| s.save_station(&name).map(|_| ()))
}

#[tauri::command]
pub(crate) fn radio_station_rename(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<RadioView, String> {
    with_station(&app, |s| s.rename_station(&id, &name))
}

#[tauri::command]
pub(crate) fn radio_station_delete(app: tauri::AppHandle, id: String) -> Result<RadioView, String> {
    with_station(&app, |s| s.delete_station(&id))
}

/// Tune the mix to a station; host and language stay.
#[tauri::command]
pub(crate) fn radio_station_activate(
    app: tauri::AppHandle,
    id: String,
) -> Result<RadioView, String> {
    with_station(&app, |s| s.activate_station(&id).map(|_| ()))
}

/// Like or dislike a song (null takes it back). Disliking the airing song skips it.
#[tauri::command]
pub(crate) fn radio_feedback(
    app: tauri::AppHandle,
    id: String,
    feedback: Option<Feedback>,
) -> Result<RadioView, String> {
    let radio = app.state::<Radio>();
    let station = radio.station()?;
    {
        // Held from the verdict to the skip, so playback cannot move on between
        // them; and the skip ends only this song, never the one after it.
        let _control = radio.control();
        station.feedback(&id, feedback).map_err(|e| e.to_string())?;
        if feedback == Some(Feedback::Dislike) {
            if let Some(next) = station.advance_from(&id) {
                play_next(&app, next);
            }
        }
    }
    emit(&app);
    Ok(view(&app))
}

/// Forget likes and dislikes of one genre, or of all when `genre` is null.
#[tauri::command]
pub(crate) fn radio_reset_feedback(
    app: tauri::AppHandle,
    genre: Option<String>,
) -> Result<RadioView, String> {
    with_station(&app, |s| {
        s.reset_feedback(genre.as_deref());
        Ok(())
    })
}

/// Stay on the airing song's genre: for `songs` songs (null: `lockSongs`), or
/// until unlocked when `songs` is 0.
#[tauri::command]
pub(crate) fn radio_lock(app: tauri::AppHandle, songs: Option<u32>) -> Result<RadioView, String> {
    let songs = match songs {
        None => Some(mix::LOCK_SONGS),
        Some(0) => None,
        Some(n) => Some(n),
    };
    with_station(&app, |s| s.lock_genre(songs).map(|_| ()))
}

#[tauri::command]
pub(crate) fn radio_unlock(app: tauri::AppHandle) -> Result<RadioView, String> {
    with_station(&app, |s| {
        s.unlock_genre();
        Ok(())
    })
}

/// Keep a song (any item id: airing, queued, played) out of clean-up.
#[tauri::command]
pub(crate) fn radio_save(app: tauri::AppHandle, id: String) -> Result<RadioView, String> {
    with_station(&app, |s| s.save_song(&id))
}

#[tauri::command]
pub(crate) fn radio_unsave(app: tauri::AppHandle, id: String) -> Result<RadioView, String> {
    with_station(&app, |s| {
        s.unsave_song(&id);
        Ok(())
    })
}

/// Play a saved song now (labelled as a replay), starting the station if needed.
#[tauri::command]
pub(crate) fn radio_play_saved(app: tauri::AppHandle, id: String) -> Result<RadioView, String> {
    enabled(&app)?;
    let radio = app.state::<Radio>();
    let station = radio.station()?;
    // Checked and decoded before going on air, so a stale id or a lost or broken
    // file changes nothing.
    let saved = station
        .snapshot()
        .saved
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("That song is no longer saved.")?;
    let audio = station
        .load_audio(&saved)
        .map_err(|e| format!("That saved song can't be played: {e}"))?;
    {
        let _control = radio.control();
        let item = station.air_saved(&id).map_err(|e| e.to_string())?;
        radio.listening.store(true, Ordering::SeqCst);
        radio.player.play(&item.id, audio);
        preload(&app);
    }
    set_on_air(&app, true)?;
    emit(&app);
    Ok(view(&app))
}

/// Choose the music engine and ACE-Step's language model, from the next song on.
#[tauri::command]
pub(crate) fn radio_music(
    app: tauri::AppHandle,
    engine: MusicEngine,
    ace_lm: AceLm,
) -> Result<RadioView, String> {
    app.state::<Radio>().station()?.set_music(engine, ace_lm);
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
    fn speak(&self, text: &str, lang: &str, out: &Path) -> Result<String, RadioError> {
        let stop = self.radio().stop.clone();
        let voice = crate::voice::radio_voice();
        self.radio()
            .voice
            .speak(text, lang, Some(&voice), out, &move || {
                stop.load(Ordering::SeqCst)
            })?;
        // OpenRAIL-M Attachment A (e): the host is labelled as machine generated.
        Ok(format!(
            "Supertonic 3 by Supertone, voice {voice} (AI-generated)"
        ))
    }
    fn compose(
        &self,
        draft: &Draft,
        seed: u64,
        seconds: u32,
        settings: &Music,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError> {
        let helper = music::helper_path().ok_or_else(|| {
            RadioError::Unavailable("The music engine (delulu-engine) is not installed.".into())
        })?;
        let models = self.app.state::<Shell>().store.models_dir();
        if !crate::music::ready(settings, &models) || crate::music::changing(&self.app, settings) {
            return Err(RadioError::Unavailable(
                "Download the generator and Song Planner in Settings → Models to make songs."
                    .into(),
            ));
        }
        let radio = self.radio();
        *radio.composing.lock().unwrap_or_else(|e| e.into_inner()) = Some(settings.clone());
        let order = Order::new(draft, seed, seconds, settings, &models);
        let mut sent = Instant::now();
        // Off air, quitting or the model removed while the helper was starting.
        let cancelled = || {
            radio.stop.load(Ordering::SeqCst)
                || radio.station().map_or(true, |s| !s.on_air())
                || !crate::music::ready(settings, &models)
                || crate::music::changing(&self.app, settings)
        };
        let result = radio
            .composer
            .compose(&helper, &order, out, &cancelled, &mut |stage| {
                *radio.stage.lock().unwrap_or_else(|e| e.into_inner()) = Some(stage);
                if sent.elapsed() >= PROGRESS_EVERY {
                    sent = Instant::now();
                    emit(&self.app);
                }
            });
        *radio.stage.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *radio.composing.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let report = result?;
        if let Ok(station) = radio.station() {
            station.set_ace_warm(warm_key());
        }
        Ok(music::provenance(&report))
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
