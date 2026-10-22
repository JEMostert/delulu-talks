//! The global dictation shortcut (`shortcut.ts`, `shortcutGesture.ts`,
//! `shortcutFormat.ts`).
//!
//! Linux Wayland binds through the xdg-desktop-portal GlobalShortcuts
//! interface, which reports press and release, so hold-to-talk works.
//! Everywhere else the app registers an accelerator through
//! [`NativeShortcuts`] (tauri-plugin-global-shortcut); those callbacks are
//! activation-only, so the shortcut always toggles there.

use std::future::Future;
use std::sync::{Arc, Weak};

use async_trait::async_trait;
use delulu_core::{now_ms, DomainError, DomainResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::env::DesktopEnv;
use crate::paste::PortalError;
use crate::types::{ShortcutMethod, ShortcutStatus};

pub const DEFAULT_SHORTCUT: &str = "Super+Z";
pub const SHORTCUT_ID: &str = "toggle-dictation";
pub const SHORTCUT_DESCRIPTION: &str = "Dictation shortcut";

/// `settings.shortcutMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutMode {
    Hold,
    #[default]
    Toggle,
}

/// Dictation commands. Called synchronously from the shortcut event; keep
/// implementations non-blocking (spawn the real work).
pub trait ShortcutActions: Send + Sync {
    fn start(&self);
    fn stop(&self);
    fn toggle(&self);
}

/// An Electron-style accelerator as a portal `preferred_trigger`
/// (`Super+Shift+Space` → `LOGO+SHIFT+space`).
pub fn portal_trigger(accelerator: &str) -> String {
    let mut parts: Vec<&str> = accelerator.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let key = parts.pop().unwrap_or("space");
    let mut out: Vec<String> = parts
        .iter()
        .filter_map(|part| match part.to_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" => Some("CTRL"),
            "shift" => Some("SHIFT"),
            "alt" | "option" => Some("ALT"),
            "super" | "meta" | "command" => Some("LOGO"),
            _ => None,
        })
        .map(str::to_owned)
        .collect();
    let lower = key.to_lowercase();
    out.push(
        match lower.as_str() {
            "space" => "space",
            "enter" | "return" => "Return",
            "escape" | "esc" => "Escape",
            "tab" => "Tab",
            other => other,
        }
        .to_owned(),
    );
    out.join("+")
}

/// Converts press/release signals and activation-only shortcuts into
/// dictation commands.
pub struct ShortcutGesture {
    mode: Arc<dyn Fn() -> ShortcutMode + Send + Sync>,
    actions: Arc<dyn ShortcutActions>,
    pressed: bool,
    stop_on_release: bool,
}

impl ShortcutGesture {
    pub fn new(mode: Arc<dyn Fn() -> ShortcutMode + Send + Sync>, actions: Arc<dyn ShortcutActions>) -> Self {
        Self { mode, actions, pressed: false, stop_on_release: false }
    }

    pub fn press(&mut self, can_release: bool) {
        if can_release {
            if self.pressed {
                return;
            }
            self.pressed = true;
        }
        self.stop_on_release = can_release && (self.mode)() == ShortcutMode::Hold;
        if self.stop_on_release {
            self.actions.start();
        } else {
            self.actions.toggle();
        }
    }

    pub fn release(&mut self) {
        if !self.pressed {
            return;
        }
        self.pressed = false;
        if self.stop_on_release {
            self.actions.stop();
        }
        self.stop_on_release = false;
    }

    pub fn reset(&mut self) {
        self.pressed = false;
        self.stop_on_release = false;
    }
}

// ---------------------------------------------------------------------------
// Backends

/// Signals of one portal session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutEvent {
    Activated(String),
    Deactivated(String),
    /// `ShortcutsChanged`: `(id, trigger_description)` pairs.
    Changed(Vec<BoundShortcut>),
    /// The portal connection failed.
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundShortcut {
    pub id: String,
    pub trigger_description: String,
}

#[async_trait]
pub trait GlobalShortcutsPortal: Send + Sync {
    /// Opens a fresh connection, registers the host app id, subscribes to
    /// the session signals (forwarded to `events`) and creates a session.
    async fn create_session(
        &self,
        events: mpsc::UnboundedSender<ShortcutEvent>,
    ) -> Result<Arc<dyn GlobalShortcutsSession>, PortalError>;
}

#[async_trait]
pub trait GlobalShortcutsSession: Send + Sync {
    async fn bind(&self, id: &str, description: &str, preferred_trigger: &str)
        -> Result<Vec<BoundShortcut>, PortalError>;
    /// `ConfigureShortcuts` (GlobalShortcuts v2).
    async fn configure(&self) -> Result<(), String>;
    /// Closes the session and disconnects.
    async fn close(&self);
}

/// The app's non-portal global shortcut registration (implemented with
/// tauri-plugin-global-shortcut). `register` replaces every previous
/// registration; `on_trigger` runs on key press only.
pub trait NativeShortcuts: Send + Sync {
    fn register(&self, accelerator: &str, on_trigger: Box<dyn Fn() + Send + Sync>) -> bool;
    fn unregister_all(&self);
}

/// No native registration (Wayland builds, tests).
pub struct NoNativeShortcuts;

impl NativeShortcuts for NoNativeShortcuts {
    fn register(&self, _accelerator: &str, _on_trigger: Box<dyn Fn() + Send + Sync>) -> bool {
        false
    }
    fn unregister_all(&self) {}
}

pub fn default_global_shortcuts_portal() -> Arc<dyn GlobalShortcutsPortal> {
    #[cfg(target_os = "linux")]
    {
        Arc::new(crate::portal::AshpdGlobalShortcuts)
    }
    #[cfg(not(target_os = "linux"))]
    {
        struct Unavailable;
        #[async_trait]
        impl GlobalShortcutsPortal for Unavailable {
            async fn create_session(
                &self,
                _events: mpsc::UnboundedSender<ShortcutEvent>,
            ) -> Result<Arc<dyn GlobalShortcutsSession>, PortalError> {
                Err(PortalError::Failed("The desktop portal is unavailable".into()))
            }
        }
        Arc::new(Unavailable)
    }
}

// ---------------------------------------------------------------------------
// Service

type Listener = Arc<dyn Fn(&ShortcutStatus) + Send + Sync>;

#[derive(Clone)]
pub struct ShortcutService {
    inner: Arc<Inner>,
}

struct Inner {
    portal_mode: bool,
    portal: Arc<dyn GlobalShortcutsPortal>,
    native: Arc<dyn NativeShortcuts>,
    state: Mutex<State>,
    gesture: Mutex<ShortcutGesture>,
    /// Startup registration and settings changes never interleave.
    queue: tokio::sync::Mutex<()>,
}

struct State {
    status: ShortcutStatus,
    publication_depth: u32,
    listeners: Vec<(u64, Listener)>,
    next_listener: u64,
    session: Option<Active>,
    generation: u64,
}

struct Active {
    session: Arc<dyn GlobalShortcutsSession>,
    events: JoinHandle<()>,
}

#[derive(Default)]
struct Patch {
    accelerator: Option<String>,
    registered: Option<bool>,
    message: Option<String>,
    last_triggered_at: Option<u64>,
}

/// First line, at most 240 characters.
fn concise(message: &str) -> String {
    message.lines().next().unwrap_or("").chars().take(240).collect()
}

fn portal_message(error: PortalError, cancelled: &str, rejected: &str) -> String {
    match error {
        PortalError::Response { code: 1, .. } => cancelled.to_owned(),
        PortalError::Response { .. } => rejected.to_owned(),
        PortalError::Failed(message) => message,
    }
}

impl ShortcutService {
    pub fn new(
        env: &DesktopEnv,
        mode: Arc<dyn Fn() -> ShortcutMode + Send + Sync>,
        actions: Arc<dyn ShortcutActions>,
        portal: Arc<dyn GlobalShortcutsPortal>,
        native: Arc<dyn NativeShortcuts>,
    ) -> Self {
        let portal_mode = env.is_linux_wayland();
        Self {
            inner: Arc::new(Inner {
                portal_mode,
                portal,
                native,
                state: Mutex::new(State {
                    status: ShortcutStatus {
                        accelerator: DEFAULT_SHORTCUT.to_owned(),
                        registered: false,
                        method: if portal_mode { ShortcutMethod::Portal } else { ShortcutMethod::Native },
                        message: "Shortcut registration pending".to_owned(),
                        last_triggered_at: None,
                    },
                    publication_depth: 0,
                    listeners: Vec::new(),
                    next_listener: 0,
                    session: None,
                    generation: 0,
                }),
                gesture: Mutex::new(ShortcutGesture::new(mode, actions)),
                queue: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn status(&self) -> ShortcutStatus {
        self.inner.state.lock().status.clone()
    }

    /// Returns an id for [`ShortcutService::off_status`].
    pub fn on_status(&self, listener: impl Fn(&ShortcutStatus) + Send + Sync + 'static) -> u64 {
        let mut state = self.inner.state.lock();
        state.next_listener += 1;
        let id = state.next_listener;
        state.listeners.push((id, Arc::new(listener)));
        id
    }

    pub fn off_status(&self, id: u64) {
        self.inner.state.lock().listeners.retain(|(other, _)| *other != id);
    }

    pub async fn register(&self, accelerator: &str) -> DomainResult<()> {
        let _turn = self.inner.queue.lock().await;
        self.inner.bind(accelerator).await
    }

    /// Binds `accelerator`, then persists. Status notifications are held
    /// until persistence succeeds or the previous binding is restored. The
    /// caller supplies the previous saved preference: portal status holds a
    /// localized trigger description, not the canonical accelerator.
    pub async fn change<T, F, Fut>(&self, accelerator: &str, previous: &str, persist: F) -> DomainResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = DomainResult<T>>,
    {
        let _turn = self.inner.queue.lock().await;
        self.inner.state.lock().publication_depth += 1;
        let result = async {
            self.inner.bind(accelerator).await?;
            persist().await
        }
        .await;
        let result = match result {
            Ok(value) => Ok(value),
            Err(error) => match self.inner.bind(previous).await {
                Ok(()) => Err(error),
                Err(restore_error) => {
                    let restore = concise(&restore_error.message);
                    self.inner.update(Patch {
                        accelerator: Some(previous.to_owned()),
                        registered: Some(false),
                        message: Some(format!("Previous shortcut could not be restored: {restore}")),
                        ..Default::default()
                    });
                    Err(DomainError::failed(format!(
                        "{}. Previous shortcut could not be restored: {restore}",
                        concise(&error.message)
                    )))
                }
            },
        };
        let publish = {
            let mut state = self.inner.state.lock();
            state.publication_depth -= 1;
            state.publication_depth == 0
        };
        if publish {
            self.inner.publish();
        }
        result
    }

    /// Opens the desktop's shortcut editor (portal sessions only).
    pub async fn configure(&self) -> DomainResult<()> {
        let session = self.inner.state.lock().session.as_ref().map(|active| active.session.clone());
        match (self.inner.portal_mode, session) {
            (true, Some(session)) => session.configure().await.map_err(DomainError::failed),
            _ => Err(DomainError::failed("The system shortcut editor is unavailable")),
        }
    }

    pub async fn shutdown(&self) {
        self.inner.native.unregister_all();
        self.inner.close_portal().await;
        self.inner.update(Patch {
            registered: Some(false),
            message: Some("Shortcut stopped".into()),
            ..Default::default()
        });
    }
}

impl Inner {
    fn update(&self, patch: Patch) {
        let publish = {
            let mut state = self.state.lock();
            let status = &mut state.status;
            if let Some(accelerator) = patch.accelerator {
                status.accelerator = accelerator;
            }
            if let Some(registered) = patch.registered {
                status.registered = registered;
            }
            if let Some(message) = patch.message {
                status.message = message;
            }
            if let Some(at) = patch.last_triggered_at {
                status.last_triggered_at = Some(at);
            }
            state.publication_depth == 0
        };
        if publish {
            self.publish();
        }
    }

    fn publish(&self) {
        let (status, listeners) = {
            let state = self.state.lock();
            (state.status.clone(), state.listeners.iter().map(|(_, l)| l.clone()).collect::<Vec<_>>())
        };
        for listener in listeners {
            listener(&status);
        }
    }

    fn press(&self) {
        self.update(Patch {
            registered: Some(true),
            message: Some("Shortcut active".into()),
            last_triggered_at: Some(now_ms()),
            ..Default::default()
        });
        self.gesture.lock().press(true);
    }

    fn release(&self) {
        self.update(Patch { message: Some("Shortcut ready".into()), ..Default::default() });
        self.gesture.lock().release();
    }

    async fn bind(self: &Arc<Self>, accelerator: &str) -> DomainResult<()> {
        if self.portal_mode {
            self.register_portal(accelerator).await
        } else {
            self.register_native(accelerator)
        }
    }

    fn register_native(self: &Arc<Self>, accelerator: &str) -> DomainResult<()> {
        self.native.unregister_all();
        let weak = Arc::downgrade(self);
        let registered = self.native.register(
            accelerator,
            Box::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.update(Patch {
                        registered: Some(true),
                        message: Some("Shortcut triggered".into()),
                        last_triggered_at: Some(now_ms()),
                        ..Default::default()
                    });
                    inner.gesture.lock().press(false);
                }
            }),
        );
        if !registered {
            self.update(Patch {
                accelerator: Some(accelerator.to_owned()),
                registered: Some(false),
                message: Some("Shortcut unavailable — choose another combination".into()),
                ..Default::default()
            });
            return Err(DomainError::failed(format!("Global shortcut '{accelerator}' is unavailable")));
        }
        self.update(Patch {
            accelerator: Some(accelerator.to_owned()),
            registered: Some(true),
            message: Some("System shortcut ready".into()),
            ..Default::default()
        });
        Ok(())
    }

    async fn register_portal(self: &Arc<Self>, accelerator: &str) -> DomainResult<()> {
        self.close_portal().await;
        self.update(Patch {
            accelerator: Some(accelerator.to_owned()),
            registered: Some(false),
            message: Some("Registering with the desktop shortcut portal".into()),
            ..Default::default()
        });
        match self.open_portal(accelerator).await {
            Ok(description) => {
                self.update(Patch {
                    accelerator: Some(description.clone()),
                    registered: Some(true),
                    message: Some(format!("Wayland shortcut ready · {description}")),
                    ..Default::default()
                });
                Ok(())
            }
            Err(message) => {
                self.close_portal().await;
                self.update(Patch {
                    accelerator: Some(accelerator.to_owned()),
                    registered: Some(false),
                    message: Some(format!("Shortcut unavailable: {}", concise(&message))),
                    ..Default::default()
                });
                Err(DomainError::failed(message))
            }
        }
    }

    async fn open_portal(self: &Arc<Self>, accelerator: &str) -> Result<String, String> {
        let (events, receiver) = mpsc::unbounded_channel();
        let generation = {
            let mut state = self.state.lock();
            state.generation += 1;
            state.generation
        };
        let listener = tokio::spawn(forward_events(Arc::downgrade(self), generation, receiver));
        let session = match self.portal.create_session(events).await {
            Ok(session) => session,
            Err(error) => {
                listener.abort();
                return Err(portal_message(
                    error,
                    "Shortcut permission was cancelled",
                    "The shortcut portal could not create a session",
                ));
            }
        };
        self.state.lock().session = Some(Active { session: session.clone(), events: listener });
        let bound = session
            .bind(SHORTCUT_ID, SHORTCUT_DESCRIPTION, &portal_trigger(accelerator))
            .await
            .map_err(|error| {
                portal_message(error, "Shortcut permission was cancelled", "The shortcut portal rejected the binding")
            })?;
        Ok(trigger_description(&bound).unwrap_or_else(|| accelerator.to_owned()))
    }

    async fn close_portal(&self) {
        let active = {
            let mut state = self.state.lock();
            state.generation += 1;
            state.session.take()
        };
        self.gesture.lock().reset();
        if let Some(active) = active {
            active.events.abort();
            active.session.close().await;
        }
    }

    fn handle(&self, event: ShortcutEvent) {
        match event {
            ShortcutEvent::Activated(id) if id == SHORTCUT_ID => self.press(),
            ShortcutEvent::Deactivated(id) if id == SHORTCUT_ID => self.release(),
            ShortcutEvent::Changed(shortcuts) => {
                if let Some(description) = trigger_description(&shortcuts) {
                    self.update(Patch {
                        message: Some(format!("Wayland shortcut ready · {description}")),
                        accelerator: Some(description),
                        ..Default::default()
                    });
                }
            }
            ShortcutEvent::Error(message) => self.update(Patch {
                registered: Some(false),
                message: Some(format!("Shortcut portal error: {}", concise(&message))),
                ..Default::default()
            }),
            _ => {}
        }
    }
}

fn trigger_description(shortcuts: &[BoundShortcut]) -> Option<String> {
    shortcuts
        .iter()
        .find(|shortcut| shortcut.id == SHORTCUT_ID)
        .map(|shortcut| shortcut.trigger_description.clone())
        .filter(|description| !description.is_empty())
}

/// Delivers a session's signals while it is the current one.
async fn forward_events(inner: Weak<Inner>, generation: u64, mut receiver: mpsc::UnboundedReceiver<ShortcutEvent>) {
    while let Some(event) = receiver.recv().await {
        let Some(inner) = inner.upgrade() else { return };
        if inner.state.lock().generation != generation {
            return;
        }
        inner.handle(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Platform;
    use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};

    #[test]
    fn portal_triggers_use_portal_modifier_names() {
        assert_eq!(portal_trigger("Super+Z"), "LOGO+z");
        assert_eq!(portal_trigger("CommandOrControl+Shift+Space"), "CTRL+SHIFT+space");
        assert_eq!(portal_trigger("Alt+Enter"), "ALT+Return");
        assert_eq!(portal_trigger(""), "space");
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<&'static str>>);
    impl ShortcutActions for Recorder {
        fn start(&self) {
            self.0.lock().push("start");
        }
        fn stop(&self) {
            self.0.lock().push("stop");
        }
        fn toggle(&self) {
            self.0.lock().push("toggle");
        }
    }

    #[test]
    fn hold_mode_starts_on_press_and_stops_on_release_while_activation_only_toggles() {
        let actions = Arc::new(Recorder::default());
        let mut hold = ShortcutGesture::new(Arc::new(|| ShortcutMode::Hold), actions.clone());
        hold.press(true);
        hold.press(true); // key repeat
        hold.release();
        hold.press(false);
        hold.release();
        let mut toggle = ShortcutGesture::new(Arc::new(|| ShortcutMode::Toggle), actions.clone());
        toggle.press(true);
        toggle.release();
        assert_eq!(*actions.0.lock(), ["start", "stop", "toggle", "toggle"]);
    }

    /// Counts sessions open at the same time, like the TypeScript fake bus.
    #[derive(Default)]
    struct FakePortal {
        open: Arc<AtomicI32>,
        max_open: Arc<AtomicI32>,
        created: AtomicUsize,
        events: Mutex<Option<mpsc::UnboundedSender<ShortcutEvent>>>,
    }

    struct FakeSession {
        open: Arc<AtomicI32>,
        closed: Mutex<bool>,
        trigger: String,
    }

    #[async_trait]
    impl GlobalShortcutsPortal for FakePortal {
        async fn create_session(
            &self,
            events: mpsc::UnboundedSender<ShortcutEvent>,
        ) -> Result<Arc<dyn GlobalShortcutsSession>, PortalError> {
            let open = self.open.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_open.fetch_max(open, Ordering::SeqCst);
            self.created.fetch_add(1, Ordering::SeqCst);
            *self.events.lock() = Some(events);
            tokio::task::yield_now().await;
            Ok(Arc::new(FakeSession { open: self.open.clone(), closed: Mutex::new(false), trigger: String::new() }))
        }
    }

    #[async_trait]
    impl GlobalShortcutsSession for FakeSession {
        async fn bind(&self, id: &str, _: &str, _: &str) -> Result<Vec<BoundShortcut>, PortalError> {
            tokio::task::yield_now().await;
            Ok(vec![BoundShortcut { id: id.into(), trigger_description: self.trigger.clone() }])
        }
        async fn configure(&self) -> Result<(), String> {
            Ok(())
        }
        async fn close(&self) {
            let mut closed = self.closed.lock();
            if !*closed {
                *closed = true;
                self.open.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    fn wayland() -> DesktopEnv {
        DesktopEnv::new(Platform::Linux, [("XDG_SESSION_TYPE", "wayland")])
    }

    #[tokio::test]
    async fn register_and_change_never_hold_two_portal_sessions_at_once() {
        let portal = Arc::new(FakePortal::default());
        let actions = Arc::new(Recorder::default());
        let service = ShortcutService::new(
            &wayland(),
            Arc::new(|| ShortcutMode::Hold),
            actions.clone(),
            portal.clone(),
            Arc::new(NoNativeShortcuts),
        );
        let (registered, saved) = tokio::join!(
            service.register("Super+A"),
            service.change("Super+B", "Super+A", || async { Ok("saved") })
        );
        registered.unwrap();
        assert_eq!(saved.unwrap(), "saved");
        assert_eq!(portal.max_open.load(Ordering::SeqCst), 1);
        assert_eq!(portal.open.load(Ordering::SeqCst), 1);
        let status = service.status();
        assert_eq!((status.accelerator.as_str(), status.registered), ("Super+B", true));
        assert_eq!(status.method, ShortcutMethod::Portal);

        // Activated/Deactivated drive hold-to-talk; other ids are ignored.
        let events = portal.events.lock().clone().unwrap();
        events.send(ShortcutEvent::Activated("other".into())).unwrap();
        events.send(ShortcutEvent::Activated(SHORTCUT_ID.into())).unwrap();
        events.send(ShortcutEvent::Deactivated(SHORTCUT_ID.into())).unwrap();
        events
            .send(ShortcutEvent::Changed(vec![BoundShortcut { id: SHORTCUT_ID.into(), trigger_description: "Super+C".into() }]))
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(*actions.0.lock(), ["start", "stop"]);
        let status = service.status();
        assert_eq!(status.message, "Wayland shortcut ready · Super+C");
        assert!(status.last_triggered_at.is_some());
        service.shutdown().await;
        assert_eq!(portal.open.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_persistence_restores_the_previous_binding_and_holds_notifications() {
        let portal = Arc::new(FakePortal::default());
        let service = ShortcutService::new(
            &wayland(),
            Arc::new(|| ShortcutMode::Toggle),
            Arc::new(Recorder::default()),
            portal.clone(),
            Arc::new(NoNativeShortcuts),
        );
        service.register("Super+A").await.unwrap();
        let published = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = published.clone();
        service.on_status(move |status| sink.lock().push(status.accelerator.clone()));
        let error = service
            .change("Super+B", "Super+A", || async { Err::<(), _>(DomainError::failed("disk full")) })
            .await
            .unwrap_err();
        assert_eq!(error.message, "disk full");
        assert_eq!(*published.lock(), ["Super+A"]);
        assert_eq!(portal.open.load(Ordering::SeqCst), 1);
    }

    struct FakeNative {
        accept: bool,
        trigger: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }
    impl NativeShortcuts for FakeNative {
        fn register(&self, _accelerator: &str, on_trigger: Box<dyn Fn() + Send + Sync>) -> bool {
            if self.accept {
                *self.trigger.lock() = Some(on_trigger);
            }
            self.accept
        }
        fn unregister_all(&self) {
            *self.trigger.lock() = None;
        }
    }

    #[tokio::test]
    async fn native_shortcuts_toggle_and_report_unavailable_combinations() {
        let env = DesktopEnv::new(Platform::Win32, Vec::<(String, String)>::new());
        let actions = Arc::new(Recorder::default());
        let native = Arc::new(FakeNative { accept: true, trigger: Mutex::new(None) });
        let service = ShortcutService::new(
            &env,
            Arc::new(|| ShortcutMode::Hold),
            actions.clone(),
            Arc::new(FakePortal::default()),
            native.clone(),
        );
        service.register("Super+Z").await.unwrap();
        assert_eq!(service.status().message, "System shortcut ready");
        (native.trigger.lock().as_ref().unwrap())();
        assert_eq!(*actions.0.lock(), ["toggle"]);
        assert_eq!(service.status().message, "Shortcut triggered");

        let refusing = ShortcutService::new(
            &env,
            Arc::new(|| ShortcutMode::Hold),
            actions,
            Arc::new(FakePortal::default()),
            Arc::new(FakeNative { accept: false, trigger: Mutex::new(None) }),
        );
        let error = refusing.register("Ctrl+Q").await.unwrap_err();
        assert_eq!(error.message, "Global shortcut 'Ctrl+Q' is unavailable");
        assert_eq!(refusing.status().message, "Shortcut unavailable — choose another combination");
        assert!(refusing.configure().await.is_err());
    }
}
