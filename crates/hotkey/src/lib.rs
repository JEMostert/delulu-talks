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
    /// Follows the physical key while the app is busy, without producing
    /// commands, so `keys_down` stays truthful and the release of a press made
    /// while busy never stops a later recording.
    pub fn track(&mut self, event: KeyEvent) {
        match event {
            KeyEvent::Pressed => {
                self.down = true;
                self.ignore_release = true;
            }
            KeyEvent::Released => {
                self.down = false;
                self.ignore_release = false;
                self.started = None;
            }
            KeyEvent::Activated => {}
        }
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
mod portal;

use portal::{Portal, PortalEvent, PortalSession};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct Hotkey {
    status: Arc<Mutex<HotkeyStatus>>,
    session: Box<dyn PortalSession>,
    task: JoinHandle<()>,
}

impl Hotkey {
    pub async fn bind(
        preferred_trigger: &str,
        events: mpsc::UnboundedSender<KeyEvent>,
        on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> (Option<Self>, HotkeyStatus) {
        let on_status: Arc<dyn Fn(HotkeyStatus) + Send + Sync> = Arc::from(on_status);
        let callback = Arc::clone(&on_status);
        let result = async {
            if let Some(data) = dirs::data_local_dir() {
                portal::ensure_desktop_entry(
                    std::path::Path::new("/usr/share/applications"),
                    &data.join("applications"),
                )
                .map_err(|e| e.to_string())?;
            }
            Self::bind_with(
                &portal::AshpdPortal,
                preferred_trigger,
                events,
                Box::new(move |status| callback(status)),
            )
            .await
        }
        .await;
        match result {
            Ok((hotkey, status)) => (Some(hotkey), status),
            Err(error) => {
                let status = HotkeyStatus {
                    bound: false,
                    trigger: None,
                    error: Some(error),
                };
                on_status(status.clone());
                (None, status)
            }
        }
    }

    async fn bind_with(
        portal: &dyn Portal,
        preferred: &str,
        events: mpsc::UnboundedSender<KeyEvent>,
        on_status: Box<dyn Fn(HotkeyStatus) + Send + Sync>,
    ) -> Result<(Self, HotkeyStatus), String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (session, trigger) = portal.open(&portal_trigger(preferred), tx).await?;
        let initial = HotkeyStatus {
            bound: trigger.is_some(),
            trigger,
            error: None,
        };
        let status = Arc::new(Mutex::new(initial.clone()));
        let shared = Arc::clone(&status);
        let task = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    PortalEvent::Pressed => {
                        let _ = events.send(KeyEvent::Pressed);
                    }
                    PortalEvent::Released => {
                        let _ = events.send(KeyEvent::Released);
                    }
                    PortalEvent::Changed(trigger) => {
                        let next = HotkeyStatus {
                            bound: trigger.is_some(),
                            trigger,
                            error: None,
                        };
                        let changed = {
                            let mut current = shared.lock().unwrap_or_else(|e| e.into_inner());
                            if current.bound == next.bound
                                && current.trigger == next.trigger
                                && current.error == next.error
                            {
                                false
                            } else {
                                *current = next.clone();
                                true
                            }
                        };
                        if changed {
                            on_status(next);
                        }
                    }
                    PortalEvent::Error(error) => {
                        let next = HotkeyStatus {
                            bound: false,
                            trigger: None,
                            error: Some(error),
                        };
                        *shared.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
                        on_status(next);
                    }
                }
            }
        });
        Ok((
            Self {
                status,
                session,
                task,
            },
            initial,
        ))
    }

    pub async fn configure(&self) -> Result<(), String> {
        self.session.configure().await
    }
    pub fn status(&self) -> HotkeyStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub async fn close(self) {
        self.task.abort();
        self.session.close().await;
    }
}

pub fn portal_trigger(accelerator: &str) -> String {
    let mut parts = accelerator
        .split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let key = parts.pop().unwrap_or("space").to_lowercase();
    let mut result = parts
        .iter()
        .filter_map(|part| match part.to_lowercase().as_str() {
            "super" | "meta" | "command" => Some("LOGO"),
            "shift" => Some("SHIFT"),
            "ctrl" | "control" | "commandorcontrol" => Some("CTRL"),
            "alt" | "option" => Some("ALT"),
            _ => None,
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    result.push(match key.as_str() {
        "enter" | "return" => "Return".into(),
        "escape" | "esc" => "Escape".into(),
        "tab" => "Tab".into(),
        _ => key,
    });
    result.join("+")
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
    fn busy_presses_are_tracked_but_ignored() {
        let mut g = Gesture::new();
        g.track(KeyEvent::Pressed);
        assert!(g.keys_down());
        // Released after the app became idle again: no command, key is up.
        assert_eq!(g.feed(KeyEvent::Released, 10), None);
        assert!(!g.keys_down());
        g.track(KeyEvent::Pressed);
        g.track(KeyEvent::Released);
        assert!(!g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 20), Some(Command::Start));
    }
    #[test]
    fn app_id() {
        assert_eq!(APP_ID, "com.joran.delulu-talks");
    }
}

#[cfg(test)]
mod portal_tests {
    use super::*;
    use crate::portal::{Portal, PortalEvent, PortalSession};
    use std::{future::Future, pin::Pin, sync::Mutex};

    struct Mock {
        sender: Mutex<Option<mpsc::UnboundedSender<PortalEvent>>>,
    }
    struct Session;
    impl Portal for Mock {
        fn open<'a>(
            &'a self,
            preferred: &'a str,
            sender: mpsc::UnboundedSender<PortalEvent>,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<(Box<dyn PortalSession>, Option<String>), String>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                assert_eq!(preferred, "LOGO+z");
                *self.sender.lock().unwrap() = Some(sender);
                Ok((
                    Box::new(Session) as Box<dyn PortalSession>,
                    Some("Super+Z from portal".into()),
                ))
            })
        }
    }
    impl PortalSession for Session {
        fn configure(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
        fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async {})
        }
    }
    #[tokio::test]
    async fn mock_events_and_status() {
        let mock = Mock {
            sender: Mutex::new(None),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (status_tx, mut status_rx) = mpsc::unbounded_channel();
        let (hotkey, initial) = Hotkey::bind_with(
            &mock,
            DEFAULT_TRIGGER,
            tx,
            Box::new(move |status| {
                let _ = status_tx.send(status);
            }),
        )
        .await
        .unwrap();
        assert_eq!(initial.trigger.as_deref(), Some("Super+Z from portal"));
        let sender = mock.sender.lock().unwrap().clone().unwrap();
        sender.send(PortalEvent::Pressed).unwrap();
        sender.send(PortalEvent::Released).unwrap();
        sender
            .send(PortalEvent::Changed(Some("Portal description".into())))
            .unwrap();
        assert_eq!(rx.recv().await, Some(KeyEvent::Pressed));
        assert_eq!(rx.recv().await, Some(KeyEvent::Released));
        assert_eq!(
            status_rx.recv().await.unwrap().trigger.as_deref(),
            Some("Portal description")
        );
        assert_eq!(
            hotkey.status().trigger.as_deref(),
            Some("Portal description")
        );
        hotkey.configure().await.unwrap();
        hotkey.close().await;
    }
    #[test]
    fn triggers() {
        assert_eq!(portal_trigger("Super+Shift+Space"), "LOGO+SHIFT+space");
        assert_eq!(portal_trigger("Super+Z"), "LOGO+z");
    }
    #[test]
    fn desktop_entry_is_hidden_and_respects_existing_files() {
        let base = std::env::temp_dir().join(format!(
            "delulu-hotkey-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let system = base.join("system");
        let target = base.join("user");
        std::fs::create_dir_all(&system).unwrap();
        portal::ensure_desktop_entry(&system, &target).unwrap();
        let file = target.join(format!("{APP_ID}.desktop"));
        let contents = std::fs::read_to_string(&file).unwrap();
        assert!(contents.contains("NoDisplay=true"));
        std::fs::write(&file, "existing").unwrap();
        portal::ensure_desktop_entry(&system, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "existing");
        std::fs::write(system.join(format!("{APP_ID}.desktop")), "system").unwrap();
        portal::ensure_desktop_entry(&system, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "existing");
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_file(system.join(format!("{APP_ID}.desktop"))).unwrap();
        portal::ensure_desktop_entry(&system, &target).unwrap();
        assert!(file.exists());
        std::fs::write(system.join(format!("{APP_ID}.desktop")), "system").unwrap();
        portal::ensure_desktop_entry(&system, &target).unwrap();
        assert!(!file.exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
