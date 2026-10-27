use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}
pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";
static MODELS: [ModelInfo;2] = [ModelInfo { id: DEFAULT_MODEL, label: "Large v3 Turbo (recommended)", file: "ggml-large-v3-turbo-q5_0.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin", sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", bytes: 574041195 }, ModelInfo { id: "small", label: "Small (faster, weaker Dutch)", file: "ggml-small.bin", url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin", sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", bytes: 487601967 }];
pub fn models() -> &'static [ModelInfo] {
    &MODELS
}
pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    models().iter().find(|m| m.id == id)
}
pub fn model_path(dir: &Path, id: &str) -> Option<PathBuf> {
    model_info(id).map(|m| dir.join(m.file))
}
pub fn is_downloaded(dir: &Path, id: &str) -> bool {
    model_info(id).is_some_and(|m| {
        dir.join(m.file)
            .metadata()
            .is_ok_and(|v| v.len() == m.bytes)
    })
}
pub fn download(
    dir: &Path,
    id: &str,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<PathBuf, SttError> {
    let info = model_info(id).ok_or_else(|| SttError::Model(format!("unknown model: {id}")))?;
    if cancel.load(Ordering::Relaxed) {
        return Err(SttError::Cancelled);
    }
    std::fs::create_dir_all(dir).map_err(download_error)?;
    let response = ureq::get(info.url).call().map_err(download_error)?;
    save_download(
        dir,
        info,
        response.into_body().into_reader(),
        progress,
        cancel,
    )
}

fn download_error(e: impl std::fmt::Display) -> SttError {
    SttError::Download(e.to_string())
}

fn save_download(
    dir: &Path,
    info: &ModelInfo,
    mut reader: impl Read,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<PathBuf, SttError> {
    use sha2::{Digest, Sha256};
    let path = dir.join(info.file);
    let part = dir.join(format!("{}.part", info.file));
    let result = (|| {
        let mut file = std::fs::File::create(&part).map_err(download_error)?;
        let mut hash = Sha256::new();
        let mut done = 0u64;
        let mut buf = [0u8; 65536];
        progress(0, info.bytes);
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(SttError::Cancelled);
            }
            let n = reader.read(&mut buf).map_err(download_error)?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(download_error)?;
            hash.update(&buf[..n]);
            done += n as u64;
            progress(done, info.bytes);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(SttError::Cancelled);
        }
        if done != info.bytes || format!("{:x}", hash.finalize()) != info.sha256 {
            return Err(SttError::Checksum);
        }
        file.flush().map_err(download_error)?;
        drop(file);
        std::fs::rename(&part, &path).map_err(download_error)?;
        Ok(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(part);
    }
    result
}
pub fn languages() -> Vec<(&'static str, &'static str)> {
    (0..=whisper_rs::get_lang_max_id())
        .filter_map(|id| {
            Some((
                whisper_rs::get_lang_str(id)?,
                whisper_rs::get_lang_str_full(id)?,
            ))
        })
        .collect()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Language {
    Auto,
    Fixed(String),
}
impl Language {
    pub fn from_setting(s: &str) -> Self {
        if s == "auto" {
            Self::Auto
        } else {
            Self::Fixed(s.into())
        }
    }
}
#[derive(Debug, Clone)]
pub struct Transcript {
    pub text: String,
    pub language: String,
    pub audio_ms: u64,
    pub elapsed_ms: u64,
}
pub struct Engine {
    _context: whisper_rs::WhisperContext,
    state: whisper_rs::WhisperState,
    id: String,
    backend: String,
}

fn params(language: &str) -> whisper_rs::FullParams<'_, '_> {
    let mut p = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    p.set_n_threads(std::thread::available_parallelism().map_or(1, |n| n.get().min(8)) as i32);
    p.set_no_context(true);
    p.set_no_timestamps(true);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p
}

fn silent(samples: &[f32]) -> bool {
    samples.len() < 4000
        || (samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32).sqrt() < 0.003
}
fn punctuation_only(text: &str) -> bool {
    !text.chars().any(char::is_alphanumeric)
}

// Match whisper.cpp's selection of the first registered GPU or integrated GPU.
fn backend_name() -> String {
    use whisper_rs_sys as sys;
    unsafe {
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            let kind = sys::ggml_backend_dev_type(dev);
            if kind == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
                || kind == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU
            {
                let name =
                    std::ffi::CStr::from_ptr(sys::ggml_backend_dev_name(dev)).to_string_lossy();
                let description = std::ffi::CStr::from_ptr(sys::ggml_backend_dev_description(dev))
                    .to_string_lossy();
                let backend = if name.starts_with("CUDA") {
                    "CUDA"
                } else if name.starts_with("Vulkan") {
                    "Vulkan"
                } else {
                    &name
                };
                return format!("{backend}: {description}");
            }
        }
    }
    "CPU".to_string()
}

impl Engine {
    pub fn load(path: &Path) -> Result<Self, SttError> {
        let name = path
            .to_str()
            .ok_or_else(|| SttError::Model("model path is not UTF-8".into()))?;
        let mut cp = whisper_rs::WhisperContextParameters::default();
        cp.flash_attn(true);
        let context = whisper_rs::WhisperContext::new_with_params(name, cp)
            .map_err(|e| SttError::Model(e.to_string()))?;
        let mut state = context
            .create_state()
            .map_err(|e| SttError::Model(e.to_string()))?;
        // Low, deterministic noise exercises both language detection and decoding.
        let mut seed = 1u32;
        let warm: Vec<f32> = (0..48000)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.01
            })
            .collect();
        state
            .full(params("auto"), &warm)
            .map_err(|e| SttError::Inference(e.to_string()))?;
        let backend = backend_name();
        let id = models()
            .iter()
            .find(|m| path.file_name().is_some_and(|f| f == m.file))
            .map_or_else(
                || {
                    path.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                },
                |m| m.id.to_string(),
            );
        Ok(Self {
            _context: context,
            state,
            id,
            backend,
        })
    }
    pub fn backend(&self) -> String {
        self.backend.clone()
    }
    pub fn model_id(&self) -> &str {
        &self.id
    }
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
    ) -> Result<Transcript, SttError> {
        let code = match language {
            Language::Auto => "auto",
            Language::Fixed(code) => code.as_str(),
        };
        let audio_ms = samples.len() as u64 / 16;
        if silent(samples) {
            return Ok(Transcript {
                text: String::new(),
                language: code.to_string(),
                audio_ms,
                elapsed_ms: 0,
            });
        }
        let start = Instant::now();
        self.state
            .full(params(code), samples)
            .map_err(|e| SttError::Inference(e.to_string()))?;
        let language = whisper_rs::get_lang_str(self.state.full_lang_id_from_state())
            .unwrap_or(code)
            .to_string();
        let segments: Vec<_> = self.state.as_iter().collect();
        let no_speech = segments.len() == 1 && segments[0].no_speech_probability() > 0.8;
        let text = segments
            .iter()
            .map(|s| {
                s.to_str_lossy()
                    .map(|s| s.trim().to_owned())
                    .map_err(|e| SttError::Inference(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        let text = if no_speech || punctuation_only(&text) {
            String::new()
        } else {
            text.trim().to_string()
        };
        Ok(Transcript {
            text,
            language,
            audio_ms,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_gate() {
        assert!(silent(&vec![0.1; 3999]));
        assert!(silent(&vec![0.002; 4000]));
        assert!(!silent(&vec![0.004; 4000]));
    }
    #[test]
    fn download_verifies_and_cleans_partial_file() {
        let dir = std::env::temp_dir().join(format!("delulu-stt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let info = ModelInfo {
            id: "test",
            label: "test",
            file: "model.bin",
            url: "",
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            bytes: 3,
        };
        let cancel = AtomicBool::new(false);
        let mut progress = Vec::new();
        let path = save_download(
            &dir,
            &info,
            &b"abc"[..],
            &mut |n, _| progress.push(n),
            &cancel,
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(progress, vec![0, 3]);
        assert!(matches!(
            save_download(&dir, &info, &b"bad"[..], &mut |_, _| {}, &cancel),
            Err(SttError::Checksum)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert!(!dir.join("model.bin.part").exists());
        cancel.store(true, Ordering::Relaxed);
        assert!(matches!(
            save_download(&dir, &info, &b"abc"[..], &mut |_, _| {}, &cancel),
            Err(SttError::Cancelled)
        ));
        assert!(!dir.join("model.bin.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn punctuation_filter() {
        assert!(punctuation_only(" ... ! "));
        assert!(!punctuation_only("hé!"));
        assert!(!punctuation_only("42."));
    }
}
#[derive(Debug, thiserror::Error)]
pub enum SttError {
    #[error("model: {0}")]
    Model(String),
    #[error("download: {0}")]
    Download(String),
    #[error("cancelled")]
    Cancelled,
    #[error("checksum mismatch")]
    Checksum,
    #[error("inference: {0}")]
    Inference(String),
}
