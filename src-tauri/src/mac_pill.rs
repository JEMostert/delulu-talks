//! The macOS recording panel (`MacPillFactory`): a transparent,
//! always-on-top, non-focusable, click-through webview showing
//! `delulu_desktop::mac_pill::html()`. Used on macOS only; it compiles
//! everywhere so the Linux build type-checks it.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use delulu_desktop::mac_pill::{html, position, render_script, AUTO_HIDE, HEIGHT, WIDTH};
use delulu_desktop::{MacPillFactory, MacPillWindow, PillCommand, PillState};
use tauri::{AppHandle, LogicalPosition, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "pill";

pub struct TauriMacPillFactory(pub AppHandle);

impl MacPillFactory for TauriMacPillFactory {
    fn create(&self, on_error: Arc<dyn Fn(String) + Send + Sync>) -> Box<dyn MacPillWindow> {
        Box::new(TauriMacPill { app: self.0.clone(), window: None, on_error, generation: Arc::new(AtomicU64::new(0)) })
    }
}

struct TauriMacPill {
    app: AppHandle,
    window: Option<WebviewWindow>,
    on_error: Arc<dyn Fn(String) + Send + Sync>,
    /// Bumped by every command, so a stale auto-hide or show is skipped.
    generation: Arc<AtomicU64>,
}

fn data_url() -> String {
    let mut encoded = String::from("data:text/html;charset=utf-8,");
    for byte in html().bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

impl TauriMacPill {
    fn window(&mut self) -> Result<WebviewWindow, String> {
        if let Some(window) = &self.window {
            return Ok(window.clone());
        }
        let url: Url = data_url().parse().map_err(|error| format!("{error}"))?;
        let window = WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::External(url))
            .inner_size(WIDTH as f64, HEIGHT as f64)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .focusable(false)
            .focused(false)
            .skip_taskbar(true)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .on_navigation(|url| url.scheme() == "data")
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|error| error.to_string())?;
        window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
        self.window = Some(window.clone());
        Ok(window)
    }

    fn place(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let cursor = self.app.cursor_position()?;
        let monitor = match self.app.monitor_from_point(cursor.x, cursor.y)? {
            Some(monitor) => Some(monitor),
            None => self.app.primary_monitor()?,
        };
        let Some(monitor) = monitor else { return Ok(()) };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let logical = |value: f64| (value / scale).round() as i32;
        let (x, y) = position(
            logical(area.position.x as f64),
            logical(area.position.y as f64),
            logical(area.size.width as f64),
            logical(area.size.height as f64),
        );
        window.set_position(LogicalPosition::new(x, y))
    }

    fn fail(&mut self, reason: String) {
        (self.on_error)(format!("Mac recording indicator unavailable: {reason}"));
        self.shutdown();
    }
}

impl MacPillWindow for TauriMacPill {
    fn send(&mut self, command: &PillCommand) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if command.state == PillState::Hidden {
            if let Some(window) = &self.window {
                let _ = window.hide();
            }
            return;
        }
        let window = match self.window() {
            Ok(window) => window,
            Err(reason) => return self.fail(reason),
        };
        let shown = self
            .place(&window)
            .and_then(|()| window.eval(render_script(command)))
            .and_then(|()| if self.generation.load(Ordering::SeqCst) == generation { window.show() } else { Ok(()) });
        if let Err(error) = shown {
            return self.fail(error.to_string());
        }
        if matches!(command.state, PillState::Success | PillState::Error) {
            let current = self.generation.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(AUTO_HIDE).await;
                if current.load(Ordering::SeqCst) == generation {
                    let _ = window.hide();
                }
            });
        }
    }

    fn shutdown(&mut self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(window) = self.window.take() {
            let _ = window.destroy();
        }
    }
}
