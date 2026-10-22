//! xdg-desktop-portal clients (Linux only), built on ashpd.
//!
//! Host (non-Flatpak) apps have no portal identity. Each connection first
//! calls `org.freedesktop.host.portal.Registry.Register("delulu-talks")`,
//! which xdg-desktop-portal (≥ 1.19) accepts only when a desktop file named
//! `delulu-talks.desktop` is installed in an `applications/` directory of
//! `XDG_DATA_DIRS`/`XDG_DATA_HOME`. It must be the first portal call on the
//! connection, so every session uses its own connection. Registration
//! failures are ignored, like the Electron app: GNOME then treats us as an
//! anonymous host app, while KDE's GlobalShortcuts needs the id to store the
//! binding. ashpd's `register_host_app` cannot be used because its `AppID`
//! requires a reverse-DNS id with a dot.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions};
use ashpd::desktop::{PersistMode, ResponseError, Session};
use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use zbus::zvariant::Value;

use crate::paste::{KeyboardGrant, KeyboardSession, PortalError, PortalStep, RemoteDesktopPortal, APP_ID};
use crate::shortcut::{BoundShortcut, GlobalShortcutsPortal, GlobalShortcutsSession, ShortcutEvent};

pub const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";
pub const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const REGISTRY: &str = "org.freedesktop.host.portal.Registry";
/// Portal dialogs wait for the user; give up after five minutes.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn failed(error: impl std::fmt::Display) -> PortalError {
    PortalError::Failed(error.to_string())
}

fn step_error(step: PortalStep) -> impl Fn(ashpd::Error) -> PortalError {
    move |error| match error {
        ashpd::Error::Response(ResponseError::Cancelled) => PortalError::Response { step, code: 1 },
        ashpd::Error::Response(ResponseError::Other) => PortalError::Response { step, code: 2 },
        other => failed(other),
    }
}

async fn bounded<T>(future: impl Future<Output = Result<T, PortalError>>) -> Result<T, PortalError> {
    tokio::time::timeout(REQUEST_TIMEOUT, future)
        .await
        .map_err(|_| PortalError::Failed("The desktop shortcut portal did not respond".into()))?
}

/// Calls `Registry.Register(APP_ID, {})` on `connection`.
pub async fn register_host_app(connection: &zbus::Connection) -> zbus::Result<()> {
    connection
        .call_method(Some(PORTAL_NAME), PORTAL_PATH, Some(REGISTRY), "Register", &(APP_ID, HashMap::<&str, Value>::new()))
        .await
        .map(|_| ())
}

async fn connect() -> Result<zbus::Connection, PortalError> {
    let connection = zbus::Connection::session().await.map_err(failed)?;
    if !ashpd::is_sandboxed() {
        // A recognized packaged application does not need host registration.
        let _ = register_host_app(&connection).await;
    }
    Ok(connection)
}

// ---------------------------------------------------------------------------
// RemoteDesktop keyboard

pub struct AshpdRemoteDesktop;

struct AshpdKeyboard {
    proxy: RemoteDesktop,
    session: Session<RemoteDesktop>,
}

#[async_trait]
impl RemoteDesktopPortal for AshpdRemoteDesktop {
    async fn open(&self, restore_token: Option<String>) -> Result<KeyboardGrant, PortalError> {
        let connection = connect().await?;
        let proxy = RemoteDesktop::with_connection(connection).await.map_err(failed)?;
        let session = bounded(async {
            proxy.create_session(Default::default()).await.map_err(step_error(PortalStep::CreateSession))
        })
        .await?;
        let started = bounded(async {
            let options = SelectDevicesOptions::default()
                .set_devices(ashpd::enumflags2::BitFlags::from_flag(DeviceType::Keyboard))
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(restore_token.as_deref());
            let select = step_error(PortalStep::SelectDevices);
            proxy.select_devices(&session, options).await.map_err(&select)?.response().map_err(&select)?;
            let start = step_error(PortalStep::Start);
            proxy.start(&session, None, Default::default()).await.map_err(&start)?.response().map_err(&start)
        })
        .await;
        match started {
            Ok(selected) => {
                let devices = selected.devices().bits();
                let restore_token = selected.restore_token().map(str::to_owned);
                Ok(KeyboardGrant { session: Arc::new(AshpdKeyboard { proxy, session }), devices, restore_token })
            }
            Err(error) => {
                let _ = session.close().await;
                Err(error)
            }
        }
    }
}

#[async_trait]
impl KeyboardSession for AshpdKeyboard {
    async fn notify_keysym(&self, keysym: i32, pressed: bool) -> Result<(), String> {
        let state = if pressed { KeyState::Pressed } else { KeyState::Released };
        self.proxy
            .notify_keyboard_keysym(&self.session, keysym, state, Default::default())
            .await
            .map_err(|error| error.to_string())
    }

    async fn close(&self) {
        // Disconnecting also closes the session.
        let _ = self.session.close().await;
    }
}

// ---------------------------------------------------------------------------
// GlobalShortcuts

pub struct AshpdGlobalShortcuts;

struct AshpdShortcutSession {
    proxy: GlobalShortcuts,
    session: Session<GlobalShortcuts>,
    signals: JoinHandle<()>,
}

#[async_trait]
impl GlobalShortcutsPortal for AshpdGlobalShortcuts {
    async fn create_session(
        &self,
        events: mpsc::UnboundedSender<ShortcutEvent>,
    ) -> Result<Arc<dyn GlobalShortcutsSession>, PortalError> {
        let connection = connect().await?;
        let proxy = GlobalShortcuts::with_connection(connection).await.map_err(failed)?;
        // Subscribe before creating the session. Signals are unicast to this
        // connection, which owns exactly one session.
        let mut activated = proxy.receive_activated().await.map_err(failed)?;
        let mut deactivated = proxy.receive_deactivated().await.map_err(failed)?;
        let mut changed = proxy.receive_shortcuts_changed().await.map_err(failed)?;
        let signals = tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    Some(signal) = activated.next() => ShortcutEvent::Activated(signal.shortcut_id().to_owned()),
                    Some(signal) = deactivated.next() => ShortcutEvent::Deactivated(signal.shortcut_id().to_owned()),
                    Some(signal) = changed.next() => ShortcutEvent::Changed(bound(signal.shortcuts())),
                    else => {
                        let _ = events.send(ShortcutEvent::Error("the portal connection closed".into()));
                        return;
                    }
                };
                if events.send(event).is_err() {
                    return;
                }
            }
        });
        let session = bounded(async {
            proxy.create_session(Default::default()).await.map_err(step_error(PortalStep::CreateSession))
        })
        .await;
        match session {
            Ok(session) => Ok(Arc::new(AshpdShortcutSession { proxy, session, signals })),
            Err(error) => {
                signals.abort();
                Err(error)
            }
        }
    }
}

fn bound(shortcuts: &[ashpd::desktop::global_shortcuts::Shortcut]) -> Vec<BoundShortcut> {
    shortcuts
        .iter()
        .map(|shortcut| BoundShortcut {
            id: shortcut.id().to_owned(),
            trigger_description: shortcut.trigger_description().to_owned(),
        })
        .collect()
}

#[async_trait]
impl GlobalShortcutsSession for AshpdShortcutSession {
    async fn bind(
        &self,
        id: &str,
        description: &str,
        preferred_trigger: &str,
    ) -> Result<Vec<BoundShortcut>, PortalError> {
        let shortcut = NewShortcut::new(id, description).preferred_trigger(preferred_trigger);
        let error = step_error(PortalStep::BindShortcuts);
        bounded(async {
            let response = self
                .proxy
                .bind_shortcuts(&self.session, &[shortcut], None, Default::default())
                .await
                .map_err(&error)?
                .response()
                .map_err(&error)?;
            Ok(bound(response.shortcuts()))
        })
        .await
    }

    async fn configure(&self) -> Result<(), String> {
        self.proxy
            .configure_shortcuts(&self.session, None, Default::default())
            .await
            .map_err(|error| error.to_string())
    }

    async fn close(&self) {
        self.signals.abort();
        let _ = self.session.close().await;
    }
}

// ---------------------------------------------------------------------------
// Introspection (diagnostics; never opens a dialog)

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PortalProbe {
    pub global_shortcuts_version: Option<u32>,
    pub remote_desktop_version: Option<u32>,
    /// `AvailableDeviceTypes` bit mask (1 keyboard, 2 pointer, 4 touch).
    pub remote_desktop_devices: Option<u32>,
}

/// Reads portal interface properties only.
pub async fn probe_portals() -> zbus::Result<PortalProbe> {
    let connection = zbus::Connection::session().await?;
    let property = |interface: &'static str, name: &'static str| {
        let connection = connection.clone();
        async move {
            let proxy = zbus::fdo::PropertiesProxy::builder(&connection)
                .destination(PORTAL_NAME)
                .ok()?
                .path(PORTAL_PATH)
                .ok()?
                .build()
                .await
                .ok()?;
            let interface = zbus::names::InterfaceName::try_from(interface).ok()?;
            let value = proxy.get(interface, name).await.ok()?;
            u32::try_from(value).ok()
        }
    };
    Ok(PortalProbe {
        global_shortcuts_version: property("org.freedesktop.portal.GlobalShortcuts", "version").await,
        remote_desktop_version: property("org.freedesktop.portal.RemoteDesktop", "version").await,
        remote_desktop_devices: property("org.freedesktop.portal.RemoteDesktop", "AvailableDeviceTypes").await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual check against the running session: `cargo test -p
    /// delulu-desktop -- --ignored portal_introspection --nocapture`.
    #[tokio::test]
    #[ignore = "talks to the session bus"]
    async fn portal_introspection() {
        let probe = probe_portals().await.unwrap();
        println!("{probe:?}");
        assert!(probe.global_shortcuts_version.is_some());
        assert!(probe.remote_desktop_devices.is_some_and(|devices| devices & 1 == 1));
    }
}
