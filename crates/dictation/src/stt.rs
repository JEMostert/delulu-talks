//! Speech to text for dictation: one `delulu-engine stt` worker process, driven from
//! a dedicated thread. Loading and transcribing block for seconds, and the worker
//! keeps ggml, Vulkan and ONNX Runtime out of the app and the daemon, so a GPU driver
//! crash ends the worker, not the hotkey.
//!
//! The thread speaks the worker protocol (`delulu_proto::worker`). When the worker
//! dies (a crash, `kill -9`) or stops answering, the dictation in flight fails with an
//! error, and a new worker loads the same model again, so the next dictation works.
use delulu_proto::worker::{
    AudioHeader, AudioSource, FromWorker, JobPayload, JobResult, Lane, ModelRef, Role, SttPrompt,
    ToWorker, WorkerErrorKind, WORKER_PROTOCOL_VERSION,
};
use delulu_stt::{Language, Prompt, Transcript};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

pub enum EngineJob {
    Load(String),
    /// Samples, language setting, Whisper prompt from the context.
    Transcribe(
        Vec<f32>,
        Language,
        Option<Prompt>,
        tokio::sync::oneshot::Sender<Result<Transcript, String>>,
    ),
}

/// What the engine thread needs from the process that runs it.
pub trait EngineHost: Send + 'static {
    fn models_dir(&self) -> PathBuf;
    /// Runs on the engine thread just before a requested model loads, to free the GPU
    /// for it. Not before a reload after a crash: the dead worker's memory is free.
    fn before_load(&self);
    /// A load finished: the compute backend, or why it failed.
    fn loaded(&self, id: String, result: Result<String, String>);
    /// The worker stopped by itself and a new one loaded model `id` again: the compute
    /// backend, or why it could not. Called after the dictation in flight, if any, got
    /// its error.
    fn recovered(&self, id: String, result: Result<String, String>) {
        self.loaded(id, result);
    }
    /// The `delulu-engine` binary.
    fn engine(&self) -> Option<PathBuf> {
        delulu_cleanup::helper_path()
    }
    /// How long a clip of `audio` may take before the worker counts as hung. Generous:
    /// on a machine without a usable GPU, Whisper runs slower than real time.
    fn job_timeout(&self, audio: Duration) -> Duration {
        Duration::from_secs(120) + audio * 3
    }
}

/// The model to load: the selected one, or else any downloaded one, so dictation
/// keeps working while a newly picked model is still downloading.
pub fn ready_model(dir: &Path, selected: &str) -> Option<String> {
    std::iter::once(selected)
        .chain(delulu_stt::models().iter().map(|m| m.id))
        .find(|id| delulu_stt::is_downloaded(dir, id))
        .map(str::to_string)
}

pub const NOT_INSTALLED: &str = "The speech engine (delulu-engine) is not installed";
const STOPPED: &str = "The speech engine stopped unexpectedly; it is restarting";
const HUNG: &str = "The speech engine stopped responding; it is restarting";
/// The first load after an engine upgrade compiles the GPU shaders.
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// A worker that dies this often within `CRASH_WINDOW` is not started again until the
/// next load or dictation asks for it.
const MAX_CRASHES: usize = 5;
const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// Samples per `audio` frame (1 MiB).
const FRAME_SAMPLES: usize = 256 * 1024;
const RATE: u32 = 16_000;

/// Runs jobs until every sender is gone.
pub fn engine_thread(host: impl EngineHost, rx: Receiver<EngineJob>) {
    let (tx, events) = mpsc::channel();
    let jobs = tx.clone();
    let forward = std::thread::Builder::new()
        .name("stt-jobs".into())
        .spawn(move || {
            for job in rx {
                if jobs.send(Event::Job(job)).is_err() {
                    return;
                }
            }
            let _ = jobs.send(Event::Closed);
        });
    if let Err(e) = forward {
        eprintln!("stt: could not start the job thread: {e}");
        return;
    }
    let mut client = Client {
        host,
        tx,
        events,
        backlog: VecDeque::new(),
        worker: None,
        model: None,
        next_job: 1,
        next_gen: 1,
        crashes: VecDeque::new(),
        closed: false,
    };
    client.run();
}

enum Event {
    Job(EngineJob),
    /// Every job sender is gone.
    Closed,
    /// From the worker of generation `gen`.
    Worker {
        gen: u64,
        message: WorkerMessage,
    },
}

enum WorkerMessage {
    Line(FromWorker),
    Exited,
}

/// A running worker. Dropping it kills and reaps the process.
struct Worker {
    child: Child,
    gen: u64,
    /// To the writer thread; closing it closes the worker's stdin.
    input: Option<Sender<Vec<u8>>>,
    /// The model it has loaded.
    loaded: Option<String>,
}

impl Worker {
    /// Starts `engine stt`. The engine thread lives as long as the process, so the
    /// parent-death signal (which follows the forking thread) fires only when the
    /// process ends.
    fn spawn(engine: &Path, gen: u64, events: Sender<Event>) -> std::io::Result<Self> {
        let mut command = Command::new(engine);
        command
            .arg("stt")
            // A ggml crash would otherwise attach gdb and hang instead of exiting.
            .env("GGML_NO_BACKTRACE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The parent died before prctl took effect.
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other("worker pipes missing"));
        };
        let (input, writes) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut stdin = stdin;
            for bytes in writes {
                if stdin
                    .write_all(&bytes)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    return;
                }
            }
        });
        std::thread::spawn(move || read_worker(stdout, gen, events));
        Ok(Self {
            child,
            gen,
            input: Some(input),
            loaded: None,
        })
    }

    fn send(&self, message: &ToWorker) {
        let mut line = serde_json::to_vec(message).expect("serialize");
        line.push(b'\n');
        self.write(line);
    }

    fn write(&self, bytes: Vec<u8>) {
        if let Some(input) = &self.input {
            // A dead writer means a dead worker; its exit arrives as an event.
            let _ = input.send(bytes);
        }
    }

    /// Sends `samples` as `audio` frames for job `id`.
    fn send_audio(&self, id: u64, samples: &[f32]) {
        let mut chunks: Vec<&[f32]> = samples.chunks(FRAME_SAMPLES).collect();
        if chunks.is_empty() {
            chunks.push(&[]);
        }
        let last = chunks.len() - 1;
        for (seq, chunk) in chunks.into_iter().enumerate() {
            let header = ToWorker::Audio(AudioHeader {
                id,
                seq: seq as u64,
                rate: RATE,
                bytes: (chunk.len() * 4) as u32,
                last: seq == last,
            });
            let mut bytes = serde_json::to_vec(&header).expect("serialize");
            bytes.push(b'\n');
            bytes.reserve(chunk.len() * 4);
            for sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            self.write(bytes);
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.input = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Forwards the worker's lines until its stdout closes, which is how its exit shows.
fn read_worker(stdout: impl Read, gen: u64, events: Sender<Event>) {
    let mut stdout = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<FromWorker>(&line) {
            Ok(FromWorker::Audio(header)) => {
                // Not something this role sends; skip its bytes to stay in step.
                let mut skip = (&mut stdout).take(header.bytes as u64);
                if std::io::copy(&mut skip, &mut std::io::sink()).is_err() {
                    break;
                }
            }
            Ok(message) => {
                let message = WorkerMessage::Line(message);
                if events.send(Event::Worker { gen, message }).is_err() {
                    return;
                }
            }
            // Not `{e}`: serde can quote the text it choked on.
            Err(e) => eprintln!(
                "stt: unreadable line from the speech engine ({:?} error at column {})",
                e.classify(),
                e.column()
            ),
        }
    }
    let _ = events.send(Event::Worker {
        gen,
        message: WorkerMessage::Exited,
    });
}

/// How a wait for the worker ended.
enum Wait<T> {
    Got(T),
    /// The worker exited (crashed or was killed).
    Exited,
    TimedOut,
    /// Every job sender is gone: stop.
    Closed,
}

/// How a load attempt ended.
enum Attempt {
    Loaded(String),
    /// The worker answered with an error, or could not start: trying again won't help.
    Failed(String),
    /// The worker died while starting or loading.
    Crashed,
    Closed,
}

struct Client<H> {
    host: H,
    tx: Sender<Event>,
    events: Receiver<Event>,
    /// Jobs that arrived while the thread waited for the worker.
    backlog: VecDeque<EngineJob>,
    worker: Option<Worker>,
    /// The model dictation uses: the last one asked for that loaded.
    model: Option<String>,
    next_job: u64,
    next_gen: u64,
    /// When the worker died by itself lately.
    crashes: VecDeque<Instant>,
    closed: bool,
}

impl<H: EngineHost> Client<H> {
    fn run(&mut self) {
        loop {
            let job = match self.backlog.pop_front() {
                Some(job) => job,
                None if self.closed => break,
                None => match self.events.recv() {
                    Ok(Event::Job(job)) => job,
                    Ok(Event::Closed) | Err(_) => break,
                    Ok(Event::Worker { gen, message }) => {
                        self.idle_event(gen, message);
                        continue;
                    }
                },
            };
            match job {
                EngineJob::Load(id) => {
                    self.host.before_load();
                    let result = self.load(&id);
                    if result.is_err() {
                        // The old model is gone too: nothing to recover.
                        self.model = None;
                    }
                    self.host.loaded(id, result);
                }
                EngineJob::Transcribe(samples, language, prompt, reply) => {
                    self.transcribe(samples, language, prompt, reply);
                }
            }
        }
        self.shut_down();
    }

    fn idle_event(&mut self, gen: u64, message: WorkerMessage) {
        let current = self.worker.as_ref().is_some_and(|w| w.gen == gen);
        if current && matches!(message, WorkerMessage::Exited) {
            eprintln!("stt: the speech engine stopped; starting a new one");
            self.worker = None;
            self.crashed();
            self.recover();
        }
    }

    /// Note a crash; false when the worker has died too often to start it again now.
    fn crashed(&mut self) -> bool {
        let now = Instant::now();
        self.crashes.push_back(now);
        while self
            .crashes
            .front()
            .is_some_and(|t| now.duration_since(*t) > CRASH_WINDOW)
        {
            self.crashes.pop_front();
        }
        self.crashes.len() < MAX_CRASHES
    }

    /// Loads the model dictation used again in a new worker, after a crash.
    fn recover(&mut self) {
        let Some(id) = self.model.clone() else {
            return;
        };
        if self.crashes.len() >= MAX_CRASHES {
            self.host.recovered(
                id,
                Err(
                    "The speech engine keeps stopping; it starts again with the next dictation"
                        .into(),
                ),
            );
            return;
        }
        let result = self.load(&id);
        if result.is_ok() || !self.closed {
            self.host.recovered(id, result);
        }
    }

    /// Loads `id` (a speech model of the registry), starting a worker if none runs.
    /// A worker that dies while loading is started again, within the crash limit.
    fn load(&mut self, id: &str) -> Result<String, String> {
        let Some(info) = delulu_stt::model_info(id) else {
            return Err(format!("unknown speech model {id}"));
        };
        let path = self.host.models_dir().join(info.path);
        loop {
            match self.try_load(id, &path) {
                Attempt::Loaded(device) => {
                    self.model = Some(id.to_string());
                    return Ok(device);
                }
                Attempt::Failed(message) => return Err(message),
                Attempt::Closed => return Err("the speech engine was stopped".into()),
                Attempt::Crashed => {
                    self.worker = None;
                    if !self.crashed() {
                        return Err(
                            "The speech engine stopped each time it loaded the model".into()
                        );
                    }
                    eprintln!("stt: the speech engine stopped while loading; starting a new one");
                }
            }
        }
    }

    fn try_load(&mut self, id: &str, path: &Path) -> Attempt {
        if let Err(attempt) = self.ensure_worker() {
            return attempt;
        }
        let worker = self.worker.as_mut().expect("worker");
        worker.loaded = None;
        worker.send(&ToWorker::Load {
            model: ModelRef {
                id: id.to_string(),
                path: path.to_string_lossy().into_owned(),
                extra: Default::default(),
            },
            opts: Default::default(),
        });
        let answer = self.wait(
            Instant::now() + LOAD_TIMEOUT,
            None,
            |message| match message {
                FromWorker::Loaded { device, .. } => Some(Ok(device.unwrap_or_default())),
                FromWorker::Error {
                    id: None, message, ..
                } => Some(Err(message)),
                _ => None,
            },
        );
        match answer {
            Wait::Got(Ok(device)) => {
                if let Some(worker) = &mut self.worker {
                    worker.loaded = Some(id.to_string());
                }
                Attempt::Loaded(device)
            }
            Wait::Got(Err(message)) => Attempt::Failed(message),
            Wait::Exited => Attempt::Crashed,
            Wait::TimedOut => {
                self.worker = None;
                Attempt::Failed("The speech model took too long to load".into())
            }
            Wait::Closed => Attempt::Closed,
        }
    }

    /// Starts a worker and greets it, unless one runs.
    fn ensure_worker(&mut self) -> Result<(), Attempt> {
        if self.worker.is_some() {
            return Ok(());
        }
        let engine = self
            .host
            .engine()
            .ok_or_else(|| Attempt::Failed(NOT_INSTALLED.into()))?;
        let gen = self.next_gen;
        self.next_gen += 1;
        let worker = Worker::spawn(&engine, gen, self.tx.clone()).map_err(|e| {
            Attempt::Failed(format!(
                "Could not start the speech engine ({}): {e}",
                engine.display()
            ))
        })?;
        worker.send(&ToWorker::Hello {
            role: Role::Stt,
            protocol: WORKER_PROTOCOL_VERSION,
        });
        self.worker = Some(worker);
        match self.wait(
            Instant::now() + HELLO_TIMEOUT,
            None,
            |message| match message {
                FromWorker::Ready { .. } => Some(Ok(())),
                FromWorker::Error {
                    id: None, message, ..
                } => Some(Err(message)),
                _ => None,
            },
        ) {
            Wait::Got(Ok(())) => Ok(()),
            Wait::Got(Err(message)) => {
                self.worker = None;
                Err(Attempt::Failed(format!(
                    "The speech engine does not speak this app's protocol: {message}"
                )))
            }
            Wait::Exited => Err(Attempt::Crashed),
            Wait::TimedOut => {
                self.worker = None;
                Err(Attempt::Failed("The speech engine did not start".into()))
            }
            Wait::Closed => Err(Attempt::Closed),
        }
    }

    fn transcribe(
        &mut self,
        samples: Vec<f32>,
        language: Language,
        prompt: Option<Prompt>,
        reply: tokio::sync::oneshot::Sender<Result<Transcript, String>>,
    ) {
        let ready = |client: &Self| {
            client
                .worker
                .as_ref()
                .is_some_and(|w| w.loaded.is_some() && w.loaded == client.model)
        };
        // After a crash that used up the restarts, this dictation starts the engine.
        if !ready(self) {
            if let Some(id) = self.model.clone() {
                self.crashes.clear();
                let result = self.load(&id);
                let failed = result.is_err();
                self.host.recovered(id, result);
                if failed {
                    let _ = reply.send(Err("Model is not loaded".into()));
                    return;
                }
            }
        }
        if !ready(self) {
            let _ = reply.send(Err("Model is not loaded".into()));
            return;
        }
        let id = self.next_job;
        self.next_job += 1;
        let audio = Duration::from_secs_f64(samples.len() as f64 / RATE as f64);
        let (language, languages) = match language {
            Language::Fixed(code) => (Some(code), Vec::new()),
            Language::Auto(allowed) => (None, allowed),
        };
        let worker = self.worker.as_ref().expect("worker");
        worker.send(&ToWorker::Job {
            id,
            lane: Lane::Dictation,
            payload: JobPayload::Transcribe {
                audio: AudioSource::Frames,
                language,
                languages,
                prompt: prompt.map(|p| SttPrompt {
                    terms: p.terms,
                    sentence: p.sentence,
                }),
                stream: false,
            },
        });
        worker.send_audio(id, &samples);
        drop(samples);
        let deadline = Instant::now() + self.host.job_timeout(audio);
        let answer = self.wait(deadline, Some((id, &reply)), |message| match message {
            FromWorker::Done {
                id: done,
                ms,
                result:
                    JobResult::Transcript {
                        text,
                        language,
                        audio_ms,
                    },
            } if done == id => Some(Ok(Transcript {
                text,
                language,
                audio_ms,
                elapsed_ms: ms,
            })),
            FromWorker::Error {
                id: Some(failed),
                message,
                kind,
            } if failed == id => Some(Err(match kind {
                WorkerErrorKind::Cancelled => "Cancelled".to_string(),
                _ => format!("Speech recognition failed: {message}"),
            })),
            _ => None,
        });
        match answer {
            Wait::Got(result) => {
                let _ = reply.send(result);
            }
            Wait::Exited => {
                eprintln!("stt: the speech engine stopped during a dictation; starting a new one");
                self.worker = None;
                let _ = reply.send(Err(STOPPED.into()));
                self.crashed();
                self.recover();
            }
            Wait::TimedOut => {
                eprintln!("stt: the speech engine stopped responding; starting a new one");
                self.worker = None;
                let _ = reply.send(Err(HUNG.into()));
                self.crashed();
                self.recover();
            }
            Wait::Closed => {
                let _ = reply.send(Err("the speech engine was stopped".into()));
            }
        }
    }

    /// Waits for the current worker's message that `pick` takes, keeping jobs that
    /// arrive meanwhile for later. With `job`, asks the worker to cancel that job once
    /// its caller stops waiting for the answer.
    fn wait<T>(
        &mut self,
        deadline: Instant,
        job: Option<(
            u64,
            &tokio::sync::oneshot::Sender<Result<Transcript, String>>,
        )>,
        mut pick: impl FnMut(FromWorker) -> Option<T>,
    ) -> Wait<T> {
        let Some(gen) = self.worker.as_ref().map(|w| w.gen) else {
            return Wait::Exited;
        };
        let mut cancel_sent = false;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Wait::TimedOut;
            }
            let step = (deadline - now).min(Duration::from_millis(200));
            let event = match self.events.recv_timeout(step) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    if let Some((id, reply)) = job {
                        if !cancel_sent && reply.is_closed() {
                            cancel_sent = true;
                            if let Some(worker) = &self.worker {
                                worker.send(&ToWorker::Cancel { id });
                            }
                        }
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return Wait::Closed,
            };
            match event {
                Event::Job(job) => self.backlog.push_back(job),
                Event::Closed => {
                    self.closed = true;
                    return Wait::Closed;
                }
                Event::Worker { gen: from, .. } if from != gen => {}
                Event::Worker {
                    message: WorkerMessage::Exited,
                    ..
                } => return Wait::Exited,
                Event::Worker {
                    message: WorkerMessage::Line(line),
                    ..
                } => {
                    if let FromWorker::Error {
                        id: None, message, ..
                    } = &line
                    {
                        eprintln!("stt: the speech engine reported: {message}");
                    }
                    if let Some(value) = pick(line) {
                        return Wait::Got(value);
                    }
                }
            }
        }
    }

    /// Asks the worker to exit, then makes sure it has.
    fn shut_down(&mut self) {
        let Some(worker) = &self.worker else {
            return;
        };
        worker.send(&ToWorker::Shutdown);
        let _ = self.wait(Instant::now() + Duration::from_secs(1), None, |m| {
            matches!(m, FromWorker::Bye).then_some(())
        });
        self.worker = None;
    }
}
