//! `delulu-music`: Delulu FM's native music engine, run as a child process so its GPU
//! memory is released as soon as a song is done (or the app stops it).
//!
//! `delulu-music generate --model <safetensors> --out <wav>` reads one JSON `Song`
//! from stdin and writes JSON lines to stdout: progress events, then a final
//! `{"done": report}` or `{"error": message}`.
//! `delulu-music probe` prints the compute device it would use.
use delulu_music::{generate, Progress, Song, SAMPLE_RATE};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: delulu-music generate --model <safetensors> --out <wav> < song.json\n       delulu-music probe";

fn emit(value: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn write_wav(path: &PathBuf, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SAMPLE_RATE,
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

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
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
            let (mut model, mut out) = (None, None);
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--model" => model = args.next().map(PathBuf::from),
                    "--out" => out = args.next().map(PathBuf::from),
                    _ => return Err(USAGE.into()),
                }
            }
            let (model, out) = model.zip(out).ok_or(USAGE)?;
            let mut input = String::new();
            std::io::stdin()
                .read_to_string(&mut input)
                .map_err(|e| format!("stdin: {e}"))?;
            let song: Song = serde_json::from_str(&input).map_err(|e| format!("song: {e}"))?;
            let output = generate(
                &model,
                &song,
                &mut |p: Progress| emit(serde_json::json!({ "progress": p })),
                &|| false,
            )?;
            write_wav(&out, &output.samples)?;
            emit(serde_json::json!({ "done": output.report }));
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            emit(serde_json::json!({ "error": e }));
            ExitCode::FAILURE
        }
    }
}
