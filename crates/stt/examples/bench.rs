use delulu_stt::{Engine, Language};
use std::{error::Error, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let id = args.next().ok_or("usage: bench <model> <wav...>")?;
    let dir = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        })
        .join("delulu-talks/models");
    let mut engine = Engine::load(&dir, &id)?;
    println!("backend: {}", engine.backend());
    let mut times = Vec::new();
    let mut en = (0, 0);
    let mut nl = (0, 0);
    for path in args {
        let mut wav = hound::WavReader::open(&path)?;
        let spec = wav.spec();
        if spec.sample_rate != 16000 || spec.channels != 1 || spec.bits_per_sample != 16 {
            return Err(format!("unsupported WAV: {path}").into());
        }
        let samples: Vec<f32> = wav
            .samples::<i16>()
            .map(|s| s.map(|x| x as f32 / 32768.0))
            .collect::<Result<_, _>>()?;
        let result = engine.transcribe(&samples, &Language::Auto, None)?;
        let name = std::path::Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        for (prefix, counts, code) in [("m-en-", &mut en, "en"), ("m-nl-", &mut nl, "nl")] {
            if name.starts_with(prefix) {
                counts.1 += 1;
                counts.0 += usize::from(result.language == code);
                times.push(result.elapsed_ms);
            }
        }
        println!(
            "{name}\t{}\t{} ms\t{}",
            result.language, result.elapsed_ms, result.text
        );
    }
    times.sort_unstable();
    let median = if times.is_empty() {
        0.0
    } else if times.len() % 2 == 0 {
        (times[times.len() / 2 - 1] + times[times.len() / 2]) as f64 / 2.0
    } else {
        times[times.len() / 2] as f64
    };
    println!(
        "summary: en {}/{}, nl {}/{}, median {:.1} ms",
        en.0, en.1, nl.0, nl.1, median
    );
    Ok(())
}
