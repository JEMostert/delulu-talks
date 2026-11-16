//! The optional music models for Delulu FM: YuE2, and ACE-Step 1.5 (turbo plus a
//! 0.6B or 4B language model). Explicit downloads into the app's own models folder,
//! cancel, and delete. Nothing downloads on its own, and only these app-owned files
//! (and their partial downloads) are ever removed.
use super::*;
use delulu_models::{Model, ACE_STEP_LM_LARGE, ACE_STEP_LM_SMALL, ACE_STEP_TURBO, YUE2_3B};
use delulu_radio::model::{AceLm, Music, MusicEngine};
use std::path::Path;

pub(crate) static MUSIC_MODEL: delulu_models::ModelFile = YUE2_3B.files[0];
/// Every music model, in the order Settings → Models lists them.
const MODELS: [&Model; 4] = [
    &YUE2_3B,
    &ACE_STEP_TURBO,
    &ACE_STEP_LM_SMALL,
    &ACE_STEP_LM_LARGE,
];
/// Download progress reaches the window at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct MusicModel {
    /// The models of the download in progress; empty when none runs.
    downloading: Mutex<Vec<&'static str>>,
    /// The model being deleted, from before the song using it is stopped until
    /// its files are gone.
    removing: Mutex<Option<&'static str>>,
    cancel: Arc<AtomicBool>,
    done_bytes: std::sync::atomic::AtomicU64,
    total_bytes: std::sync::atomic::AtomicU64,
    error: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TermsView {
    name: &'static str,
    url: &'static str,
    credit: &'static str,
    text: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicModelRow {
    id: &'static str,
    /// yue or acestep
    engine: &'static str,
    label: &'static str,
    license: &'static str,
    bytes: u64,
    /// missing, downloading or ready
    state: &'static str,
    /// Shown before the download.
    terms: Option<TermsView>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicModelStatus {
    models: Vec<MusicModelRow>,
    /// Bytes of the download in progress, over all its models.
    done_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The models a song with these settings may load: YuE2, or ACE-Step's turbo set
/// and the language models its choice allows (auto takes whichever is installed).
pub(crate) fn needed(music: &Music) -> Vec<&'static Model> {
    match (music.engine, music.ace_lm) {
        (MusicEngine::Yue2, _) => vec![&YUE2_3B],
        (MusicEngine::AceStep, AceLm::Small) => vec![&ACE_STEP_TURBO, &ACE_STEP_LM_SMALL],
        (MusicEngine::AceStep, AceLm::Large) => vec![&ACE_STEP_TURBO, &ACE_STEP_LM_LARGE],
        (MusicEngine::AceStep, AceLm::Auto) => {
            vec![&ACE_STEP_TURBO, &ACE_STEP_LM_SMALL, &ACE_STEP_LM_LARGE]
        }
    }
}

/// Songs with these settings can be made from what is installed.
pub(crate) fn ready(music: &Music, dir: &Path) -> bool {
    match (music.engine, music.ace_lm) {
        (MusicEngine::AceStep, AceLm::Auto) => {
            ACE_STEP_TURBO.installed(dir)
                && (ACE_STEP_LM_SMALL.installed(dir) || ACE_STEP_LM_LARGE.installed(dir))
        }
        _ => needed(music).iter().all(|m| m.installed(dir)),
    }
}

/// A download is writing one of the models these settings need: the radio must
/// not read them.
/// A download or a delete is changing one of the models these settings need: the
/// radio must not read them.
pub(crate) fn changing(app: &tauri::AppHandle, music: &Music) -> bool {
    let m = app.state::<MusicModel>();
    let downloading = lock(&m.downloading).clone();
    let removing = *lock(&m.removing);
    needed(music)
        .iter()
        .any(|model| downloading.contains(&model.id) || removing == Some(model.id))
}

fn status(app: &tauri::AppHandle) -> MusicModelStatus {
    let m = app.state::<MusicModel>();
    let downloading = lock(&m.downloading).clone();
    let dir = app.state::<Shell>().store.models_dir();
    let status = MusicModelStatus {
        models: MODELS
            .iter()
            .map(|model| MusicModelRow {
                id: model.id,
                engine: model.engine.as_str(),
                label: model.label,
                license: model.license,
                bytes: model.bytes,
                state: if downloading.contains(&model.id) {
                    "downloading"
                } else if model.installed(&dir) {
                    "ready"
                } else {
                    "missing"
                },
                terms: model.terms.map(|t| TermsView {
                    name: t.name,
                    url: t.url,
                    credit: t.credit,
                    text: t.text,
                }),
            })
            .collect(),
        done_bytes: m.done_bytes.load(Ordering::SeqCst),
        total_bytes: if downloading.is_empty() {
            0
        } else {
            m.total_bytes.load(Ordering::SeqCst)
        },
        error: lock(&m.error).clone(),
    };
    status
}

fn emit_status(app: &tauri::AppHandle) {
    let _ = app.emit("music-model", status(app));
}

/// Mark `models` as downloading unless a download already runs or nothing is
/// missing. The lock is released on return, so the caller may read the status.
fn claim(downloading: &Mutex<Vec<&'static str>>, models: &[&'static Model]) -> bool {
    let mut downloading = lock(downloading);
    if !downloading.is_empty() || models.is_empty() {
        return false;
    }
    *downloading = models.iter().map(|m| m.id).collect();
    true
}

fn model(id: &str) -> Result<&'static Model, String> {
    MODELS
        .iter()
        .copied()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown music model {id}"))
}

#[tauri::command]
pub(crate) fn get_music_model(app: tauri::AppHandle) -> MusicModelStatus {
    status(&app)
}

/// Download the given models one after another (YuE2 when none are given),
/// skipping those already here. One download runs at a time.
#[tauri::command]
pub(crate) fn download_music_model(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> Result<MusicModelStatus, String> {
    let dir = app.state::<Shell>().store.models_dir();
    let ids = ids.unwrap_or_else(|| vec![YUE2_3B.id.to_string()]);
    let models: Vec<&'static Model> = ids
        .iter()
        .map(|id| model(id))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|m| !m.installed(&dir))
        .collect();
    let m = app.state::<MusicModel>();
    if !claim(&m.downloading, &models) {
        return Ok(status(&app));
    }
    m.cancel.store(false, Ordering::SeqCst);
    m.done_bytes.store(0, Ordering::SeqCst);
    m.total_bytes
        .store(models.iter().map(|m| m.bytes).sum(), Ordering::SeqCst);
    *lock(&m.error) = None;
    let cancel = m.cancel.clone();
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut before = 0u64;
        let mut result = Ok(());
        for model in models {
            let mut sent = Instant::now();
            let mut progress = |done: u64, _total: u64| {
                worker
                    .state::<MusicModel>()
                    .done_bytes
                    .store(before + done, Ordering::SeqCst);
                if sent.elapsed() >= PROGRESS_EVERY {
                    sent = Instant::now();
                    emit_status(&worker);
                }
            };
            result = delulu_models::download(&dir, model, &mut progress, &cancel);
            if result.is_err() {
                break;
            }
            before += model.bytes;
        }
        let m = worker.state::<MusicModel>();
        *lock(&m.error) = match result {
            Ok(()) | Err(delulu_models::Error::Cancelled) => None,
            Err(e) => Some(e.to_string()),
        };
        lock(&m.downloading).clear();
        emit_status(&worker);
        radio::models_changed(&worker);
        // A station waiting for the model can start now.
        if let Ok(station) = worker.state::<radio::Radio>().station() {
            station.wake();
        }
    });
    Ok(status(&app))
}

#[tauri::command]
pub(crate) fn cancel_music_download(app: tauri::AppHandle) {
    app.state::<MusicModel>()
        .cancel
        .store(true, Ordering::SeqCst);
}

/// Remove a downloaded model (YuE2 when none is given). A song in the making that
/// may use it stops first.
#[tauri::command]
pub(crate) fn delete_music_model(
    app: tauri::AppHandle,
    id: Option<String>,
) -> Result<MusicModelStatus, String> {
    let model = model(id.as_deref().unwrap_or(YUE2_3B.id))?;
    let m = app.state::<MusicModel>();
    if !lock(&m.downloading).is_empty() {
        return Err("Cancel the download first.".into());
    }
    let radio = app.state::<radio::Radio>();
    // Marked first: a song starting from now on sees it in its start-up check
    // (`changing`), and one that already passed that check is active, so the stop
    // below reaches it.
    *lock(&m.removing) = Some(model.id);
    // The song being made keeps the settings it started with, which may differ
    // from the station's since an engine switch.
    let uses = |music: &Music| needed(music).iter().any(|m| m.id == model.id);
    let in_use = radio.composing().as_ref().is_some_and(uses)
        || radio.station().map_or(true, |s| uses(&s.snapshot().music));
    if in_use {
        radio.composer.stop();
    }
    let removed = delulu_models::remove(&app.state::<Shell>().store.models_dir(), model);
    *lock(&m.removing) = None;
    removed.map_err(|e| format!("Could not delete {e}"))?;
    *lock(&m.error) = None;
    emit_status(&app);
    radio::models_changed(&app);
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engines open the files by these names; the registry downloads them.
    #[test]
    fn registry_names_the_files_the_engines_open() {
        assert_eq!(super::MUSIC_MODEL.file, delulu_radio::music::MODEL_FILE);
        assert_eq!(
            crate::cleanup::CLEANUP_MODEL.file,
            delulu_cleanup::MODEL_FILE
        );
    }

    /// A second download while one runs, or one with nothing missing, is refused
    /// without keeping the lock (the command then reads the status under it).
    #[test]
    fn a_refused_download_leaves_the_state_unlocked() {
        let downloading = Mutex::new(Vec::new());
        assert!(!claim(&downloading, &[]));
        assert!(downloading.try_lock().is_ok());
        assert!(claim(&downloading, &[&ACE_STEP_TURBO]));
        assert!(!claim(&downloading, &[&YUE2_3B]));
        assert!(downloading.try_lock().is_ok());
        assert_eq!(*lock(&downloading), [ACE_STEP_TURBO.id]);
    }

    /// ACE-Step on auto runs with either language model; a fixed choice needs it.
    #[test]
    fn ace_step_is_ready_with_the_files_its_choice_needs() {
        let dir = std::env::temp_dir().join(format!("delulu-music-{}", std::process::id()));
        let place = |model: &Model| {
            for f in model.files {
                let path = dir.join(f.file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::File::create(&path)
                    .unwrap()
                    .set_len(f.bytes)
                    .unwrap();
            }
        };
        let ace = |ace_lm| Music {
            engine: MusicEngine::AceStep,
            ace_lm,
            ace_warm: None,
        };
        place(&ACE_STEP_TURBO);
        assert!(!ready(&ace(AceLm::Auto), &dir));
        place(&ACE_STEP_LM_SMALL);
        assert!(ready(&ace(AceLm::Auto), &dir));
        assert!(ready(&ace(AceLm::Small), &dir));
        assert!(!ready(&ace(AceLm::Large), &dir));
        // YuE2 is not installed: ACE-Step's files do not make it ready.
        assert!(!ready(&Music::default(), &dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
