use super::*;

#[derive(Serialize)]
pub(crate) struct ModelStatus {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    downloaded: bool,
}
#[tauri::command]
pub(crate) fn list_models(s: State<'_, Shell>) -> Vec<ModelStatus> {
    delulu_stt::models()
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            label: m.label,
            bytes: m.bytes,
            downloaded: delulu_stt::is_downloaded(&s.store.models_dir(), m.id),
        })
        .collect()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    id: String,
    done_bytes: u64,
    total_bytes: u64,
    finished: bool,
    error: Option<String>,
}
#[tauri::command]
pub(crate) fn download_model(
    app: tauri::AppHandle,
    s: State<'_, Shell>,
    id: String,
) -> Result<(), String> {
    let total = delulu_stt::model_info(&id).ok_or("Unknown model")?.bytes;
    if s.downloading.swap(true, Ordering::SeqCst) {
        return Err("Download already in progress".into());
    }
    let cancel = s.download.clone();
    cancel.store(false, Ordering::SeqCst);
    let downloading = s.downloading.clone();
    let dir = s.store.models_dir();
    tauri::async_runtime::spawn_blocking(move || {
        // The public download API uses true to request cancellation.
        let mut progress = |done, total| {
            let _ = app.emit(
                "model-download",
                Progress {
                    id: id.clone(),
                    done_bytes: done,
                    total_bytes: total,
                    finished: false,
                    error: None,
                },
            );
        };
        let result = delulu_stt::download(&dir, &id, &mut progress, &cancel);
        downloading.store(false, Ordering::SeqCst);
        let (finished, error) = match result {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let _ = app.emit(
            "model-download",
            Progress {
                id: id.clone(),
                done_bytes: if finished { total } else { 0 },
                total_bytes: total,
                finished,
                error,
            },
        );
        if finished && app.state::<Shell>().store.settings().model == id {
            load_model(&app, id);
        }
    });
    Ok(())
}
#[tauri::command]
pub(crate) fn cancel_download(s: State<'_, Shell>) {
    s.download.store(true, Ordering::SeqCst);
}
