//! The optional Chatterbox Turbo voice (`--engine chatterbox`): an existing Python
//! environment with torch and chatterbox-tts runs the embedded adapter once per
//! reply. Kept as an opt-in while the native voice replaces it; it is only used
//! when asked for and configured.
use crate::{absolute, atomic_write, check_cancel, home, lock, run};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

const RUNTIME: &str = include_str!("runtime.py");

#[derive(Serialize, Deserialize)]
pub struct Config {
    python: PathBuf,
    device: String,
    reference: Option<PathBuf>,
    #[serde(default)]
    model_dir: PathBuf,
    #[serde(default)]
    revision: Option<String>,
}

fn python(config: &Config, root: &Path, mode: &str, path: &Path) -> Command {
    let mut cmd = Command::new(&config.python);
    cmd.arg("-c")
        .arg(RUNTIME)
        .arg(mode)
        .arg(root.join("python-deps"))
        .arg(path)
        .env("TOKENIZERS_PARALLELISM", "false");
    cmd
}

pub fn read_config(root: &Path) -> Result<Config> {
    serde_json::from_slice(&fs::read(root.join("config.json")).context(
        "Chatterbox is not configured. Run delulu setup --python /path/to/venv/bin/python first",
    )?)
    .context("Invalid Chatterbox configuration; rerun delulu setup --python …")
}

pub fn ready(config: &Config) -> bool {
    config.python.is_file()
        && [
            "conds.pt",
            "t3_turbo_v1.safetensors",
            "ve.safetensors",
            "s3gen_meanflow.safetensors",
            "tokenizer_config.json",
            "vocab.json",
            "merges.txt",
            "added_tokens.json",
            "special_tokens_map.json",
        ]
        .iter()
        .all(|name| config.model_dir.join(name).is_file())
}

/// Configures Chatterbox in an existing Python environment (never modified).
pub fn setup(
    root: &Path,
    python_path: Option<PathBuf>,
    device: Option<String>,
    reference: Option<PathBuf>,
    default_voice: bool,
) -> Result<()> {
    let _lock = lock(root)?;
    let old = read_config(root).ok();
    let python_path = python_path
        .or_else(|| old.as_ref().map(|c| c.python.clone()))
        .context("Chatterbox needs --python /path/to/venv/bin/python")?;
    if !python_path.is_file() {
        bail!("No compatible Python found at {}. Install chatterbox-tts in an existing torch environment, then run delulu setup --python /path/to/venv/bin/python. No shared Python environment will be modified.", python_path.display());
    }
    let device = device
        .or_else(|| old.as_ref().map(|c| c.device.clone()))
        .unwrap_or_else(|| "cuda".to_string());
    let reference = if default_voice {
        None
    } else {
        reference
            .map(fs::canonicalize)
            .transpose()
            .context("Voice reference does not exist")?
            .or_else(|| old.as_ref().and_then(|c| c.reference.clone()))
    };
    // Perth currently imports pkg_resources, removed by setuptools 81+. Install
    // only this small shim in our private target; never resolve/install CUDA.
    if !root.join("python-deps/pkg_resources/__init__.py").is_file() {
        let uv = home()?.join(".local/bin/uv");
        let uv = if uv.is_file() {
            uv.into_os_string()
        } else {
            "uv".into()
        };
        run(
            Command::new(uv)
                .args(["pip", "install", "--no-deps", "--target"])
                .arg(root.join("python-deps"))
                .arg("setuptools==80.9.0"),
            "private compatibility dependency installation (requires uv)",
        )?;
    }
    let config = Config {
        // Preserve the venv executable path: resolving its symlink would lose site-packages.
        python: absolute(&python_path)?,
        device,
        reference,
        model_dir: PathBuf::new(),
        revision: old.and_then(|c| c.revision),
    };
    let mut staged = tempfile::NamedTempFile::new_in(root)?;
    staged.write_all(&serde_json::to_vec_pretty(&config)?)?;
    eprintln!("Checking Chatterbox dependencies and reusing cached Turbo weights only (no model download)...");
    run(
        &mut python(&config, root, "setup", staged.path()),
        "Turbo setup",
    )?;
    let config: Config = serde_json::from_slice(&fs::read(staged.path())?)?;
    atomic_write(
        &root.join("config.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    eprintln!("Chatterbox configured. Install its model with delulu install-model --engine chatterbox if absent.");
    Ok(())
}

pub fn install_model(root: &Path) -> Result<()> {
    let _lock = lock(root)?;
    let config = read_config(root)?;
    let mut staged = tempfile::NamedTempFile::new_in(root)?;
    staged.write_all(&serde_json::to_vec_pretty(&config)?)?;
    eprintln!(
        "Installing optional Chatterbox Turbo model (~3 GB download); cached files are reused..."
    );
    run(
        &mut python(&config, root, "install", staged.path()),
        "Turbo model installation",
    )?;
    let config: Config = serde_json::from_slice(&fs::read(staged.path())?)?;
    if !ready(&config) {
        bail!("Turbo model snapshot is incomplete; retry delulu install-model --engine chatterbox");
    }
    atomic_write(
        &root.join("config.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    eprintln!("Turbo model installed. Use it with delulu speak --engine chatterbox.");
    Ok(())
}

pub fn speak(
    root: &Path,
    text: &str,
    output: Option<PathBuf>,
    volume: f32,
    bundled_voice: bool,
) -> Result<()> {
    let mut config = read_config(root)?;
    if !ready(&config) {
        bail!("The Chatterbox Turbo model is not installed; run delulu install-model --engine chatterbox");
    }
    let _lock = lock(root)?;
    let job = tempfile::tempdir_in(root)?;
    let input = job.path().join("text.txt");
    let wav = job.path().join("speech.wav");
    fs::write(&input, text)?;
    let mut config_path = root.join("config.json");
    if bundled_voice && config.reference.is_some() {
        // A private copy without the reference; the saved configuration is untouched.
        let bundled = Config {
            reference: None,
            ..config
        };
        config_path = job.path().join("config.json");
        fs::write(&config_path, serde_json::to_vec_pretty(&bundled)?)?;
        config = bundled;
    }
    run(
        python(&config, root, "speak", &config_path)
            .arg(input)
            .arg(&wav),
        "Turbo synthesis",
    )?;
    check_cancel()?;
    if let Some(output) = output {
        // No playback on this explicit path, suitable for silent verification.
        let bytes = fs::read(&wav)?;
        atomic_write(&absolute(&output)?, &bytes)?;
        println!("{}", output.display());
    } else {
        run(
            Command::new("pw-play")
                .arg("--volume")
                .arg(volume.to_string())
                .arg(&wav),
            "audio playback (requires PipeWire pw-play)",
        )?;
    }
    Ok(())
}
