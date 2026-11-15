//! Linux on-demand speech CLI, independent of the desktop app.
//!
//! The default voice is native: Supertonic 3 in `delulu-engine tts`, on the CPU, in
//! Dutch and English, with no Python. Chatterbox Turbo stays as an explicit opt-in
//! (`--engine chatterbox`) for an existing Python setup.
mod chatterbox;
mod native;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, IsTerminal, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicI32, Ordering},
    time::{Duration, Instant},
};

const SKILL: &str = include_str!("../../../skills/delulu-speak/SKILL.md");
/// Longest reply `speak` accepts, in bytes.
const MAX_TEXT_BYTES: usize = 16000;
pub(crate) static SIGNAL: AtomicI32 = AtomicI32::new(0);
/// When this process started, for `DELULU_TIMINGS`.
pub(crate) static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
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

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Engine {
    /// Supertonic 3 on the CPU, Dutch and English, no Python (default).
    Native,
    /// Chatterbox Turbo in an existing Python environment (English only).
    Chatterbox,
}

#[derive(Subcommand)]
enum Action {
    /// Install the binary and the agent skill. Downloads no model and needs no Python.
    /// The Chatterbox options configure the optional `--engine chatterbox` voice.
    Setup {
        /// Chatterbox only: an existing Python with torch and chatterbox.tts_turbo (never modified).
        #[arg(long)]
        python: Option<PathBuf>,
        /// Chatterbox only.
        #[arg(long, value_parser = ["cuda", "cpu"])]
        device: Option<String>,
        /// Chatterbox only: a voice reference (>5 seconds).
        #[arg(long)]
        reference: Option<PathBuf>,
        /// Chatterbox only: reset a configured reference to the bundled speaker.
        #[arg(long, conflicts_with = "reference")]
        default_voice: bool,
    },
    /// Download the voice model (Supertonic 3, about 400 MB) after showing its licence.
    InstallModel {
        #[arg(long, value_enum, default_value = "native")]
        engine: Engine,
    },
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
        /// Voice: F1–F5 or M1–M5 (default: the one chosen in Settings, else F1).
        #[arg(long)]
        voice: Option<String>,
        /// Language: auto (per sentence), nl or en.
        #[arg(long, default_value = "auto")]
        lang: String,
        #[arg(long, value_enum, default_value = "native")]
        engine: Engine,
        /// Chatterbox only: use its bundled speaker, ignoring a configured reference.
        #[arg(long)]
        bundled_voice: bool,
    },
    /// Print readiness as JSON without loading a model.
    Status,
}

pub(crate) fn home() -> Result<PathBuf> {
    dirs::home_dir().context("Cannot locate home directory")
}

fn root() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .context("Cannot locate user data directory")?
        .join("delulu-talks/voice"))
}

pub(crate) fn signalled() -> bool {
    SIGNAL.load(Ordering::Relaxed) != 0
}

pub(crate) fn check_cancel() -> Result<()> {
    if signalled() {
        bail!("Speech cancelled");
    }
    Ok(())
}

/// One speech job per user at a time: the flock stays held for the whole invocation,
/// including playback, and later jobs queue behind it.
pub(crate) fn lock(root: &Path) -> Result<File> {
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

/// Runs a helper in its own process group, so cancellation kills its descendants too.
pub(crate) fn run(command: &mut Command, label: &str) -> Result<()> {
    check_cancel()?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(io::stderr()))
        .stderr(Stdio::inherit());
    // SIGKILL of the coordinator also kills its immediate child (parent-death signal).
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
        if signalled() || start.elapsed() > Duration::from_secs(1800) {
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

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Path needs a parent directory")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

pub(crate) fn absolute(path: &Path) -> Result<PathBuf> {
    Ok(if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    })
}

/// Installs this binary as ~/.local/bin/delulu and the agent skill.
fn install_cli(root: &Path) -> Result<()> {
    let _lock = lock(root)?;
    let bin = home()?.join(".local/bin/delulu");
    let current = std::env::current_exe()?;
    if current != bin {
        let dir = bin.parent().expect("has a parent");
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
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
            bail!(
                "Preserving customized skill at {}; reconcile it with skills/delulu-speak/SKILL.md before retrying",
                path.display()
            );
        }
        atomic_write(&path, SKILL.as_bytes())?;
        eprintln!("Skill: {}", path.display());
    }
    atomic_write(&root.join("installed-skill.md"), SKILL.as_bytes())?;
    let model = if native::readiness().model {
        "The voice model is installed."
    } else {
        "Download the voice model with delulu install-model (about 400 MB)."
    };
    eprintln!(
        "CLI installed: {} speak 'Done. The change is ready.'\nEnsure ~/.local/bin is on PATH. {model}",
        bin.display()
    );
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
        if bytes.len() > MAX_TEXT_BYTES {
            bail!("Reply exceeds {MAX_TEXT_BYTES} bytes; summarize it before speaking");
        }
    }
    String::from_utf8(bytes).context("stdin must contain UTF-8 text")
}

fn text_of(words: Vec<String>) -> Result<String> {
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
    if text.len() > MAX_TEXT_BYTES {
        bail!("Reply exceeds {MAX_TEXT_BYTES} bytes; summarize it before speaking");
    }
    Ok(text)
}

fn status(root: &Path) -> serde_json::Value {
    let native = native::readiness();
    let settings = native::Settings::load(root);
    let chatterbox = chatterbox::read_config(root).ok();
    serde_json::json!({
        // The default (native) voice can speak now.
        "ready": native.model && native.engine.is_some(),
        // Nothing needs configuring for the native voice beyond its engine.
        "configured": native.engine.is_some(),
        "engine": "native",
        "model": native.model,
        "modelId": native::MODEL.id,
        "modelBytes": native::MODEL.bytes,
        "engineBinary": native.engine,
        "resident": native::resident(),
        "voice": settings.voice,
        "radioVoice": settings.radio_voice,
        "steps": settings.steps,
        "voices": delulu_models::SUPERTONIC_VOICES,
        "chatterbox": {
            "configured": chatterbox.is_some(),
            "ready": chatterbox.as_ref().is_some_and(chatterbox::ready),
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn speak(
    root: &Path,
    words: Vec<String>,
    output: Option<PathBuf>,
    volume: f32,
    voice: Option<String>,
    lang: String,
    engine: Engine,
    bundled_voice: bool,
) -> Result<()> {
    if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
        bail!("Volume must be between 0 and 1");
    }
    if !["auto", "nl", "en"].contains(&lang.to_lowercase().as_str()) {
        bail!("Language must be auto, nl or en");
    }
    let voice = match voice {
        Some(v) => Some(native::voice_name(&v).with_context(|| {
            format!(
                "Unknown voice {v}; choose one of {}",
                delulu_models::SUPERTONIC_VOICES.join(", ")
            )
        })?),
        None => None,
    };
    let text = text_of(words)?;
    match engine {
        Engine::Chatterbox => chatterbox::speak(root, &text, output, volume, bundled_voice),
        Engine::Native => {
            let voice = voice.unwrap_or_else(|| native::Settings::load(root).voice);
            native::speak(
                root,
                native::Request {
                    text: &text,
                    voice,
                    lang: lang.to_lowercase(),
                    output,
                    volume,
                },
            )
        }
    }
}

fn main() {
    STARTED.get_or_init(Instant::now);
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
        } => {
            install_cli(&root)?;
            if python.is_some() || device.is_some() || reference.is_some() || default_voice {
                chatterbox::setup(&root, python, device, reference, default_voice)?;
            }
            Ok(())
        }
        Action::InstallModel {
            engine: Engine::Native,
        } => native::install_model(&root),
        Action::InstallModel {
            engine: Engine::Chatterbox,
        } => chatterbox::install_model(&root),
        Action::Speak {
            text,
            output,
            volume,
            voice,
            lang,
            engine,
            bundled_voice,
        } => speak(
            &root,
            text,
            output,
            volume,
            voice,
            lang,
            engine,
            bundled_voice,
        ),
        Action::Status => {
            println!("{}", status(&root));
            Ok(())
        }
    });
    if let Err(error) = result {
        eprintln!("delulu: {error:#}");
        let signal = SIGNAL.load(Ordering::Relaxed);
        std::process::exit(if signal == 0 { 1 } else { 128 + signal });
    }
}
