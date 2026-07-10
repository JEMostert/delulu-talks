use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use arboard::Clipboard;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, Stream, StreamConfig,
};
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const SETTINGS_FILE: &str = "settings.json";
const HISTORY_FILE: &str = "history.json";
const ASR_ERROR_FILE: &str = "last-asr-error.log";
const ASR_SIDECAR_LOG_FILE: &str = "asr-sidecar.log";
const DICTATION_EVENT: &str = "dictation-state";
const TRANSCRIPT_EVENT: &str = "dictation-transcript";
const OVERLAY_LABEL: &str = "overlay";
const DEFAULT_INPUT_DEVICE: &str = "default";
const OVERLAY_BOTTOM_GAP_LOGICAL_PX: f64 = 56.0;
const MIN_RECORDING_DURATION_MS: u64 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RecordingMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ModelOption {
    ParakeetTdt06bV3,
    MossTranscribeDiarize,
    CohereTranscribe,
    Nemotron35Streaming,
}

impl ModelOption {
    fn as_hf_id(self) -> &'static str {
        match self {
            Self::ParakeetTdt06bV3 => "nvidia/parakeet-tdt-0.6b-v3",
            Self::MossTranscribeDiarize => "OpenMOSS-Team/MOSS-Transcribe-Diarize",
            Self::CohereTranscribe => "CohereLabs/cohere-transcribe-03-2026",
            Self::Nemotron35Streaming => "nvidia/nemotron-3.5-asr-streaming-0.6b",
        }
    }

    fn required_python_packages(self) -> Vec<&'static str> {
        if self == Self::ParakeetTdt06bV3 {
            return vec![
                "transcribe-cpp==0.1.2",
                "huggingface-hub>=1.0.0",
                "soundfile",
                "librosa",
            ];
        }

        let mut packages = vec![
            "torch",
            "torchaudio",
            "accelerate",
            "soundfile",
            "librosa",
            "sentencepiece",
            "protobuf",
        ];

        match self {
            Self::MossTranscribeDiarize => {
                packages.push("git+https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git")
            }
            Self::CohereTranscribe | Self::Nemotron35Streaming => {
                packages.push("transformers>=5.4.0")
            }
            Self::ParakeetTdt06bV3 => unreachable!(),
        }

        packages
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OutputStyle {
    Smart,
    Plain,
    SpeakerAware,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CustomWord {
    id: String,
    term: String,
    sounds_like: String,
    replacement: String,
    enabled: bool,
}

impl Default for CustomWord {
    fn default() -> Self {
        Self {
            id: String::new(),
            term: String::new(),
            sounds_like: String::new(),
            replacement: String::new(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AppSettings {
    shortcut: String,
    recording_mode: RecordingMode,
    model: ModelOption,
    language: String,
    python_command: String,
    input_device: String,
    output_style: OutputStyle,
    auto_paste: bool,
    keep_history: bool,
    punctuation: bool,
    custom_words: Vec<CustomWord>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: "Ctrl+Shift+Space".to_string(),
            recording_mode: RecordingMode::Hold,
            model: ModelOption::ParakeetTdt06bV3,
            language: "auto".to_string(),
            python_command: "python3".to_string(),
            input_device: DEFAULT_INPUT_DEVICE.to_string(),
            output_style: OutputStyle::Smart,
            auto_paste: true,
            keep_history: true,
            punctuation: true,
            custom_words: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum DictationPhase {
    Idle,
    Bootstrapping,
    Listening,
    Transcribing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationStatus {
    phase: DictationPhase,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptSegment {
    start: f64,
    end: f64,
    speaker: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionResult {
    text: String,
    raw_text: String,
    language: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptRecord {
    id: String,
    created_at: u64,
    duration_ms: u64,
    text: String,
    raw_text: String,
    model: ModelOption,
    language: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimePhase {
    Idle,
    Listening,
    Transcribing,
}

enum WorkerCommand {
    Start,
    Stop,
    Toggle,
}

struct RecorderSession {
    stream: Stream,
    writer: Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>,
    path: PathBuf,
    started_at: Instant,
}

impl RecorderSession {
    fn finalize(self) -> Result<(PathBuf, u64), String> {
        let duration_ms = self.started_at.elapsed().as_millis() as u64;
        drop(self.stream);

        if let Some(writer) = self
            .writer
            .lock()
            .map_err(|_| "Failed to lock audio writer".to_string())?
            .take()
        {
            writer
                .finalize()
                .map_err(|err| format!("Failed to finalize WAV file: {err}"))?;
        }

        Ok((self.path, duration_ms))
    }
}

struct AsrSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    model: ModelOption,
}

impl Drop for AsrSidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrSidecarRequest<'a> {
    audio: String,
    model: &'a str,
    language: &'a str,
    output_style: &'a str,
    custom_words: &'a [CustomWord],
    punctuation: bool,
}

impl AsrSidecar {
    fn request(&mut self, request: &AsrSidecarRequest<'_>) -> Result<TranscriptionResult, String> {
        serde_json::to_writer(&mut self.stdin, request)
            .map_err(|err| format!("Failed to encode ASR request: {err}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|err| format!("Failed to send ASR request: {err}"))?;

        let mut response = String::new();
        let bytes = self
            .stdout
            .read_line(&mut response)
            .map_err(|err| format!("Failed to read ASR response: {err}"))?;
        if bytes == 0 {
            let status = self
                .child
                .try_wait()
                .ok()
                .flatten()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            return Err(format!("ASR sidecar exited unexpectedly ({status})"));
        }

        let value: serde_json::Value = serde_json::from_str(response.trim())
            .map_err(|err| format!("Invalid response from ASR sidecar: {err}"))?;
        if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
            return Err(error.to_string());
        }

        serde_json::from_value(value)
            .map_err(|err| format!("Invalid transcript from ASR sidecar: {err}"))
    }
}

struct AppRuntime {
    settings: Mutex<AppSettings>,
    phase: Mutex<RuntimePhase>,
    ready: Mutex<bool>,
    clipboard: Mutex<Option<Clipboard>>,
    setup_in_progress: AtomicBool,
    bootstrap_lock: Mutex<()>,
    registered_shortcut: Mutex<String>,
    asr_sidecar: Mutex<Option<AsrSidecar>>,
    worker_tx: Sender<WorkerCommand>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;

    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create app data dir: {err}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return AppSettings::default();
    };

    let Ok(raw) = fs::read_to_string(path) else {
        return AppSettings::default();
    };

    serde_json::from_str::<AppSettings>(&raw).unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed to serialize settings: {err}"))?;
    fs::write(path, serialized).map_err(|err| format!("Failed to persist settings: {err}"))
}

fn asr_error_path(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = settings_path(app)?;
    Ok(settings.with_file_name(ASR_ERROR_FILE))
}

fn asr_sidecar_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = settings_path(app)?;
    Ok(settings.with_file_name(ASR_SIDECAR_LOG_FILE))
}

fn concise_asr_error(stderr: &str) -> String {
    let detail = stderr
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.contains("unauthenticated requests")
                && !line.contains("Loading weights")
                && !line.contains("feature_extractor_class")
        })
        .last()
        .unwrap_or("The ASR sidecar exited without a readable error.");

    detail.chars().take(500).collect()
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create app data dir: {err}"))?;
    Ok(dir.join(HISTORY_FILE))
}

fn load_history(app: &AppHandle) -> Result<Vec<TranscriptRecord>, String> {
    let path = history_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("Failed to read history: {err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("Failed to parse history: {err}"))
}

fn save_history(app: &AppHandle, records: &[TranscriptRecord]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(records)
        .map_err(|err| format!("Failed to encode history: {err}"))?;
    fs::write(history_path(app)?, raw).map_err(|err| format!("Failed to write history: {err}"))
}

fn append_history(app: &AppHandle, record: TranscriptRecord) -> Result<(), String> {
    let mut records = load_history(app)?;
    records.insert(0, record);
    records.truncate(250);
    save_history(app, &records)
}

fn list_input_devices_internal() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let mut devices = vec![DEFAULT_INPUT_DEVICE.to_string()];

    let found = host
        .input_devices()
        .map_err(|err| format!("Failed to list input devices: {err}"))?;

    for device in found {
        if let Ok(name) = device.name() {
            if !name.trim().is_empty() && !devices.contains(&name) {
                devices.push(name);
            }
        }
    }

    Ok(devices)
}

fn next_wav_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("Failed to resolve app cache dir: {err}"))?;

    fs::create_dir_all(&cache_dir)
        .map_err(|err| format!("Failed to create app cache dir: {err}"))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System time error: {err}"))?
        .as_millis();

    cache_dir.push(format!("dictation-{ts}.wav"));
    Ok(cache_dir)
}

fn cleanup_stale_recordings(app: &AppHandle) {
    let Ok(cache_dir) = app.path().app_cache_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_stale_recording = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("dictation-") && name.ends_with(".wav"))
            .unwrap_or(false);
        if is_stale_recording {
            let _ = fs::remove_file(path);
        }
    }
}

fn write_i16_samples(
    samples: &[i16],
    writer: &Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>,
) {
    let Ok(mut guard) = writer.lock() else {
        return;
    };

    let Some(writer) = guard.as_mut() else {
        return;
    };

    for &sample in samples {
        let _ = writer.write_sample(sample);
    }
}

fn write_u16_samples(
    samples: &[u16],
    writer: &Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>,
) {
    let Ok(mut guard) = writer.lock() else {
        return;
    };

    let Some(writer) = guard.as_mut() else {
        return;
    };

    for &sample in samples {
        let centered = (sample as i32 - 32_768) as i16;
        let _ = writer.write_sample(centered);
    }
}

fn write_f32_samples(
    samples: &[f32],
    writer: &Arc<Mutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>,
) {
    let Ok(mut guard) = writer.lock() else {
        return;
    };

    let Some(writer) = guard.as_mut() else {
        return;
    };

    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let s = (clamped * i16::MAX as f32) as i16;
        let _ = writer.write_sample(s);
    }
}

fn resolve_input_device(settings: &AppSettings) -> Result<cpal::Device, String> {
    let host = cpal::default_host();

    if settings.input_device == DEFAULT_INPUT_DEVICE {
        return host
            .default_input_device()
            .ok_or_else(|| "No default microphone found".to_string());
    }

    let devices = host
        .input_devices()
        .map_err(|err| format!("Failed to list input devices: {err}"))?;

    for device in devices {
        if let Ok(name) = device.name() {
            if name == settings.input_device {
                return Ok(device);
            }
        }
    }

    host.default_input_device().ok_or_else(|| {
        format!(
            "Configured microphone '{}' not found and no default device available",
            settings.input_device
        )
    })
}

fn start_recorder(app: &AppHandle, settings: &AppSettings) -> Result<RecorderSession, String> {
    let input_device = resolve_input_device(settings)?;

    let supported = input_device
        .default_input_config()
        .map_err(|err| format!("Failed to read input config: {err}"))?;

    let wav_path = next_wav_path(app)?;
    let spec = WavSpec {
        channels: supported.channels(),
        sample_rate: supported.sample_rate().0,
        bits_per_sample: 16,
        sample_format: WavSampleFormat::Int,
    };

    let writer = WavWriter::create(&wav_path, spec)
        .map_err(|err| format!("Failed to create WAV writer: {err}"))?;
    let writer = Arc::new(Mutex::new(Some(writer)));

    let stream_config: StreamConfig = supported.clone().into();
    let err_fn = |err| {
        eprintln!("audio input stream error: {err}");
    };

    let stream = match supported.sample_format() {
        SampleFormat::I16 => {
            let writer = writer.clone();
            input_device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| write_i16_samples(data, &writer),
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build i16 input stream: {err}"))?
        }
        SampleFormat::U16 => {
            let writer = writer.clone();
            input_device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| write_u16_samples(data, &writer),
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build u16 input stream: {err}"))?
        }
        SampleFormat::F32 => {
            let writer = writer.clone();
            input_device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| write_f32_samples(data, &writer),
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Failed to build f32 input stream: {err}"))?
        }
        other => {
            return Err(format!("Unsupported sample format: {other:?}"));
        }
    };

    stream
        .play()
        .map_err(|err| format!("Failed to start audio capture: {err}"))?;

    Ok(RecorderSession {
        stream,
        writer,
        path: wav_path,
        started_at: Instant::now(),
    })
}

fn resolve_transcriber_script(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("python").join("transcription_engine.py"));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("transcription_engine.py"),
    );

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("python")
                .join("transcription_engine.py"),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "Could not locate transcription_engine.py".to_string())
}

fn command_error(prefix: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    if detail.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}: {detail}")
    }
}

fn configure_child_process(_command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn python_version(command_name: &str) -> Result<(u32, u32, u32), String> {
    let (program, args) = command_program_and_args(command_name);
    let mut command = Command::new(program);
    command.args(args);
    command.args([
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
    ]);
    configure_child_process(&mut command);

    let output = command
        .output()
        .map_err(|err| format!("Python command '{command_name}' failed to start: {err}"))?;

    if !output.status.success() {
        return Err(command_error(
            &format!("Python command '{command_name}' is not usable"),
            &output.stderr,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version_text = stdout.trim();
    let mut parts = version_text
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());

    let major = parts
        .next()
        .ok_or_else(|| format!("Could not parse Python version from '{version_text}'"))?;
    let minor = parts
        .next()
        .ok_or_else(|| format!("Could not parse Python version from '{version_text}'"))?;
    let patch = parts.next().unwrap_or(0);

    Ok((major, minor, patch))
}

fn supports_asr_packages(version: (u32, u32, u32)) -> bool {
    version.0 == 3 && (10..=13).contains(&version.1)
}

fn resolve_base_python_command(settings: &AppSettings) -> Result<String, String> {
    let configured = settings.python_command.trim();
    if configured.is_empty() {
        return Err("Python command cannot be empty".to_string());
    }

    let generic_python = configured == "python" || configured == "python3";
    let candidates: Vec<String> = if generic_python {
        #[cfg(windows)]
        {
            vec![
                "py -3.12".to_string(),
                "py -3.11".to_string(),
                configured.to_string(),
            ]
        }
        #[cfg(not(windows))]
        {
            vec![
                "python3.12".to_string(),
                "python3.11".to_string(),
                "python3.10".to_string(),
                configured.to_string(),
            ]
        }
    } else {
        vec![configured.to_string()]
    };

    let mut errors = Vec::new();
    for candidate in candidates {
        match python_version(&candidate) {
            Ok(version) if supports_asr_packages(version) => return Ok(candidate),
            Ok(version) => errors.push(format!(
                "{candidate} is Python {}.{}.{}; ASR dependencies need Python 3.10-3.13",
                version.0, version.1, version.2
            )),
            Err(err) => errors.push(err),
        }
    }

    Err(format!(
        "No supported Python runtime found. Install Python 3.11 or 3.12, or set Python Command explicitly. Checked: {}",
        errors.join("; ")
    ))
}

fn command_program_and_args(command_text: &str) -> (OsString, Vec<OsString>) {
    let mut parts = command_text.split_whitespace();
    let program = parts.next().unwrap_or(command_text).into();
    let args = parts.map(OsString::from).collect();
    (program, args)
}

fn python_command(settings: &AppSettings) -> Result<Command, String> {
    let resolved = resolve_base_python_command(settings)?;
    let (program, args) = command_program_and_args(&resolved);
    let mut command = Command::new(program);
    command.args(args);
    Ok(command)
}

fn asr_venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(settings_path(app)?
        .parent()
        .ok_or_else(|| "Failed to resolve app data directory".to_string())?
        .join("asr-venv"))
}

fn asr_venv_python(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = asr_venv_dir(app)?;

    #[cfg(windows)]
    {
        path.push("Scripts");
        path.push("python.exe");
    }

    #[cfg(not(windows))]
    {
        path.push("bin");
        path.push("python");
    }

    Ok(path)
}

fn venv_python_command(app: &AppHandle) -> Result<Command, String> {
    let python_path = asr_venv_python(app)?;
    if !python_path.exists() {
        return Err("ASR environment is not set up yet. Open Runtime and run setup.".to_string());
    }

    Ok(Command::new(python_path))
}

fn ensure_python_binary(settings: &AppSettings) -> Result<(), String> {
    let resolved = resolve_base_python_command(settings)?;
    let mut command = python_command(settings)?;
    command.arg("--version");
    configure_child_process(&mut command);

    let output = command
        .output()
        .map_err(|err| format!("Python command '{resolved}' failed to start: {err}",))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(
            &format!("Python command '{resolved}' is not usable"),
            &output.stderr,
        ))
    }
}

fn ensure_asr_venv(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let venv_python = asr_venv_python(app)?;
    if venv_python.exists() {
        return Ok(());
    }

    let venv_dir = asr_venv_dir(app)?;
    if let Some(parent) = venv_dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create app data directory: {err}"))?;
    }

    let mut command = python_command(settings)?;
    command.args(["-m", "venv"]);
    command.arg(&venv_dir);
    configure_child_process(&mut command);

    let output = command
        .output()
        .map_err(|err| format!("Failed launching Python venv creation: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(
            "Failed to create ASR Python environment",
            &output.stderr,
        ))
    }
}

fn ensure_python_dependencies(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let mut check_command = venv_python_command(app)?;
    let dependency_check = dependency_check_script(settings.model);
    check_command.args(["-c", dependency_check]);
    configure_child_process(&mut check_command);

    let check = check_command.output().map_err(|err| {
        format!(
            "Dependency check failed for '{}': {err}",
            settings.python_command
        )
    })?;

    if check.status.success() {
        return Ok(());
    }

    let packages = settings.model.required_python_packages();
    let mut install_command = venv_python_command(app)?;
    install_command.args(["-m", "pip", "install", "--upgrade", "pip"]);
    configure_child_process(&mut install_command);

    let pip = install_command
        .output()
        .map_err(|err| format!("Failed launching pip upgrade: {err}"))?;

    if !pip.status.success() {
        return Err(command_error(
            "Failed to upgrade ASR environment pip",
            &pip.stderr,
        ));
    }

    let mut install_command = venv_python_command(app)?;
    install_command.args(["-m", "pip", "install", "-U"]);
    install_command.args(&packages);
    configure_child_process(&mut install_command);

    let install = install_command
        .output()
        .map_err(|err| format!("Failed launching pip installer: {err}"))?;

    if install.status.success() {
        Ok(())
    } else {
        let install_hint = format!(
            "Auto-install failed (pip install -U {})",
            packages.join(" ")
        );
        Err(command_error(&install_hint, &install.stderr))
    }
}

fn dependency_check_script(model: ModelOption) -> &'static str {
    match model {
        ModelOption::ParakeetTdt06bV3 => "import transcribe_cpp, huggingface_hub, soundfile, librosa",
        ModelOption::MossTranscribeDiarize => "import torch, transformers, soundfile, librosa, moss_transcribe_diarize",
        ModelOption::CohereTranscribe => "import torch, transformers, soundfile, librosa; assert hasattr(transformers, 'CohereAsrForConditionalGeneration')",
        ModelOption::Nemotron35Streaming => "import torch, transformers, soundfile, librosa",
    }
}

fn is_asr_environment_ready(app: &AppHandle, settings: &AppSettings) -> bool {
    let Ok(mut check_command) = venv_python_command(app) else {
        return false;
    };

    check_command.args(["-c", dependency_check_script(settings.model)]);
    configure_child_process(&mut check_command);

    check_command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn warmup_selected_model(settings: &AppSettings, app: &AppHandle) -> Result<(), String> {
    let script_path = resolve_transcriber_script(app)?;

    let mut command = venv_python_command(app)?;
    command
        .arg(script_path)
        .arg("--warmup")
        .arg("--model")
        .arg(settings.model.as_hf_id())
        .arg("--language")
        .arg(&settings.language);
    configure_child_process(&mut command);

    let output = command
        .output()
        .map_err(|err| format!("Failed launching model warmup: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error("Model warmup failed", &output.stderr))
    }
}

fn bootstrap_asr_runtime(
    app: &AppHandle,
    state: &Arc<AppRuntime>,
    settings: AppSettings,
) -> Result<(), String> {
    let _bootstrap_guard = state
        .bootstrap_lock
        .lock()
        .map_err(|_| "Failed to lock bootstrap state".to_string())?;

    let _ = set_runtime_ready(state, false);
    emit_status(
        app,
        DictationPhase::Bootstrapping,
        Some("Checking Python runtime...".to_string()),
    );

    ensure_python_binary(&settings)?;

    emit_status(
        app,
        DictationPhase::Bootstrapping,
        Some("Creating app ASR environment...".to_string()),
    );
    ensure_asr_venv(app, &settings)?;

    emit_status(
        app,
        DictationPhase::Bootstrapping,
        Some("Installing ASR dependencies into app environment...".to_string()),
    );
    ensure_python_dependencies(app, &settings)?;

    emit_status(
        app,
        DictationPhase::Bootstrapping,
        Some("Preparing selected model (first run may download)...".to_string()),
    );
    warmup_selected_model(&settings, app)?;

    let selection_is_current = state
        .settings
        .lock()
        .map(|current| {
            current.model == settings.model && current.python_command == settings.python_command
        })
        .map_err(|_| "Failed to verify selected model after setup".to_string())?;

    if !selection_is_current {
        let _ = set_runtime_ready(state, false);
        emit_status(
            app,
            DictationPhase::Idle,
            Some(
                "Setup finished for the previous selection. Run setup for the current model."
                    .to_string(),
            ),
        );
        return Ok(());
    }

    let _ = set_runtime_ready(state, true);
    emit_status(app, DictationPhase::Idle, Some("Ready".to_string()));
    preload_asr_sidecar(app.clone(), state.clone(), settings);
    Ok(())
}

fn spawn_bootstrap_task(
    app: AppHandle,
    state: Arc<AppRuntime>,
    settings: AppSettings,
) -> Result<(), String> {
    if state.setup_in_progress.swap(true, Ordering::SeqCst) {
        return Err("ASR setup is already running.".to_string());
    }

    thread::spawn(move || {
        if let Err(err) = bootstrap_asr_runtime(&app, &state, settings) {
            let _ = set_runtime_ready(&state, false);
            emit_status(&app, DictationPhase::Error, Some(err));
        }
        state.setup_in_progress.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn initialize_runtime_readiness(app: &AppHandle, state: &Arc<AppRuntime>, settings: &AppSettings) {
    if is_asr_environment_ready(app, settings) {
        let _ = set_runtime_ready(state, true);
        emit_status(app, DictationPhase::Idle, Some("Ready".to_string()));
        preload_asr_sidecar(app.clone(), state.clone(), settings.clone());
    } else {
        let _ = set_runtime_ready(state, false);
        emit_status(
            app,
            DictationPhase::Idle,
            Some("ASR environment setup required".to_string()),
        );
    }
}

fn output_style_name(style: OutputStyle) -> &'static str {
    match style {
        OutputStyle::Smart => "smart",
        OutputStyle::Plain => "plain",
        OutputStyle::SpeakerAware => "speaker-aware",
    }
}

fn spawn_asr_sidecar(settings: &AppSettings, app: &AppHandle) -> Result<AsrSidecar, String> {
    let script_path = resolve_transcriber_script(app)?;
    let log_file = fs::File::create(asr_sidecar_log_path(app)?)
        .map_err(|err| format!("Failed to create ASR sidecar log: {err}"))?;

    let mut command = venv_python_command(app)?;
    command
        .arg(script_path)
        .arg("--serve")
        .arg("--model")
        .arg(settings.model.as_hf_id())
        .arg("--language")
        .arg(&settings.language)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log_file));
    configure_child_process(&mut command);

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to start persistent ASR sidecar: {err}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Persistent ASR sidecar has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Persistent ASR sidecar has no stdout".to_string())?;
    let mut sidecar = AsrSidecar {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        model: settings.model,
    };

    let mut ready = String::new();
    let bytes = sidecar
        .stdout
        .read_line(&mut ready)
        .map_err(|err| format!("Failed waiting for ASR sidecar warmup: {err}"))?;
    if bytes == 0 {
        return Err("Persistent ASR sidecar exited during warmup".to_string());
    }
    let response: serde_json::Value = serde_json::from_str(ready.trim())
        .map_err(|err| format!("Invalid ASR sidecar warmup response: {err}"))?;
    if let Some(error) = response.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    if response.get("ready").and_then(|value| value.as_bool()) != Some(true) {
        return Err("ASR sidecar did not report ready".to_string());
    }

    Ok(sidecar)
}

fn stop_asr_sidecar(state: &Arc<AppRuntime>) {
    if let Ok(mut sidecar) = state.asr_sidecar.lock() {
        sidecar.take();
    }
}

fn preload_asr_sidecar(app: AppHandle, state: Arc<AppRuntime>, settings: AppSettings) {
    if settings.model != ModelOption::ParakeetTdt06bV3 {
        return;
    }

    thread::spawn(move || {
        let Ok(mut guard) = state.asr_sidecar.lock() else {
            return;
        };
        if guard
            .as_ref()
            .is_some_and(|sidecar| sidecar.model == settings.model)
        {
            return;
        }
        match spawn_asr_sidecar(&settings, &app) {
            Ok(sidecar) => *guard = Some(sidecar),
            Err(err) => eprintln!("Could not preload ASR sidecar: {err}"),
        }
    });
}

fn transcribe_audio_once(
    settings: &AppSettings,
    app: &AppHandle,
    audio_path: &Path,
) -> Result<TranscriptionResult, String> {
    let script_path = resolve_transcriber_script(app)?;

    let mut command = venv_python_command(app)?;
    command
        .arg(script_path)
        .arg("--audio")
        .arg(audio_path)
        .arg("--model")
        .arg(settings.model.as_hf_id())
        .arg("--language")
        .arg(&settings.language)
        .arg("--output-style")
        .arg(output_style_name(settings.output_style))
        .arg("--vocabulary-json")
        .arg(
            serde_json::to_string(&settings.custom_words)
                .map_err(|err| format!("Failed to encode vocabulary: {err}"))?,
        );
    if settings.punctuation {
        command.arg("--punctuation");
    }
    configure_child_process(&mut command);

    let output = command.output().map_err(|err| {
        format!(
            "Failed to launch Python process '{}': {err}",
            asr_venv_python(app)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| settings.python_command.clone())
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = fs::write(asr_error_path(app)?, stderr.as_bytes());
        return Err(format!(
            "ASR sidecar failed: {}",
            concise_asr_error(&stderr)
        ));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|err| format!("Invalid UTF-8 from sidecar: {err}"))?;
    let transcript: TranscriptionResult = serde_json::from_str(stdout.trim())
        .map_err(|err| format!("Invalid response from ASR sidecar: {err}"))?;

    if transcript.text.trim().is_empty() {
        return Err("ASR returned empty transcript".to_string());
    }

    Ok(transcript)
}

fn transcribe_audio(
    settings: &AppSettings,
    app: &AppHandle,
    state: &Arc<AppRuntime>,
    audio_path: &Path,
) -> Result<TranscriptionResult, String> {
    if settings.model != ModelOption::ParakeetTdt06bV3 {
        return transcribe_audio_once(settings, app, audio_path);
    }

    let request = AsrSidecarRequest {
        audio: audio_path.display().to_string(),
        model: settings.model.as_hf_id(),
        language: &settings.language,
        output_style: output_style_name(settings.output_style),
        custom_words: &settings.custom_words,
        punctuation: settings.punctuation,
    };

    let mut guard = state
        .asr_sidecar
        .lock()
        .map_err(|_| "Failed to lock persistent ASR sidecar".to_string())?;
    if guard
        .as_ref()
        .is_none_or(|sidecar| sidecar.model != settings.model)
    {
        *guard = Some(spawn_asr_sidecar(settings, app)?);
    }

    let first_result = guard
        .as_mut()
        .ok_or_else(|| "Persistent ASR sidecar is unavailable".to_string())?
        .request(&request);
    let transcript_result = match first_result {
        Ok(transcript) => Ok(transcript),
        Err(first_error) => {
            *guard = None;
            match spawn_asr_sidecar(settings, app) {
                Ok(mut sidecar) => {
                    let result = sidecar.request(&request);
                    *guard = Some(sidecar);
                    result
                }
                Err(restart_error) => Err(format!(
                    "{first_error}; restarting sidecar failed: {restart_error}"
                )),
            }
        }
    };
    let transcript = transcript_result.map_err(|err| {
        if let Ok(path) = asr_error_path(app) {
            let _ = fs::write(path, err.as_bytes());
        }
        format!("ASR sidecar failed: {err}")
    })?;

    if transcript.text.trim().is_empty() {
        return Err("ASR returned empty transcript".to_string());
    }

    Ok(transcript)
}

fn copy_text_to_clipboard(state: &Arc<AppRuntime>, transcript: &str) -> Result<(), String> {
    if transcript.is_empty() {
        return Ok(());
    }

    let mut clipboard_guard = state
        .clipboard
        .lock()
        .map_err(|_| "Failed to lock clipboard state".to_string())?;

    if clipboard_guard.is_none() {
        *clipboard_guard = Some(
            Clipboard::new().map_err(|err| format!("Clipboard initialization failed: {err}"))?,
        );
    }

    let clipboard = clipboard_guard
        .as_mut()
        .ok_or_else(|| "Clipboard is unavailable".to_string())?;
    clipboard
        .set_text(transcript.to_string())
        .map_err(|err| format!("Failed to write transcript to clipboard: {err}"))
}

fn paste_clipboard_at_cursor() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;

    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    // Give X11/Wayland clipboard ownership time to settle before requesting a
    // paste in the previously focused application.
    thread::sleep(Duration::from_millis(60));

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|err| format!("Input automation init failed: {err}"))?;

    enigo
        .key(modifier, Press)
        .and_then(|_| enigo.key(Key::Unicode('v'), Click))
        .and_then(|_| enigo.key(modifier, Release))
        .map_err(|err| format!("Auto-paste failed: {err}"))
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window
        .show()
        .map_err(|err| format!("Failed to show main window: {err}"))?;
    window
        .set_focus()
        .map_err(|err| format!("Failed to focus main window: {err}"))
}

fn hide_settings_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    window
        .hide()
        .map_err(|err| format!("Failed to hide main window: {err}"))
}

fn ensure_overlay_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    let _window = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .title("Dictation Overlay")
    .inner_size(280.0, 72.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .focusable(false)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|err| format!("Failed to create overlay window: {err}"))?;

    Ok(())
}

fn place_overlay_bottom_center(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };

    // Resolve from the center of the main window instead of the hidden overlay.
    // `current_monitor` alone is unreliable when a window crosses display edges.
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| {
            let position = main.outer_position().ok()?;
            let size = main.outer_size().ok()?;
            let center_x = position.x as f64 + size.width as f64 / 2.0;
            let center_y = position.y as f64 + size.height as f64 / 2.0;
            main.monitor_from_point(center_x, center_y).ok().flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten());

    let monitor = monitor.or_else(|| window.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return;
    };

    let work_area = monitor.work_area();
    let overlay_size = match window.inner_size() {
        Ok(size) => size,
        Err(_) => return,
    };

    let x = work_area.position.x + ((work_area.size.width as i32 - overlay_size.width as i32) / 2);
    let bottom_margin = (OVERLAY_BOTTOM_GAP_LOGICAL_PX * monitor.scale_factor()).round() as i32;
    let y = work_area.position.y + work_area.size.height as i32
        - overlay_size.height as i32
        - bottom_margin;

    if let Err(error) = window.set_position(Position::Physical(PhysicalPosition::new(x, y))) {
        eprintln!("Could not place dictation overlay at bottom center: {error}");
    }
}

fn emit_status(app: &AppHandle, phase: DictationPhase, message: Option<String>) {
    let payload = DictationStatus {
        phase: phase.clone(),
        message,
    };

    let _ = app.emit(DICTATION_EVENT, payload.clone());

    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.emit(DICTATION_EVENT, payload);

        match phase {
            DictationPhase::Idle => {
                let _ = overlay.hide();
            }
            _ => {
                // Map the native window first. Several Linux window managers apply
                // their default centered placement when a hidden window is shown,
                // which would otherwise overwrite our bottom-center coordinates.
                let _ = overlay.show();
                let _ = overlay.set_always_on_top(true);
                place_overlay_bottom_center(app);

                // Reapply once after the compositor has finished mapping the
                // window. This is especially important under KDE/XWayland.
                let app_handle = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(60));
                    if let Some(overlay) = app_handle.get_webview_window(OVERLAY_LABEL) {
                        let _ = overlay.set_always_on_top(true);
                        place_overlay_bottom_center(&app_handle);
                    }
                });
            }
        }
    }
}

fn set_phase(state: &Arc<AppRuntime>, phase: RuntimePhase) -> Result<(), String> {
    *state
        .phase
        .lock()
        .map_err(|_| "Failed to lock runtime phase".to_string())? = phase;
    Ok(())
}

fn current_phase(state: &Arc<AppRuntime>) -> Result<RuntimePhase, String> {
    state
        .phase
        .lock()
        .map(|phase| *phase)
        .map_err(|_| "Failed to lock runtime phase".to_string())
}

fn set_runtime_ready(state: &Arc<AppRuntime>, ready: bool) -> Result<(), String> {
    *state
        .ready
        .lock()
        .map_err(|_| "Failed to lock runtime readiness".to_string())? = ready;
    Ok(())
}

fn is_runtime_ready(state: &Arc<AppRuntime>) -> Result<bool, String> {
    state
        .ready
        .lock()
        .map(|ready| *ready)
        .map_err(|_| "Failed to lock runtime readiness".to_string())
}

fn worker_start(app: &AppHandle, state: &Arc<AppRuntime>, active: &mut Option<RecorderSession>) {
    if active.is_some() {
        return;
    }

    match current_phase(state) {
        Ok(RuntimePhase::Transcribing) => return,
        Ok(RuntimePhase::Listening) => return,
        Ok(RuntimePhase::Idle) => {}
        Err(err) => {
            emit_status(app, DictationPhase::Error, Some(err));
            return;
        }
    }

    match is_runtime_ready(state) {
        Ok(true) => {}
        Ok(false) => {
            emit_status(
                app,
                DictationPhase::Bootstrapping,
                Some("ASR setup still running. Please wait...".to_string()),
            );
            return;
        }
        Err(err) => {
            emit_status(app, DictationPhase::Error, Some(err));
            return;
        }
    }

    let settings = match state.settings.lock() {
        Ok(settings) => settings.clone(),
        Err(_) => {
            emit_status(
                app,
                DictationPhase::Error,
                Some("Failed to lock settings".to_string()),
            );
            return;
        }
    };

    match start_recorder(app, &settings) {
        Ok(session) => {
            *active = Some(session);
            let _ = set_phase(state, RuntimePhase::Listening);
            emit_status(
                app,
                DictationPhase::Listening,
                Some("Listening...".to_string()),
            );
        }
        Err(err) => {
            let _ = set_phase(state, RuntimePhase::Idle);
            emit_status(app, DictationPhase::Error, Some(err));
        }
    }
}

fn worker_stop(app: &AppHandle, state: &Arc<AppRuntime>, active: &mut Option<RecorderSession>) {
    if current_phase(state).ok() != Some(RuntimePhase::Listening) {
        return;
    }

    let Some(session) = active.take() else {
        return;
    };

    let (audio_path, duration_ms) = match session.finalize() {
        Ok(result) => result,
        Err(err) => {
            let _ = set_phase(state, RuntimePhase::Idle);
            emit_status(app, DictationPhase::Error, Some(err));
            return;
        }
    };

    let captured_bytes = fs::metadata(&audio_path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if duration_ms < MIN_RECORDING_DURATION_MS || captured_bytes <= 44 {
        let _ = fs::remove_file(&audio_path);
        let _ = set_phase(state, RuntimePhase::Idle);
        emit_status(
            app,
            DictationPhase::Error,
            Some(
                "Recording was too short. Hold the shortcut while speaking, then release."
                    .to_string(),
            ),
        );
        return;
    }

    let _ = set_phase(state, RuntimePhase::Transcribing);
    emit_status(
        app,
        DictationPhase::Transcribing,
        Some("Transcribing speech...".to_string()),
    );

    let settings = match state.settings.lock() {
        Ok(settings) => settings.clone(),
        Err(_) => {
            let _ = set_phase(state, RuntimePhase::Idle);
            emit_status(
                app,
                DictationPhase::Error,
                Some("Failed to lock settings".to_string()),
            );
            return;
        }
    };

    let transcript = transcribe_audio(&settings, app, state, &audio_path);

    let completion_message = match transcript {
        Ok(result) => {
            let created_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let record = TranscriptRecord {
                id: format!("capture-{created_at}"),
                created_at,
                duration_ms,
                text: result.text.clone(),
                raw_text: result.raw_text,
                model: settings.model,
                language: result.language,
                segments: result.segments,
            };
            if settings.keep_history {
                let _ = append_history(app, record.clone());
            }
            let _ = app.emit(TRANSCRIPT_EVENT, record.clone());

            if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = overlay.hide();
            }

            match copy_text_to_clipboard(state, &record.text) {
                Ok(()) if settings.auto_paste => match paste_clipboard_at_cursor() {
                    Ok(()) => Some("Copied and pasted transcript".to_string()),
                    Err(err) => Some(format!(
                        "Transcript copied — paste manually with Ctrl+V ({err})"
                    )),
                },
                Ok(()) => Some("Transcript copied to clipboard".to_string()),
                Err(err) => Some(format!(
                    "Transcript saved, but clipboard copy failed: {err}"
                )),
            }
        }
        Err(err) => {
            let _ = fs::remove_file(&audio_path);
            let _ = set_phase(state, RuntimePhase::Idle);
            emit_status(app, DictationPhase::Error, Some(err));
            return;
        }
    };

    let _ = fs::remove_file(&audio_path);
    let _ = set_phase(state, RuntimePhase::Idle);
    emit_status(app, DictationPhase::Idle, completion_message);
}

fn run_worker_loop(app: AppHandle, state: Arc<AppRuntime>, rx: Receiver<WorkerCommand>) {
    let mut active_session: Option<RecorderSession> = None;

    while let Ok(command) = rx.recv() {
        match command {
            WorkerCommand::Start => worker_start(&app, &state, &mut active_session),
            WorkerCommand::Stop => worker_stop(&app, &state, &mut active_session),
            WorkerCommand::Toggle => {
                if current_phase(&state).ok() == Some(RuntimePhase::Listening) {
                    worker_stop(&app, &state, &mut active_session);
                } else {
                    worker_start(&app, &state, &mut active_session);
                }
            }
        }
    }
}

fn queue_command(state: &Arc<AppRuntime>, command: WorkerCommand) -> Result<(), String> {
    if current_phase(state).ok() == Some(RuntimePhase::Transcribing) {
        match command {
            WorkerCommand::Start | WorkerCommand::Stop | WorkerCommand::Toggle => {
                return Ok(());
            }
        }
    }

    state
        .worker_tx
        .send(command)
        .map_err(|err| format!("Failed to send worker command: {err}"))
}

fn start_dictation_internal(state: &Arc<AppRuntime>) -> Result<(), String> {
    queue_command(state, WorkerCommand::Start)
}

fn stop_dictation_internal(state: &Arc<AppRuntime>) -> Result<(), String> {
    queue_command(state, WorkerCommand::Stop)
}

fn toggle_dictation_internal(state: &Arc<AppRuntime>) -> Result<(), String> {
    queue_command(state, WorkerCommand::Toggle)
}

fn normalize_shortcut_key_token(token: &str) -> Result<String, String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Shortcut key cannot be empty".to_string());
    }

    if trimmed.eq_ignore_ascii_case("space") || trimmed == " " {
        return Ok("Space".to_string());
    }

    if trimmed.eq_ignore_ascii_case("esc") || trimmed.eq_ignore_ascii_case("escape") {
        return Ok("Escape".to_string());
    }

    if trimmed.eq_ignore_ascii_case("enter") {
        return Ok("Enter".to_string());
    }

    if trimmed.eq_ignore_ascii_case("tab") {
        return Ok("Tab".to_string());
    }

    if trimmed.eq_ignore_ascii_case("backspace") {
        return Ok("Backspace".to_string());
    }

    if trimmed.eq_ignore_ascii_case("delete") {
        return Ok("Delete".to_string());
    }

    if trimmed.eq_ignore_ascii_case("up") || trimmed.eq_ignore_ascii_case("arrowup") {
        return Ok("ArrowUp".to_string());
    }

    if trimmed.eq_ignore_ascii_case("down") || trimmed.eq_ignore_ascii_case("arrowdown") {
        return Ok("ArrowDown".to_string());
    }

    if trimmed.eq_ignore_ascii_case("left") || trimmed.eq_ignore_ascii_case("arrowleft") {
        return Ok("ArrowLeft".to_string());
    }

    if trimmed.eq_ignore_ascii_case("right") || trimmed.eq_ignore_ascii_case("arrowright") {
        return Ok("ArrowRight".to_string());
    }

    if trimmed.len() == 1 {
        let ch = trimmed.chars().next().unwrap_or_default();
        if ch.is_ascii_alphabetic() {
            return Ok(ch.to_ascii_uppercase().to_string());
        }

        if ch.is_ascii_digit() {
            return Ok(ch.to_string());
        }
    }

    let upper = trimmed.to_ascii_uppercase();
    if upper.starts_with('F')
        && upper.len() <= 3
        && upper
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_digit())
    {
        return Ok(upper);
    }

    Ok(trimmed.to_string())
}

fn normalize_shortcut_text(shortcut_text: &str) -> Result<String, String> {
    let mut tokens: Vec<String> = shortcut_text
        .split('+')
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect();

    if tokens.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let key_token = tokens
        .pop()
        .ok_or_else(|| "Shortcut key cannot be empty".to_string())?;

    let mut modifiers = Vec::new();
    for token in tokens {
        let normalized_modifier = match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "Ctrl",
            "shift" => "Shift",
            "alt" | "option" => "Alt",
            "meta" | "super" | "cmd" | "command" | "win" | "windows" => "Super",
            _ => {
                return Err(format!(
                    "Unsupported modifier '{token}'. Use Ctrl, Shift, Alt, or Super."
                ));
            }
        };

        if !modifiers
            .iter()
            .any(|existing: &String| existing == normalized_modifier)
        {
            modifiers.push(normalized_modifier.to_string());
        }
    }

    modifiers.sort_by_key(|modifier| match modifier.as_str() {
        "Ctrl" => 0,
        "Shift" => 1,
        "Alt" => 2,
        "Super" => 3,
        _ => 4,
    });

    let key = normalize_shortcut_key_token(&key_token)?;
    let normalized = if modifiers.is_empty() {
        key
    } else {
        format!("{}+{key}", modifiers.join("+"))
    };

    normalized.parse::<Shortcut>().map(|_| normalized).map_err(|error| {
            format!(
                "Invalid shortcut '{shortcut_text}'. Try keys like F8, Space, Ctrl+Shift+Space: {error}"
            )
        })
}

fn register_shortcut(
    app: &AppHandle,
    state: &Arc<AppRuntime>,
    shortcut_text: &str,
) -> Result<String, String> {
    let normalized_shortcut = normalize_shortcut_text(shortcut_text)?;

    let shortcut: Shortcut = normalized_shortcut
        .parse()
        .map_err(|err| format!("Invalid shortcut '{normalized_shortcut}': {err}"))?;

    app.global_shortcut()
        .unregister_all()
        .map_err(|err| format!("Failed to clear previous shortcuts: {err}"))?;

    let state_for_handler = state.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app_handle, _shortcut, event| {
            let settings = match state_for_handler.settings.lock() {
                Ok(settings) => settings.clone(),
                Err(_) => return,
            };

            match settings.recording_mode {
                RecordingMode::Hold => {
                    if event.state == ShortcutState::Pressed {
                        // Some desktops emit repeated Pressed events while the
                        // shortcut remains held. Start is idempotent, so those
                        // repeats cannot accidentally stop a long dictation.
                        let _ = start_dictation_internal(&state_for_handler);
                    }

                    if event.state == ShortcutState::Released {
                        let _ = stop_dictation_internal(&state_for_handler);
                    }
                }
                RecordingMode::Toggle => {
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_dictation_internal(&state_for_handler);
                    }
                }
            }
        })
        .map_err(|err| format!("Failed to register shortcut handler: {err}"))?;

    *state
        .registered_shortcut
        .lock()
        .map_err(|_| "Failed to lock shortcut state".to_string())? = normalized_shortcut.clone();

    Ok(normalized_shortcut)
}

fn install_tray(app: &AppHandle, state: Arc<AppRuntime>) -> Result<(), String> {
    let open_item = MenuItem::with_id(app, "open", "Open Settings", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let toggle_item =
        MenuItem::with_id(app, "toggle", "Start / Stop Dictation", true, None::<&str>)
            .map_err(|err| err.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|err| err.to_string())?;

    let menu = Menu::with_items(app, &[&open_item, &toggle_item, &quit_item])
        .map_err(|err| err.to_string())?;

    let state_for_menu = state.clone();
    let mut tray_builder = TrayIconBuilder::with_id("dictation-tray");

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder
        .tooltip("Delulu Talks")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "open" => {
                let _ = show_settings_window(app_handle);
            }
            "toggle" => {
                let _ = toggle_dictation_internal(&state_for_menu);
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .build(app)
        .map_err(|err| format!("Failed to create tray icon: {err}"))?;

    Ok(())
}

#[tauri::command]
fn get_settings(state: State<'_, Arc<AppRuntime>>) -> Result<AppSettings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Failed to lock settings".to_string())
}

#[tauri::command]
fn get_runtime_status(state: State<'_, Arc<AppRuntime>>) -> Result<DictationStatus, String> {
    let phase = current_phase(state.inner())?;
    let ready = is_runtime_ready(state.inner())?;
    let setup_in_progress = state.setup_in_progress.load(Ordering::SeqCst);

    Ok(match phase {
        RuntimePhase::Listening => DictationStatus {
            phase: DictationPhase::Listening,
            message: Some("Listening...".to_string()),
        },
        RuntimePhase::Transcribing => DictationStatus {
            phase: DictationPhase::Transcribing,
            message: Some("Transcribing speech...".to_string()),
        },
        RuntimePhase::Idle if setup_in_progress => DictationStatus {
            phase: DictationPhase::Bootstrapping,
            message: Some("Preparing the selected model...".to_string()),
        },
        RuntimePhase::Idle => DictationStatus {
            phase: DictationPhase::Idle,
            message: Some(if ready {
                "Ready".to_string()
            } else {
                "ASR environment setup required".to_string()
            }),
        },
    })
}

#[tauri::command]
fn list_input_devices() -> Result<Vec<String>, String> {
    list_input_devices_internal()
}

#[tauri::command]
fn get_history(app: AppHandle) -> Result<Vec<TranscriptRecord>, String> {
    load_history(&app)
}

#[tauri::command]
fn delete_history_item(app: AppHandle, id: String) -> Result<(), String> {
    let mut history = load_history(&app)?;
    history.retain(|item| item.id != id);
    save_history(&app, &history)
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<(), String> {
    save_history(&app, &[])
}

#[tauri::command]
fn copy_text(state: State<'_, Arc<AppRuntime>>, text: String) -> Result<(), String> {
    copy_text_to_clipboard(state.inner(), &text)
}

#[tauri::command]
fn normalize_shortcut(shortcut: String) -> Result<String, String> {
    normalize_shortcut_text(&shortcut)
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    let normalized_shortcut = normalize_shortcut_text(&settings.shortcut)?;
    let registered_shortcut = state
        .registered_shortcut
        .lock()
        .map_err(|_| "Failed to lock shortcut state".to_string())?
        .clone();

    if registered_shortcut != normalized_shortcut {
        register_shortcut(&app, state.inner(), &normalized_shortcut)?;
    }
    settings.shortcut = normalized_shortcut;
    save_settings(&app, &settings)?;

    let mut current = state
        .settings
        .lock()
        .map_err(|_| "Failed to lock settings".to_string())?;

    let should_mark_not_ready =
        current.python_command != settings.python_command || current.model != settings.model;

    *current = settings.clone();
    drop(current);

    if should_mark_not_ready {
        stop_asr_sidecar(state.inner());
        let _ = set_runtime_ready(state.inner(), false);
        emit_status(
            &app,
            DictationPhase::Idle,
            Some("Settings saved. Run ASR setup to apply runtime changes.".to_string()),
        );
    }

    Ok(settings)
}

#[tauri::command]
fn setup_asr_environment(app: AppHandle, state: State<'_, Arc<AppRuntime>>) -> Result<(), String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Failed to lock settings".to_string())?
        .clone();

    stop_asr_sidecar(state.inner());
    let _ = set_runtime_ready(state.inner(), false);
    spawn_bootstrap_task(app, state.inner().clone(), settings)
}

#[tauri::command]
fn reset_asr_environment(app: AppHandle, state: State<'_, Arc<AppRuntime>>) -> Result<(), String> {
    if current_phase(state.inner())? != RuntimePhase::Idle {
        return Err("Stop dictation before removing the Python environment.".to_string());
    }

    if state.setup_in_progress.load(Ordering::SeqCst) {
        return Err(
            "ASR setup is currently running. Wait for it to finish before removing the environment."
                .to_string(),
        );
    }

    let _bootstrap_guard = state.bootstrap_lock.try_lock().map_err(|_| {
        "ASR setup is currently running. Wait for it to finish before removing the environment."
            .to_string()
    })?;

    stop_asr_sidecar(state.inner());
    let environment_dir = asr_venv_dir(&app)?;
    if environment_dir.exists() {
        fs::remove_dir_all(&environment_dir)
            .map_err(|err| format!("Failed to remove Python environment: {err}"))?;
    }

    set_runtime_ready(state.inner(), false)?;
    emit_status(
        &app,
        DictationPhase::Idle,
        Some("Python environment removed. Select a model and run setup again.".to_string()),
    );
    Ok(())
}

#[tauri::command]
fn start_dictation(state: State<'_, Arc<AppRuntime>>) -> Result<(), String> {
    start_dictation_internal(state.inner())
}

#[tauri::command]
fn stop_dictation(state: State<'_, Arc<AppRuntime>>) -> Result<(), String> {
    stop_dictation_internal(state.inner())
}

#[tauri::command]
fn toggle_dictation(state: State<'_, Arc<AppRuntime>>) -> Result<(), String> {
    toggle_dictation_internal(state.inner())
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings_window(&app)
}

#[tauri::command]
fn hide_settings(app: AppHandle) -> Result<(), String> {
    hide_settings_window(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        // Wayland compositors commonly reject app-controlled window coordinates
        // and topmost requests. XWayland preserves the intended floating overlay.
        std::env::set_var("GDK_BACKEND", "x11");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            cleanup_stale_recordings(app.handle());
            let initial_settings = load_settings(app.handle());
            let (worker_tx, worker_rx) = mpsc::channel::<WorkerCommand>();

            let runtime = Arc::new(AppRuntime {
                settings: Mutex::new(initial_settings.clone()),
                phase: Mutex::new(RuntimePhase::Idle),
                ready: Mutex::new(false),
                clipboard: Mutex::new(Clipboard::new().ok()),
                setup_in_progress: AtomicBool::new(false),
                bootstrap_lock: Mutex::new(()),
                registered_shortcut: Mutex::new(initial_settings.shortcut.clone()),
                asr_sidecar: Mutex::new(None),
                worker_tx,
            });

            app.manage(runtime.clone());
            let normalized_shortcut =
                register_shortcut(app.handle(), &runtime, &initial_settings.shortcut)?;

            if normalized_shortcut != initial_settings.shortcut {
                let mut loaded_settings = initial_settings.clone();
                loaded_settings.shortcut = normalized_shortcut;
                save_settings(app.handle(), &loaded_settings)?;
                *runtime
                    .settings
                    .lock()
                    .map_err(|_| "Failed to lock settings".to_string())? = loaded_settings.clone();
            }

            let app_handle_for_worker = app.handle().clone();
            let runtime_for_worker = runtime.clone();
            std::thread::spawn(move || {
                run_worker_loop(app_handle_for_worker, runtime_for_worker, worker_rx)
            });

            ensure_overlay_window(app.handle())?;
            install_tray(app.handle(), runtime.clone())?;

            if let Some(main_window) = app.get_webview_window("main") {
                let window_handle = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_handle.hide();
                    }
                });
            }

            let startup_settings = runtime
                .settings
                .lock()
                .map_err(|_| "Failed to lock settings".to_string())?
                .clone();
            initialize_runtime_readiness(app.handle(), &runtime, &startup_settings);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            get_runtime_status,
            list_input_devices,
            get_history,
            delete_history_item,
            clear_history,
            copy_text,
            normalize_shortcut,
            update_settings,
            setup_asr_environment,
            reset_asr_environment,
            start_dictation,
            stop_dictation,
            toggle_dictation,
            open_settings_window,
            hide_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{concise_asr_error, normalize_shortcut_text};

    #[test]
    fn sidecar_errors_skip_hugging_face_noise() {
        let stderr = "Warning: You are sending unauthenticated requests to the HF Hub.\n\
                      Loading weights: 100%\n\
                      Transcription failed: Audio must contain at least one sample";

        assert_eq!(
            concise_asr_error(stderr),
            "Transcription failed: Audio must contain at least one sample"
        );
    }

    #[test]
    fn shortcut_input_is_normalized_consistently() {
        assert_eq!(
            normalize_shortcut_text("shift + control + space").unwrap(),
            "Ctrl+Shift+Space"
        );
        assert!(normalize_shortcut_text("").is_err());
    }
}
