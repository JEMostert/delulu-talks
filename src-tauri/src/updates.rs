//! Explicit, user-driven updates (`electron/services/updates.ts`) on
//! tauri-plugin-updater: check, download with progress, keep the verified
//! download, and install + restart only while nothing is busy.
//!
//! Supported installations: the Linux AppImage (`$APPIMAGE`), the macOS app
//! bundle and the Windows NSIS installer. Development builds and deb, rpm
//! and pacman packages report `unsupported`; their tray offers the GitHub
//! releases page instead.

use std::sync::Arc;
use std::time::{Duration, Instant};

use delulu_core::DomainResult;
use delulu_domain::{UpdatePhase, UpdateStatus};
use parking_lot::Mutex;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::{plain, AppState};

pub const RELEASES_URL: &str = "https://github.com/JEMostert/delulu-talks/releases/latest";

type Publish = Arc<dyn Fn(&UpdateStatus) + Send + Sync>;
type CanInstall = Arc<dyn Fn() -> bool + Send + Sync>;

struct State {
    status: UpdateStatus,
    /// The release found by the last check.
    available: Option<Update>,
    downloading: bool,
    /// A verified download, kept until installed.
    ready: Option<(Update, Vec<u8>)>,
    install_requested: bool,
}

#[derive(Clone)]
pub struct UpdateService {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    supported: bool,
    state: Mutex<State>,
    checking: tokio::sync::Mutex<()>,
    publish: Publish,
    can_install: CanInstall,
}

/// First line, at most 240 characters, without an `Error:` prefix.
fn error_message(error: impl std::fmt::Display) -> String {
    let text = error.to_string();
    let text = text.strip_prefix("Error:").or_else(|| text.strip_prefix("error:")).unwrap_or(&text).trim_start();
    text.lines().next().unwrap_or("").chars().take(240).collect()
}

/// Whether this installation can replace itself.
pub fn self_update_supported(packaged: bool) -> bool {
    if !packaged {
        return false;
    }
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty())
    } else if cfg!(target_os = "macos") {
        std::env::current_exe()
            .is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
    } else if cfg!(windows) {
        tauri::utils::platform::bundle_type() == Some(tauri::utils::config::BundleType::Nsis)
    } else {
        false
    }
}

impl UpdateService {
    pub fn new(
        app: AppHandle,
        supported: bool,
        current_version: String,
        publish: impl Fn(&UpdateStatus) + Send + Sync + 'static,
        can_install: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        let status = if supported {
            UpdateStatus {
                phase: UpdatePhase::Idle,
                current_version,
                version: None,
                message: "Updates are delivered through GitHub Releases".into(),
                percent: None,
                transferred: None,
                total: None,
                bytes_per_second: None,
            }
        } else {
            UpdateStatus {
                phase: UpdatePhase::Unsupported,
                current_version,
                version: None,
                message: "Use GitHub Releases to update this installation".into(),
                percent: None,
                transferred: None,
                total: None,
                bytes_per_second: None,
            }
        };
        Self {
            inner: Arc::new(Inner {
                app,
                supported,
                state: Mutex::new(State {
                    status,
                    available: None,
                    downloading: false,
                    ready: None,
                    install_requested: false,
                }),
                checking: tokio::sync::Mutex::new(()),
                publish: Arc::new(publish),
                can_install: Arc::new(can_install),
            }),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner.state.lock().status.clone()
    }

    fn update(&self, change: impl FnOnce(&mut UpdateStatus)) {
        let status = {
            let mut state = self.inner.state.lock();
            change(&mut state.status);
            state.status.clone()
        };
        (self.inner.publish)(&status);
    }

    fn busy_or_ready(&self) -> bool {
        let state = self.inner.state.lock();
        state.downloading
            || state.ready.is_some()
            || matches!(state.status.phase, UpdatePhase::Downloading | UpdatePhase::Downloaded)
    }

    /// `updates:check`. Concurrent checks share one request.
    pub async fn check(&self) -> UpdateStatus {
        if !self.inner.supported || self.busy_or_ready() {
            return self.status();
        }
        let Ok(_turn) = self.inner.checking.try_lock() else {
            let _wait = self.inner.checking.lock().await;
            return self.status();
        };
        self.update(|status| {
            status.phase = UpdatePhase::Checking;
            status.message = "Checking GitHub Releases…".into();
        });
        let result = match self.inner.app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        if self.busy_or_ready() {
            return self.status();
        }
        match result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                self.inner.state.lock().available = Some(update);
                self.update(|status| {
                    status.phase = UpdatePhase::Available;
                    status.message = format!("Version {version} is ready to download");
                    status.version = Some(version);
                    status.percent = Some(0.0);
                });
            }
            Ok(None) => {
                self.inner.state.lock().available = None;
                self.update(|status| {
                    status.phase = UpdatePhase::UpToDate;
                    status.message = format!("Delulu Talks {} is up to date", status.current_version);
                    status.version = None;
                    status.percent = None;
                });
            }
            Err(error) => self.update(|status| {
                status.phase = UpdatePhase::Error;
                status.message = error_message(error);
            }),
        }
        self.status()
    }

    /// `updates:download`: downloads and verifies the available release.
    pub async fn download(&self) -> UpdateStatus {
        let update = {
            let mut state = self.inner.state.lock();
            let downloadable = matches!(state.status.phase, UpdatePhase::Available | UpdatePhase::Error)
                && state.status.version.is_some();
            if !self.inner.supported || state.downloading || state.ready.is_some() || !downloadable {
                return state.status.clone();
            }
            let Some(update) = state.available.clone() else {
                return state.status.clone();
            };
            state.downloading = true;
            update
        };
        let version = update.version.clone();
        self.update(|status| {
            status.phase = UpdatePhase::Downloading;
            status.version = Some(version.clone());
            status.message = format!("Starting version {version} download");
            status.percent = Some(0.0);
        });
        let started = Instant::now();
        let mut transferred = 0u64;
        let mut last_publish: Option<Instant> = None;
        let service = self.clone();
        let progress_version = version.clone();
        let result = update
            .download(
                |chunk, total| {
                    transferred += chunk as u64;
                    // Coalesce chunk callbacks into a few updates per second.
                    if last_publish.is_some_and(|at| at.elapsed() < Duration::from_millis(250)) {
                        return;
                    }
                    last_publish = Some(Instant::now());
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    service.update(|status| {
                        status.phase = UpdatePhase::Downloading;
                        status.message = format!("Downloading version {progress_version}");
                        status.transferred = Some(transferred as f64);
                        status.total = total.map(|total| total as f64);
                        status.percent = total
                            .filter(|total| *total > 0)
                            .map(|total| (transferred as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
                        status.bytes_per_second = Some((transferred as f64 / elapsed).round());
                    });
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                {
                    let mut state = self.inner.state.lock();
                    state.downloading = false;
                    state.ready = Some((update, bytes));
                }
                self.update(|status| {
                    status.phase = UpdatePhase::Downloaded;
                    status.message = format!("Version {version} is ready to install");
                    status.percent = Some(100.0);
                });
            }
            Err(error) => {
                self.inner.state.lock().downloading = false;
                self.update(|status| {
                    status.phase = UpdatePhase::Error;
                    status.message = error_message(error);
                });
            }
        }
        self.status()
    }

    /// Whether a downloaded update could restart right now.
    pub fn installable(&self) -> bool {
        (self.inner.can_install)()
    }

    /// `updates:install`: installs the retained download and restarts.
    pub fn install(&self) -> DomainResult<()> {
        let ready = {
            let mut state = self.inner.state.lock();
            let current = state.status.phase == UpdatePhase::Downloaded
                && state.ready.as_ref().is_some_and(|(update, _)| Some(&update.version) == state.status.version.as_ref());
            if !self.inner.supported || state.install_requested || !current {
                return Ok(());
            }
            if !(self.inner.can_install)() {
                return Err(plain("Finish recording, processing, or model setup before restarting"));
            }
            state.install_requested = true;
            state.ready.take()
        };
        let Some((update, bytes)) = ready else { return Ok(()) };
        if let Err(error) = update.install(&bytes) {
            let message = format!(
                "Could not install the update: {}. Check for updates and retry, or install from GitHub Releases.",
                error_message(&error)
            );
            {
                let mut state = self.inner.state.lock();
                state.install_requested = false;
                state.available = None;
            }
            self.update(|status| {
                status.phase = UpdatePhase::Error;
                status.message = message.clone();
            });
            return Err(plain(message));
        }
        // Windows hands over to the NSIS installer, which exits the app itself.
        if let Some(state) = AppState::get(&self.inner.app) {
            state.shell.restart_after_quit.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        crate::shell::quit(&self.inner.app);
        Ok(())
    }

    /// Checks 8 s after start and then every six hours.
    pub fn schedule_checks(&self) {
        if !self.inner.supported {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            loop {
                service.check().await;
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_are_one_short_line() {
        assert_eq!(error_message("Error: network down\nmore"), "network down");
        assert_eq!(error_message("x".repeat(300)).chars().count(), 240);
    }

    #[test]
    fn development_builds_do_not_self_update() {
        assert!(!self_update_supported(false));
    }
}
