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
        if let Some(error) = &error {
            let s = app.state::<Shell>();
            let nothing_ready = ready_model(&dir, &s.store.settings().model).is_none();
            let phase_now = status_value(&s).phase;
            if let Some(message) = failed_while_waiting(&phase_now, nothing_ready, &id, error) {
                phase(&app, "error", Some(message));
            }
        }
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

/// The phase message when model `id`'s download failed (or was cancelled) while the
/// app waited for it with no downloaded model to use, as after Parakeet v3 was
/// retired: the waiting "loadingModel" phase would otherwise stay, and it blocks
/// picking another model. None when another downloaded model is there to load.
pub(crate) fn failed_while_waiting(
    phase: &str,
    nothing_ready: bool,
    id: &str,
    error: &str,
) -> Option<String> {
    (phase == "loadingModel" && nothing_ready).then(|| {
        let label = delulu_stt::model_info(id).map_or(id, |m| m.label);
        format!("{label} did not download ({error}). Try again or pick another model in Settings.")
    })
}

/// Changing the model would race these phases.
pub(crate) fn model_change_blocked(phase: &str) -> bool {
    matches!(phase, "recording" | "transcribing" | "loadingModel")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed replacement download must leave a phase that lets the user switch
    /// models; the waiting phase does not.
    #[test]
    fn a_failed_download_while_waiting_unblocks_picking_another_model() {
        let ultra = "parakeet-ultra-q8_0";
        let message = failed_while_waiting("loadingModel", true, ultra, "cancelled").unwrap();
        assert!(message.starts_with("Parakeet Ultra did not download (cancelled)"));
        assert!(model_change_blocked("loadingModel"));
        assert!(
            !model_change_blocked("error"),
            "the new phase allows a switch"
        );
        // Another downloaded model (Whisper) is there, loaded or loading: its phase stays.
        assert_eq!(failed_while_waiting("idle", false, ultra, "x"), None);
        assert_eq!(
            failed_while_waiting("loadingModel", false, ultra, "x"),
            None
        );
    }
}
