//! The optional music model for Delulu FM: an explicit download into the app's own
//! models folder, cancel, and delete. Nothing downloads on its own, and only this
//! one app-owned file (and its partial download) is ever removed.
use super::*;
use delulu_models::YUE2_3B as MODEL;

pub(crate) static MUSIC_MODEL: delulu_models::ModelFile = MODEL.files[0];
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

/// The model is being downloaded or removed: the radio must not read it.
pub(crate) fn changing(app: &tauri::AppHandle) -> bool {
    app.state::<MusicModel>().downloading.load(Ordering::SeqCst)
}

fn status(app: &tauri::AppHandle) -> MusicModelStatus {
    let m = app.state::<MusicModel>();
    let downloading = m.downloading.load(Ordering::SeqCst);
    let error = m.error.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let ready = !downloading && MODEL.installed(&app.state::<Shell>().store.models_dir());
    MusicModelStatus {
        state: if downloading {
            "downloading"
        } else if ready {
            "ready"
        } else {
            "missing"
        },
        label: MODEL.label,
        license: MODEL.license,
        done_bytes: if downloading {
            m.done_bytes.load(Ordering::SeqCst)
        } else {
            0
        },
        total_bytes: MODEL.bytes,
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
        let result = delulu_models::download(&dir, &MODEL, &mut progress, &cancel);
        let m = worker.state::<MusicModel>();
        *m.error.lock().unwrap_or_else(|e| e.into_inner()) = match result {
            Ok(()) | Err(delulu_models::Error::Cancelled) => None,
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
    delulu_models::remove(&app.state::<Shell>().store.models_dir(), &MODEL)
        .map_err(|e| format!("Could not delete {e}"))?;
    *m.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
    emit_status(&app);
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    /// The engines open the files by these names; the registry downloads them.
    #[test]
    fn registry_names_the_files_the_engines_open() {
        assert_eq!(super::MUSIC_MODEL.file, delulu_radio::music::MODEL_FILE);
        assert_eq!(
            crate::cleanup::CLEANUP_MODEL.file,
            delulu_cleanup::MODEL_FILE
        );
    }
}
