use crate::{APP_ID, SHORTCUT_ID};
use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut},
    Session,
};
use futures_util::StreamExt;
use std::{collections::HashMap, future::Future, path::Path, pin::Pin};
use tokio::{sync::mpsc, task::JoinHandle};
use zbus::zvariant::Value;

type FutureResult<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub(crate) enum PortalEvent {
    Pressed,
    Released,
    Changed(Option<String>),
    Error(String),
}
pub(crate) trait Portal: Send + Sync {
    fn open<'a>(
        &'a self,
        preferred: &'a str,
        events: mpsc::UnboundedSender<PortalEvent>,
    ) -> FutureResult<'a, (Box<dyn PortalSession>, Option<String>)>;
}
pub(crate) trait PortalSession: Send + Sync {
    fn configure(&self) -> FutureResult<'_, ()>;
    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// Marks the hidden entry dev runs write, so it can be told apart from the user's own.
const MANAGED: &str = "X-Delulu-Managed=true";

/// GNOME only lets an app register with the portal when a desktop entry with its
/// id exists. Dev runs get a hidden user entry; once the package installs the
/// system entry, ours is removed so it can't shadow the visible launcher.
pub(crate) fn ensure_desktop_entry(system: &Path, target: &Path) -> std::io::Result<()> {
    let file = target.join(format!("{APP_ID}.desktop"));
    let managed = std::fs::read_to_string(&file).is_ok_and(|c| c.contains(MANAGED));
    if system.join(format!("{APP_ID}.desktop")).exists() {
        if managed {
            std::fs::remove_file(&file)?;
        }
        return Ok(());
    }
    if file.exists() && !managed {
        return Ok(());
    }
    std::fs::create_dir_all(target)?;
    let executable = std::env::current_exe()?;
    let exec = executable
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$");
    // Rewritten every run so Exec follows the current dev binary.
    std::fs::write(
        &file,
        format!("[Desktop Entry]\nType=Application\nName=Delulu Talks\nExec=\"{exec}\"\nNoDisplay=true\nCategories=Utility;\n{MANAGED}\n"),
    )
}

pub(crate) struct AshpdPortal;
struct AshpdSession {
    proxy: GlobalShortcuts,
    session: Session<GlobalShortcuts>,
    signals: JoinHandle<()>,
}
fn trigger(shortcuts: &[Shortcut]) -> Option<String> {
    shortcuts
        .iter()
        .find(|s| s.id() == SHORTCUT_ID)
        .map(|s| s.trigger_description().to_owned())
}
impl Portal for AshpdPortal {
    fn open<'a>(
        &'a self,
        preferred: &'a str,
        events: mpsc::UnboundedSender<PortalEvent>,
    ) -> FutureResult<'a, (Box<dyn PortalSession>, Option<String>)> {
        Box::pin(async move {
            let connection = zbus::Connection::session()
                .await
                .map_err(|e| e.to_string())?;
            if !ashpd::is_sandboxed() {
                let result = connection
                    .call_method(
                        Some("org.freedesktop.portal.Desktop"),
                        "/org/freedesktop/portal/desktop",
                        Some("org.freedesktop.host.portal.Registry"),
                        "Register",
                        &(APP_ID, HashMap::<&str, Value>::new()),
                    )
                    .await;
                if let Err(error) = result {
                    log::debug!("Host registration failed: {error}");
                }
            }
            let proxy = GlobalShortcuts::with_connection(connection)
                .await
                .map_err(|e| e.to_string())?;
            let mut activated = proxy.receive_activated().await.map_err(|e| e.to_string())?;
            let mut deactivated = proxy
                .receive_deactivated()
                .await
                .map_err(|e| e.to_string())?;
            let mut changed = proxy
                .receive_shortcuts_changed()
                .await
                .map_err(|e| e.to_string())?;
            let session = proxy
                .create_session(Default::default())
                .await
                .map_err(|e| e.to_string())?;
            let signals = tokio::spawn(async move {
                loop {
                    let event = tokio::select! {
                        signal = activated.next() => match signal { Some(s) if s.shortcut_id() == SHORTCUT_ID => Some(PortalEvent::Pressed), Some(_) => None, None => break },
                        signal = deactivated.next() => match signal { Some(s) if s.shortcut_id() == SHORTCUT_ID => Some(PortalEvent::Released), Some(_) => None, None => break },
                        signal = changed.next() => match signal { Some(s) => Some(PortalEvent::Changed(trigger(s.shortcuts()))), None => break },
                    };
                    if let Some(event) = event {
                        if events.send(event).is_err() {
                            return;
                        }
                    }
                }
                let _ = events.send(PortalEvent::Error(
                    "The shortcut portal connection closed".into(),
                ));
            });
            let shortcut =
                NewShortcut::new(SHORTCUT_ID, "Dictation shortcut").preferred_trigger(preferred);
            let result = async {
                proxy
                    .bind_shortcuts(&session, &[shortcut], None, Default::default())
                    .await
                    .map_err(|e| e.to_string())?
                    .response()
                    .map_err(|e| e.to_string())
                    .map(|response| trigger(response.shortcuts()))
            }
            .await;
            match result {
                Ok(trigger) => Ok((
                    Box::new(AshpdSession {
                        proxy,
                        session,
                        signals,
                    }) as Box<dyn PortalSession>,
                    trigger,
                )),
                Err(error) => {
                    signals.abort();
                    let _ = session.close().await;
                    Err(error)
                }
            }
        })
    }
}
impl PortalSession for AshpdSession {
    fn configure(&self) -> FutureResult<'_, ()> {
        Box::pin(async move {
            if self.proxy.version() >= 2 {
                self.proxy
                    .configure_shortcuts(&self.session, None, Default::default())
                    .await
                    .map_err(|e| e.to_string())
            } else {
                let _ = std::process::Command::new("gnome-control-center")
                    .arg("applications")
                    .spawn();
                Ok(())
            }
        })
    }
    fn close(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.signals.abort();
            let _ = self.session.close().await;
        })
    }
}
