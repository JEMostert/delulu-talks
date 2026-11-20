use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Clone, Copy)]
struct Package {
    target: &'static str,
    suffix: &'static str,
}

fn package() -> Result<Package, String> {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    let (target, suffix) = match (std::env::consts::ARCH, bundle_type()) {
        ("aarch64", Some(BundleType::App)) => ("darwin-aarch64", ".app.tar.gz"),
        ("x86_64", Some(BundleType::Deb))
            if std::path::Path::new("/usr/lib/delulu-talks/arch-package").is_file() =>
        {
            ("linux-x86_64-pacman", ".pkg.tar.zst")
        }
        ("x86_64", Some(BundleType::Deb)) => ("linux-x86_64-deb", ".deb"),
        ("x86_64", Some(BundleType::Rpm)) => ("linux-x86_64-rpm", ".rpm"),
        _ => return Err("Install a supported release package to use Settings updates.".into()),
    };
    Ok(Package { target, suffix })
}

const RELEASES: &str = "https://github.com/JEMostert/delulu-talks/releases/download/";

fn project_asset(url: &str, version: &str, suffix: &str) -> bool {
    url.strip_prefix(&format!("{RELEASES}v{version}/"))
        .is_some_and(|name| {
            name.ends_with(suffix)
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        })
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, Pending>,
) -> Result<Option<String>, String> {
    let mut pending = pending
        .0
        .try_lock()
        .map_err(|_| "An update is already in progress.")?;
    *pending = None;
    let package = package()?;
    let updater = app
        .updater_builder()
        .target(package.target)
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        })
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if !project_asset(
        update.download_url.as_str(),
        &update.version,
        package.suffix,
    ) {
        return Err("The release has an incompatible package address.".into());
    }
    let version = update.version.clone();
    *pending = Some(update);
    Ok(Some(version))
}

#[tauri::command]
pub async fn install_update(
    pending: State<'_, Pending>,
    progress: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let mut pending = pending
        .0
        .try_lock()
        .map_err(|_| "An update is already in progress.")?;
    let update = pending.take().ok_or("Check for updates first.")?;
    let package = package()?;
    let mut downloaded = 0u64;
    let mut last_mb = 0;
    let bytes = update
        .download(
            |size, _| {
                downloaded += size as u64;
                let mb = downloaded / 1_000_000;
                if mb > last_mb {
                    last_mb = mb;
                    let _ = progress.send(format!("Downloaded {mb} MB…"));
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = progress.send("Installing update…".into());
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            // download() verified both the bytes and signed version. Leave all
            // authentication to the system's polkit agent.
            let (command, flag) = match package.suffix {
                ".deb" => ("/usr/bin/dpkg", "-i"),
                ".rpm" => ("/usr/bin/rpm", "-U"),
                ".pkg.tar.zst" => ("/usr/bin/pacman", "-U"),
                _ => return Err("Unsupported Linux package.".into()),
            };
            let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
            let path = dir.path().join(format!("update{}", package.suffix));
            std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
            let mut install = std::process::Command::new("/usr/bin/pkexec");
            install.arg(command).arg(flag);
            if package.suffix == ".pkg.tar.zst" {
                install.arg("--noconfirm");
            }
            let status = install.arg(path).status().map_err(|e| format!("Could not launch the system installer: {e}"))?;
            if status.success() { Ok(()) } else { Err(format!("The system installer exited with {status}. Check authorization and package dependencies.")) }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = package;
            update.install(bytes).map_err(|e| e.to_string())
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_assets_for_the_selected_release_and_package_are_accepted() {
        let base = format!("{RELEASES}v1.9.0/");
        for name in ["delulu.deb", "Delulu-Talks_1.9.0_amd64.deb"] {
            assert!(project_asset(&format!("{base}{name}"), "1.9.0", ".deb"));
        }
        for url in [
            format!("{base}delulu.rpm"),
            format!("{base}../v1.8.0/old.deb"),
            format!("{base}bad%2Fname.deb"),
            format!("{RELEASES}v1.8.0/old.deb"),
            "https://example.org/update.deb".into(),
        ] {
            assert!(!project_asset(&url, "1.9.0", ".deb"));
        }
    }
}
