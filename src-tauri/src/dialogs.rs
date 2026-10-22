//! Native open/save dialogs (tauri-plugin-dialog) as async calls.

use std::path::PathBuf;

use delulu_core::DomainResult;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};
use tokio::sync::oneshot;

use crate::state::plain;

pub struct Filter<'a> {
    pub name: &'a str,
    pub extensions: &'a [&'a str],
}

fn builder(app: &AppHandle, title: &str, filter: Option<Filter<'_>>) -> FileDialogBuilder<tauri::Wry> {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(filter) = filter {
        dialog = dialog.add_filter(filter.name, filter.extensions);
    }
    if let Some(window) = crate::shell::main_window(app) {
        dialog = dialog.set_parent(&window);
    }
    dialog
}

fn paths(chosen: Option<Vec<FilePath>>) -> Vec<PathBuf> {
    chosen.unwrap_or_default().into_iter().filter_map(|path| path.into_path().ok()).collect()
}

/// Chosen files; empty when cancelled.
pub async fn open(app: &AppHandle, title: &str, filter: Filter<'_>, multiple: bool) -> Vec<PathBuf> {
    let (sender, receiver) = oneshot::channel();
    let dialog = builder(app, title, Some(filter));
    if multiple {
        dialog.pick_files(move |chosen| {
            let _ = sender.send(paths(chosen));
        });
    } else {
        dialog.pick_file(move |chosen| {
            let _ = sender.send(paths(chosen.map(|path| vec![path])));
        });
    }
    receiver.await.unwrap_or_default()
}

/// `chooseExportPath`: the dialog confirms overwrites, so its exact path is
/// kept; a name without the expected extension is refused rather than
/// suffixed (which would bypass that confirmation).
pub async fn save(
    app: &AppHandle,
    title: &str,
    default_name: &str,
    filter: Filter<'_>,
) -> DomainResult<Option<PathBuf>> {
    let extension = filter.extensions.first().copied().unwrap_or("").to_owned();
    let (sender, receiver) = oneshot::channel();
    builder(app, title, Some(filter)).set_file_name(default_name).save_file(move |chosen| {
        let _ = sender.send(chosen.and_then(|path| path.into_path().ok()));
    });
    let Some(path) = receiver.await.ok().flatten() else { return Ok(None) };
    let actual = path.extension().map(|value| value.to_string_lossy().to_lowercase());
    if actual.as_deref() != Some(extension.as_str()) {
        return Err(plain(format!("Choose a filename ending in .{extension}.")));
    }
    Ok(Some(path))
}
