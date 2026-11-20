pub use crate::APP_ID;
pub use delulu_core::gesture::{Command, Gesture, KeyEvent, HOLD_MS};
use std::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

pub const DEFAULT_TRIGGER: &str = "Control+Shift+Space";
const TRIGGERS: [&str; 3] = [DEFAULT_TRIGGER, "Control+Option+D", "Control+Shift+Z"];
static EVENTS: Mutex<Option<UnboundedSender<KeyEvent>>> = Mutex::new(None);
extern "C" {
    fn delulu_bind(edge: extern "C" fn(bool)) -> i32;
    fn delulu_unbind();
    fn delulu_configure() -> i32;
}
extern "C" fn edge(down: bool) {
    if let Ok(events) = EVENTS.lock() {
        if let Some(sender) = events.as_ref() {
            let _ = sender.send(if down {
                KeyEvent::Pressed
            } else {
                KeyEvent::Released
            });
        }
    }
}
pub use crate::hotkey_types::HotkeyStatus;
fn status(index: i32) -> HotkeyStatus {
    let trigger = TRIGGERS.get(index as usize).map(|s| s.to_string());
    HotkeyStatus {
        bound: trigger.is_some(),
        error: trigger
            .is_none()
            .then(|| "Shortcut unavailable. Choose another talk key.".into()),
        trigger,
    }
}
pub struct Hotkey {
    status: Mutex<HotkeyStatus>,
    changed: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
}
impl Hotkey {
    pub async fn bind(
        _: &str,
        events: UnboundedSender<KeyEvent>,
        changed: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> (Option<Self>, HotkeyStatus) {
        *EVENTS.lock().unwrap() = Some(events);
        let initial = status(unsafe { delulu_bind(edge) });
        (
            Some(Self {
                status: Mutex::new(initial.clone()),
                changed,
            }),
            initial,
        )
    }
    pub fn status(&self) -> HotkeyStatus {
        self.status.lock().unwrap().clone()
    }
    pub async fn configure(&self) -> Result<(), String> {
        let index = unsafe { delulu_configure() };
        if index < 0 {
            return Err("Shortcut unavailable. Choose another talk key.".into());
        }
        let next = status(index);
        *self.status.lock().unwrap() = next.clone();
        (self.changed)(next);
        Ok(())
    }
    pub async fn close(self) {}
}
impl Drop for Hotkey {
    fn drop(&mut self) {
        unsafe { delulu_unbind() };
        *EVENTS.lock().unwrap() = None;
    }
}
