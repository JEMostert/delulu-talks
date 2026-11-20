//! The native voice: Supertonic 3 in `delulu-engine tts`, spoken to over the worker
//! protocol. A resident engine (its socket in `$XDG_RUNTIME_DIR`) answers warm; the
//! first reply starts one that stays for `keepWarmSeconds` after its last reply, or,
//! with that set to 0, a one-shot engine that exits with the reply.
use crate::{absolute, atomic_write, check_cancel, lock, signalled, SIGNAL, STARTED};
use anyhow::{anyhow, bail, Context, Result};
use delulu_models::{Model, SUPERTONIC_3};
use delulu_proto::worker::{
    AudioHeader, FromWorker, JobPayload, Lane, ModelRef, Role, ToWorker, WorkerErrorKind,
    WORKER_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::sync::mpsc;
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        fd::{AsRawFd, RawFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MODEL: &Model = &SUPERTONIC_3;
const ENGINE_NAME: &str = "delulu-engine";
/// A reply that takes longer than this is stopped.
const JOB_LIMIT: Duration = Duration::from_secs(30 * 60);
/// How long a new resident engine may take to load before falling back to one-shot.
const RESIDENT_START: Duration = Duration::from_secs(20);
const JOB_ID: u64 = 1;
/// Denoising steps, as in delulu-tts: 8 by default, at most 32.
const DEFAULT_STEPS: u32 = 8;
const MAX_STEPS: u32 = 32;

/// `voice/settings.json`, written by the app's Settings and read on every reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Agents' replies.
    pub voice: String,
    /// Delulu FM's host.
    pub radio_voice: String,
    /// Denoising steps: 8 is the quality default, 4 about twice as fast.
    pub steps: u32,
    /// How long a resident engine stays loaded after a reply; 0 = one-shot.
    pub keep_warm_seconds: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            voice: delulu_models::DEFAULT_AGENT_VOICE.into(),
            radio_voice: delulu_models::DEFAULT_RADIO_VOICE.into(),
            steps: DEFAULT_STEPS,
            keep_warm_seconds: 300,
        }
    }
}

impl Settings {
    /// Unknown voices and out-of-range values fall back to the defaults.
    pub fn load(root: &Path) -> Settings {
        let mut s: Settings = fs::read(root.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let d = Settings::default();
        s.voice = voice_name(&s.voice).unwrap_or(d.voice);
        s.radio_voice = voice_name(&s.radio_voice).unwrap_or(d.radio_voice);
        if !(1..=MAX_STEPS).contains(&s.steps) {
            s.steps = d.steps;
        }
        s.keep_warm_seconds = s.keep_warm_seconds.min(24 * 3600);
        s
    }
}

/// `f1` → `F1`; None for a name the model does not have.
pub fn voice_name(name: &str) -> Option<String> {
    let upper = name.trim().to_uppercase();
    delulu_models::supertonic_voice(&upper)
}

pub fn models_dir() -> Result<PathBuf> {
    Ok(dirs::data_dir()
        .context("Cannot locate user data directory")?
        .join("delulu-talks/models"))
}

/// `$DELULU_ENGINE`, next to this binary, then the packaged location.
pub fn engine_path() -> Option<PathBuf> {
    let from_env = std::env::var_os("DELULU_ENGINE").map(PathBuf::from);
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(ENGINE_NAME)));
    let system = Some(Path::new("/usr/lib/delulu-talks").join(ENGINE_NAME));
    [from_env, sibling, system]
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
}

pub fn socket_path() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|d| !d.is_empty())
        .map(|d| delulu_proto::socket_path(Path::new(&d)).with_file_name("tts.sock"))
}

/// A resident engine answers on the socket.
pub fn resident() -> bool {
    socket_path().is_some_and(|s| UnixStream::connect(s).is_ok())
}

pub struct Readiness {
    pub model: bool,
    pub engine: Option<PathBuf>,
}

pub fn readiness() -> Readiness {
    Readiness {
        model: models_dir().is_ok_and(|d| MODEL.installed(&d)),
        engine: engine_path(),
    }
}

pub fn install_model(root: &Path) -> Result<()> {
    let terms = MODEL.terms.expect("Supertonic has terms");
    eprintln!(
        "{} ({:.0} MB) — {}\nLicence: {} ({})\n\n{}\n",
        MODEL.label,
        MODEL.bytes as f64 / 1e6,
        terms.credit,
        terms.name,
        terms.url,
        terms.text
    );
    let _lock = lock(root)?;
    let dir = models_dir()?;
    if MODEL.installed(&dir) {
        eprintln!(
            "The voice model is already installed in {}.",
            dir.join(MODEL.path).display()
        );
        return Ok(());
    }
    fs::create_dir_all(&dir)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (cancel, done) = (cancel.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                if SIGNAL.load(Ordering::Relaxed) != 0 {
                    cancel.store(true, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    let terminal = io::IsTerminal::is_terminal(&io::stderr());
    let mut last_step = u64::MAX;
    let result = delulu_models::download(
        &dir,
        MODEL,
        &mut |done_bytes, total| {
            let percent = done_bytes * 100 / total.max(1);
            let step = if terminal { percent } else { percent / 10 };
            if step != last_step {
                last_step = step;
                let text = format!(
                    "Downloading {}: {percent}% of {:.0} MB",
                    MODEL.label,
                    total as f64 / 1e6
                );
                if terminal {
                    eprint!("\r{text}");
                } else {
                    eprintln!("{text}");
                }
            }
        },
        &cancel,
    );
    done.store(true, Ordering::Relaxed);
    let _ = watcher.join();
    if terminal {
        eprintln!();
    }
    match result {
        Ok(()) => {
            eprintln!(
                "Voice model installed in {}. Ready for delulu speak.",
                dir.join(MODEL.path).display()
            );
            Ok(())
        }
        Err(delulu_models::Error::Cancelled) => {
            check_cancel()?;
            bail!("Download cancelled; run delulu install-model again to continue")
        }
        Err(e) => Err(anyhow!(
            "Voice model download failed: {e}. Run delulu install-model again to continue"
        )),
    }
}

pub struct Request<'a> {
    pub text: &'a str,
    pub voice: String,
    /// `auto`, `nl` or `en`.
    pub lang: String,
    pub output: Option<PathBuf>,
    pub volume: f32,
}

pub fn speak(root: &Path, req: Request) -> Result<()> {
    let dir = models_dir()?;
    if !MODEL.installed(&dir) {
        bail!("The voice model is not installed. Run delulu install-model, or use Install model in Delulu Talks → Settings → Voice replies");
    }
    let engine = engine_path().context(
        "The Delulu engine (delulu-engine) is not installed. Reinstall Delulu Talks, or set DELULU_ENGINE to its path",
    )?;
    let settings = Settings::load(root);
    let _lock = lock(root)?;
    let model = ModelRef {
        id: MODEL.id.into(),
        path: dir.join(MODEL.path).to_string_lossy().into_owned(),
        extra: [(
            "lexicon".to_string(),
            root.join("lexicon-nl.tsv").to_string_lossy().into_owned(),
        )]
        .into(),
    };
    let mut conn = Connection::open(&engine, &model, &settings)?;
    let result = conn.speak(&model, &req, settings.steps);
    let (mode, first_audio) = (conn.mode, conn.first_audio);
    conn.close();
    // DELULU_TIMINGS=1: one JSON line on stderr, for measuring cold and warm starts.
    if std::env::var_os("DELULU_TIMINGS").is_some() {
        let since = |t: Instant| STARTED.get().map(|s| t.duration_since(*s).as_millis());
        eprintln!(
            "{}",
            serde_json::json!({
                "engine": mode,
                "firstAudioMs": first_audio.and_then(since),
                "totalMs": since(Instant::now()),
            })
        );
    }
    let audio = result?;
    if let Some(output) = &req.output {
        let (samples, rate) = match audio {
            Sink::Collect { samples, rate } => (samples, rate),
            Sink::Play(_) => unreachable!("output collects"),
        };
        atomic_write(&absolute(output)?, &wav_bytes(&samples, rate))?;
        println!("{}", output.display());
    } else if let Sink::Play(Some(player)) = audio {
        player.finish()?;
    }
    Ok(())
}

/// Reads with a 100 ms poll, so a signal or the job limit interrupts a blocking read.
struct PollRead {
    fd: RawFd,
    inner: Box<dyn Read + Send>,
    deadline: Instant,
}

impl Read for PollRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // Not `Interrupted`: buffered readers retry that kind forever.
            if signalled() {
                return Err(io::Error::other("cancelled"));
            }
            if Instant::now() > self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "speech took longer than 30 minutes",
                ));
            }
            let mut fd = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd for an fd this struct owns through `inner`.
            let ready = unsafe { libc::poll(&mut fd, 1, 100) };
            if ready > 0 {
                return self.inner.read(buf);
            }
            if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(io::Error::last_os_error());
            }
        }
    }
}

struct Connection {
    reader: BufReader<PollRead>,
    writer: Box<dyn Write + Send>,
    /// A one-shot engine, killed with its process group when the reply ends.
    child: Option<Child>,
    stderr: Option<std::thread::JoinHandle<String>>,
    /// "resident", "started-resident" or "one-shot".
    mode: &'static str,
    /// When the first audio arrived.
    first_audio: Option<Instant>,
}

fn spawn_resident(
    engine: &Path,
    socket: &Path,
    model: &ModelRef,
    settings: &Settings,
) -> Option<UnixStream> {
    let mut command = Command::new(engine);
    command
        .args(["tts", "--listen"])
        .arg(socket)
        .arg("--model-dir")
        .arg(&model.path)
        .arg("--idle-exit")
        .arg(settings.keep_warm_seconds.to_string())
        .arg("--steps")
        .arg(settings.steps.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(lexicon) = model.extra.get("lexicon") {
        command.arg("--lexicon").arg(lexicon);
    }
    // Its own session: it outlives this reply and ignores this terminal's Ctrl-C.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    while started.elapsed() < RESIDENT_START && !signalled() {
        if let Ok(stream) = UnixStream::connect(socket) {
            return Some(stream);
        }
        if child.try_wait().ok().flatten().is_some() {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

impl Connection {
    fn open(engine: &Path, model: &ModelRef, settings: &Settings) -> Result<Connection> {
        let deadline = Instant::now() + JOB_LIMIT;
        let socket = socket_path();
        // keepWarmSeconds 0 means a fresh engine per reply, even while an earlier
        // resident engine is still running out its idle time.
        let warm = settings.keep_warm_seconds > 0;
        let mut stream = socket
            .as_deref()
            .filter(|_| warm)
            .and_then(|s| UnixStream::connect(s).ok());
        let mut mode = "resident";
        if stream.is_none() && warm {
            if let Some(socket) = &socket {
                stream = spawn_resident(engine, socket, model, settings);
                mode = "started-resident";
            }
        }
        check_cancel()?;
        if let Some(stream) = stream {
            let fd = stream.as_raw_fd();
            let writer = stream.try_clone()?;
            return Ok(Connection {
                reader: BufReader::new(PollRead {
                    fd,
                    inner: Box::new(stream),
                    deadline,
                }),
                writer: Box::new(writer),
                child: None,
                stderr: None,
                mode,
                first_audio: None,
            });
        }
        // One-shot: the engine is our child and dies with us.
        let mut command = Command::new(engine);
        command
            .args(["tts", "--steps"])
            .arg(settings.steps.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let parent = std::process::id() as i32;
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::_exit(130);
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("Cannot start {}", engine.display()))?;
        let stdout = child.stdout.take().expect("piped");
        let stdin = child.stdin.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let stderr = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        Ok(Connection {
            reader: BufReader::new(PollRead {
                fd: stdout.as_raw_fd(),
                inner: Box::new(stdout),
                deadline,
            }),
            writer: Box::new(stdin),
            child: Some(child),
            stderr: Some(stderr),
            mode: "one-shot",
            first_audio: None,
        })
    }

    fn send(&mut self, message: &ToWorker) -> Result<()> {
        let line = serde_json::to_string(message)?;
        writeln!(self.writer, "{line}")
            .and_then(|()| self.writer.flush())
            .map_err(|e| self.lost(e))
    }

    /// The engine went away: its last log line says why, when it had one.
    fn lost(&mut self, error: io::Error) -> anyhow::Error {
        if signalled() {
            return anyhow!("Speech cancelled");
        }
        if let Some(child) = self.child.as_mut() {
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
        let detail = self
            .stderr
            .take()
            .and_then(|h| h.join().ok())
            .and_then(|s| {
                s.lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .map(str::to_string)
            });
        match detail {
            Some(line) => anyhow!("The voice engine stopped: {line}"),
            None => anyhow!("The voice engine stopped: {error}"),
        }
    }

    fn receive(&mut self) -> Result<(FromWorker, Vec<f32>)> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => {
                return Err(self.lost(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed",
                )))
            }
            Ok(_) => {}
            Err(e) => return Err(self.lost(e)),
        }
        let message: FromWorker = serde_json::from_str(&line)
            .map_err(|e| anyhow!("Unreadable reply from the voice engine: {e}"))?;
        let mut samples = Vec::new();
        if let FromWorker::Audio(AudioHeader { bytes, .. }) = &message {
            let mut raw = vec![0u8; *bytes as usize];
            if let Err(e) = self.reader.read_exact(&mut raw) {
                return Err(self.lost(e));
            }
            samples = raw
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect();
        }
        Ok((message, samples))
    }

    fn expect(&mut self, what: &str) -> Result<FromWorker> {
        match self.receive()?.0 {
            FromWorker::Error { message, kind, .. } => {
                if kind == WorkerErrorKind::LoadFailed {
                    bail!("The voice model could not be loaded: {message}. Run delulu install-model to repair it")
                }
                bail!("The voice engine refused {what}: {message}")
            }
            other => Ok(other),
        }
    }

    fn speak(&mut self, model: &ModelRef, req: &Request, steps: u32) -> Result<Sink> {
        self.send(&ToWorker::Hello {
            role: Role::Tts,
            protocol: WORKER_PROTOCOL_VERSION,
        })?;
        self.expect("the connection")?;
        self.send(&ToWorker::Load {
            model: model.clone(),
            opts: Default::default(),
        })?;
        while !matches!(self.expect("the model")?, FromWorker::Loaded { .. }) {}
        self.send(&ToWorker::Job {
            id: JOB_ID,
            lane: Lane::Report,
            payload: JobPayload::Speak {
                text: req.text.to_string(),
                voice: Some(req.voice.clone()),
                language: Some(req.lang.clone()),
                steps: Some(steps),
            },
        })?;
        let mut sink = if req.output.is_some() {
            Sink::Collect {
                samples: Vec::new(),
                rate: 0,
            }
        } else {
            Sink::Play(None)
        };
        let outcome = (|| -> Result<()> {
            loop {
                match self.receive()? {
                    (FromWorker::Audio(h), samples) if h.id == JOB_ID => {
                        if !samples.is_empty() && self.first_audio.is_none() {
                            self.first_audio = Some(Instant::now());
                        }
                        sink.push(&samples, h.rate, req.volume)?
                    }
                    (FromWorker::Done { id: JOB_ID, .. }, _) => return Ok(()),
                    (
                        FromWorker::Error {
                            id: Some(JOB_ID),
                            kind: WorkerErrorKind::Cancelled,
                            ..
                        },
                        _,
                    ) => {
                        check_cancel()?;
                        bail!("Speech cancelled by the voice engine")
                    }
                    (
                        FromWorker::Error {
                            id: Some(JOB_ID),
                            message,
                            ..
                        },
                        _,
                    ) => bail!("Speech failed: {message}"),
                    _ => {}
                }
            }
        })();
        if let Err(e) = outcome {
            // Stop the engine's work, then the player.
            let _ = self.send(&ToWorker::Cancel { id: JOB_ID });
            if let Sink::Play(Some(player)) = sink {
                player.kill();
            }
            return Err(e);
        }
        Ok(sink)
    }

    fn close(mut self) {
        if let Some(mut child) = self.child.take() {
            if signalled() {
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                return;
            }
            let _ = self.send(&ToWorker::Shutdown);
            drop(self.writer);
            // A clean exit takes milliseconds; never wait long for it.
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2) {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
    }
}

enum Sink {
    Collect { samples: Vec<f32>, rate: u32 },
    Play(Option<Player>),
}

impl Sink {
    fn push(&mut self, samples: &[f32], rate: u32, volume: f32) -> Result<()> {
        match self {
            Sink::Collect {
                samples: all,
                rate: r,
            } => {
                *r = rate;
                all.extend_from_slice(samples);
            }
            Sink::Play(player) => {
                if samples.is_empty() {
                    return Ok(());
                }
                if player.is_none() {
                    *player = Some(Player::start(rate, volume)?);
                }
                player.as_mut().expect("started").write(samples)?;
            }
        }
        Ok(())
    }
}

/// `pw-play` reading raw f32 from a pipe. A thread feeds it, so playback never stops
/// the next sentence from arriving.
#[cfg(target_os = "linux")]
struct Player {
    child: Child,
    feed: Option<mpsc::Sender<Vec<u8>>>,
    writer: Option<std::thread::JoinHandle<io::Result<()>>>,
}

#[cfg(target_os = "linux")]
impl Player {
    fn start(rate: u32, volume: f32) -> Result<Player> {
        let mut command = Command::new("pw-play");
        command
            .args(["--raw", "--format", "f32", "--channels", "1", "--rate"])
            .arg(rate.to_string())
            .arg("--volume")
            .arg(volume.to_string())
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .context("Cannot start audio playback (requires PipeWire pw-play)")?;
        let mut stdin = child.stdin.take().expect("piped");
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let writer = std::thread::spawn(move || {
            for bytes in rx {
                stdin.write_all(&bytes)?;
            }
            Ok(())
        });
        Ok(Player {
            child,
            feed: Some(tx),
            writer: Some(writer),
        })
    }

    fn write(&mut self, samples: &[f32]) -> Result<()> {
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.feed
            .as_ref()
            .and_then(|f| f.send(bytes).ok())
            .context("Audio playback stopped (pw-play)")
    }

    /// Waits until everything was played, or a signal stops it.
    fn finish(mut self) -> Result<()> {
        drop(self.feed.take());
        loop {
            if signalled() {
                self.kill();
                return check_cancel();
            }
            if let Some(status) = self.child.try_wait()? {
                if let Some(Err(e)) = self.writer.take().map(|w| w.join().unwrap_or(Ok(()))) {
                    bail!("Audio playback failed: {e}");
                }
                if !status.success() {
                    bail!("Audio playback failed ({status}); see the diagnostic above");
                }
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn kill(mut self) {
        drop(self.feed.take());
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

// afplay consumes a complete WAV. Keep the file private and use the shared
// cancellable process runner for playback.
#[cfg(target_os = "macos")]
struct Player {
    samples: Vec<f32>,
    rate: u32,
    volume: f32,
}
#[cfg(target_os = "macos")]
impl Player {
    fn start(rate: u32, volume: f32) -> Result<Self> {
        Ok(Self {
            samples: Vec::new(),
            rate,
            volume,
        })
    }
    fn write(&mut self, samples: &[f32]) -> Result<()> {
        self.samples.extend_from_slice(samples);
        Ok(())
    }
    fn finish(self) -> Result<()> {
        let mut wav = tempfile::Builder::new().suffix(".wav").tempfile()?;
        wav.write_all(&wav_bytes(&self.samples, self.rate))?;
        crate::run(
            Command::new("/usr/bin/afplay")
                .arg("-v")
                .arg(self.volume.to_string())
                .arg(wav.path()),
            "audio playback",
        )
    }
    fn kill(self) {}
}

/// Mono 16-bit PCM WAV.
pub fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_fall_back_per_field() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(dir.path()), Settings::default());
        fs::write(
            dir.path().join("settings.json"),
            r#"{"voice":"m3","radioVoice":"Z9","steps":99}"#,
        )
        .unwrap();
        let s = Settings::load(dir.path());
        assert_eq!(
            (s.voice.as_str(), s.radio_voice.as_str(), s.steps),
            ("M3", "M1", 8)
        );
        assert_eq!(s.keep_warm_seconds, 300);
    }

    #[test]
    fn wav_header_matches_the_samples() {
        let bytes = wav_bytes(&[0.0, 1.0, -1.0], 44_100);
        assert_eq!(bytes.len(), 44 + 6);
        assert_eq!(&bytes[40..44], &6u32.to_le_bytes());
        assert_eq!(&bytes[44..], &[0, 0, 0xff, 0x7f, 0x01, 0x80]);
    }
}
