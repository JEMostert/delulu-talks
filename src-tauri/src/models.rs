use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelStatus {
    id: &'static str,
    label: &'static str,
    /// "whisper" or "parakeet".
    engine: &'static str,
    bytes: u64,
    downloaded: bool,
    license: &'static str,
    /// Who made it and where its licence is, for the credit shown at download.
    credit: Option<&'static str>,
    license_url: Option<&'static str>,
    /// The retired model this one replaces, while its files are still here: the
    /// window then says so and downloads this one.
    replaces: Option<&'static str>,
}
pub(crate) fn model_status(
    dir: &std::path::Path,
    m: &'static delulu_stt::ModelInfo,
) -> ModelStatus {
    ModelStatus {
        id: m.id,
        label: m.label,
        engine: m.engine.as_str(),
        bytes: m.bytes,
        downloaded: delulu_stt::is_downloaded(dir, m.id),
        license: m.license,
        credit: m.terms.map(|t| t.credit),
        license_url: m.terms.map(|t| t.url),
        replaces: delulu_stt::replaces_on_disk(dir, m.id).map(|r| r.label),
    }
}
#[tauri::command]
pub(crate) fn list_models(s: State<'_, Shell>) -> Vec<ModelStatus> {
    let dir = s.store.models_dir();
    delulu_stt::models()
        .iter()
        .map(|m| model_status(&dir, m))
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
    let model = delulu_stt::model_info(&id).ok_or("Unknown model")?;
    let total = model.bytes;
    if s.downloading.swap(true, Ordering::SeqCst) {
        return Err("Download already in progress".into());
    }
    let cancel = s.download.clone();
    cancel.store(false, Ordering::SeqCst);
    let downloading = s.downloading.clone();
    let dir = s.store.models_dir();
    tauri::async_runtime::spawn_blocking(move || {
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
        let result = delulu_models::download(&dir, model, &mut progress, &cancel);
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
        if finished {
            // The retired model this one replaces can no longer run.
            delulu_stt::remove_replaced(&dir, &id);
        }
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
