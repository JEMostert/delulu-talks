//! Dictation context in the app: the shared [`delulu_dictation::context::Context`] plus
//! the tray topic and the expiry timer.
use super::*;
pub(crate) use delulu_dictation::context::{Context, EXPIRE};

/// Keep what this dictation was about for the next one, and end it after a quiet spell.
pub(crate) fn remember(app: &tauri::AppHandle, topic: Option<String>, sentence: &str) {
    let generation = app.state::<Shell>().context.remember(topic, sentence);
    tray::set_topic(app, app.state::<Shell>().context.topic().as_deref());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(EXPIRE).await;
        if app.state::<Shell>().context.clear_if(Some(generation)) {
            tray::set_topic(&app, None);
        }
    });
}

/// Forget the context now (tray "Clear topic").
pub(crate) fn clear(app: &tauri::AppHandle) {
    app.state::<Shell>().context.clear_if(None);
    tray::set_topic(app, None);
}
