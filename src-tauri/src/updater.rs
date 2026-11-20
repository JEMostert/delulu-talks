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
    #[cfg(target_os = "macos")]
    installed_bundle()?;
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
        .configure_client(|client| {
            client
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(30))
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
    tauri::async_runtime::spawn_blocking(move || install_package(package, &update, bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
const CHANGED: &str =
    "The installed app has changed. Quit and reopen Delulu Talks before updating.";

#[cfg(target_os = "linux")]
fn install_package(package: Package, update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    // A package manager may have replaced the installed executable since this
    // window started. /proc/self/exe still references the running inode.
    let installed = tauri::utils::platform::current_exe()
        .and_then(std::fs::metadata)
        .map_err(|_| CHANGED)?;
    let running = std::fs::metadata("/proc/self/exe").map_err(|e| e.to_string())?;
    if (installed.dev(), installed.ino()) != (running.dev(), running.ino()) {
        return Err(CHANGED.into());
    }
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = Command::new("/usr/bin/pkexec")
        .arg("/usr/libexec/delulu-talks/install-update")
        .args([package.suffix, &update.version, update.signature.trim()])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not launch the system installer: {e}"))?;
    // The authenticated helper stages and verifies its own private copy. Close
    // the pipe before waiting so the helper sees EOF, including on write error.
    let sent = child.stdin.take().unwrap().write_all(&bytes);
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        sent.map_err(|e| e.to_string())
    } else {
        Err(format!("The system installer exited with {status}. Check authorization and package dependencies."))
    }
}

#[cfg(target_os = "macos")]
fn installed_bundle() -> Result<std::path::PathBuf, String> {
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .ancestors()
        .nth(3)
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .ok_or("Copy the app to Applications and open it there before updating.")?;
    if !exe.starts_with(bundle.join("Contents/MacOS")) || bundle.starts_with("/Volumes") {
        return Err("Copy the app to Applications and open it there before updating.".into());
    }
    Ok(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn install_package(_: Package, update: &Update, bytes: Vec<u8>) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::{io::Write, path::Path, process::Command};

    // download() verified these bytes and their signed version in memory. Pin
    // their digest in the authorization request, independent of the temp file.
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut archive = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    archive.write_all(&bytes).map_err(|e| e.to_string())?;
    let bundle = installed_bundle()?;
    let script = include_str!("../../packaging/macos/install-update.sh");
    let mut install = if bundle == Path::new("/Applications/Delulu Talks.app") {
        let mut command = Command::new("/usr/bin/osascript");
        command.args([
            "-e",
            include_str!("../../packaging/macos/authorize-update.applescript"),
            script,
        ]);
        command
    } else {
        let mut command = Command::new("/bin/bash");
        command.args(["-p", "-c", script, "install-update"]);
        command
    };
    let output = install
        .arg(archive.path())
        .arg(digest)
        .arg(&bundle)
        .args([&update.current_version, &update.version])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not replace the installed app. {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
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
