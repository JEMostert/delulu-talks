//! Transcript delivery (`electron/services/paste.ts`): publish to the
//! clipboard, then send the platform paste shortcut.
//!
//! - Linux Wayland: xdg-desktop-portal RemoteDesktop keyboard (persisted
//!   with a restore token), plus Klipper publication on KDE.
//! - Linux X11: `xdotool key --clearmodifiers ctrl+v`.
//! - macOS: `osascript` System Events Cmd+V, gated on Accessibility.
//! - Windows: PowerShell `SendKeys`.
//! - Otherwise the transcript stays on the clipboard (`clipboard-only`).
//!
//! The transcript itself only ever reaches the clipboard (and Klipper's
//! D-Bus call on KDE); the injector receives nothing but the shortcut.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use delulu_core::{DomainError, DomainResult};

use crate::clipboard::ClipboardBackend;
use crate::clipboard_restore::{ClipboardRestore, RestoreFn};
use crate::command::{CommandOutcome, CommandRunner, CommandSpec, KillSignal, SystemCommandRunner};
use crate::env::DesktopEnv;
use crate::permissions::accessibility_permission;
use crate::types::{
    AccessibilityPermission, DeliveryTimings, OverlayMethod, PasteShortcut, Platform, PlatformCapabilities,
};

/// The desktop file id the portals know the app by (see `portal.rs`).
pub const APP_ID: &str = "delulu-talks";
pub const KEYBOARD_DEVICE: u32 = 1;
pub const KEYSYM_LEFTCTRL: i32 = 0xffe3;
pub const KEYSYM_LEFTSHIFT: i32 = 0xffe1;
pub const KEYSYM_V: i32 = 0x76;

/// Cause name of clipboard failures; dictation keeps "copied" false for them.
pub const CLIPBOARD_COPY_ERROR: &str = "ClipboardCopyError";

pub fn is_clipboard_copy_error(error: &DomainError) -> bool {
    error.cause.as_ref().is_some_and(|cause| cause.name == CLIPBOARD_COPY_ERROR)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// The injector for this platform, or `None` (Linux without `xdotool`).
pub fn resolve_command(platform: Platform, shortcut: PasteShortcut, xdotool: bool) -> Option<PasteCommand> {
    let terminal = shortcut == PasteShortcut::Terminal;
    let command = |program: &str, args: &[&str]| PasteCommand {
        program: program.to_owned(),
        args: args.iter().map(|s| s.to_string()).collect(),
    };
    match platform {
        Platform::Darwin => Some(command(
            "osascript",
            &["-e", r#"tell application "System Events" to keystroke "v" using command down"#],
        )),
        Platform::Win32 => Some(command(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                if terminal {
                    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+v')"
                } else {
                    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
                },
            ],
        )),
        Platform::Linux if xdotool => Some(command(
            "xdotool",
            &["key", "--clearmodifiers", if terminal { "ctrl+shift+v" } else { "ctrl+v" }],
        )),
        Platform::Linux => None,
    }
}

// ---------------------------------------------------------------------------
// Portal boundary

/// The portal request that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalStep {
    CreateSession,
    SelectDevices,
    Start,
    BindShortcuts,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalError {
    /// A Request finished with a non-zero response (1 = cancelled by the user).
    Response { step: PortalStep, code: u32 },
    /// D-Bus or protocol failure; the message is shown (first line).
    Failed(String),
}

impl PortalError {
    pub fn cancelled(&self) -> bool {
        matches!(self, PortalError::Response { code: 1, .. })
    }
}

/// A started RemoteDesktop session.
pub struct KeyboardGrant {
    pub session: Arc<dyn KeyboardSession>,
    /// `devices` from the Start response.
    pub devices: u32,
    pub restore_token: Option<String>,
}

#[async_trait]
pub trait RemoteDesktopPortal: Send + Sync {
    /// Registers the host app id, then CreateSession, SelectDevices(keyboard,
    /// persist_mode 2, restore token) and Start. Implementations close the
    /// partially created session on failure.
    async fn open(&self, restore_token: Option<String>) -> Result<KeyboardGrant, PortalError>;
}

#[async_trait]
pub trait KeyboardSession: Send + Sync {
    async fn notify_keysym(&self, keysym: i32, pressed: bool) -> Result<(), String>;
    /// Closes the session and its connection; errors are ignored.
    async fn close(&self);
}

/// Used where no portal exists (tests, non-Linux builds).
pub struct NoRemoteDesktop;

#[async_trait]
impl RemoteDesktopPortal for NoRemoteDesktop {
    async fn open(&self, _restore_token: Option<String>) -> Result<KeyboardGrant, PortalError> {
        Err(PortalError::Failed("The desktop portal is unavailable".to_owned()))
    }
}

// ---------------------------------------------------------------------------
// Service

type Getter<T> = Arc<dyn Fn() -> T + Send + Sync>;

/// Everything the service touches, injectable for tests.
pub struct PasteIo {
    pub env: DesktopEnv,
    pub runner: Arc<dyn CommandRunner>,
    pub clipboard: Arc<dyn ClipboardBackend>,
    pub portal: Arc<dyn RemoteDesktopPortal>,
    pub accessibility: Getter<AccessibilityPermission>,
    /// `settings.pasteShortcut`.
    pub shortcut: Getter<PasteShortcut>,
    /// `settings.pastePortalToken || null`.
    pub load_restore_token: Getter<Option<String>>,
    /// Persists `settings.pastePortalToken` (and broadcasts the settings).
    pub save_restore_token: Arc<dyn Fn(String) + Send + Sync>,
}

impl PasteIo {
    /// The running desktop with the real clipboard, commands and portal.
    pub fn system(clipboard: Arc<dyn ClipboardBackend>) -> Self {
        let env = DesktopEnv::current();
        let platform = env.platform;
        Self {
            env,
            runner: Arc::new(SystemCommandRunner),
            clipboard,
            portal: default_remote_desktop(),
            accessibility: Arc::new(move || accessibility_permission(platform)),
            shortcut: Arc::new(PasteShortcut::default),
            load_restore_token: Arc::new(|| None),
            save_restore_token: Arc::new(|_| {}),
        }
    }
}

fn default_remote_desktop() -> Arc<dyn RemoteDesktopPortal> {
    #[cfg(target_os = "linux")]
    {
        Arc::new(crate::portal::AshpdRemoteDesktop)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Arc::new(NoRemoteDesktop)
    }
}

#[derive(Clone)]
pub struct PasteService {
    inner: Arc<Inner>,
}

struct Inner {
    io: PasteIo,
    wayland_portal: bool,
    kde_wayland: bool,
    qdbus: Option<&'static str>,
    command: Option<PasteCommand>,
    xdotool: bool,
    restore: Arc<ClipboardRestore>,
    in_flight: AtomicBool,
    portal: tokio::sync::Mutex<Option<Arc<dyn KeyboardSession>>>,
}

/// Clears the in-flight flag however the delivery ends.
struct Lease<'a>(&'a AtomicBool);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn failed(message: impl Into<String>) -> DomainError {
    DomainError::failed(message)
}

impl PasteService {
    pub fn new(io: PasteIo) -> Self {
        let env = &io.env;
        let wayland_portal = env.is_linux_wayland();
        let kde_wayland = wayland_portal && env.is_kde();
        let runner = &io.runner;
        let qdbus = ["qdbus6", "qdbus"].into_iter().find(|program| runner.exists(program));
        let xdotool = env.platform == Platform::Linux && runner.exists("xdotool");
        let command = resolve_command(env.platform, PasteShortcut::Standard, xdotool);
        let restore = ClipboardRestore::new(io.clipboard.clone());
        Self {
            inner: Arc::new(Inner {
                io,
                wayland_portal,
                kde_wayland,
                qdbus,
                command,
                xdotool,
                restore,
                in_flight: AtomicBool::new(false),
                portal: tokio::sync::Mutex::new(None),
            }),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.inner.in_flight.load(Ordering::SeqCst)
    }

    fn lease(&self, message: &str) -> DomainResult<Lease<'_>> {
        self.inner
            .in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Lease(&self.inner.in_flight))
            .map_err(|_| failed(message))
    }

    /// Copies without pasting. Cancels a pending clipboard restore.
    pub async fn copy(&self, text: &str, timings: Option<&mut DeliveryTimings>) -> DomainResult<()> {
        let _lease = self.lease("A clipboard operation is already in progress.")?;
        let started = Instant::now();
        self.inner.restore.cancel();
        let result = self.inner.publish_clipboard(text).await;
        if let Some(timings) = timings {
            timings.clipboard_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        }
        result
    }

    /// Opens the Wayland paste session ahead of time (shows the portal
    /// dialog once); a no-op elsewhere.
    pub async fn authorize(&self) -> DomainResult<()> {
        if !self.inner.wayland_portal {
            return Ok(());
        }
        let mut portal = self.inner.portal.lock().await;
        self.inner.ensure_portal_session(&mut portal).await.map(|_| ())
    }

    /// Runs `body` while no other delivery can start.
    pub async fn with_clipboard_lease<T, F, Fut>(&self, body: F) -> DomainResult<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = DomainResult<T>>,
    {
        let _lease = self.lease("A clipboard delivery is already in progress.")?;
        self.inner.restore.cancel();
        body().await
    }

    /// Publishes `text` and pastes it into the focused app. Returns the
    /// method used (`wayland-portal` or the injector program).
    pub async fn paste(
        &self,
        text: &str,
        restore_clipboard: bool,
        timings: Option<&mut DeliveryTimings>,
    ) -> DomainResult<String> {
        let started = Instant::now();
        let _lease = self.lease("A paste is already in progress; wait before pasting again")?;
        let result = self.perform_paste(text, restore_clipboard).await;
        if let Some(timings) = timings {
            timings.paste_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        }
        result
    }

    async fn perform_paste(&self, text: &str, restore_clipboard: bool) -> DomainResult<String> {
        let inner = &self.inner;
        let shortcut = (inner.io.shortcut)();
        let pending = inner.restore.begin(restore_clipboard).await;
        let generation = inner.restore.generation();
        if let Err(error) = inner.publish_clipboard(text).await {
            return Err(failed(error.message).with_cause(CLIPBOARD_COPY_ERROR, None));
        }
        let armed = match pending {
            Some(pending) => pending.arm(self.restore_fn()).await,
            None => None,
        };
        let result = self.deliver(shortcut).await;
        match result {
            Ok(method) => {
                if let Some(armed) = armed {
                    armed.finish();
                }
                Ok(method)
            }
            Err(error) => {
                if generation == inner.restore.generation() {
                    inner.restore.cancel();
                }
                Err(error)
            }
        }
    }

    fn restore_fn(&self) -> RestoreFn {
        let weak = Arc::downgrade(&self.inner);
        Box::new(move |previous: String| {
            Box::pin(async move {
                let Some(inner) = weak.upgrade() else { return Ok(()) };
                PasteService { inner }.copy(&previous, None).await
            })
        })
    }

    async fn deliver(&self, shortcut: PasteShortcut) -> DomainResult<String> {
        let inner = &self.inner;
        if inner.io.env.platform == Platform::Darwin {
            let accessibility = (inner.io.accessibility)();
            if !accessibility.can_attempt_paste {
                return Err(failed(format!("The transcript was copied; {}", accessibility.detail)));
            }
        }
        if inner.wayland_portal {
            inner.paste_through_portal(shortcut).await?;
            return Ok("wayland-portal".to_owned());
        }
        let Some(command) = resolve_command(inner.io.env.platform, shortcut, inner.xdotool) else {
            return Err(failed("no compatible input injector is available; the transcript is on the clipboard"));
        };
        tokio::time::sleep(Duration::from_millis(120)).await;
        let outcome = inner
            .io
            .runner
            .run(CommandSpec {
                program: command.program.clone(),
                args: command.args.clone(),
                // A stuck injector must not keep the paste (and dictation) busy forever.
                timeout: Duration::from_secs(5),
                kill: KillSignal::Term,
            })
            .await;
        match outcome {
            CommandOutcome::Exited { code: Some(0), .. } => Ok(command.program),
            CommandOutcome::Exited { code, stderr } => {
                let stderr = stderr.trim();
                Err(failed(if stderr.is_empty() {
                    format!("{} exited with code {}", command.program, code.map_or("null".to_owned(), |c| c.to_string()))
                } else {
                    stderr.to_owned()
                }))
            }
            CommandOutcome::TimedOut => {
                Err(failed(format!("{} did not finish; the transcript is on the clipboard", command.program)))
            }
            CommandOutcome::SpawnFailed(message) => Err(failed(message)),
        }
    }

    /// Clears the restore and closes the portal session.
    pub async fn shutdown(&self) {
        self.inner.restore.cancel();
        let session = self.inner.portal.lock().await.take();
        if let Some(session) = session {
            session.close().await;
        }
    }

    /// `PlatformCapabilities` for this desktop. `large_speech_available` is
    /// left for the caller.
    pub fn capabilities(&self, overlay_method: OverlayMethod, overlay_detail: Option<String>) -> PlatformCapabilities {
        let env = &self.inner.io.env;
        let session_type = env.session_type().unwrap_or_else(|| "unknown".to_owned());
        PlatformCapabilities {
            large_speech_available: None,
            platform: env.platform,
            desktop: env.desktop(),
            wayland: session_type == "wayland",
            session_type,
            paste_method: if self.inner.wayland_portal {
                "wayland-portal".to_owned()
            } else {
                self.inner.command.as_ref().map_or("clipboard-only".to_owned(), |c| c.program.clone())
            },
            overlay_method,
            overlay_detail,
        }
    }
}

impl Inner {
    async fn publish_clipboard(&self, text: &str) -> DomainResult<()> {
        let clipboard = self.io.clipboard.clone();
        let owned = text.to_owned();
        tokio::task::spawn_blocking(move || clipboard.write_text(&owned))
            .await
            .map_err(|e| failed(e.to_string()))?
            .map_err(failed)?;
        // Publish through Plasma's clipboard service as well so the
        // destination sees the transcript after focus has moved. Klipper may
        // ask us to serve the selection before it answers; the clipboard
        // thread keeps serving while this call is awaited.
        if let (true, Some(qdbus)) = (self.kde_wayland, self.qdbus) {
            let outcome = self
                .io
                .runner
                .run(CommandSpec {
                    program: qdbus.to_owned(),
                    args: vec![
                        "org.kde.klipper".into(),
                        "/klipper".into(),
                        "setClipboardContents".into(),
                        text.to_owned(),
                    ],
                    timeout: Duration::from_secs(2),
                    kill: KillSignal::Kill,
                })
                .await;
            match outcome {
                CommandOutcome::Exited { code: Some(0), .. } => {}
                CommandOutcome::Exited { .. } => {
                    return Err(failed("KDE clipboard rejected the transcript. Try Copy again from History."))
                }
                CommandOutcome::TimedOut => {
                    return Err(failed(
                        "KDE clipboard did not respond. Your transcript remains in History; try Copy again.",
                    ))
                }
                CommandOutcome::SpawnFailed(_) => {
                    return Err(failed("Could not contact the KDE clipboard. Your transcript remains in History."))
                }
            }
        }
        Ok(())
    }

    /// A remote-desktop session closed by the user or a portal restart fails
    /// on the first key. Drop it so the next paste opens a fresh session;
    /// retrying now could paste twice if part of the shortcut arrived.
    async fn paste_through_portal(&self, shortcut: PasteShortcut) -> DomainResult<()> {
        let mut portal = self.portal.lock().await;
        let session = self.ensure_portal_session(&mut portal).await?;
        let result = self.send_shortcut(&*session, shortcut).await;
        if result.is_err() {
            if let Some(session) = portal.take() {
                tokio::spawn(async move { session.close().await });
            }
        }
        result
    }

    async fn send_shortcut(&self, session: &dyn KeyboardSession, shortcut: PasteShortcut) -> DomainResult<()> {
        // Let the portal dialog close and restore focus before pasting.
        tokio::time::sleep(Duration::from_millis(220)).await;
        let mut keys = vec![KEYSYM_LEFTCTRL];
        if shortcut == PasteShortcut::Terminal {
            keys.push(KEYSYM_LEFTSHIFT);
        }
        keys.push(KEYSYM_V);
        let mut held = Vec::new();
        let mut press_error = None;
        for keysym in keys {
            // A rejected notification may still have reached the compositor.
            held.push(keysym);
            if let Err(error) = session.notify_keysym(keysym, true).await {
                press_error = Some(error);
                break;
            }
        }
        let mut release_error = None;
        for keysym in held.into_iter().rev() {
            if let Err(error) = session.notify_keysym(keysym, false).await {
                release_error.get_or_insert(error);
            }
        }
        // Attempt every release without masking the original failure.
        match (press_error, release_error) {
            (Some(error), _) | (None, Some(error)) => Err(failed(error)),
            (None, None) => Ok(()),
        }
    }

    async fn ensure_portal_session(
        &self,
        slot: &mut Option<Arc<dyn KeyboardSession>>,
    ) -> DomainResult<Arc<dyn KeyboardSession>> {
        if let Some(session) = slot.as_ref() {
            return Ok(session.clone());
        }
        let cancelled = "Automatic paste permission was cancelled";
        let grant = self.io.portal.open((self.io.load_restore_token)()).await.map_err(|error| {
            failed(match error {
                PortalError::Response { code: 1, .. } => cancelled.to_owned(),
                PortalError::Response { step: PortalStep::CreateSession, .. } => {
                    "Could not create a Wayland paste session".to_owned()
                }
                PortalError::Response { step: PortalStep::SelectDevices, .. } => {
                    "Keyboard control was not approved".to_owned()
                }
                PortalError::Response { .. } => "Could not start automatic paste".to_owned(),
                PortalError::Failed(message) => message,
            })
        })?;
        if grant.devices & KEYBOARD_DEVICE == 0 {
            grant.session.close().await;
            return Err(failed("Keyboard control was not granted; the transcript remains on the clipboard"));
        }
        if let Some(token) = grant.restore_token.filter(|token| !token.is_empty()) {
            (self.io.save_restore_token)(token);
        }
        *slot = Some(grant.session.clone());
        Ok(grant.session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::fake::FakeClipboard;
    use crate::command::fake::FakeRunner;
    use crate::types::AccessibilityState;
    use parking_lot::Mutex;

    const DANGEROUS: &str = "$(touch /tmp/never-run); {ENTER}\r\nhéllo 👋";

    struct Fixture {
        service: PasteService,
        clipboard: Arc<FakeClipboard>,
        runner: Arc<FakeRunner>,
    }

    fn io(platform: Platform, vars: &[(&str, &str)], runner: Arc<FakeRunner>, clipboard: Arc<FakeClipboard>) -> PasteIo {
        PasteIo {
            env: DesktopEnv::new(platform, vars.iter().copied()),
            runner,
            clipboard,
            portal: Arc::new(NoRemoteDesktop),
            accessibility: Arc::new(|| AccessibilityPermission {
                state: AccessibilityState::Granted,
                can_attempt_paste: true,
                detail: "Allowed".into(),
            }),
            shortcut: Arc::new(PasteShortcut::default),
            load_restore_token: Arc::new(|| None),
            save_restore_token: Arc::new(|_| {}),
        }
    }

    fn fixture(platform: Platform, shortcut: PasteShortcut) -> Fixture {
        let runner = FakeRunner::with(&["xdotool", "qdbus6"]);
        let clipboard = Arc::new(FakeClipboard::with_text("Original clipboard"));
        let mut io = io(platform, &[("XDG_SESSION_TYPE", "x11")], runner.clone(), clipboard.clone());
        io.shortcut = Arc::new(move || shortcut);
        Fixture { service: PasteService::new(io), clipboard, runner }
    }

    #[tokio::test(start_paused = true)]
    async fn injection_keeps_transcript_on_clipboard_and_sends_only_the_shortcut() {
        for platform in [Platform::Darwin, Platform::Win32, Platform::Linux] {
            let f = fixture(platform, PasteShortcut::Terminal);
            let method = f.service.paste(DANGEROUS, false, None).await.unwrap();
            assert_eq!(*f.clipboard.writes.lock(), vec![DANGEROUS.to_owned()]);
            let commands = f.runner.commands.lock().clone();
            assert_eq!(commands.len(), 1);
            assert!(!commands[0].args.join(" ").contains(DANGEROUS));
            let expected = resolve_command(platform, PasteShortcut::Terminal, true).unwrap();
            assert_eq!((commands[0].program.clone(), commands[0].args.clone()), (expected.program.clone(), expected.args));
            assert_eq!(method, expected.program);
            assert_eq!(commands[0].kill, KillSignal::Term);
            assert_eq!(commands[0].timeout, Duration::from_secs(5));
        }
        assert_eq!(
            resolve_command(Platform::Win32, PasteShortcut::Terminal, false).unwrap().args[3],
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+v')"
        );
        assert_eq!(
            resolve_command(Platform::Linux, PasteShortcut::Terminal, true).unwrap().args,
            ["key", "--clearmodifiers", "ctrl+shift+v"]
        );
        assert_eq!(resolve_command(Platform::Linux, PasteShortcut::Standard, false), None);
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    async fn advance(ms: u64) {
        for _ in 0..(ms / 50) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            settle().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn clipboard_restore_preserves_previous_text_and_is_cancelled_by_newer_writes_failure_and_shutdown() {
        for action in ["restore", "failure", "overwrite", "copy-identical", "shutdown"] {
            let f = fixture(Platform::Linux, PasteShortcut::Standard);
            if action == "failure" {
                f.runner.push(CommandOutcome::Exited { code: Some(1), stderr: "Injection denied\n".into() });
                let error = f.service.paste("Transcript", true, None).await.unwrap_err();
                assert_eq!(error.message, "Injection denied");
            } else {
                f.service.paste("Transcript", true, None).await.unwrap();
            }
            match action {
                "overwrite" => f.clipboard.external_write("New user clipboard"),
                "copy-identical" => f.service.copy("Transcript", None).await.unwrap(),
                "shutdown" => f.service.shutdown().await,
                _ => {}
            }
            advance(2500).await;
            let expected = match action {
                "restore" => "Original clipboard",
                "overwrite" => "New user clipboard",
                _ => "Transcript",
            };
            assert_eq!(f.clipboard.text().as_deref(), Some(expected), "{action}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rich_clipboards_are_not_replaced_by_a_plain_text_backup() {
        let f = fixture(Platform::Linux, PasteShortcut::Standard);
        f.clipboard.current.lock().rich = true;
        f.service.paste("Transcript", true, None).await.unwrap();
        advance(2500).await;
        assert_eq!(f.clipboard.text().as_deref(), Some("Transcript"));
    }

    #[tokio::test(start_paused = true)]
    async fn clipboard_failure_prevents_injection_and_injector_failure_releases_the_lease() {
        for clipboard_failure in [true, false] {
            let f = fixture(Platform::Linux, PasteShortcut::Standard);
            if clipboard_failure {
                *f.clipboard.fail_writes.lock() = true;
            } else {
                f.runner.push(CommandOutcome::Exited { code: Some(1), stderr: String::new() });
            }
            let error = f.service.paste(DANGEROUS, false, None).await.unwrap_err();
            assert_eq!(is_clipboard_copy_error(&error), clipboard_failure);
            if clipboard_failure {
                assert_eq!(error.message, "Clipboard rejected");
            } else {
                assert_eq!(error.message, "xdotool exited with code 1");
            }
            assert_eq!(f.clipboard.writes.lock().len(), usize::from(!clipboard_failure));
            assert_eq!(f.runner.commands.lock().len(), usize::from(!clipboard_failure));
            assert!(!f.service.is_busy());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn injector_timeouts_and_missing_injectors_keep_the_transcript_on_the_clipboard() {
        let f = fixture(Platform::Linux, PasteShortcut::Standard);
        f.runner.push(CommandOutcome::TimedOut);
        let error = f.service.paste("x", false, None).await.unwrap_err();
        assert_eq!(error.message, "xdotool did not finish; the transcript is on the clipboard");

        let runner = FakeRunner::with(&[]);
        let clipboard = Arc::new(FakeClipboard::default());
        let service = PasteService::new(io(Platform::Linux, &[("XDG_SESSION_TYPE", "x11")], runner, clipboard.clone()));
        assert_eq!(service.capabilities(OverlayMethod::Unavailable, None).paste_method, "clipboard-only");
        let error = service.paste("x", false, None).await.unwrap_err();
        assert_eq!(error.message, "no compatible input injector is available; the transcript is on the clipboard");
        assert_eq!(clipboard.text().as_deref(), Some("x"));
    }

    #[tokio::test(start_paused = true)]
    async fn macos_requires_accessibility_before_injecting() {
        let runner = FakeRunner::with(&[]);
        let clipboard = Arc::new(FakeClipboard::default());
        let mut io = io(Platform::Darwin, &[], runner.clone(), clipboard.clone());
        io.accessibility = Arc::new(accessibility_permission_denied);
        let service = PasteService::new(io);
        let error = service.paste("x", false, None).await.unwrap_err();
        assert!(error.message.starts_with("The transcript was copied; Enable Delulu Talks in System Settings"));
        assert!(runner.commands.lock().is_empty());
        assert_eq!(clipboard.text().as_deref(), Some("x"));
    }

    fn accessibility_permission_denied() -> AccessibilityPermission {
        crate::permissions::mac_accessibility_from(Ok(false))
    }

    struct FakeSession {
        keys: Arc<Mutex<Vec<(i32, bool)>>>,
        closed: Arc<Mutex<u32>>,
    }

    #[async_trait]
    impl KeyboardSession for FakeSession {
        async fn notify_keysym(&self, keysym: i32, pressed: bool) -> Result<(), String> {
            self.keys.lock().push((keysym, pressed));
            if keysym == KEYSYM_V && pressed {
                return Err("Press failed".into());
            }
            if !pressed {
                return Err("Release failed".into());
            }
            Ok(())
        }
        async fn close(&self) {
            *self.closed.lock() += 1;
        }
    }

    struct FakePortal {
        keys: Arc<Mutex<Vec<(i32, bool)>>>,
        closed: Arc<Mutex<u32>>,
        opened: Mutex<Vec<Option<String>>>,
    }

    #[async_trait]
    impl RemoteDesktopPortal for FakePortal {
        async fn open(&self, restore_token: Option<String>) -> Result<KeyboardGrant, PortalError> {
            self.opened.lock().push(restore_token);
            Ok(KeyboardGrant {
                session: Arc::new(FakeSession { keys: self.keys.clone(), closed: self.closed.clone() }),
                devices: 1,
                restore_token: Some("next-token".into()),
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn wayland_releases_every_possibly_pressed_key_and_preserves_the_original_error() {
        let runner = FakeRunner::with(&["xdotool"]);
        let clipboard = Arc::new(FakeClipboard::default());
        let keys = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(Mutex::new(0));
        let portal = Arc::new(FakePortal { keys: keys.clone(), closed: closed.clone(), opened: Mutex::new(vec![]) });
        let saved = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut io = io(Platform::Linux, &[("XDG_SESSION_TYPE", "wayland")], runner.clone(), clipboard.clone());
        io.portal = portal.clone();
        io.shortcut = Arc::new(|| PasteShortcut::Terminal);
        io.load_restore_token = Arc::new(|| Some("saved-token".into()));
        let sink = saved.clone();
        io.save_restore_token = Arc::new(move |token| sink.lock().push(token));
        let service = PasteService::new(io);
        assert_eq!(service.capabilities(OverlayMethod::LayerShell, None).paste_method, "wayland-portal");

        let error = service.paste(DANGEROUS, false, None).await.unwrap_err();
        assert_eq!(error.message, "Press failed");
        assert_eq!(
            *keys.lock(),
            vec![
                (0xffe3, true),
                (0xffe1, true),
                (0x76, true),
                (0x76, false),
                (0xffe1, false),
                (0xffe3, false)
            ]
        );
        assert_eq!(*clipboard.writes.lock(), vec![DANGEROUS.to_owned()]);
        assert!(runner.commands.lock().is_empty());
        assert!(!service.is_busy());
        assert_eq!(*portal.opened.lock(), vec![Some("saved-token".to_owned())]);
        assert_eq!(*saved.lock(), vec!["next-token".to_owned()]);
        settle().await;
        // The failed session is dropped; the next paste opens a fresh one.
        assert_eq!(*closed.lock(), 1);
        let _ = service.paste("again", false, None).await;
        assert_eq!(portal.opened.lock().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn kde_publication_holds_delivery_until_klipper_acknowledges() {
        let runner = FakeRunner::with(&["qdbus6"]);
        let gate = Arc::new(tokio::sync::Notify::new());
        *runner.gate.lock() = Some(gate.clone());
        let clipboard = Arc::new(FakeClipboard::default());
        let service = PasteService::new(io(
            Platform::Linux,
            &[("XDG_SESSION_TYPE", "wayland"), ("XDG_CURRENT_DESKTOP", "KDE")],
            runner.clone(),
            clipboard,
        ));
        let pending = tokio::spawn({
            let service = service.clone();
            async move { service.copy(DANGEROUS, None).await }
        });
        // The clipboard write runs on the blocking pool first.
        for _ in 0..1000 {
            if !runner.commands.lock().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(Duration::from_millis(1));
        }
        let commands = runner.commands.lock().clone();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].program, "qdbus6");
        assert_eq!(commands[0].args[3], DANGEROUS);
        assert_eq!(commands[0].kill, KillSignal::Kill);
        assert!(service.is_busy());
        let error = service.copy("Overwrite", None).await.unwrap_err();
        assert!(error.message.contains("already in progress"));
        gate.notify_one();
        pending.await.unwrap().unwrap();
        assert!(!service.is_busy());

        *runner.gate.lock() = None;
        runner.push(CommandOutcome::TimedOut);
        let error = service.copy("x", None).await.unwrap_err();
        assert_eq!(error.message, "KDE clipboard did not respond. Your transcript remains in History; try Copy again.");
    }
}
