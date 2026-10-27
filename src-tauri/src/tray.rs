use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
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
pub fn create(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(image) = icon("idle") {
        builder = builder.icon(image);
    }
    builder.build(app)?;
    Ok(())
}
