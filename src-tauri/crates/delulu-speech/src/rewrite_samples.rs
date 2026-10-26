//! Development-only capture of dictation samples for rewrite testing.
//!
//! Debug builds started with `DELULU_REWRITE_SAMPLES=<directory>` keep each
//! dictation's audio next to a JSON file with the transcript, the exact text
//! sent to rewriting and the rewrite result. `scripts/rewrite-eval/` replays
//! those transcripts against the rewrite model. Release builds never write
//! samples, whatever the environment says.

use std::path::{Path, PathBuf};

use delulu_domain::{AppSettings, TranscriptRecord};
use serde_json::json;

pub const SAMPLES_ENV: &str = "DELULU_REWRITE_SAMPLES";

fn directory() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let value = std::env::var_os(SAMPLES_ENV)?;
    (!value.is_empty()).then(|| PathBuf::from(value))
}

/// Best effort: a failed sample write is logged and never affects dictation.
pub fn save(
    wav: &[u8],
    record: &TranscriptRecord,
    settings: &AppSettings,
    rewrite_input: &str,
    rewrite_error: Option<&str>,
) {
    let Some(directory) = directory() else { return };
    if let Err(error) = write(
        &directory,
        wav,
        record,
        settings,
        rewrite_input,
        rewrite_error,
    ) {
        log::error!("Could not save rewrite sample: {error}");
    }
}

fn write(
    directory: &Path,
    wav: &[u8],
    record: &TranscriptRecord,
    settings: &AppSettings,
    rewrite_input: &str,
    rewrite_error: Option<&str>,
) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(directory)?;
    let stem = format!("sample-{}-{}", delulu_core::now_ms(), &record.id);
    delulu_core::util::create_private(&directory.join(format!("{stem}.wav")))?.write_all(wav)?;
    let sample = json!({
        "audio": format!("{stem}.wav"),
        "createdAt": record.created_at,
        "durationMs": record.duration_ms,
        "language": record.language,
        "speechModel": record.model,
        "transcript": record.text,
        "rewriteInput": rewrite_input,
        "rewrite": {
            "enabled": settings.magic_enabled,
            "model": settings.magic_model,
            "preset": settings.magic_preset,
            "allowInferences": settings.magic_allow_inferences,
            "output": record.magic_text.clone().flatten(),
            "error": rewrite_error,
            "processingTimeMs": record.magic_processing_time_ms,
        },
        "record": record,
    });
    let mut file = delulu_core::util::create_private(&directory.join(format!("{stem}.json")))?;
    serde_json::to_writer_pretty(&mut file, &sample)?;
    file.write_all(b"\n")?;
    log::info!("Saved rewrite sample {stem} to {}", directory.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_audio_and_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let record = TranscriptRecord {
            id: "rec".into(),
            text: "Tuesday, sorry, Wednesday".into(),
            magic_text: Some(Some("Wednesday".into())),
            ..Default::default()
        };
        let settings = AppSettings::default();
        write(
            dir.path(),
            b"RIFF",
            &record,
            &settings,
            "Tuesday, sorry, Wednesday",
            None,
        )
        .unwrap();
        let mut names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names.len(), 2);
        let sample: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(&names[0])).unwrap()).unwrap();
        assert_eq!(sample["audio"], names[1]);
        assert_eq!(sample["rewriteInput"], "Tuesday, sorry, Wednesday");
        assert_eq!(sample["rewrite"]["output"], "Wednesday");
        assert_eq!(std::fs::read(dir.path().join(&names[1])).unwrap(), b"RIFF");
    }
}
