//! Every model the app can download, and the one downloader that fetches them.
//!
//! The registry is a table: adding a model (a TTS voice, a chat model, another speech
//! engine) means adding a row to [`MODELS`]. Files land in the app's models folder
//! under the names given here, so a file already there at its expected size counts
//! as installed without hashing it again.
mod download;

use std::path::Path;

pub use download::{download, download_with, part_path, remove, Error, Options};

/// What a model is for. A screen or worker picks the models of its role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Speech to text for dictation.
    Stt,
    /// Transcript cleanup and radio writing.
    Cleanup,
    /// Song generation for Delulu FM.
    Music,
}

/// The runtime that loads a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Whisper,
    Parakeet,
    Llama,
    Yue,
}
impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whisper => "whisper",
            Self::Parakeet => "parakeet",
            Self::Llama => "llama",
            Self::Yue => "yue",
        }
    }
}

/// One downloadable file; `file` is relative to the models folder.
#[derive(Debug, Clone, Copy)]
pub struct ModelFile {
    pub file: &'static str,
    /// Pinned to a revision, so the bytes behind it never change.
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}
impl ModelFile {
    /// True when the file is in `dir` at its expected size. Downloads only ever
    /// appear under this name after their hash checked out, so the size is enough.
    pub fn ready(&self, dir: &Path) -> bool {
        dir.join(self.file)
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() == self.bytes)
    }
}

#[derive(Debug)]
pub struct Model {
    pub id: &'static str,
    pub role: Role,
    pub engine: Engine,
    pub label: &'static str,
    /// Short licence name shown next to the model.
    pub license: &'static str,
    /// What the engine loads, relative to the models folder: a file or a folder.
    pub path: &'static str,
    pub files: &'static [ModelFile],
    /// All files together.
    pub bytes: u64,
}
impl Model {
    pub fn installed(&self, dir: &Path) -> bool {
        self.files.iter().all(|f| f.ready(dir))
    }
}

const fn total(files: &[ModelFile]) -> u64 {
    let mut sum = 0;
    let mut i = 0;
    while i < files.len() {
        sum += files[i].bytes;
        i += 1;
    }
    sum
}

macro_rules! whisper_cpp {
    ($file:literal) => {
        concat!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/",
            $file
        )
    };
}
macro_rules! parakeet_onnx {
    ($file:literal) => {
        concat!(
            "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/",
            $file
        )
    };
}

pub static WHISPER_TURBO: Model = Model {
    id: "large-v3-turbo-q5_0",
    role: Role::Stt,
    engine: Engine::Whisper,
    label: "Large v3 Turbo (recommended)",
    license: "MIT",
    path: "ggml-large-v3-turbo-q5_0.bin",
    files: &[ModelFile {
        file: "ggml-large-v3-turbo-q5_0.bin",
        url: whisper_cpp!("ggml-large-v3-turbo-q5_0.bin"),
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        bytes: 574_041_195,
    }],
    bytes: 574_041_195,
};

pub static WHISPER_SMALL: Model = Model {
    id: "small",
    role: Role::Stt,
    engine: Engine::Whisper,
    label: "Small (faster, weaker Dutch)",
    license: "MIT",
    path: "ggml-small.bin",
    files: &[ModelFile {
        file: "ggml-small.bin",
        url: whisper_cpp!("ggml-small.bin"),
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        bytes: 487_601_967,
    }],
    bytes: 487_601_967,
};

static PARAKEET_FILES: [ModelFile; 4] = [
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/encoder-model.int8.onnx",
        url: parakeet_onnx!("encoder-model.int8.onnx"),
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
        bytes: 652_183_999,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/decoder_joint-model.int8.onnx",
        url: parakeet_onnx!("decoder_joint-model.int8.onnx"),
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
        bytes: 18_202_004,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/nemo128.onnx",
        url: parakeet_onnx!("nemo128.onnx"),
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
        bytes: 139_764,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/vocab.txt",
        url: parakeet_onnx!("vocab.txt"),
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        bytes: 93_939,
    },
];

/// NVIDIA Parakeet TDT 0.6B v3, int8 ONNX export by istupakov.
pub static PARAKEET: Model = Model {
    id: "parakeet-tdt-0.6b-v3",
    role: Role::Stt,
    engine: Engine::Parakeet,
    label: "Parakeet TDT 0.6B v3",
    license: "CC BY 4.0",
    path: "parakeet-tdt-0.6b-v3-int8",
    files: &PARAKEET_FILES,
    bytes: total(&PARAKEET_FILES),
};

/// Gemma 4 E4B, the text cleanup model.
pub static GEMMA_4_E4B: Model = Model {
    id: "gemma-4-e4b",
    role: Role::Cleanup,
    engine: Engine::Llama,
    label: "Gemma 4 E4B",
    license: "Gemma",
    path: "gemma-4-E4B_q4_0-it.gguf",
    files: &[ModelFile {
        file: "gemma-4-E4B_q4_0-it.gguf",
        url: "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf",
        sha256: "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
        bytes: 5_154_941_280,
    }],
    bytes: 5_154_941_280,
};

/// YuE2 3B in ComfyUI's INT8 ConvRot packaging (Comfy-Org/YuE2 at a fixed revision).
pub static YUE2_3B: Model = Model {
    id: "yue2-3b-int8",
    role: Role::Music,
    engine: Engine::Yue,
    label: "YuE2 3B",
    license: "CC BY-NC 4.0",
    path: "yue2_3b_int8_convrot.safetensors",
    files: &[ModelFile {
        file: "yue2_3b_int8_convrot.safetensors",
        url: "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_int8_convrot.safetensors",
        sha256: "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6",
        bytes: 3_960_938_800,
    }],
    bytes: 3_960_938_800,
};

/// The registry. The first model of a role is its default.
pub static MODELS: [&Model; 5] = [
    &WHISPER_TURBO,
    &WHISPER_SMALL,
    &PARAKEET,
    &GEMMA_4_E4B,
    &YUE2_3B,
];

pub fn get(id: &str) -> Option<&'static Model> {
    MODELS.iter().copied().find(|m| m.id == id)
}

pub fn with_role(role: Role) -> impl Iterator<Item = &'static Model> {
    MODELS.iter().copied().filter(move |m| m.role == role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rows_are_consistent() {
        let mut ids = std::collections::HashSet::new();
        let mut files = std::collections::HashSet::new();
        for m in MODELS {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.bytes, total(m.files), "{}", m.id);
            for f in m.files {
                assert!(files.insert(f.file), "{} is in two models", f.file);
                assert!(f.file.starts_with(m.path), "{}", f.file);
                let revision = f
                    .url
                    .split("/resolve/")
                    .nth(1)
                    .and_then(|r| r.split('/').next());
                assert!(
                    revision
                        .is_some_and(|r| r.len() == 40 && r.bytes().all(|b| b.is_ascii_hexdigit())),
                    "{} is not pinned to a revision",
                    f.file
                );
                assert_eq!(f.sha256.len(), 64, "{}", f.file);
            }
        }
    }
}
