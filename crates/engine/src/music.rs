//! `delulu-engine music`: Delulu FM's music engines, run as a child process so a
//! song's GPU memory is released as soon as it is done (or the app stops it).
//!
//! `delulu-engine music generate [--model <safetensors>] [--models <dir>] --out <wav>`
//! reads one JSON song from stdin and writes JSON lines to stdout: progress events,
//! then a final `{"done": report}` or `{"error": message}`. The song's `engine`
//! field picks the engine:
//! - `"yue2"` (also when absent): YuE2 3B, `--model` is its checkpoint.
//! - `"acestep"`: ACE-Step 1.5 turbo, `--models` is the app's models folder (the
//!   files live in its `ace-step-1.5/`). SIGTERM or SIGINT stops the song at the
//!   next LM token, DiT step or VAE tile, without leaving a file.
//!
//! `delulu-engine music probe` starts the compute device it would use and prints it.
use delulu_music::{generate, Progress, Song, SAMPLE_RATE};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};

const USAGE: &str = "usage: delulu-engine music generate --model <safetensors> --out <wav> < song.json   (YuE2)\n       delulu-engine music generate --models <dir> --out <wav> < song.json      (\"engine\": \"acestep\")\n       delulu-engine music probe";

fn emit(value: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Interleaved stereo float samples, written to `<out>.wav.part` and renamed, so a
/// killed process never leaves a partial song under the real name.
fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let temp = path.with_extension("wav.part");
    let result = (|| -> Result<(), hound::Error> {
        let mut w = hound::WavWriter::create(&temp, spec)?;
        for &s in samples {
            w.write_sample(s)?;
        }
        w.finalize()
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write {}: {e}", path.display()));
    }
    std::fs::rename(&temp, path).map_err(|e| format!("{}: {e}", path.display()))
}

#[derive(Debug)]
enum Request {
    Yue2(Song),
    AceStep(delulu_music_ace::Song),
}

/// Not `{e}`: serde can quote the lyrics it choked on, and this reaches the log.
/// A missing field names only our own field; for an unknown name the value given
/// is dropped and only the accepted ones are listed.
fn describe(e: serde_json::Error) -> String {
    let message = e.to_string();
    let message = &message[..message.find(" at line").unwrap_or(message.len())];
    if message.starts_with("missing field") {
        format!("song: {message}")
    } else if let (true, Some(expected)) = (
        message.starts_with("unknown variant"),
        // From the end: the list of accepted names comes last, the given value before.
        message.rfind(", expected"),
    ) {
        format!("song: unknown value{}", &message[expected..])
    } else {
        format!("song: {:?} error at column {}", e.classify(), e.column())
    }
}

fn parse_request(input: &str) -> Result<Request, String> {
    let value: serde_json::Value = serde_json::from_str(input).map_err(describe)?;
    match value.get("engine").map(|e| e.as_str()) {
        None | Some(Some("yue2")) => serde_json::from_str(input).map(Request::Yue2),
        Some(Some("acestep")) => serde_json::from_str(input).map(Request::AceStep),
        _ => return Err("song: engine must be \"yue2\" or \"acestep\"".into()),
    }
    .map_err(describe)
}

static CANCEL: AtomicBool = AtomicBool::new(false);

extern "C" fn on_stop_signal(_: libc::c_int) {
    CANCEL.store(true, Ordering::SeqCst);
}

/// SIGTERM and SIGINT ask the song to stop at its next step instead of ending the
/// process mid-write. SIGKILL (what the radio uses) still ends it at once.
fn stop_on_signals() {
    let handler = on_stop_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

fn run_acestep(models: &Path, out: &Path, song: &delulu_music_ace::Song) -> Result<(), String> {
    stop_on_signals();
    let plan = delulu_music_ace::plan(models, song, delulu_music_ace::best_device())?;
    let output = delulu_music_ace::generate(
        &plan,
        &mut |p| emit(serde_json::json!({ "progress": p })),
        &|| CANCEL.load(Ordering::SeqCst),
    )?;
    write_wav(out, &output.samples, delulu_music_ace::SAMPLE_RATE)?;
    emit(serde_json::json!({ "done": output.report }));
    Ok(())
}

fn run(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let command = args.next().ok_or(USAGE)?;
    match command.as_str() {
        "probe" => {
            let device = delulu_music::ggml::Device::new(1)?;
            let memory = device.memory();
            emit(serde_json::json!({
                "device": device.name,
                "gpu": device.gpu.is_some(),
                "freeBytes": memory.map(|m| m.0),
                "totalBytes": memory.map(|m| m.1),
            }));
            Ok(())
        }
        "generate" => {
            let (mut model, mut models, mut out) = (None, None, None);
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--model" => model = args.next().map(PathBuf::from),
                    "--models" => models = args.next().map(PathBuf::from),
                    "--out" => out = args.next().map(PathBuf::from),
                    _ => return Err(USAGE.into()),
                }
            }
            let out = out.ok_or(USAGE)?;
            let mut input = String::new();
            std::io::stdin()
                .read_to_string(&mut input)
                .map_err(|e| format!("stdin: {e}"))?;
            match parse_request(&input)? {
                Request::Yue2(song) => {
                    let model = model.ok_or(USAGE)?;
                    let output = generate(
                        &model,
                        &song,
                        &mut |p: Progress| emit(serde_json::json!({ "progress": p })),
                        &|| false,
                    )?;
                    write_wav(&out, &output.samples, SAMPLE_RATE)?;
                    emit(serde_json::json!({ "done": output.report }));
                    Ok(())
                }
                Request::AceStep(song) => run_acestep(&models.ok_or(USAGE)?, &out, &song),
            }
        }
        _ => Err(USAGE.into()),
    }
}

pub fn main(args: impl Iterator<Item = String>) -> ExitCode {
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            emit(serde_json::json!({ "error": e }));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_field_picks_the_engine_and_yue2_is_the_default() {
        let yue2 = r#"{"style":"pop","lyrics":"[verse]\nla","seed":1,"maxSeconds":30}"#;
        let tagged =
            r#"{"engine":"yue2","style":"pop","lyrics":"[verse]\nla","seed":1,"maxSeconds":30}"#;
        for input in [yue2, tagged] {
            assert!(matches!(parse_request(input), Ok(Request::Yue2(s)) if s.max_seconds == 30.0));
        }
        let ace = r#"{"engine":"acestep","style":"pop","lyrics":"[Verse]\nla","seed":1,"seconds":150,"language":"nl"}"#;
        let Ok(Request::AceStep(song)) = parse_request(ace) else {
            panic!("not acestep")
        };
        assert_eq!(
            (song.seconds, song.language.as_deref()),
            (150.0, Some("nl"))
        );
    }

    #[test]
    fn bad_requests_never_echo_the_lyrics() {
        let secret = "my private verse, expected nothing";
        let cases = [
            (
                r#"{"engine":"musicgen","style":"x","seed":1,"seconds":60}"#.to_string(),
                "engine must be",
            ),
            // An ACE song needs `seconds`; YuE2's `maxSeconds` is not enough.
            (
                format!(
                    r#"{{"engine":"acestep","style":"x","lyrics":"{secret}","seed":1,"maxSeconds":60}}"#
                ),
                "missing field `seconds`",
            ),
            (
                format!(
                    r#"{{"engine":"acestep","style":"x","lyrics":"{secret}","seed":"{secret}","seconds":60}}"#
                ),
                "Data error",
            ),
            (
                format!(
                    r#"{{"engine":"acestep","style":"x","seed":1,"seconds":60,"lm":"{secret}"}}"#
                ),
                "unknown value, expected one of `auto`, `0.6b`, `4b`",
            ),
            (format!(r#"{{"style":"x","lyrics":"{secret}""#), "Eof error"),
        ];
        for (input, want) in cases {
            let e = parse_request(&input).unwrap_err();
            assert!(e.contains(want), "{e}");
            // Not even a fragment: the value contains serde's own ", expected".
            for word in ["private", "verse", "nothing"] {
                assert!(!e.contains(word), "{e}");
            }
        }
    }
}
