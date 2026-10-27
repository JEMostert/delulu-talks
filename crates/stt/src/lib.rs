use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
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
    _dir: &Path,
    _id: &str,
    _progress: &mut dyn FnMut(u64, u64),
    _cancel: &AtomicBool,
) -> Result<PathBuf, SttError> {
    Err(SttError::Download("Stub download".into()))
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
    id: String,
}
impl Engine {
    pub fn load(_path: &Path) -> Result<Self, SttError> {
        Ok(Self {
            id: DEFAULT_MODEL.into(),
        })
    }
    pub fn backend(&self) -> String {
        "Stub".into()
    }
    pub fn model_id(&self) -> &str {
        &self.id
    }
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        _language: &Language,
    ) -> Result<Transcript, SttError> {
        Ok(Transcript {
            text: "stub transcript".into(),
            language: "en".into(),
            audio_ms: samples.len() as u64 / 16,
            elapsed_ms: 0,
        })
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
