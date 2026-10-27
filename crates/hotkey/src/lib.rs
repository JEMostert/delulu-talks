pub const APP_ID: &str = "com.joran.delulu-talks";
pub const SHORTCUT_ID: &str = "dictate";
pub const DEFAULT_TRIGGER: &str = "Super+Z";
pub const HOLD_MS: u64 = 400;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Pressed,
    Released,
    Activated,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
}
#[derive(Default)]
pub struct Gesture {
    down: bool,
    started: Option<u64>,
    recording: bool,
    ignore_release: bool,
}
impl Gesture {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn keys_down(&self) -> bool {
        self.down
    }
    pub fn feed(&mut self, event: KeyEvent, now_ms: u64) -> Option<Command> {
        match event {
            KeyEvent::Activated => {
                self.recording = !self.recording;
                self.started = None;
                Some(if self.recording {
                    Command::Start
                } else {
                    Command::Stop
                })
            }
            KeyEvent::Pressed if !self.down => {
                self.down = true;
                if self.recording {
                    self.recording = false;
                    self.ignore_release = true;
                    self.started = None;
                    Some(Command::Stop)
                } else {
                    self.recording = true;
                    self.started = Some(now_ms);
                    Some(Command::Start)
                }
            }
            KeyEvent::Released if self.down => {
                self.down = false;
                if self.ignore_release {
                    self.ignore_release = false;
                    None
                } else if self
                    .started
                    .take()
                    .is_some_and(|start| now_ms.saturating_sub(start) >= HOLD_MS)
                {
                    self.recording = false;
                    Some(Command::Stop)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub bound: bool,
    pub trigger: Option<String>,
    pub error: Option<String>,
}
pub struct Hotkey {
    status: HotkeyStatus,
}
impl Hotkey {
    pub async fn bind(
        _preferred_trigger: &str,
        _events: tokio::sync::mpsc::UnboundedSender<KeyEvent>,
        _on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> (Option<Self>, HotkeyStatus) {
        let status = HotkeyStatus {
            bound: true,
            trigger: Some(DEFAULT_TRIGGER.into()),
            error: None,
        };
        (
            Some(Self {
                status: status.clone(),
            }),
            status,
        )
    }
    pub async fn configure(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn status(&self) -> HotkeyStatus {
        self.status.clone()
    }
    pub async fn close(self) {}
}
pub fn portal_trigger(accelerator: &str) -> String {
    accelerator
        .replace("Super", "LOGO")
        .replace("Shift", "SHIFT")
        .replace("Space", "space")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gesture_paths() {
        let mut g = Gesture::new();
        assert_eq!(g.feed(KeyEvent::Released, 0), None);
        assert_eq!(g.feed(KeyEvent::Pressed, 0), Some(Command::Start));
        assert!(g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 1), None);
        assert_eq!(g.feed(KeyEvent::Released, 400), Some(Command::Stop));
        assert!(!g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 500), Some(Command::Start));
        assert_eq!(g.feed(KeyEvent::Released, 501), None);
        assert_eq!(g.feed(KeyEvent::Pressed, 502), Some(Command::Stop));
        assert!(g.keys_down());
        assert_eq!(g.feed(KeyEvent::Released, 503), None);
        assert_eq!(g.feed(KeyEvent::Activated, 504), Some(Command::Start));
        assert_eq!(g.feed(KeyEvent::Activated, 505), Some(Command::Stop));
        assert!(!g.keys_down());
    }
    #[test]
    fn app_id() {
        assert_eq!(APP_ID, "com.joran.delulu-talks");
    }
}
