//! Linux on-demand speech CLI, independent of the desktop app.
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, IsTerminal, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicI32, Ordering},
    time::{Duration, Instant},
};

const RUNTIME: &str = include_str!("runtime.py");
const SKILL: &str = include_str!("../../../skills/delulu-speak/SKILL.md");
static SIGNAL: AtomicI32 = AtomicI32::new(0);
extern "C" fn cancelled(signal: i32) {
    SIGNAL.store(signal, Ordering::Relaxed);
}

#[derive(Parser)]
#[command(
    name = "delulu",
    version,
    about = "On-demand spoken replies for Delulu Talks (Linux)"
)]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Install binary, config and agent skills; reuse cached weights without downloading models.
    Setup {
        /// Existing Python with torch and chatterbox.tts_turbo (never modified).
        #[arg(long)]
        python: Option<PathBuf>,
        #[arg(long, value_parser = ["cuda", "cpu"])]
        device: Option<String>,
        /// Explicit voice reference (>5 seconds); defaults to bundled speaker on first setup.
        #[arg(long)]
        reference: Option<PathBuf>,
        /// Reset a previously configured reference to the official bundled speaker.
        #[arg(long, conflicts_with = "reference")]
        default_voice: bool,
    },
    /// Explicitly download the optional official Turbo model (~3 GB), or reuse its cache.
    InstallModel,
    /// Speak arguments, or read UTF-8 text from stdin when arguments are omitted (or '-').
    Speak {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        text: Vec<String>,
        /// Save a WAV silently instead of playing it. Also useful for headless harnesses.
        #[arg(long)]
        output: Option<PathBuf>,
        /// Playback stream volume (0 = silent); never changes system volume.
        #[arg(long, default_value = "1")]
        volume: f32,
    },
    /// Print setup readiness as JSON without loading Python or a model.
    Status,
}
#[derive(Serialize, Deserialize)]
struct Config {
    python: PathBuf,
    device: String,
    reference: Option<PathBuf>,
    #[serde(default)]
    model_dir: PathBuf,
    #[serde(default)]
    revision: Option<String>,
}
fn home() -> Result<PathBuf> {
    dirs::home_dir().context("Cannot locate home directory")
}
fn root() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .context("Cannot locate user data directory")?
        .join("delulu-talks/voice"))
}
fn check_cancel() -> Result<()> {
    if SIGNAL.load(Ordering::Relaxed) != 0 {
        bail!("Speech cancelled");
    }
    Ok(())
}
// flock stays held across the whole invocation, including playback; only owned jobs queue.
fn lock(root: &Path) -> Result<File> {
    fs::create_dir_all(root)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("job.lock"))?;
    let start = Instant::now();
    loop {
        check_cancel()?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(error.into());
        }
        if start.elapsed() > Duration::from_secs(600) {
            bail!("Another Delulu speech job is still busy; retry later");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn run(command: &mut Command, label: &str) -> Result<()> {
    check_cancel()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(io::stderr()))
        .stderr(Stdio::inherit());
    // Separate group lets cancellation kill descendants, too. SIGKILL of the
    // coordinator also kills its immediate child (Linux parent-death signal).
    let parent = std::process::id() as i32;
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::_exit(130);
            }
            Ok(())
        });
    }
    let mut child = command.spawn().with_context(|| {
        format!("Cannot start {label}; check dependencies and run delulu setup")
    })?;
    let start = Instant::now();
    loop {
        if SIGNAL.load(Ordering::Relaxed) != 0 || start.elapsed() > Duration::from_secs(1800) {
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            check_cancel()?;
            bail!("{label} exceeded 30 minutes and was stopped");
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("{label} failed ({status}); see diagnostic above");
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Path needs a parent directory")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
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
fn read_config(root: &Path) -> Result<Config> {
    serde_json::from_slice(
        &fs::read(root.join("config.json"))
            .context("Speech is not configured. Run delulu setup first")?,
    )
    .context("Invalid speech configuration; rerun delulu setup")
}
fn ready(config: &Config) -> bool {
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
fn setup(
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
        .unwrap_or(
            home()?.join(".local/share/ai-director/chatterbox_flash_local/.venv/bin/python"),
        );
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
        python: python_path_absolute(&python_path)?,
        device,
        reference,
        model_dir: PathBuf::new(),
        revision: old.and_then(|c| c.revision),
    };
    // Preserve venv executable path: resolving its symlink would lose site-packages.
    let mut staged = tempfile::NamedTempFile::new_in(root)?;
    staged.write_all(&serde_json::to_vec_pretty(&config)?)?;
    eprintln!("Checking dependencies and reusing cached Turbo weights only (no model download)...");
    run(
        &mut python(&config, root, "setup", staged.path()),
        "Turbo setup",
    )?;
    let config: Config = serde_json::from_slice(&fs::read(staged.path())?)?;
    let bin = home()?.join(".local/bin/delulu");
    let current = std::env::current_exe()?;
    if current != bin {
        let mut temp = tempfile::NamedTempFile::new_in({
            fs::create_dir_all(bin.parent().unwrap())?;
            bin.parent().unwrap()
        })?;
        io::copy(&mut File::open(current)?, &mut temp)?;
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o755))?;
        temp.persist(&bin).map_err(|e| e.error)?;
    }
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".codex"));
    let mut skill_roots = vec![codex.join("skills")];
    // Other installed harnesses follow their established skill directories.
    for dir in [
        home()?.join(".claude/skills"),
        home()?.join(".agents/skills"),
    ] {
        if dir.is_dir() && !skill_roots.contains(&dir) {
            skill_roots.push(dir);
        }
    }
    let previous_skill =
        fs::read_to_string(root.join("installed-skill.md")).unwrap_or_else(|_| SKILL.to_string());
    for dir in skill_roots {
        let path = dir.join("delulu-speak/SKILL.md");
        if path.exists()
            && fs::read_to_string(&path)? != SKILL
            && fs::read_to_string(&path)? != previous_skill
        {
            bail!("Preserving customized skill at {}; reconcile it with skills/delulu-speak/SKILL.md before retrying", path.display());
        }
        atomic_write(&path, SKILL.as_bytes())?;
        eprintln!("Skill: {}", path.display());
    }
    atomic_write(&root.join("installed-skill.md"), SKILL.as_bytes())?;
    atomic_write(
        &root.join("config.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    eprintln!("CLI installed: {} speak 'Done. The change is ready.'\nEnsure ~/.local/bin is on PATH. Install the optional model with delulu install-model if absent. No model stays resident.", bin.display());
    Ok(())
}
fn python_path_absolute(path: &Path) -> Result<PathBuf> {
    Ok(if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    })
}
fn install_model(root: &Path) -> Result<()> {
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
        bail!("Turbo model snapshot is incomplete; retry delulu install-model");
    }
    atomic_write(
        &root.join("config.json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    eprintln!("Turbo model installed. Ready for delulu speak.");
    Ok(())
}
fn read_stdin() -> Result<String> {
    let mut bytes = Vec::new();
    loop {
        check_cancel()?;
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut fd, 1, 100) };
        if result < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io::Error::last_os_error().into());
        }
        if result == 0 {
            continue;
        }
        let mut buf = [0u8; 4096];
        let count = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
        if count < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io::Error::last_os_error().into());
        }
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..count as usize]);
        if bytes.len() > 16000 {
            bail!("Reply exceeds 16000 bytes; summarize it before speaking");
        }
    }
    String::from_utf8(bytes).context("stdin must contain UTF-8 text")
}
fn speak(root: &Path, words: Vec<String>, output: Option<PathBuf>, volume: f32) -> Result<()> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        bail!("Volume must be between 0 and 1");
    }
    let text = if words.is_empty() || words == ["-"] {
        if io::stdin().is_terminal() {
            bail!("Provide text: delulu speak 'Done.' or pipe text into delulu speak");
        }
        read_stdin()?
    } else {
        words.join(" ")
    };
    if text.trim().is_empty() {
        bail!("No text to speak");
    }
    if text.len() > 16000 {
        bail!("Reply exceeds 16000 bytes; summarize it before speaking");
    }
    let config = read_config(root)?;
    if !ready(&config) {
        bail!("Optional Turbo model is not installed; run delulu install-model or use Install model in Settings");
    }
    let _lock = lock(root)?;
    let job = tempfile::tempdir_in(root)?;
    let input = job.path().join("text.txt");
    let wav = job.path().join("speech.wav");
    fs::write(&input, text)?;
    run(
        python(&config, root, "speak", &root.join("config.json"))
            .arg(input)
            .arg(&wav),
        "Turbo synthesis",
    )?;
    if let Some(output) = output {
        // No playback on this explicit path, suitable for silent verification.
        let bytes = fs::read(&wav)?;
        atomic_write(&python_path_absolute(&output)?, &bytes)?;
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
fn main() {
    unsafe {
        libc::signal(libc::SIGINT, cancelled as *const () as usize);
        libc::signal(libc::SIGTERM, cancelled as *const () as usize);
    }
    let cli = Cli::parse();
    let result = root().and_then(|root| match cli.command {
        Action::Setup {
            python,
            device,
            reference,
            default_voice,
        } => setup(&root, python, device, reference, default_voice),
        Action::InstallModel => install_model(&root),
        Action::Speak {
            text,
            output,
            volume,
        } => speak(&root, text, output, volume),
        Action::Status => {
            let config = read_config(&root).ok();
            println!(
                "{}",
                serde_json::json!({"ready": config.as_ref().is_some_and(ready), "configured": config.is_some()})
            );
            Ok(())
        }
    });
    if let Err(error) = result {
        eprintln!("delulu: {error:#}");
        let signal = SIGNAL.load(Ordering::Relaxed);
        std::process::exit(if signal == 0 { 1 } else { 128 + signal });
    }
}
