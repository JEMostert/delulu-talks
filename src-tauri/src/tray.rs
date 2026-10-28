use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, Wry,
};
/// Menu items that change while the app runs.
struct TrayMenu {
    topic: MenuItem<Wry>,
    clear: MenuItem<Wry>,
}
fn icon(phase: &str) -> Option<Image<'static>> {
    let bytes: &[u8] = match phase {
        "recording" => include_bytes!("../icons/tray/tray-recording.png"),
        "transcribing" | "loadingModel" => include_bytes!("../icons/tray/tray-busy.png"),
        _ => include_bytes!("../icons/tray/tray-idle.png"),
    };
    Image::from_bytes(bytes).ok()
}
pub fn set_icon(app: &tauri::AppHandle, phase: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(icon(phase));
    }
}
fn topic_text(topic: Option<&str>) -> String {
    match topic {
        Some(topic) => format!("Topic: {topic}"),
        None => "No topic yet".into(),
    }
}
/// Show the current dictation topic, and whether there is one to clear.
pub fn set_topic(app: &tauri::AppHandle, topic: Option<&str>) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.topic.set_text(topic_text(topic));
        let _ = menu.clear.set_enabled(topic.is_some());
    }
}
pub fn create(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    // A label: the topic the next dictation starts from.
    let topic = MenuItem::with_id(app, "topic", topic_text(None), false, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear-topic", "Clear topic", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &topic,
            &clear,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(TrayMenu {
        topic: topic.clone(),
        clear: clear.clone(),
    });
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "clear-topic" => crate::context::clear(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(image) = icon("idle") {
        builder = builder.icon(image);
    }
    builder.build(app)?;
    Ok(())
}
