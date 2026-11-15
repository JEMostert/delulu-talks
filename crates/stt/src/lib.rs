use std::{path::Path, time::Instant};

/// The speech engines are rows of the shared model registry (`delulu-models`), which
/// also downloads them. Whisper runs on the GPU and follows the language setting and
/// context prompt; Parakeet runs on the CPU and detects the language.
pub use delulu_models::{Engine as EngineKind, Model as ModelInfo, ModelFile};

pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";

/// The speech-to-text models, in registry order.
pub fn models() -> Vec<&'static ModelInfo> {
    delulu_models::with_role(delulu_models::Role::Stt).collect()
}
pub fn model_info(id: &str) -> Option<&'static ModelInfo> {
    delulu_models::get(id).filter(|m| m.role == delulu_models::Role::Stt)
}
pub fn is_downloaded(dir: &Path, id: &str) -> bool {
    model_info(id).is_some_and(|m| m.installed(dir))
}
/// True when the file is in `dir` at its expected size.
pub fn file_ready(dir: &Path, file: &ModelFile) -> bool {
    file.ready(dir)
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
/// What automatic detection chooses from when the stored set holds no Whisper language.
/// The settings store has the same default.
pub const DEFAULT_ALLOWED_LANGUAGES: [&str; 2] = ["nl", "en"];
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Language {
    /// Detect the language, choosing only among these codes.
    Auto(Vec<String>),
    Fixed(String),
}
impl Language {
    /// `allowed` applies only when `s` is "auto".
    pub fn from_setting(s: &str, allowed: &[String]) -> Self {
        if s == "auto" {
            Self::Auto(allowed.to_vec())
        } else {
            Self::Fixed(s.into())
        }
    }
}
/// Whisper's ids for `allowed`, or for the default set when none of it is a Whisper language.
fn allowed_ids(allowed: &[String]) -> Vec<i32> {
    let ids = |codes: &mut dyn Iterator<Item = &str>| {
        let mut ids = Vec::new();
        for code in codes {
            // whisper_lang_id also takes full names; a NUL byte would panic in whisper-rs.
            if let Some(id) = (!code.contains('\0'))
                .then(|| whisper_rs::get_lang_id(code))
                .flatten()
            {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        ids
    };
    let chosen = ids(&mut allowed.iter().map(String::as_str));
    if chosen.is_empty() {
        ids(&mut DEFAULT_ALLOWED_LANGUAGES.into_iter())
    } else {
        chosen
    }
}
/// The most probable language within `allowed`, given Whisper's probability for each
/// language id. Whisper's own top choice may lie outside the set (short or quiet clips
/// drift to Icelandic or Welsh); then the best language inside the set wins.
fn choose_language(probs: &[f32], allowed: &[String]) -> &'static str {
    let prob = |id: i32| probs.get(id as usize).copied().unwrap_or(f32::MIN);
    allowed_ids(allowed)
        .into_iter()
        .max_by(|a, b| prob(*a).total_cmp(&prob(*b)))
        .and_then(whisper_rs::get_lang_str)
        .unwrap_or(DEFAULT_ALLOWED_LANGUAGES[0])
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

fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().min(8))
}
fn params<'a>(language: &'a str, prompt: Option<&'a str>) -> whisper_rs::FullParams<'a, 'a> {
    let mut p = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    if let Some(prompt) = prompt {
        // Read as the text before this clip: it steers spelling and names.
        p.set_initial_prompt(prompt);
    }
    p.set_n_threads(threads() as i32);
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
            other => {
                return Err(SttError::Model(format!(
                    "{id} is a {} model, not speech",
                    other.as_str()
                )))
            }
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
        let audio_ms = samples.len() as u64 / 16;
        if silent(samples) {
            return Ok(Transcript {
                text: String::new(),
                language: match language {
                    Language::Auto(_) => "auto".to_string(),
                    Language::Fixed(code) => code.clone(),
                },
                audio_ms,
                elapsed_ms: 0,
            });
        }
        let start = Instant::now();
        let (text, language) = match &mut self.inner {
            Inner::Whisper { state, .. } => {
                let code = match language {
                    Language::Auto(allowed) => detect_within(state, samples, allowed)?,
                    Language::Fixed(code) => code.as_str(),
                };
                whisper_text(state, samples, code, prompt)?
            }
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
                    // Parakeet cannot be held to the allowed set, so its guess stands.
                    Language::Auto(_) => guess_language(&text).unwrap_or("auto").to_string(),
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

/// The most probable allowed language, from the same detection pass Whisper's own
/// "auto" runs; a one-language set needs no detection.
fn detect_within(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    allowed: &[String],
) -> Result<&'static str, SttError> {
    if let [only] = allowed_ids(allowed)[..] {
        if let Some(code) = whisper_rs::get_lang_str(only) {
            return Ok(code);
        }
    }
    let inference = |e: whisper_rs::WhisperError| SttError::Inference(e.to_string());
    state.pcm_to_mel(samples, threads()).map_err(inference)?;
    let (_, probs) = state.lang_detect(0, threads()).map_err(inference)?;
    Ok(choose_language(&probs, allowed))
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
    fn default_model_is_a_whisper_model() {
        assert_eq!(
            model_info(DEFAULT_MODEL).unwrap().engine,
            EngineKind::Whisper
        );
        assert_eq!(models()[0].id, DEFAULT_MODEL);
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
    fn chooses_the_most_probable_allowed_language() {
        let id = |code| whisper_rs::get_lang_id(code).unwrap() as usize;
        let mut probs = vec![0.001; whisper_rs::get_lang_max_id() as usize + 1];
        probs[id("is")] = 0.6;
        probs[id("en")] = 0.1;
        probs[id("nl")] = 0.25;
        let set = |codes: &[&str]| codes.iter().map(|c| c.to_string()).collect::<Vec<_>>();
        assert_eq!(choose_language(&probs, &set(&["nl", "en"])), "nl");
        assert_eq!(choose_language(&probs, &set(&["en", "de"])), "en");
        assert_eq!(choose_language(&probs, &set(&["de"])), "de");
        // Nothing usable stored: the default set, so never Icelandic.
        assert_eq!(choose_language(&probs, &[]), "nl");
        assert_eq!(choose_language(&probs, &set(&["xx", "", "a\0b"])), "nl");
        assert_eq!(allowed_ids(&set(&["xx"])), allowed_ids(&set(&["nl", "en"])));
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
    #[error("inference: {0}")]
    Inference(String),
}
