//! The optional music model for Delulu FM: an explicit download into the app's own
//! models folder, cancel, and delete. Nothing downloads on its own, and only this
//! one app-owned file (and its partial download) is ever removed.
use super::*;
use delulu_radio::music;

pub(crate) static MUSIC_MODEL: delulu_stt::ModelFile = delulu_stt::ModelFile {
    file: music::MODEL_FILE,
    url: music::MODEL_URL,
    sha256: music::MODEL_SHA256,
    bytes: music::MODEL_BYTES,
};
/// Download progress reaches the window at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(crate) struct MusicModel {
    downloading: AtomicBool,
    cancel: Arc<AtomicBool>,
    done_bytes: std::sync::atomic::AtomicU64,
    error: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicModelStatus {
    /// missing, downloading or ready
    state: &'static str,
    label: &'static str,
    license: &'static str,
    done_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

fn path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.state::<Shell>()
        .store
        .models_dir()
        .join(MUSIC_MODEL.file)
}

/// The model is being downloaded or removed: the radio must not read it.
pub(crate) fn changing(app: &tauri::AppHandle) -> bool {
    app.state::<MusicModel>().downloading.load(Ordering::SeqCst)
}

fn status(app: &tauri::AppHandle) -> MusicModelStatus {
    let m = app.state::<MusicModel>();
    let downloading = m.downloading.load(Ordering::SeqCst);
    let error = m.error.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let ready = !downloading
        && delulu_stt::file_ready(&app.state::<Shell>().store.models_dir(), &MUSIC_MODEL);
    MusicModelStatus {
        state: if downloading {
            "downloading"
        } else if ready {
            "ready"
        } else {
            "missing"
        },
        label: music::MODEL_LABEL,
        license: music::MODEL_LICENSE,
        done_bytes: if downloading {
            m.done_bytes.load(Ordering::SeqCst)
        } else {
            0
        },
        total_bytes: MUSIC_MODEL.bytes,
        error,
    }
}

fn emit_status(app: &tauri::AppHandle) {
    let _ = app.emit("music-model", status(app));
}

#[tauri::command]
pub(crate) fn get_music_model(app: tauri::AppHandle) -> MusicModelStatus {
    status(&app)
}

#[tauri::command]
pub(crate) fn download_music_model(app: tauri::AppHandle) -> Result<MusicModelStatus, String> {
    let m = app.state::<MusicModel>();
    if m.downloading.swap(true, Ordering::SeqCst) {
        return Ok(status(&app));
    }
    m.cancel.store(false, Ordering::SeqCst);
    m.done_bytes.store(0, Ordering::SeqCst);
    *m.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let cancel = m.cancel.clone();
    let dir = app.state::<Shell>().store.models_dir();
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sent = Instant::now();
        let mut progress = |done: u64, _total: u64| {
            worker
                .state::<MusicModel>()
                .done_bytes
                .store(done, Ordering::SeqCst);
            if sent.elapsed() >= PROGRESS_EVERY {
                sent = Instant::now();
                emit_status(&worker);
            }
        };
        let result = delulu_stt::download_file(&dir, &MUSIC_MODEL, &mut progress, &cancel);
        let m = worker.state::<MusicModel>();
        *m.error.lock().unwrap_or_else(|e| e.into_inner()) = match result {
            Ok(_) | Err(delulu_stt::SttError::Cancelled) => None,
            Err(e) => Some(e.to_string()),
        };
        m.downloading.store(false, Ordering::SeqCst);
        emit_status(&worker);
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

/// Remove the downloaded model. A song in the making stops first.
#[tauri::command]
pub(crate) fn delete_music_model(app: tauri::AppHandle) -> Result<MusicModelStatus, String> {
    let m = app.state::<MusicModel>();
    if m.downloading.load(Ordering::SeqCst) {
        return Err("Cancel the download first.".into());
    }
    app.state::<radio::Radio>().composer.stop();
    let file = path(&app);
    let part = file.with_file_name(format!("{}.part", MUSIC_MODEL.file));
    for p in [&file, &part] {
        match std::fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not delete {}: {e}", p.display())),
        }
    }
    *m.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    emit_status(&app);
    Ok(status(&app))
}
