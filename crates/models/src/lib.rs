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
    /// Speech for agents' replies and Delulu FM's host.
    Tts,
}

/// The runtime that loads a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Whisper,
    Parakeet,
    Llama,
    Yue,
    Supertonic,
}
impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whisper => "whisper",
            Self::Parakeet => "parakeet",
            Self::Llama => "llama",
            Self::Yue => "yue",
            Self::Supertonic => "supertonic",
        }
    }
}

/// Licence terms the user must see before downloading a model.
#[derive(Debug)]
pub struct Terms {
    pub name: &'static str,
    pub url: &'static str,
    /// Who made the model, for the credit line.
    pub credit: &'static str,
    /// What the user agrees to, in full.
    pub text: &'static str,
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
    /// Terms shown before the download, when the licence asks for that.
    pub terms: Option<&'static Terms>,
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
    terms: None,
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
    terms: None,
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
    terms: None,
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
    terms: None,
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
    terms: None,
};

macro_rules! supertonic {
    ($file:literal) => {
        concat!(
            "https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/",
            $file
        )
    };
}
macro_rules! supertonic_file {
    ($file:literal, $sha:literal, $bytes:literal) => {
        ModelFile {
            file: concat!("supertonic-3/", $file),
            url: supertonic!($file),
            sha256: $sha,
            bytes: $bytes,
        }
    };
}

static SUPERTONIC_FILES: [ModelFile; 17] = [
    // The licence travels with the model (OpenRAIL-M §4, and so it stays at hand).
    supertonic_file!(
        "LICENSE",
        "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f",
        15_007
    ),
    supertonic_file!(
        "onnx/duration_predictor.onnx",
        "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
        3_700_147
    ),
    supertonic_file!(
        "onnx/text_encoder.onnx",
        "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
        36_416_150
    ),
    supertonic_file!(
        "onnx/vector_estimator.onnx",
        "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
        256_534_781
    ),
    supertonic_file!(
        "onnx/vocoder.onnx",
        "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
        101_424_195
    ),
    supertonic_file!(
        "onnx/tts.json",
        "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
        8_253
    ),
    supertonic_file!(
        "onnx/unicode_indexer.json",
        "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
        277_676
    ),
    supertonic_file!(
        "voice_styles/F1.json",
        "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2",
        292_046
    ),
    supertonic_file!(
        "voice_styles/F2.json",
        "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6",
        292_423
    ),
    supertonic_file!(
        "voice_styles/F3.json",
        "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab",
        290_794
    ),
    supertonic_file!(
        "voice_styles/F4.json",
        "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b",
        291_808
    ),
    supertonic_file!(
        "voice_styles/F5.json",
        "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d",
        291_479
    ),
    supertonic_file!(
        "voice_styles/M1.json",
        "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b",
        291_748
    ),
    supertonic_file!(
        "voice_styles/M2.json",
        "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50",
        292_055
    ),
    supertonic_file!(
        "voice_styles/M3.json",
        "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b",
        290_198
    ),
    supertonic_file!(
        "voice_styles/M4.json",
        "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303",
        291_522
    ),
    supertonic_file!(
        "voice_styles/M5.json",
        "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2",
        291_469
    ),
];

/// BigScience OpenRAIL-M, as Supertone ships it. §5 asks every user of an app that
/// uses the model to follow Attachment A, so the app shows it before downloading.
pub static OPENRAIL_M: Terms = Terms {
    name: "BigScience OpenRAIL-M",
    url: "https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE",
    credit: "Supertonic 3 by Supertone Inc.",
    text: "Supertonic 3 by Supertone Inc. is licensed under the BigScience OpenRAIL-M licence. \
By downloading and using it you agree to its use restrictions (Attachment A). You agree not to use the model:
(a) in any way that violates any applicable national, federal, state, local or international law or regulation;
(b) for the purpose of exploiting, harming or attempting to exploit or harm minors in any way;
(c) to generate or disseminate verifiably false information and/or content with the purpose of harming others;
(d) to generate or disseminate personal identifiable information that can be used to harm an individual;
(e) to generate or disseminate content in any context without expressly and intelligibly disclaiming that it is machine generated;
(f) to defame, disparage or otherwise harass others;
(g) to impersonate or attempt to impersonate (e.g. deepfakes) others without their consent;
(h) for fully automated decision making that adversely impacts an individual's legal rights or otherwise creates or modifies a binding, enforceable obligation;
(i) for any use intended to or which has the effect of discriminating against or harming individuals or groups based on online or offline social behavior or known or predicted personal or personality characteristics;
(j) to exploit any of the vulnerabilities of a specific group of persons based on their age, social, physical or mental characteristics, in order to materially distort the behavior of a person pertaining to that group in a manner that causes or is likely to cause that person or another person physical or psychological harm;
(k) for any use intended to or which has the effect of discriminating against individuals or groups based on legally protected characteristics or categories;
(l) to provide medical advice and medical results interpretation;
(m) to generate or disseminate information for the purpose to be used for administration of justice, law enforcement, immigration or asylum processes, such as predicting an individual will commit fraud/crime commitment.
The voices are machine generated; say so wherever you share their audio.",
};

/// Supertonic 3's preset voices, one style file each: five female, five male.
pub const SUPERTONIC_VOICES: [&str; 10] =
    ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
/// Agents' replies. A female default, so it differs from the radio host.
pub const DEFAULT_AGENT_VOICE: &str = "F1";
/// Delulu FM's host.
pub const DEFAULT_RADIO_VOICE: &str = "M1";

/// `f1` → `F1`; None for a name Supertonic 3 does not have.
pub fn supertonic_voice(name: &str) -> Option<String> {
    let upper = name.trim().to_uppercase();
    SUPERTONIC_VOICES.contains(&upper.as_str()).then_some(upper)
}

/// Supertonic 3 (Supertone Inc.): ONNX, 10 preset voices, Dutch and English among
/// 31 languages. Runs on the CPU in `delulu-engine tts`.
pub static SUPERTONIC_3: Model = Model {
    id: "supertonic-3",
    role: Role::Tts,
    engine: Engine::Supertonic,
    label: "Supertonic 3",
    license: "OpenRAIL-M",
    path: "supertonic-3",
    files: &SUPERTONIC_FILES,
    bytes: total(&SUPERTONIC_FILES),
    terms: Some(&OPENRAIL_M),
};

/// The registry. The first model of a role is its default.
pub static MODELS: [&Model; 6] = [
    &WHISPER_TURBO,
    &WHISPER_SMALL,
    &PARAKEET,
    &GEMMA_4_E4B,
    &YUE2_3B,
    &SUPERTONIC_3,
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
    fn every_supertonic_voice_has_its_style_file() {
        for voice in SUPERTONIC_VOICES {
            let file = format!("supertonic-3/voice_styles/{voice}.json");
            assert!(SUPERTONIC_3.files.iter().any(|f| f.file == file), "{file}");
        }
        assert_eq!(supertonic_voice(" m3 ").as_deref(), Some("M3"));
        assert_eq!(supertonic_voice("X1"), None);
    }

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
