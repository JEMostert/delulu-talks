use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
/// The two speech engines. Whisper runs on the GPU and follows the language
/// setting and context prompt; Parakeet runs on the CPU and detects the language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Whisper,
    Parakeet,
}
impl EngineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whisper => "whisper",
            Self::Parakeet => "parakeet",
        }
    }
}
/// One downloadable file; `file` is relative to the models folder.
pub struct ModelFile {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub engine: EngineKind,
    /// What the engine loads, relative to the models folder: a file or a folder.
    pub path: &'static str,
    pub files: &'static [ModelFile],
    /// All files together.
    pub bytes: u64,
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
pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";
static TURBO_FILES: [ModelFile; 1] = [ModelFile {
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    bytes: 574041195,
}];
static SMALL_FILES: [ModelFile; 1] = [ModelFile {
    file: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    bytes: 487601967,
}];
/// NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0), int8 ONNX export by istupakov.
static PARAKEET_FILES: [ModelFile; 4] = [
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/encoder-model.int8.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/encoder-model.int8.onnx",
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
        bytes: 652183999,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/decoder_joint-model.int8.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/decoder_joint-model.int8.onnx",
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
        bytes: 18202004,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/nemo128.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/nemo128.onnx",
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
        bytes: 139764,
    },
    ModelFile {
        file: "parakeet-tdt-0.6b-v3-int8/vocab.txt",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/vocab.txt",
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        bytes: 93939,
    },
];
static MODELS: [ModelInfo; 3] = [
    ModelInfo {
        id: DEFAULT_MODEL,
        label: "Large v3 Turbo (recommended)",
        engine: EngineKind::Whisper,
        path: "ggml-large-v3-turbo-q5_0.bin",
        files: &TURBO_FILES,
        bytes: total(&TURBO_FILES),
    },
    ModelInfo {
        id: "small",
        label: "Small (faster, weaker Dutch)",
        engine: EngineKind::Whisper,
        path: "ggml-small.bin",
        files: &SMALL_FILES,
        bytes: total(&SMALL_FILES),
    },
    ModelInfo {
        id: "parakeet-tdt-0.6b-v3",
        label: "Parakeet TDT 0.6B v3",
        engine: EngineKind::Parakeet,
        path: "parakeet-tdt-0.6b-v3-int8",
        files: &PARAKEET_FILES,
        bytes: total(&PARAKEET_FILES),
    },
];
pub fn models() -> &'static [ModelInfo] {
    &MODELS
}
pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    models().iter().find(|m| m.id == id)
}
pub fn is_downloaded(dir: &Path, id: &str) -> bool {
    model_info(id).is_some_and(|m| m.files.iter().all(|f| file_ready(dir, f)))
}
/// True when the file is in `dir` at its expected size.
pub fn file_ready(dir: &Path, file: &ModelFile) -> bool {
    dir.join(file.file)
        .metadata()
        .is_ok_and(|v| v.len() == file.bytes)
}
/// Downloads every missing file of a model, reporting progress over all of them.
pub fn download(
    dir: &Path,
    id: &str,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<(), SttError> {
    let info = model_info(id).ok_or_else(|| SttError::Model(format!("unknown model: {id}")))?;
    let mut before = 0;
    for file in info.files {
        if !file_ready(dir, file) {
            download_file(
                dir,
                file,
                &mut |done, _| progress(before + done, info.bytes),
                cancel,
            )?;
        }
        before += file.bytes;
    }
    progress(info.bytes, info.bytes);
    Ok(())
}
/// Downloads one file into `dir`, verifying size and SHA-256 before it appears
/// under its final name.
pub fn download_file(
    dir: &Path,
    info: &ModelFile,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<PathBuf, SttError> {
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
    info: &ModelFile,
    mut reader: impl Read,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<PathBuf, SttError> {
    use sha2::{Digest, Sha256};
    let path = dir.join(info.file);
    let part = dir.join(format!("{}.part", info.file));
    let result = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(download_error)?;
        }
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
    inner: Inner,
    id: String,
    backend: String,
}
enum Inner {
    Whisper {
        _context: whisper_rs::WhisperContext,
        state: whisper_rs::WhisperState,
    },
    Parakeet(Box<transcribe_rs::onnx::parakeet::ParakeetModel>),
}

fn params<'a>(language: &'a str, prompt: Option<&'a str>) -> whisper_rs::FullParams<'a, 'a> {
    let mut p = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    if let Some(prompt) = prompt {
        // Read as the text before this clip: it steers spelling and names.
        p.set_initial_prompt(prompt);
    }
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
    // Gate only near-digital silence. Quiet speech can sit below 0.003 RMS;
    // Whisper's no-speech probability handles recordings without speech.
    samples.len() < 4000
        || (samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32).sqrt() < 0.0001
}
fn punctuation_only(text: &str) -> bool {
    !text.chars().any(char::is_alphanumeric)
}
/// Whisper sometimes just repeats its prompt on a near-silent clip; that is not speech.
/// Short replies ("yes", "GG") may well repeat a prompt word, so only longer runs count.
fn echoes(text: &str, prompt: Option<&str>) -> bool {
    let plain = |s: &str| {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let text = plain(text);
    prompt.is_some_and(|prompt| text.split(' ').count() >= 4 && plain(prompt).contains(&text))
}

/// Parakeet v3's languages that whatlang knows (all but Maltese), by ISO 639-1 code.
const PARAKEET_LANGUAGES: [(whatlang::Lang, &str); 24] = {
    use whatlang::Lang::*;
    [
        (Bul, "bg"),
        (Hrv, "hr"),
        (Ces, "cs"),
        (Dan, "da"),
        (Nld, "nl"),
        (Eng, "en"),
        (Est, "et"),
        (Fin, "fi"),
        (Fra, "fr"),
        (Deu, "de"),
        (Ell, "el"),
        (Hun, "hu"),
        (Ita, "it"),
        (Lav, "lv"),
        (Lit, "lt"),
        (Pol, "pl"),
        (Por, "pt"),
        (Ron, "ro"),
        (Slk, "sk"),
        (Slv, "sl"),
        (Spa, "es"),
        (Swe, "sv"),
        (Rus, "ru"),
        (Ukr, "uk"),
    ]
};
/// Common short words that only one of Dutch and English uses ("is", "in", "we" and
/// "me" are in both). Trigram detection often confuses the two on a short phrase.
const DUTCH_WORDS: &[&str] = &[
    "de", "het", "een", "en", "ik", "je", "jij", "mijn", "niet", "wat", "van", "dat", "die", "met",
    "voor", "op", "naar", "kan", "kun", "wil", "moet", "zijn", "er", "maar", "ook", "dit", "deze",
    "hoe", "waar", "wel", "geen", "om", "te", "aan", "bij", "uit", "nog", "mij", "u", "uw",
    "jullie", "wij", "ze", "hij", "zij", "heb", "heeft", "hebben", "graag", "kunnen", "ga", "gaan",
    "mag", "wordt", "worden", "dan", "als", "ben", "bent",
];
const ENGLISH_WORDS: &[&str] = &[
    "the", "a", "an", "and", "to", "of", "are", "am", "my", "i", "you", "your", "can", "it",
    "that", "this", "what", "with", "for", "on", "not", "do", "does", "be", "have", "has",
    "please", "how", "at", "from", "was", "will", "would", "want", "need", "get", "there", "they",
    "our", "just", "then", "if", "or", "but", "no", "yes", "change",
];
/// Parakeet does not say which language it heard, so guess it from the text. Another
/// language needs whatlang to be sure; Dutch versus English goes by common words, then
/// by whatlang choosing between just those two. None for text with no letters.
fn guess_language(text: &str) -> Option<&'static str> {
    let code = |lang| {
        PARAKEET_LANGUAGES
            .iter()
            .find(|(l, _)| *l == lang)
            .map(|(_, code)| *code)
    };
    let guess = whatlang::Detector::with_allowlist(PARAKEET_LANGUAGES.map(|(l, _)| l).to_vec())
        .detect(text);
    if let Some(info) = &guess {
        if info.is_reliable() && !matches!(info.lang(), whatlang::Lang::Nld | whatlang::Lang::Eng) {
            return code(info.lang());
        }
    }
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let hits = |list: &[&str]| words.iter().filter(|w| list.contains(&w.as_str())).count();
    let (dutch, english) = (hits(DUTCH_WORDS), hits(ENGLISH_WORDS));
    if dutch != english {
        return Some(if dutch > english { "nl" } else { "en" });
    }
    // An unsure guess on a few words is often far off ("New loan." as Hungarian).
    match guess {
        Some(info) if info.is_reliable() => code(info.lang()),
        _ => whatlang::Detector::with_allowlist(vec![whatlang::Lang::Nld, whatlang::Lang::Eng])
            .detect(text)
            .and_then(|info| code(info.lang())),
    }
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

/// Low, deterministic noise for warming a model up.
fn warmup_noise() -> Vec<f32> {
    let mut seed = 1u32;
    (0..48000)
        .map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.01
        })
        .collect()
}

impl Engine {
    /// Loads model `id` from the models folder `dir` and warms it up.
    pub fn load(dir: &Path, id: &str) -> Result<Self, SttError> {
        let info = model_info(id).ok_or_else(|| SttError::Model(format!("unknown model: {id}")))?;
        let path = dir.join(info.path);
        let (inner, backend) = match info.engine {
            EngineKind::Whisper => load_whisper(&path)?,
            EngineKind::Parakeet => load_parakeet(&path)?,
        };
        Ok(Self {
            inner,
            id: id.to_string(),
            backend,
        })
    }
    pub fn backend(&self) -> String {
        self.backend.clone()
    }
    pub fn model_id(&self) -> &str {
        &self.id
    }
    /// `prompt` is context from earlier dictations (names, the last sentence).
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
        prompt: Option<&str>,
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
        let (text, language) = match &mut self.inner {
            Inner::Whisper { state, .. } => whisper_text(state, samples, code, prompt)?,
            Inner::Parakeet(model) => {
                let text = model
                    .transcribe_with(samples, &Default::default())
                    .map_err(|e| SttError::Inference(e.to_string()))?
                    .text
                    .trim()
                    .to_string();
                // A fixed language setting wins over a guess from a short phrase.
                let language = match language {
                    Language::Fixed(code) => code.clone(),
                    Language::Auto => guess_language(&text).unwrap_or("auto").to_string(),
                };
                (text, language)
            }
        };
        let text = if punctuation_only(&text) {
            String::new()
        } else {
            text
        };
        Ok(Transcript {
            text,
            language,
            audio_ms,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

fn load_whisper(path: &Path) -> Result<(Inner, String), SttError> {
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
    // Noise exercises both language detection and decoding.
    state
        .full(params("auto", None), &warmup_noise())
        .map_err(|e| SttError::Inference(e.to_string()))?;
    Ok((
        Inner::Whisper {
            _context: context,
            state,
        },
        backend_name(),
    ))
}

fn load_parakeet(path: &Path) -> Result<(Inner, String), SttError> {
    use transcribe_rs::onnx::{parakeet::ParakeetModel, Quantization};
    let mut model = ParakeetModel::load(path, &Quantization::Int8)
        .map_err(|e| SttError::Model(e.to_string()))?;
    model
        .transcribe_with(&warmup_noise(), &Default::default())
        .map_err(|e| SttError::Inference(e.to_string()))?;
    Ok((
        Inner::Parakeet(Box::new(model)),
        "CPU (ONNX Runtime)".to_string(),
    ))
}

/// Whisper's text and detected language; empty text when it heard no speech or only
/// repeated its prompt.
fn whisper_text(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    prompt: Option<&str>,
) -> Result<(String, String), SttError> {
    state
        .full(params(code, prompt), samples)
        .map_err(|e| SttError::Inference(e.to_string()))?;
    let language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
        .unwrap_or(code)
        .to_string();
    let segments: Vec<_> = state.as_iter().collect();
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
    let text = if no_speech || echoes(&text, prompt) {
        String::new()
    } else {
        text.trim().to_string()
    };
    Ok((text, language))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_echoes_are_not_speech() {
        let prompt = Some("T3 Code, Tauri. Fix the merge conflict.");
        assert!(echoes("Fix the merge conflict.", prompt));
        assert!(echoes("t3 code tauri fix", prompt));
        assert!(!echoes("T3 code", prompt), "short replies are kept");
        assert!(!echoes("Open T3 Code and fix it.", prompt));
        assert!(!echoes("Fix the merge conflict.", None));
    }
    #[test]
    fn silence_gate() {
        assert!(silent(&vec![0.1; 3999]));
        assert!(silent(&vec![0.00001; 4000]));
        assert!(!silent(&vec![0.002; 4000]));
    }
    #[test]
    fn download_verifies_and_cleans_partial_file() {
        let dir = std::env::temp_dir().join(format!("delulu-stt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let info = ModelFile {
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
    fn file_ready_checks_size_and_static_model_info() {
        static INFO: ModelFile = ModelFile {
            file: "static-test.bin",
            url: "",
            sha256: "",
            bytes: 3,
        };
        let dir = std::env::temp_dir().join(format!("delulu-stt-ready-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!file_ready(&dir, &INFO));
        std::fs::write(dir.join("static-test.bin"), b"ab").unwrap();
        assert!(!file_ready(&dir, &INFO));
        std::fs::write(dir.join("static-test.bin"), b"abc").unwrap();
        assert!(file_ready(&dir, &INFO));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn model_table_is_consistent() {
        for m in models() {
            assert_eq!(
                m.bytes,
                m.files.iter().map(|f| f.bytes).sum::<u64>(),
                "{}",
                m.id
            );
            assert!(
                m.files.iter().all(|f| f.file.starts_with(m.path)),
                "{}",
                m.id
            );
        }
        assert_eq!(
            model_info(DEFAULT_MODEL).unwrap().engine,
            EngineKind::Whisper
        );
    }
    #[test]
    fn guesses_parakeet_language() {
        assert_eq!(guess_language("Blokkeer mijn kaart."), Some("nl"));
        assert_eq!(guess_language("Ik wil mijn saldo zien."), Some("nl"));
        assert_eq!(guess_language("Freeze my card."), Some("en"));
        assert_eq!(guess_language("Can I change my address?"), Some("en"));
        assert_eq!(guess_language("Can I get a new business loan?"), Some("en"));
        assert_eq!(guess_language("Kan ik geld storten?"), Some("nl"));
        assert_eq!(
            guess_language("Please move the meeting to Thursday at half past three."),
            Some("en")
        );
        assert_eq!(
            guess_language("Bitte verschieben Sie das Treffen auf Donnerstag um halb vier."),
            Some("de")
        );
        assert_eq!(guess_language("42"), None);
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
