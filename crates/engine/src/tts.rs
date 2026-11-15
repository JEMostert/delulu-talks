//! `delulu-engine tts`: Supertonic 3 speech on the CPU (ONNX Runtime, linked
//! statically into this binary only).
//!
//! - `delulu-engine tts [--threads N] [--steps N] [--idle-unload SECS]` speaks the
//!   worker protocol (`delulu_proto::worker`) on stdin/stdout: `hello`, `load`, then
//!   `job{speak}` answered by `audio` frames per sentence and `done`. `cancel{id}`
//!   stops a job between denoising steps; an idle model is unloaded and loaded again
//!   by the next job.
//! - `delulu-engine tts --listen <socket> --model-dir <dir> [--idle-exit SECS]` keeps
//!   the model loaded and serves the same protocol to one connection at a time, so
//!   `delulu speak` reaches first audio without a cold start. It exits after being
//!   idle, removing its socket.
//! - `delulu-engine tts --once --model-dir <dir> --out <wav> [--voice V] [--lang L]
//!   [text…]` speaks the text (or stdin) into a WAV file and prints timings as JSON.
use delulu_proto::worker::{
    AudioHeader, Capability, FromWorker, JobPayload, JobResult, ModelRef, Role, ToWorker,
    WorkerErrorKind, WORKER_PROTOCOL_VERSION,
};
use delulu_tts::{
    LangChoice, Lexicon, Spoken, SynthOptions, Synthesizer, DEFAULT_STEPS, MAX_STEPS,
};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

const ENGINE: &str = "supertonic-ort";
const USAGE: &str = "usage: delulu-engine tts [--threads N] [--steps N] [--idle-unload SECS]
       delulu-engine tts --listen <socket> --model-dir <dir> [--idle-exit SECS] [--lexicon <tsv>]
       delulu-engine tts --once --model-dir <dir> --out <wav> [--voice V] [--lang auto|nl|en] [--lexicon <tsv>] [text…]";
/// An id no job uses, meaning "nothing cancelled".
const NONE: u64 = u64::MAX;

struct Args {
    threads: usize,
    steps: usize,
    model_dir: Option<PathBuf>,
    lexicon: Option<PathBuf>,
    idle_unload: Option<Duration>,
    listen: Option<PathBuf>,
    idle_exit: Duration,
    once: bool,
    out: Option<PathBuf>,
    voice: String,
    lang: LangChoice,
    text: Vec<String>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().clamp(1, 8));
    let mut a = Args {
        threads,
        steps: DEFAULT_STEPS,
        model_dir: None,
        lexicon: None,
        idle_unload: None,
        listen: None,
        idle_exit: Duration::from_secs(300),
        once: false,
        out: None,
        voice: delulu_tts::DEFAULT_VOICE.into(),
        lang: LangChoice::Auto,
        text: Vec::new(),
    };
    let number = |v: Option<String>, name: &str| -> Result<u64, String> {
        v.and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("{name} needs a number"))
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--threads" => a.threads = number(args.next(), "--threads")?.clamp(1, 64) as usize,
            "--steps" => {
                a.steps = number(args.next(), "--steps")? as usize;
                if !(1..=MAX_STEPS).contains(&a.steps) {
                    return Err(format!("--steps must be between 1 and {MAX_STEPS}"));
                }
            }
            "--model-dir" => a.model_dir = args.next().map(PathBuf::from),
            "--lexicon" => a.lexicon = args.next().map(PathBuf::from),
            "--idle-unload" => {
                a.idle_unload = Some(Duration::from_secs(number(args.next(), "--idle-unload")?))
            }
            "--listen" => a.listen = args.next().map(PathBuf::from),
            "--idle-exit" => {
                a.idle_exit = Duration::from_secs(number(args.next(), "--idle-exit")?.max(1))
            }
            "--once" => a.once = true,
            "--out" => a.out = args.next().map(PathBuf::from),
            "--voice" => a.voice = args.next().ok_or("--voice needs a name")?.to_uppercase(),
            "--lang" => {
                let v = args.next().ok_or("--lang needs auto, nl or en")?;
                a.lang = LangChoice::parse(&v).ok_or("--lang needs auto, nl or en")?;
            }
            "--" => a.text.extend(args.by_ref()),
            other if other.starts_with("--") => {
                return Err(format!("unknown argument {other}\n{USAGE}"))
            }
            _ => a.text.push(arg),
        }
    }
    if (a.once || a.listen.is_some()) && a.model_dir.is_none() {
        return Err(format!("--model-dir is required\n{USAGE}"));
    }
    if a.once && a.out.is_none() {
        return Err(format!("--once needs --out\n{USAGE}"));
    }
    Ok(a)
}

/// Keep stdout for the protocol only: anything a C library prints goes to stderr.
fn protocol_out() -> File {
    // SAFETY: plain fd syscalls on fds this process owns; the dup'd fd is owned by File.
    unsafe {
        let fd = libc::dup(libc::STDOUT_FILENO);
        assert!(fd >= 0, "dup stdout");
        libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO);
        File::from_raw_fd(fd)
    }
}

/// What the protocol needs from the model; a fake in the tests.
trait Speaker {
    fn sample_rate(&self) -> u32;
    fn speak(
        &mut self,
        text: &str,
        opts: &SynthOptions,
        cancelled: &dyn Fn() -> bool,
        on_audio: &mut dyn FnMut(&[f32]) -> Result<(), delulu_tts::Error>,
    ) -> Result<Spoken, delulu_tts::Error>;
}

impl Speaker for Synthesizer {
    fn sample_rate(&self) -> u32 {
        Synthesizer::sample_rate(self)
    }
    fn speak(
        &mut self,
        text: &str,
        opts: &SynthOptions,
        cancelled: &dyn Fn() -> bool,
        on_audio: &mut dyn FnMut(&[f32]) -> Result<(), delulu_tts::Error>,
    ) -> Result<Spoken, delulu_tts::Error> {
        Synthesizer::speak(self, text, opts, cancelled, on_audio)
    }
}

type Loader = fn(&Path, usize, Lexicon) -> Result<Box<dyn Speaker>, String>;

fn load_supertonic(
    dir: &Path,
    threads: usize,
    lexicon: Lexicon,
) -> Result<Box<dyn Speaker>, String> {
    Ok(Box::new(
        Synthesizer::load(dir, threads, lexicon).map_err(|e| e.to_string())?,
    ))
}

/// The loaded model and what loading it needs.
struct State {
    threads: usize,
    steps: usize,
    lexicon_file: Option<PathBuf>,
    loader: Loader,
    synth: Option<Box<dyn Speaker>>,
    /// The model last asked for, so a job after an idle unload can reload it.
    model: Option<ModelRef>,
}

impl State {
    fn lexicon(&self, model: &ModelRef) -> Lexicon {
        let mut lexicon = Lexicon::builtin();
        let file = model
            .extra
            .get("lexicon")
            .map(PathBuf::from)
            .or_else(|| self.lexicon_file.clone());
        if let Some(file) = file {
            if let Err(e) = lexicon.extend_from_file(&file) {
                eprintln!("delulu-engine tts: lexicon {}: {e}", file.display());
            }
        }
        lexicon
    }

    /// Loads `model` unless it is already loaded. Returns the load time in ms.
    fn load(&mut self, model: &ModelRef) -> Result<u64, String> {
        if self.synth.is_some() && self.model.as_ref() == Some(model) {
            return Ok(0);
        }
        let started = Instant::now();
        self.synth = None;
        let lexicon = self.lexicon(model);
        let synth = (self.loader)(Path::new(&model.path), self.threads, lexicon)?;
        self.synth = Some(synth);
        self.model = Some(model.clone());
        Ok(started.elapsed().as_millis() as u64)
    }

    fn unload(&mut self) {
        self.synth = None;
    }
}

fn model_ref(dir: &Path) -> ModelRef {
    ModelRef {
        id: "supertonic-3".into(),
        path: dir.to_string_lossy().into_owned(),
        extra: Default::default(),
    }
}

/// Lowers this process's CPU priority, so dictation keeps the processor first.
fn be_nice() {
    // SAFETY: setpriority on our own process.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

pub fn main(args: impl Iterator<Item = String>) -> ExitCode {
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("delulu-engine tts: {message}");
            return ExitCode::from(2);
        }
    };
    be_nice();
    let mut state = State {
        threads: args.threads,
        steps: args.steps,
        lexicon_file: args.lexicon.clone(),
        loader: load_supertonic,
        synth: None,
        model: None,
    };
    if args.once {
        return once(&args, &mut state);
    }
    if let Some(socket) = &args.listen {
        return listen(
            socket,
            args.model_dir.as_deref().expect("checked"),
            args.idle_exit,
            &mut state,
        );
    }
    let out = protocol_out();
    let stdin = std::io::stdin();
    let _ = serve(stdin, out, &mut state, args.idle_unload);
    ExitCode::SUCCESS
}

fn once(args: &Args, state: &mut State) -> ExitCode {
    let text = if args.text.is_empty() {
        let mut s = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut s) {
            eprintln!("delulu-engine tts: stdin: {e}");
            return ExitCode::FAILURE;
        }
        s
    } else {
        args.text.join(" ")
    };
    let dir = args.model_dir.as_deref().expect("checked");
    let load_ms = match state.load(&model_ref(dir)) {
        Ok(ms) => ms,
        Err(e) => {
            eprintln!("delulu-engine tts: {e}");
            return ExitCode::FAILURE;
        }
    };
    let synth = state.synth.as_mut().expect("loaded");
    let rate = synth.sample_rate();
    let opts = SynthOptions {
        voice: args.voice.clone(),
        lang: args.lang,
        steps: state.steps,
        ..Default::default()
    };
    let mut samples = Vec::new();
    let spoken = synth.speak(&text, &opts, &|| false, &mut |audio| {
        samples.extend_from_slice(audio);
        Ok(())
    });
    let spoken = match spoken {
        Ok(spoken) => spoken,
        Err(e) => {
            eprintln!("delulu-engine tts: {e}");
            return ExitCode::FAILURE;
        }
    };
    let out = args.out.as_deref().expect("checked");
    if let Err(e) = write_wav(out, &samples, rate) {
        eprintln!("delulu-engine tts: {e}");
        return ExitCode::FAILURE;
    }
    println!(
        "{}",
        serde_json::json!({
            "loadMs": load_ms,
            "firstAudioMs": spoken.first_audio_ms,
            "totalMs": spoken.total_ms,
            "audioMs": samples.len() as u64 * 1000 / rate as u64,
            "segments": spoken.segments,
            "rate": rate,
        })
    );
    ExitCode::SUCCESS
}

/// 16-bit PCM, written next to the target and renamed into place.
fn write_wav(path: &Path, samples: &[f32], rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let temp = path.with_extension("wav.part");
    let result = (|| -> Result<(), hound::Error> {
        let mut w = hound::WavWriter::create(&temp, spec)?;
        for &s in samples {
            w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16)?;
        }
        w.finalize()
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write {}: {e}", path.display()));
    }
    std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn listen(socket: &Path, model_dir: &Path, idle_exit: Duration, state: &mut State) -> ExitCode {
    if let Some(dir) = socket.parent() {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir);
    }
    if socket.exists() {
        match UnixStream::connect(socket) {
            Ok(_) => {
                eprintln!(
                    "delulu-engine tts: another engine already listens on {}",
                    socket.display()
                );
                return ExitCode::SUCCESS;
            }
            // A socket left by an engine that died: take its place.
            Err(_) => {
                let _ = std::fs::remove_file(socket);
            }
        }
    }
    let listener = match UnixListener::bind(socket) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("delulu-engine tts: {}: {e}", socket.display());
            return ExitCode::FAILURE;
        }
    };
    // Load before accepting: a client that connected meanwhile waits in the backlog.
    if let Err(e) = state.load(&model_ref(model_dir)) {
        eprintln!("delulu-engine tts: {e}");
        let _ = std::fs::remove_file(socket);
        return ExitCode::FAILURE;
    }
    eprintln!("delulu-engine tts: listening on {}", socket.display());
    if listener.set_nonblocking(true).is_err() {
        return ExitCode::FAILURE;
    }
    let mut idle_since = Instant::now();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                match stream.try_clone() {
                    Ok(input) => {
                        let _ = serve(input, stream, state, None);
                    }
                    Err(e) => eprintln!("delulu-engine tts: {e}"),
                }
                idle_since = Instant::now();
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if idle_since.elapsed() >= idle_exit {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                eprintln!("delulu-engine tts: accept: {e}");
                break;
            }
        }
    }
    // Only remove the socket if it is still ours (a newer engine may have replaced it).
    if UnixStream::connect(socket).is_err() {
        let _ = std::fs::remove_file(socket);
    }
    ExitCode::SUCCESS
}

enum Incoming {
    Message(ToWorker),
    Bad(String),
    Eof,
}

/// Reads protocol lines on a thread, so `cancel` reaches a running job.
fn reader<R: Read + Send + 'static>(
    input: R,
    cancel: Arc<AtomicU64>,
    gone: Arc<AtomicBool>,
) -> mpsc::Receiver<Incoming> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = BufReader::new(input);
        let mut line = String::new();
        loop {
            line.clear();
            match input.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.trim().is_empty() {
                continue;
            }
            let message = match serde_json::from_str::<ToWorker>(&line) {
                Ok(m) => m,
                Err(e) => {
                    // Not `{e}`: serde can quote the text it choked on.
                    let detail = format!("{:?} error at column {}", e.classify(), e.column());
                    if tx.send(Incoming::Bad(detail)).is_err() {
                        return;
                    }
                    continue;
                }
            };
            match &message {
                ToWorker::Cancel { id } => cancel.store(*id, Ordering::SeqCst),
                // Audio is not an input of this role; skip its bytes to stay in sync.
                ToWorker::Audio(header) => {
                    let mut skip = (&mut input).take(header.bytes as u64);
                    if std::io::copy(&mut skip, &mut std::io::sink()).is_err() {
                        break;
                    }
                }
                _ => {}
            }
            if tx.send(Incoming::Message(message)).is_err() {
                return;
            }
        }
        gone.store(true, Ordering::SeqCst);
        let _ = tx.send(Incoming::Eof);
    });
    rx
}

fn send<W: Write>(out: &mut W, message: &FromWorker) -> std::io::Result<()> {
    let line = serde_json::to_string(message).expect("serialize");
    writeln!(out, "{line}")?;
    out.flush()
}

fn send_audio<W: Write>(out: &mut W, header: AudioHeader, samples: &[f32]) -> std::io::Result<()> {
    let line = serde_json::to_string(&FromWorker::Audio(header)).expect("serialize");
    let mut bytes = Vec::with_capacity(line.len() + 1 + samples.len() * 4);
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    out.write_all(&bytes)?;
    out.flush()
}

/// One protocol session. Returns when the peer closes its side or asks to shut down.
fn serve<R: Read + Send + 'static, W: Write>(
    input: R,
    mut out: W,
    state: &mut State,
    idle_unload: Option<Duration>,
) -> std::io::Result<()> {
    let cancel = Arc::new(AtomicU64::new(NONE));
    let gone = Arc::new(AtomicBool::new(false));
    let rx = reader(input, cancel.clone(), gone.clone());
    loop {
        let incoming = match idle_unload {
            Some(idle) if state.synth.is_some() => match rx.recv_timeout(idle) {
                Ok(m) => m,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    state.unload();
                    eprintln!("delulu-engine tts: idle, model unloaded");
                    send(&mut out, &FromWorker::Unloaded)?;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            },
            _ => match rx.recv() {
                Ok(m) => m,
                Err(_) => return Ok(()),
            },
        };
        let message = match incoming {
            Incoming::Eof => return Ok(()),
            Incoming::Bad(detail) => {
                eprintln!("delulu-engine tts: bad message ({detail})");
                send(
                    &mut out,
                    &FromWorker::Error {
                        id: None,
                        kind: WorkerErrorKind::BadMessage,
                        message: detail,
                    },
                )?;
                continue;
            }
            Incoming::Message(m) => m,
        };
        match message {
            ToWorker::Hello { role, protocol } => {
                let reply = if role != Role::Tts || protocol != WORKER_PROTOCOL_VERSION {
                    FromWorker::Error {
                        id: None,
                        kind: WorkerErrorKind::Unsupported,
                        message: format!(
                            "this worker speaks role tts, protocol {WORKER_PROTOCOL_VERSION}"
                        ),
                    }
                } else {
                    FromWorker::Ready {
                        engine: ENGINE.into(),
                        protocol: WORKER_PROTOCOL_VERSION,
                        device: Some("CPU".into()),
                        vram_bytes: None,
                        caps: vec![
                            Capability::Streaming,
                            Capability::Voices,
                            Capability::Languages,
                        ],
                    }
                };
                send(&mut out, &reply)?;
            }
            ToWorker::Load { model, .. } => {
                let reply = match state.load(&model) {
                    Ok(load_ms) => FromWorker::Loaded {
                        model_id: model.id.clone(),
                        load_ms,
                        vram_bytes: None,
                    },
                    Err(message) => FromWorker::Error {
                        id: None,
                        kind: WorkerErrorKind::LoadFailed,
                        message,
                    },
                };
                send(&mut out, &reply)?;
            }
            ToWorker::Job {
                id,
                payload:
                    JobPayload::Speak {
                        text,
                        voice,
                        language,
                        steps,
                    },
                ..
            } => {
                let reply = speak(
                    &mut out, state, id, &text, voice, language, steps, &cancel, &gone,
                )?;
                send(&mut out, &reply)?;
            }
            ToWorker::Job { id, .. } => {
                send(
                    &mut out,
                    &FromWorker::Error {
                        id: Some(id),
                        kind: WorkerErrorKind::Unsupported,
                        message: "the tts role only speaks".into(),
                    },
                )?;
            }
            ToWorker::Unload => {
                state.unload();
                send(&mut out, &FromWorker::Unloaded)?;
            }
            ToWorker::Shutdown => {
                send(&mut out, &FromWorker::Bye)?;
                return Ok(());
            }
            // Speech is short; a cancel for a finished job needs no answer.
            ToWorker::Cancel { .. } | ToWorker::Pause | ToWorker::Resume | ToWorker::Audio(_) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn speak<W: Write>(
    out: &mut W,
    state: &mut State,
    id: u64,
    text: &str,
    voice: Option<String>,
    language: Option<String>,
    steps: Option<u32>,
    cancel: &AtomicU64,
    gone: &AtomicBool,
) -> std::io::Result<FromWorker> {
    let started = Instant::now();
    let failed = |kind, message: String| FromWorker::Error {
        id: Some(id),
        kind,
        message,
    };
    let lang = match language.as_deref() {
        None => LangChoice::Auto,
        Some(l) => match LangChoice::parse(l) {
            Some(choice) => choice,
            None => {
                return Ok(failed(
                    WorkerErrorKind::JobFailed,
                    format!("unsupported language {l}; use auto, nl or en"),
                ))
            }
        },
    };
    // After an idle unload, the next job loads the model again.
    if state.synth.is_none() {
        let Some(model) = state.model.clone() else {
            return Ok(failed(WorkerErrorKind::JobFailed, "no model loaded".into()));
        };
        if let Err(message) = state.load(&model) {
            return Ok(failed(WorkerErrorKind::LoadFailed, message));
        }
    }
    let opts = SynthOptions {
        voice: voice
            .map(|v| v.to_uppercase())
            .unwrap_or_else(|| delulu_tts::DEFAULT_VOICE.into()),
        lang,
        steps: steps.map_or(state.steps, |s| s as usize),
        ..Default::default()
    };
    let synth = state.synth.as_mut().expect("loaded");
    let rate = synth.sample_rate();
    let mut seq = 0u64;
    let mut write_error = None;
    let cancelled = || cancel.load(Ordering::SeqCst) == id || gone.load(Ordering::SeqCst);
    let result = synth.speak(text, &opts, &cancelled, &mut |audio| {
        let header = AudioHeader {
            id,
            seq,
            rate,
            bytes: (audio.len() * 4) as u32,
            last: false,
        };
        seq += 1;
        send_audio(out, header, audio).map_err(|e| {
            write_error = Some(e);
            delulu_tts::Error::Cancelled
        })
    });
    if let Some(e) = write_error {
        return Err(e);
    }
    Ok(match result {
        Ok(spoken) => {
            send_audio(
                out,
                AudioHeader {
                    id,
                    seq,
                    rate,
                    bytes: 0,
                    last: true,
                },
                &[],
            )?;
            eprintln!(
                "delulu-engine tts: job {id}: {} segments, first audio {} ms, total {} ms",
                spoken.segments, spoken.first_audio_ms, spoken.total_ms
            );
            FromWorker::Done {
                id,
                ms: started.elapsed().as_millis() as u64,
                result: JobResult::Spoken {
                    audio_ms: spoken.samples as u64 * 1000 / rate as u64,
                },
            }
        }
        Err(delulu_tts::Error::Cancelled) => failed(WorkerErrorKind::Cancelled, "cancelled".into()),
        Err(e) => failed(WorkerErrorKind::JobFailed, e.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use delulu_proto::worker::Lane;

    /// One 10 ms chunk per word, 20 ms apart, checking for cancel like the model does
    /// between denoising steps.
    struct Fake;
    impl Speaker for Fake {
        fn sample_rate(&self) -> u32 {
            44_100
        }
        fn speak(
            &mut self,
            text: &str,
            opts: &SynthOptions,
            cancelled: &dyn Fn() -> bool,
            on_audio: &mut dyn FnMut(&[f32]) -> Result<(), delulu_tts::Error>,
        ) -> Result<Spoken, delulu_tts::Error> {
            if !delulu_tts::is_voice(&opts.voice) {
                return Err(delulu_tts::Error::Input(format!(
                    "unknown voice {}",
                    opts.voice
                )));
            }
            let words = text.split_whitespace().count();
            for _ in 0..words {
                std::thread::sleep(Duration::from_millis(20));
                if cancelled() {
                    return Err(delulu_tts::Error::Cancelled);
                }
                on_audio(&[0.25; 441])?;
            }
            Ok(Spoken {
                samples: words * 441,
                segments: words,
                first_audio_ms: 20,
                total_ms: 20 * words as u64,
            })
        }
    }

    fn fake_loader(dir: &Path, _: usize, _: Lexicon) -> Result<Box<dyn Speaker>, String> {
        if dir.ends_with("missing") {
            return Err(format!("{}: no such model", dir.display()));
        }
        Ok(Box::new(Fake))
    }

    struct Client {
        input: BufReader<UnixStream>,
        output: UnixStream,
    }

    impl Client {
        fn start() -> (Client, std::thread::JoinHandle<()>) {
            let (ours, theirs) = UnixStream::pair().unwrap();
            let worker = std::thread::spawn(move || {
                let mut state = State {
                    threads: 1,
                    steps: 8,
                    lexicon_file: None,
                    loader: fake_loader,
                    synth: None,
                    model: None,
                };
                let input = theirs.try_clone().unwrap();
                let _ = serve(input, theirs, &mut state, None);
            });
            let client = Client {
                input: BufReader::new(ours.try_clone().unwrap()),
                output: ours,
            };
            (client, worker)
        }
        fn send(&mut self, message: &ToWorker) {
            writeln!(self.output, "{}", serde_json::to_string(message).unwrap()).unwrap();
        }
        /// The next message; audio frames come with their samples.
        fn next(&mut self) -> (FromWorker, Vec<f32>) {
            let mut line = String::new();
            self.input.read_line(&mut line).unwrap();
            let message: FromWorker = serde_json::from_str(&line).unwrap();
            let mut samples = Vec::new();
            if let FromWorker::Audio(h) = &message {
                let mut bytes = vec![0u8; h.bytes as usize];
                self.input.read_exact(&mut bytes).unwrap();
                samples = bytes
                    .chunks(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
            }
            (message, samples)
        }
        fn open(&mut self, path: &str) -> FromWorker {
            self.send(&ToWorker::Hello {
                role: Role::Tts,
                protocol: WORKER_PROTOCOL_VERSION,
            });
            assert!(matches!(self.next().0, FromWorker::Ready { .. }));
            self.send(&ToWorker::Load {
                model: model_ref(Path::new(path)),
                opts: Default::default(),
            });
            self.next().0
        }
        fn speak(&mut self, id: u64, text: &str, voice: Option<&str>) {
            self.send(&ToWorker::Job {
                id,
                lane: Lane::Report,
                payload: JobPayload::Speak {
                    text: text.into(),
                    voice: voice.map(Into::into),
                    language: Some("en".into()),
                    steps: None,
                },
            });
        }
    }

    #[test]
    fn a_job_streams_audio_frames_then_a_last_frame_and_done() {
        let (mut c, worker) = Client::start();
        assert!(matches!(
            c.open("/models/supertonic-3"),
            FromWorker::Loaded { .. }
        ));
        c.speak(1, "one two three", Some("m2"));
        let mut samples = 0;
        let mut seqs = Vec::new();
        loop {
            match c.next() {
                (FromWorker::Audio(h), s) => {
                    assert_eq!((h.id, h.rate), (1, 44_100));
                    seqs.push(h.seq);
                    samples += s.len();
                    if h.last {
                        assert!(s.is_empty());
                    }
                }
                (FromWorker::Done { id, result, .. }, _) => {
                    assert_eq!(id, 1);
                    assert_eq!(result, JobResult::Spoken { audio_ms: 30 });
                    break;
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(seqs, [0, 1, 2, 3]);
        assert_eq!(samples, 3 * 441);
        c.send(&ToWorker::Shutdown);
        assert_eq!(c.next().0, FromWorker::Bye);
        worker.join().unwrap();
    }

    #[test]
    fn cancel_stops_a_running_job_and_the_session_continues() {
        let (mut c, worker) = Client::start();
        c.open("/models/supertonic-3");
        let words = vec!["word"; 200].join(" ");
        c.speak(7, &words, None);
        let (first, _) = c.next();
        assert!(matches!(
            first,
            FromWorker::Audio(AudioHeader { id: 7, seq: 0, .. })
        ));
        let sent = Instant::now();
        c.send(&ToWorker::Cancel { id: 7 });
        let end = loop {
            match c.next().0 {
                FromWorker::Audio(h) => assert!(!h.last, "a cancelled job has no last frame"),
                other => break other,
            }
        };
        assert!(
            matches!(
                end,
                FromWorker::Error {
                    id: Some(7),
                    kind: WorkerErrorKind::Cancelled,
                    ..
                }
            ),
            "{end:?}"
        );
        assert!(
            sent.elapsed() < Duration::from_millis(500),
            "cancel took {:?}",
            sent.elapsed()
        );
        // The next job runs normally.
        c.speak(8, "again", None);
        assert!(matches!(
            c.next().0,
            FromWorker::Audio(AudioHeader { id: 8, .. })
        ));
        drop(c);
        worker.join().unwrap();
    }

    #[test]
    fn errors_name_the_job_and_do_not_end_the_session() {
        let (mut c, worker) = Client::start();
        assert!(matches!(
            c.open("/models/missing"),
            FromWorker::Error {
                id: None,
                kind: WorkerErrorKind::LoadFailed,
                ..
            }
        ));
        c.speak(1, "hello", None);
        assert!(matches!(
            c.next().0,
            FromWorker::Error {
                id: Some(1),
                kind: WorkerErrorKind::JobFailed,
                ..
            }
        ));
        c.send(&ToWorker::Load {
            model: model_ref(Path::new("/models/supertonic-3")),
            opts: Default::default(),
        });
        assert!(matches!(c.next().0, FromWorker::Loaded { .. }));
        c.speak(2, "hello", Some("X9"));
        match c.next().0 {
            FromWorker::Error {
                id: Some(2),
                kind: WorkerErrorKind::JobFailed,
                message,
            } => assert!(message.contains("X9")),
            other => panic!("unexpected {other:?}"),
        }
        writeln!(c.output, "{{\"type\":\"nonsense\"}}").unwrap();
        assert!(matches!(
            c.next().0,
            FromWorker::Error {
                id: None,
                kind: WorkerErrorKind::BadMessage,
                ..
            }
        ));
        drop(c);
        worker.join().unwrap();
    }

    #[test]
    fn a_client_that_disconnects_mid_job_cancels_it() {
        let (mut c, worker) = Client::start();
        c.open("/models/supertonic-3");
        c.speak(1, &vec!["word"; 500].join(" "), None);
        c.next();
        let started = Instant::now();
        drop(c);
        // The worker notices on its next step or write and ends the session.
        let _ = worker.join();
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
