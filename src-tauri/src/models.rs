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
            download_failed(&AppPhases(&app, &dir), &id, error);
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

/// What the download's failure path reads and changes; the app's status in the app,
/// a fake in the tests.
pub(crate) trait Phases {
    fn phase(&self) -> String;
    fn set_error(&self, message: String);
    /// No downloaded model fits the speech model setting (see `ready_model`).
    fn nothing_ready(&self) -> bool;
}

struct AppPhases<'a>(&'a tauri::AppHandle, &'a std::path::Path);
impl Phases for AppPhases<'_> {
    fn phase(&self) -> String {
        status_value(&self.0.state::<Shell>()).phase
    }
    fn set_error(&self, message: String) {
        phase(self.0, "error", Some(message));
    }
    fn nothing_ready(&self) -> bool {
        let settings = self.0.state::<Shell>().store.settings();
        ready_model(self.1, &settings.model).is_none()
    }
}

/// Model `id`'s download failed (or was cancelled). When the app was waiting for it
/// with no downloaded model to use, as after Parakeet v3 was retired, it leaves the
/// waiting "loadingModel" phase, which blocks picking another model, for an error
/// that says what happened. Another downloaded model loaded or loading keeps its
/// phase.
pub(crate) fn download_failed(app: &impl Phases, id: &str, error: &str) {
    if app.phase() == "loadingModel" && app.nothing_ready() {
        let label = delulu_stt::model_info(id).map_or(id, |m| m.label);
        app.set_error(format!(
            "{label} did not download ({error}). Try again or pick another model in Settings."
        ));
    }
}

/// Changing the model would race these phases.
pub(crate) fn model_change_blocked(phase: &str) -> bool {
    matches!(phase, "recording" | "transcribing" | "loadingModel")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        phase: RefCell<String>,
        message: RefCell<Option<String>>,
        nothing_ready: bool,
    }
    impl Phases for Fake {
        fn phase(&self) -> String {
            self.phase.borrow().clone()
        }
        fn set_error(&self, message: String) {
            *self.phase.borrow_mut() = "error".into();
            *self.message.borrow_mut() = Some(message);
        }
        fn nothing_ready(&self) -> bool {
            self.nothing_ready
        }
    }
    fn waiting(nothing_ready: bool) -> Fake {
        Fake {
            phase: RefCell::new("loadingModel".into()),
            message: RefCell::new(None),
            nothing_ready,
        }
    }

    /// The bug: a cancelled replacement download left "loadingModel", in which
    /// set_settings refuses a model change.
    #[test]
    fn a_failed_download_while_waiting_lets_the_user_pick_another_model() {
        let app = waiting(true);
        assert!(model_change_blocked(&app.phase()));
        download_failed(&app, "parakeet-ultra-q8_0", "cancelled");
        assert!(!model_change_blocked(&app.phase()));
        assert_eq!(
            app.message.borrow().as_deref(),
            Some("Parakeet Ultra did not download (cancelled). Try again or pick another model in Settings.")
        );
    }

    #[test]
    fn a_failed_download_leaves_another_models_load_alone() {
        let app = waiting(false);
        download_failed(&app, "parakeet-ultra-q8_0", "network down");
        assert_eq!(app.phase(), "loadingModel");
        assert_eq!(*app.message.borrow(), None);
    }
}
