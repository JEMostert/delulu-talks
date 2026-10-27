use std::collections::HashMap;
use std::sync::{mpsc, Mutex};

use arboard::{Clipboard, LinuxClipboardKind, SetExtLinux};
use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::{PersistMode, Session};
use async_trait::async_trait;
use zbus::zvariant::Value;

pub const APP_ID: &str = "com.joran.delulu-talks";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteKey {
    ShiftInsert,
    CtrlV,
    CtrlShiftV,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    Pasted,
    CopiedOnly { reason: String },
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertStatus {
    pub ready: bool,
    pub error: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum InsertError {
    #[error("clipboard: {0}")]
    Clipboard(String),
}

type ClipboardRequest = (String, mpsc::Sender<Result<(), String>>);

fn clipboard_worker(rx: mpsc::Receiver<ClipboardRequest>) {
    let mut clipboard = None;
    for (text, reply) in rx {
        let result = (|| {
            if clipboard.is_none() {
                clipboard = Some(Clipboard::new().map_err(|e| e.to_string())?);
            }
            let board = clipboard.as_mut().ok_or("clipboard unavailable")?;
            board.set_text(&text).map_err(|e| e.to_string())?;
            board
                .set()
                .clipboard(LinuxClipboardKind::Primary)
                .text(&text)
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = reply.send(result);
    }
}

#[async_trait]
trait KeyboardSession: Send + Sync {
    async fn key(&self, keysym: i32, pressed: bool) -> Result<(), String>;
    async fn close(&self);
}
#[async_trait]
trait Portal: Send + Sync {
    async fn open(
        &self,
        token: Option<&str>,
    ) -> Result<(Box<dyn KeyboardSession>, Option<String>), String>;
}
struct DesktopPortal;
struct DesktopSession {
    proxy: RemoteDesktop,
    session: Session<RemoteDesktop>,
}
#[async_trait]
impl KeyboardSession for DesktopSession {
    async fn key(&self, keysym: i32, pressed: bool) -> Result<(), String> {
        let state = if pressed {
            KeyState::Pressed
        } else {
            KeyState::Released
        };
        self.proxy
            .notify_keyboard_keysym(&self.session, keysym, state, Default::default())
            .await
            .map_err(|e| e.to_string())
    }
    async fn close(&self) {
        let _ = self.session.close().await;
    }
}
#[async_trait]
impl Portal for DesktopPortal {
    async fn open(
        &self,
        token: Option<&str>,
    ) -> Result<(Box<dyn KeyboardSession>, Option<String>), String> {
        let connection = zbus::Connection::session()
            .await
            .map_err(|e| e.to_string())?;
        let _ = connection
            .call_method(
                Some("org.freedesktop.portal.Desktop"),
                "/org/freedesktop/portal/desktop",
                Some("org.freedesktop.host.portal.Registry"),
                "Register",
                &(APP_ID, HashMap::<&str, Value>::new()),
            )
            .await;
        let proxy = RemoteDesktop::with_connection(connection)
            .await
            .map_err(|e| e.to_string())?;
        let session = proxy
            .create_session(Default::default())
            .await
            .map_err(|e| e.to_string())?;
        let result = async {
            let options = SelectDevicesOptions::default()
                .set_devices(ashpd::enumflags2::BitFlags::from_flag(DeviceType::Keyboard))
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(token);
            proxy
                .select_devices(&session, options)
                .await
                .map_err(|e| e.to_string())?
                .response()
                .map_err(|e| e.to_string())?;
            let selected = proxy
                .start(&session, None, Default::default())
                .await
                .map_err(|e| e.to_string())?
                .response()
                .map_err(|e| e.to_string())?;
            if !selected.devices().contains(DeviceType::Keyboard) {
                return Err("Keyboard control was not granted".to_owned());
            }
            Ok(selected
                .restore_token()
                .filter(|s| !s.is_empty())
                .map(str::to_owned))
        }
        .await;
        match result {
            Ok(token) => Ok((Box::new(DesktopSession { proxy, session }), token)),
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
        }
    }
}

struct PortalState {
    session: Option<Box<dyn KeyboardSession>>,
    token: Option<String>,
}
pub struct Inserter {
    clipboard: mpsc::Sender<ClipboardRequest>,
    portal: Box<dyn Portal>,
    state: tokio::sync::Mutex<PortalState>,
    status: Mutex<InsertStatus>,
    save_token: Box<dyn Fn(Option<String>) + Send + Sync>,
}
impl Inserter {
    pub fn new(
        token: Option<String>,
        save_token: Box<dyn Fn(Option<String>) + Send + Sync>,
    ) -> Self {
        Self::with_portal(token, save_token, Box::new(DesktopPortal))
    }
    fn with_portal(
        token: Option<String>,
        save_token: Box<dyn Fn(Option<String>) + Send + Sync>,
        portal: Box<dyn Portal>,
    ) -> Self {
        let (clipboard, rx) = mpsc::channel();
        std::thread::spawn(move || clipboard_worker(rx));
        Self {
            clipboard,
            portal,
            state: tokio::sync::Mutex::new(PortalState {
                session: None,
                token,
            }),
            status: Mutex::new(InsertStatus::default()),
            save_token,
        }
    }
    fn set_status(&self, status: InsertStatus) -> InsertStatus {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        status
    }
    async fn ensure_session(&self, state: &mut PortalState) -> Result<(), String> {
        if state.session.is_none() {
            match self.portal.open(state.token.as_deref()).await {
                Ok((session, token)) => {
                    if let Some(token) = token {
                        state.token = Some(token.clone());
                        (self.save_token)(Some(token));
                    }
                    state.session = Some(session);
                    self.set_status(InsertStatus {
                        ready: true,
                        error: None,
                    });
                }
                Err(error) => {
                    self.set_status(InsertStatus {
                        ready: false,
                        error: Some(error.clone()),
                    });
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub async fn prepare(&self) -> InsertStatus {
        let mut state = self.state.lock().await;
        let _ = self.ensure_session(&mut state).await;
        self.status()
    }
    pub fn status(&self) -> InsertStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn copy(&self, text: &str) -> Result<(), InsertError> {
        let (tx, rx) = mpsc::channel();
        self.clipboard
            .send((text.to_owned(), tx))
            .map_err(|e| InsertError::Clipboard(e.to_string()))?;
        rx.recv()
            .map_err(|e| InsertError::Clipboard(e.to_string()))?
            .map_err(InsertError::Clipboard)
    }
    pub async fn insert(&self, text: &str, key: PasteKey) -> Result<InsertOutcome, InsertError> {
        let mut state = self.state.lock().await;
        self.copy(text)?;
        Ok(self.paste(&mut state, key).await)
    }
    async fn paste(&self, state: &mut PortalState, key: PasteKey) -> InsertOutcome {
        let opening = state.session.is_none();
        if let Err(reason) = self.ensure_session(state).await {
            return InsertOutcome::CopiedOnly { reason };
        }
        if opening {
            // Give the portal dialog time to close and return focus.
            tokio::time::sleep(std::time::Duration::from_millis(220)).await;
        }
        let Some(session) = state.session.as_ref() else {
            return InsertOutcome::CopiedOnly {
                reason: "Portal session unavailable".into(),
            };
        };
        match send_shortcut(session.as_ref(), key).await {
            Ok(()) => InsertOutcome::Pasted,
            Err(reason) => {
                if let Some(session) = state.session.take() {
                    session.close().await;
                }
                self.set_status(InsertStatus {
                    ready: false,
                    error: Some(reason.clone()),
                });
                InsertOutcome::CopiedOnly { reason }
            }
        }
    }
}
async fn send_shortcut(session: &dyn KeyboardSession, key: PasteKey) -> Result<(), String> {
    let keys: &[i32] = match key {
        PasteKey::ShiftInsert => &[0xffe1, 0xff63],
        PasteKey::CtrlV => &[0xffe3, 0x76],
        PasteKey::CtrlShiftV => &[0xffe3, 0xffe1, 0x76],
    };
    let mut held = Vec::new();
    let mut error = None;
    for &key in keys {
        held.push(key);
        if let Err(e) = session.key(key, true).await {
            error = Some(e);
            break;
        }
    }
    for key in held.into_iter().rev() {
        if let Err(e) = session.key(key, false).await {
            if error.is_none() {
                error = Some(e);
            }
        }
    }
    match error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn app_id() {
        assert_eq!(APP_ID, "com.joran.delulu-talks");
    }

    struct MockSession {
        calls: Arc<Mutex<Vec<(i32, bool)>>>,
        fail_press: Option<i32>,
        fail_release: bool,
    }
    #[async_trait]
    impl KeyboardSession for MockSession {
        async fn key(&self, key: i32, pressed: bool) -> Result<(), String> {
            self.calls.lock().unwrap().push((key, pressed));
            if (pressed && self.fail_press == Some(key)) || (!pressed && self.fail_release) {
                Err(if pressed {
                    "press failed"
                } else {
                    "release failed"
                }
                .into())
            } else {
                Ok(())
            }
        }
        async fn close(&self) {}
    }
    struct MockPortal {
        calls: Arc<Mutex<Vec<(i32, bool)>>>,
        opens: Arc<AtomicUsize>,
        fail_press: Option<i32>,
    }
    #[async_trait]
    impl Portal for MockPortal {
        async fn open(
            &self,
            _: Option<&str>,
        ) -> Result<(Box<dyn KeyboardSession>, Option<String>), String> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            Ok((
                Box::new(MockSession {
                    calls: self.calls.clone(),
                    fail_press: self.fail_press,
                    fail_release: true,
                }),
                Some("token".into()),
            ))
        }
    }
    #[tokio::test]
    async fn ordering_for_all_keys() {
        for (key, expected) in [
            (PasteKey::ShiftInsert, vec![0xffe1, 0xff63]),
            (PasteKey::CtrlV, vec![0xffe3, 0x76]),
            (PasteKey::CtrlShiftV, vec![0xffe3, 0xffe1, 0x76]),
        ] {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let session = MockSession {
                calls: calls.clone(),
                fail_press: None,
                fail_release: false,
            };
            send_shortcut(&session, key).await.unwrap();
            let expected: Vec<_> = expected
                .iter()
                .map(|&k| (k, true))
                .chain(expected.iter().rev().map(|&k| (k, false)))
                .collect();
            assert_eq!(*calls.lock().unwrap(), expected);
        }
    }
    #[tokio::test]
    async fn failed_press_releases_all_attempted_keys_and_preserves_error() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let session = MockSession {
            calls: calls.clone(),
            fail_press: Some(0x76),
            fail_release: true,
        };
        assert_eq!(
            send_shortcut(&session, PasteKey::CtrlShiftV)
                .await
                .unwrap_err(),
            "press failed"
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                (0xffe3, true),
                (0xffe1, true),
                (0x76, true),
                (0x76, false),
                (0xffe1, false),
                (0xffe3, false)
            ]
        );
    }
    #[tokio::test]
    async fn portal_failure_keeps_copy_and_reopens_next_time() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let opens = Arc::new(AtomicUsize::new(0));
        let copied = Arc::new(Mutex::new(Vec::new()));
        let mut inserter = Inserter::with_portal(
            None,
            Box::new(|_| {}),
            Box::new(MockPortal {
                calls,
                opens: opens.clone(),
                fail_press: Some(0x76),
            }),
        );
        let (tx, rx) = mpsc::channel::<ClipboardRequest>();
        inserter.clipboard = tx;
        let saved = copied.clone();
        std::thread::spawn(move || {
            for (text, reply) in rx {
                saved.lock().unwrap().push(text);
                let _ = reply.send(Ok(()));
            }
        });
        assert_eq!(
            inserter.insert("Zoë café", PasteKey::CtrlV).await.unwrap(),
            InsertOutcome::CopiedOnly {
                reason: "press failed".into()
            }
        );
        assert_eq!(*copied.lock().unwrap(), vec!["Zoë café"]);
        assert!(!inserter.status().ready);
        let _ = inserter.insert("again", PasteKey::CtrlV).await.unwrap();
        assert_eq!(opens.load(Ordering::SeqCst), 2);
    }
}
