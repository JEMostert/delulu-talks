//! Voice replies: readiness and the model install go through the `delulu` CLI, so the
//! app reports exactly what `delulu speak` will find. Voice choices live in the CLI's
//! `voice/settings.json`, which every reply reads.
use serde::Serialize;
use std::{
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    name: &'static str,
    url: &'static str,
    credit: &'static str,
    text: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// `delulu speak` can speak now.
    ready: bool,
    cli_path: PathBuf,
    installing: bool,
    /// The voice model is downloaded.
    model: bool,
    /// The voice engine (`delulu-engine`) is installed.
    engine: bool,
    voice: String,
    radio_voice: String,
    voices: Vec<String>,
    model_label: &'static str,
    model_bytes: u64,
    /// Shown before the download, as the model's licence requires.
    terms: Terms,
}

fn run_cli(action: &str) -> Result<std::process::Output, String> {
    let cli = delulu_radio::voice::cli_path();
    Command::new(&cli).arg(action).output().map_err(|error| {
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

fn settings_path() -> Result<PathBuf, String> {
    Ok(dirs::data_dir()
        .ok_or("No data folder")?
        .join("delulu-talks/voice/settings.json"))
}

/// The voice Delulu FM's host uses (`radioVoice` in the CLI's settings).
pub fn radio_voice() -> String {
    settings_path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["radioVoice"].as_str().map(str::to_uppercase))
        .filter(|v| delulu_models::supertonic_voice(v).is_some())
        .unwrap_or_else(|| delulu_models::DEFAULT_RADIO_VOICE.to_string())
}

fn status() -> Result<VoiceStatus, String> {
    let output = checked_output("status")?;
    let cli: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        "Could not read voice reply status. Check your delulu installation.".to_string()
    })?;
    // A `delulu` from before the native voice reports no model; treat it as not ready.
    let text = |key: &str, default: &str| cli[key].as_str().unwrap_or(default).to_string();
    let model = &delulu_models::SUPERTONIC_3;
    let terms = model.terms.expect("the voice model has terms");
    Ok(VoiceStatus {
        cli_path: delulu_radio::voice::cli_path(),
        ready: cli["ready"].as_bool() == Some(true) && cli["model"].is_boolean(),
        installing: INSTALLING.load(Ordering::SeqCst),
        model: cli["model"].as_bool() == Some(true),
        engine: cli["engineBinary"].is_string(),
        voice: text("voice", delulu_models::DEFAULT_AGENT_VOICE),
        radio_voice: text("radioVoice", delulu_models::DEFAULT_RADIO_VOICE),
        voices: delulu_models::SUPERTONIC_VOICES
            .iter()
            .map(|v| v.to_string())
            .collect(),
        model_label: model.label,
        model_bytes: model.bytes,
        terms: Terms {
            name: terms.name,
            url: terms.url,
            credit: terms.credit,
            text: terms.text,
        },
    })
}

#[tauri::command]
pub async fn get_voice_status() -> Result<VoiceStatus, String> {
    tauri::async_runtime::spawn_blocking(status)
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
        checked_output("install-model").map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sets the agents' voice (`role` "agent") or the radio host's (`role` "radio"),
/// keeping the other settings in the file.
#[tauri::command]
pub async fn set_voice(role: String, voice: String) -> Result<(), String> {
    let Some(voice) = delulu_models::supertonic_voice(&voice) else {
        return Err(format!("Unknown voice {voice}."));
    };
    let key = match role.as_str() {
        "agent" => "voice",
        "radio" => "radioVoice",
        _ => return Err(format!("Unknown voice role {role}.")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let path = settings_path()?;
        let mut settings = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        settings[key] = serde_json::Value::String(voice);
        let dir = path.parent().ok_or("No voice folder")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let temp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&temp, bytes)
            .and_then(|()| std::fs::rename(&temp, &path))
            .map_err(|e| format!("Could not save the voice: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
