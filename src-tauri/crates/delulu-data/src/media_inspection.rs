//! Audio file metadata for the Lab (`mediaInspection.ts`).
//!
//! Reads metadata only: no model startup, conversion, download or disk
//! output. Blocking (up to the 5 s probe timeout); run on a blocking task.

use delulu_core::HostEnv;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use delulu_domain::{AudioDecoder, AudioFileMetadata};
use serde_json::Value;

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 128 * 1024;

/// Runs a program and returns its stdout, or `None` on failure, timeout or
/// oversized output.
fn probe(program: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.host_env().args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let read = (&mut stdout).take(MAX_OUTPUT as u64 + 1).read_to_end(&mut buffer);
        read.ok().map(|_| buffer)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = reader.join().ok().flatten()?;
    if !status?.success() || output.len() > MAX_OUTPUT {
        return None;
    }
    String::from_utf8(output).ok()
}

fn positive(value: Option<&Value>) -> Option<f64> {
    let number = crate::json::to_number(value);
    (number.is_finite() && number > 0.0).then_some(number)
}

/// Inspects a source file. `speech_python` is the speech runtime's Python
/// (for `soundfile`), if it is installed.
pub fn inspect_media(path: &Path, speech_python: Option<&Path>) -> AudioFileMetadata {
    let extension = path.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default();
    let direct = [".wav", ".flac", ".ogg", ".opus"].contains(&extension.as_str());
    let path_text = path.to_string_lossy().into_owned();
    let mut result = AudioFileMetadata {
        duration_seconds: None,
        channels: None,
        sample_rate: None,
        decoder: if direct { AudioDecoder::Soundfile } else { AudioDecoder::Ffmpeg },
        decoder_ready: false,
        decoder_detail: "Decoder availability could not be confirmed.".into(),
        estimated_pcm_bytes: None,
        processing_time_estimate: "Unknown: depends on recording length, model and hardware; model loading adds time.".into(),
    };
    if direct {
        let script = "import json,sys,soundfile as sf; i=sf.info(sys.argv[1]); print(json.dumps({'duration':i.duration,'channels':i.channels,'sample_rate':i.samplerate}))";
        let metadata = speech_python.filter(|python| python.exists()).and_then(|python| probe(python, &["-B", "-c", script, &path_text]));
        match metadata {
            Some(metadata) => {
                if let Ok(info) = serde_json::from_str::<Value>(&metadata) {
                    result.duration_seconds = positive(info.get("duration"));
                    result.channels = positive(info.get("channels")).map(|n| n as u32);
                    result.sample_rate = positive(info.get("sample_rate")).map(|n| n as u32);
                    result.decoder_ready = true;
                    result.decoder_detail =
                        "Speech runtime soundfile opened this file's header. Full audio decoding happens when you start.".into();
                }
            }
            None => {
                result.decoder_detail = "Speech runtime soundfile is unavailable or could not open this file. Set up or repair Speech in Models, or choose a readable file.".into();
            }
        }
    }
    let need_probe = result.duration_seconds.is_none() || result.channels.is_none();
    let ffprobe = need_probe.then(|| {
        let path_text = path_text.clone();
        std::thread::spawn(move || {
            probe(
                Path::new("ffprobe"),
                &[
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=duration,channels,sample_rate:format=duration",
                    "-of",
                    "json",
                    &path_text,
                ],
            )
        })
    });
    let ffmpeg = (!direct).then(|| std::thread::spawn(|| probe(Path::new("ffmpeg"), &["-version"])));
    let metadata = ffprobe.and_then(|handle| handle.join().ok().flatten());
    let ffmpeg = ffmpeg.and_then(|handle| handle.join().ok().flatten());
    if let Some(metadata) = metadata {
        if let Ok(info) = serde_json::from_str::<Value>(&metadata) {
            match info.get("streams").and_then(|s| s.get(0)) {
                Some(stream) => {
                    if result.duration_seconds.is_none() {
                        result.duration_seconds =
                            positive(stream.get("duration")).or_else(|| positive(info.get("format").and_then(|f| f.get("duration"))));
                    }
                    if result.channels.is_none() {
                        result.channels = positive(stream.get("channels")).map(|n| n as u32);
                    }
                    if result.sample_rate.is_none() {
                        result.sample_rate = positive(stream.get("sample_rate")).map(|n| n as u32);
                    }
                }
                None if !direct => {
                    result.decoder_detail = "No audio stream found in this file.".into();
                    return result;
                }
                None => {}
            }
        }
    }
    if !direct {
        result.decoder_ready = ffmpeg.is_some();
        result.decoder_detail = if ffmpeg.is_some() {
            "FFmpeg is available for local conversion. Full audio decoding happens when you start."
        } else {
            "FFmpeg is missing or did not respond. Install FFmpeg before transcribing this format."
        }
        .into();
    }
    if let Some(duration) = result.duration_seconds {
        result.estimated_pcm_bytes = Some((duration * 16_000.0 * 2.0).ceil() as u64);
    }
    result
}
