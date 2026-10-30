use serde::{Deserialize, Serialize};
use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct CliStatus {
    ready: bool,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    ready: bool,
    configured: bool,
    installing: bool,
}

fn run_cli(action: &str) -> Result<std::process::Output, String> {
    let local = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join(".local/bin/delulu"));
    let output = match local {
        Some(path) => match Command::new(path).arg(action).output() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Command::new("delulu").arg(action).output()
            }
            result => result,
        },
        None => Command::new("delulu").arg(action).output(),
    };
    output.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "Voice replies are unavailable. Install the delulu command in ~/.local/bin or on your PATH, then reopen Settings.".to_string()
        } else {
            format!("Could not start voice replies: {error}")
        }
    })
}

fn checked_output(action: &str) -> Result<std::process::Output, String> {
    let output = run_cli(action)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lines: Vec<_> = stderr.lines().rev().take(8).collect();
        let detail: String = lines
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(1500)
            .collect();
        let detail = detail.trim().to_string();
        return Err(if detail.is_empty() {
            format!("Voice replies {action} failed. Please try again.")
        } else {
            detail
        });
    }
    Ok(output)
}

#[tauri::command]
pub async fn get_voice_status() -> Result<VoiceStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = checked_output("status")?;
        let status: CliStatus = serde_json::from_slice(&output.stdout).map_err(|_| {
            "Could not read voice reply status. Check your delulu installation.".to_string()
        })?;
        Ok(VoiceStatus {
            ready: status.ready,
            configured: status.configured,
            installing: INSTALLING.load(Ordering::SeqCst),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn install_voice_model() -> Result<(), String> {
    if INSTALLING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Voice model installation is already running.".into());
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }
    tauri::async_runtime::spawn_blocking(|| {
        let _reset = Reset;
        let output = checked_output("status")?;
        let status: CliStatus = serde_json::from_slice(&output.stdout).map_err(|_| {
            "Could not read voice reply status. Check your delulu installation.".to_string()
        })?;
        if !status.configured {
            checked_output("setup")?;
        }
        checked_output("install-model").map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
