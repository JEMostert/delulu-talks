//! Bounded reading of a linked source for in-app review (`audioSource.ts`).

use std::fs::File;
use std::io::Read;
use std::path::Path;

use delulu_core::DomainResult;

use crate::plain_error;

const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

/// The MIME type the renderer uses for a source extension (empty if unknown).
pub fn audio_mime(path: &Path) -> &'static str {
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match extension.as_str() {
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "webm" => "audio/webm",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        _ => "",
    }
}

pub struct LinkedAudio {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

pub fn load_linked_audio(path: &Path) -> DomainResult<LinkedAudio> {
    let file = File::open(path)?;
    let info = file.metadata()?;
    if !info.is_file() {
        return Err(plain_error("The linked source is not a regular file"));
    }
    if info.len() > MAX_PREVIEW_BYTES {
        return Err(plain_error(
            "In-app audio review supports source files up to 32 MiB. Transcription remains available for larger files.",
        ));
    }
    // Bound the read even if another application grows the source concurrently.
    let mut bytes = Vec::with_capacity(info.len() as usize + 1);
    file.take(info.len() + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > info.len() {
        return Err(plain_error("The source changed while opening; open the review again"));
    }
    if bytes.is_empty() {
        return Err(plain_error("The linked source is empty"));
    }
    Ok(LinkedAudio { bytes, mime: audio_mime(path) })
}
