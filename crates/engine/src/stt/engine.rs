//! The speech engines of `delulu-engine stt`: Whisper large-v3-turbo through whisper.cpp
//! and Parakeet Ultra through transcribe.cpp (`delulu-transcribe`), both on the
//! engine's one ggml. One model at a time; the role (`super`) drives it from the
//! worker protocol.
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use super::{closing, pieces, vad, SttError};
use delulu_stt::{
    flipped, guess_language, model_info, EngineKind, Language, Prompt, Transcript,
    DEFAULT_ALLOWED_LANGUAGES,
};

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
/// The codes automatic detection chooses from, as `allowed_ids` reads the setting.
fn allowed_codes(allowed: &[String]) -> Vec<String> {
    allowed_ids(allowed)
        .into_iter()
        .filter_map(whisper_rs::get_lang_str)
        .map(str::to_string)
        .collect()
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
pub struct Engine {
    inner: Inner,
    backend: String,
}
enum Inner {
    Whisper {
        context: whisper_rs::WhisperContext,
        state: whisper_rs::WhisperState,
        /// None only if the built-in detector failed to load; then every clip is decoded.
        vad: Option<vad::Vad>,
    },
    Parakeet(delulu_transcribe::Ultra),
}

fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().min(8))
}
fn params<'a>(language: &'a str, prompt: Option<&'a str>) -> whisper_rs::FullParams<'a, 'a> {
    params_for(language, prompt, Redo::None)
}
/// How a decode differs from the normal one.
#[derive(Clone, Copy)]
enum Redo<'a> {
    None,
    /// With timestamps: whisper.cpp then decodes in segments, a different path.
    Timestamps,
    /// With timestamps, and without the given first tokens.
    AvoidStart(&'a closing::AvoidStart),
}
fn params_for<'a>(
    language: &'a str,
    prompt: Option<&'a str>,
    redo: Redo<'a>,
) -> whisper_rs::FullParams<'a, 'a> {
    let mut p = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    if let Some(prompt) = prompt {
        // Read as the text before this clip: it steers spelling and names.
        p.set_initial_prompt(prompt);
    }
    p.set_n_threads(threads() as i32);
    p.set_no_context(true);
    p.set_no_timestamps(matches!(redo, Redo::None));
    if let Redo::AvoidStart(avoid) = redo {
        // SAFETY: `avoid` outlives the parameters and so the decode that reads them.
        unsafe {
            p.set_filter_logits_callback(Some(closing::avoid_start));
            p.set_filter_logits_callback_user_data(
                avoid as *const closing::AvoidStart as *mut std::ffi::c_void,
            );
        }
    }
    // Stops at the next encoder or decoder step once the job is cancelled.
    // SAFETY: the callback reads two atomics and ignores its (null) user data.
    unsafe { p.set_abort_callback(Some(abort)) };
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p
}

fn silent(samples: &[f32]) -> bool {
    // Gate only near-digital silence. Quiet speech can sit below 0.003 RMS; for
    // Whisper, the speech detector handles recordings without speech.
    samples.len() < 4000
        || (samples.iter().map(|x| x * x).sum::<f32>() / samples.len() as f32).sqrt() < 0.0001
}
fn punctuation_only(text: &str) -> bool {
    !text.chars().any(char::is_alphanumeric)
}
/// Text that only describes a sound ("*Sigh*", "[Music]", "♪") or only
/// names sighs and gasps ("Sigh. Sigh.", "Shhh!", "Pfff.") is what Whisper writes for a
/// noise, not what someone said. Interjections ("Oh.", "Hmm.") and laughter stay:
/// people say them, and the speech detector already drops recordings without speech.
/// Parentheses are Whisper's style for spoken asides too ("(I agree.)"), so they stay.
fn sound_only(text: &str) -> bool {
    const SOUNDS: &[&str] = &["sh", "pf", "sigh", "sighs", "gasp", "gasps"];
    let mut words = String::new();
    let mut closer = None;
    for c in text.chars() {
        match closer {
            // An unclosed description runs to the end.
            Some(end) if c == end => closer = None,
            Some(_) => {}
            None => match c {
                '*' => closer = Some('*'),
                '[' => closer = Some(']'),
                '♪' => words.push(' '),
                c => words.extend(c.to_lowercase()),
            },
        }
    }
    words
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .all(|word| {
            // "Shhhh" is "sh", "hmmm" is "hm".
            let mut squeezed: Vec<char> = word.chars().collect();
            squeezed.dedup();
            SOUNDS.contains(&squeezed.into_iter().collect::<String>().as_str())
        })
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

/// No job is decoding.
const IDLE: u64 = u64::MAX;
/// The job decoding now and the last job cancelled. A decode stops at its next step
/// once they agree. One engine per process (the `stt` role), so these are process-wide;
/// keeping them apart means a cancel can arrive before, during or after its job.
static RUNNING: AtomicU64 = AtomicU64::new(IDLE);
static CANCELLED: AtomicU64 = AtomicU64::new(IDLE - 1);

/// Stop job `id` if it is decoding now, or when it starts.
pub fn cancel(id: u64) {
    CANCELLED.store(id, Ordering::SeqCst);
}

fn cancelled() -> bool {
    CANCELLED.load(Ordering::SeqCst) == RUNNING.load(Ordering::SeqCst)
}

unsafe extern "C" fn abort(_: *mut std::ffi::c_void) -> bool {
    cancelled()
}

/// Marks job `id` as decoding while it lives.
pub struct Running(());
impl Running {
    pub fn start(id: u64) -> Self {
        RUNNING.store(id, Ordering::SeqCst);
        Self(())
    }
    /// The job was cancelled (before or while it ran).
    pub fn cancelled(&self) -> bool {
        cancelled()
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.store(IDLE, Ordering::SeqCst);
    }
}

impl Engine {
    /// Loads model `id` (a speech row of the registry) from `path` and warms it up.
    pub fn load(id: &str, path: &Path) -> Result<Self, SttError> {
        let info = model_info(id).ok_or_else(|| SttError::Model(format!("unknown model: {id}")))?;
        let (inner, backend) = match info.engine {
            EngineKind::Whisper => load_whisper(path)?,
            EngineKind::Parakeet => load_parakeet(path)?,
            other => {
                return Err(SttError::Model(format!(
                    "{id} is a {} model, not speech",
                    other.as_str()
                )))
            }
        };
        Ok(Self { inner, backend })
    }
    pub fn backend(&self) -> String {
        self.backend.clone()
    }
    /// `prompt` is context from earlier dictations (names, the last sentence); Parakeet
    /// takes none.
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        language: &Language,
        prompt: Option<&Prompt>,
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
            Inner::Whisper {
                context,
                state,
                vad,
            } => std::thread::scope(|scope| {
                // The detector runs on the CPU while Whisper runs on the GPU, so it adds
                // no time to a dictation.
                let speech = vad.as_mut().map(|vad| scope.spawn(|| vad.speech(samples)));
                let (code, allowed) = match language {
                    Language::Auto(allowed) => (
                        detect_within(state, samples, allowed)?,
                        allowed_codes(allowed),
                    ),
                    // A fixed language allows no other.
                    Language::Fixed(code) => (code.as_str(), Vec::new()),
                };
                let (mut pieces, language) =
                    whisper_pieces(state, samples, code, &allowed, prompt)?;
                let speech = speech.and_then(|handle| {
                    handle
                        .join()
                        .unwrap_or_else(|_| {
                            Err(SttError::Inference("speech detection panicked".into()))
                        })
                        // Better a typed noise than a lost dictation.
                        .inspect_err(|e| log::warn!("stt: {e}; keeping the text"))
                        .ok()
                });
                if speech.as_ref().is_some_and(Vec::is_empty) {
                    // Nobody spoke: whatever Whisper wrote is invented.
                    return Ok((String::new(), language));
                }
                for piece in &mut pieces {
                    let seconds = |at: usize| at as f32 / 16_000.0;
                    let speech = speech.as_ref().map(|stretches| {
                        vad::speech_within(
                            stretches,
                            seconds(piece.range.start)..seconds(piece.range.end),
                        )
                    });
                    let clip = &samples[piece.range.clone()];
                    if closing::only_closing(&piece.text) {
                        piece.text = recheck_closing(context, state, clip, code, piece, speech)?;
                    } else if speech.is_some_and(|s| too_short(&piece.text, s)) {
                        piece.text = recheck_short(state, clip, code, piece)?;
                    }
                }
                let texts: Vec<String> = pieces
                    .into_iter()
                    .map(|p| p.text)
                    .filter(|t| !punctuation_only(t))
                    .collect();
                Ok((texts.join(" "), language))
            })?,
            Inner::Parakeet(model) => {
                let text = model
                    .transcribe(samples, cancelled)
                    .map_err(|e| SttError::Inference(e.to_string()))?
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
    let vad = vad::Vad::load()
        .and_then(|mut vad| vad.speech(&warmup_noise()).map(|_| vad))
        .inspect_err(|e| log::warn!("stt: {e}; every recording will be decoded"))
        .ok();
    Ok((
        Inner::Whisper {
            context,
            state,
            vad,
        },
        backend_name(),
    ))
}

/// Parakeet Ultra from its folder's `.gguf` (or a `.gguf` path), warmed up: on the
/// graphics card when there is one, else, or when the card fails to load or run it,
/// on the processor.
fn load_parakeet(path: &Path) -> Result<(Inner, String), SttError> {
    let file = if path.is_dir() {
        std::fs::read_dir(path)
            .map_err(|e| SttError::Model(format!("{}: {e}", path.display())))?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .find(|p| p.extension().is_some_and(|x| x == "gguf"))
            .ok_or_else(|| SttError::Model(format!("no .gguf in {}", path.display())))?
    } else {
        path.to_path_buf()
    };
    let gpu = backend_name();
    let warm = |gpu: bool| {
        let mut model = delulu_transcribe::Ultra::load(&file, gpu, threads())?;
        model.transcribe(&warmup_noise(), || false)?;
        Ok::<_, delulu_transcribe::Error>(model)
    };
    if gpu != "CPU" {
        match warm(true) {
            Ok(model) => return Ok((Inner::Parakeet(model), gpu)),
            Err(e) => {
                log::warn!("stt: Parakeet on the graphics card failed ({e}); using the processor")
            }
        }
    }
    let model = warm(false).map_err(|e| SttError::Model(e.to_string()))?;
    Ok((Inner::Parakeet(model), "CPU".to_string()))
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

/// A decoded piece of a clip, and the prompt its text came from.
struct Piece {
    range: std::ops::Range<usize>,
    prompt: Option<String>,
    text: String,
}

/// Whisper's text for a clip of any length: in pieces under its 30 s window, cut at
/// pauses (see `pieces`), in order. Each piece after the first reads the previous
/// piece's text as its sentence, as whisper.cpp does between its own windows.
fn whisper_pieces(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    allowed: &[String],
    prompt: Option<&Prompt>,
) -> Result<(Vec<Piece>, String), SttError> {
    let mut decoded: Vec<Piece> = Vec::new();
    let mut language = code.to_string();
    for range in pieces::pieces(samples) {
        let previous = decoded
            .iter()
            .rfind(|p| !p.text.is_empty())
            .map(|piece| Prompt {
                terms: prompt.and_then(|p| p.terms.clone()),
                sentence: Some(tail(&piece.text, 200).to_string()),
            });
        let (text, lang, used) = whisper_transcribe(
            state,
            &samples[range.clone()],
            code,
            allowed,
            previous.as_ref().or(prompt),
        )?;
        language = lang;
        decoded.push(Piece {
            range,
            prompt: used,
            text: if punctuation_only(&text) {
                String::new()
            } else {
                text
            },
        });
    }
    Ok((decoded, language))
}

fn word_count(text: &str) -> usize {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .count()
}

/// Far too little text for the speech heard: people say two to three words a second,
/// and a piece with seconds of speech and almost no words lost them ("K u wel." for
/// 20 s of a speech). Real dictation stays well above half a word per second.
fn too_short(text: &str, speech_s: f32) -> bool {
    speech_s >= 4.0 && (word_count(text) as f32) < speech_s * 0.5
}

/// A piece that is far too short for its speech, decoded again with timestamps (see
/// `recheck_closing`). The second text wins only if it has at least twice the words.
fn recheck_short(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    piece: &Piece,
) -> Result<String, SttError> {
    let (again, _) = whisper_text_with(
        state,
        samples,
        code,
        piece.prompt.as_deref(),
        Redo::Timestamps,
    )?;
    if word_count(&again) >= 2 * word_count(&piece.text).max(1) && !closing::only_closing(&again) {
        log::info!("stt: the text was far too short for its speech; the second decode replaced it");
        return Ok(again);
    }
    Ok(piece.text.clone())
}

/// A piece whose whole text is a closing phrase ("Dank u wel."), asked again. A decode
/// with timestamps takes another path through the model and rarely does this; its text
/// wins unless it is a closing phrase too. If both agree, the phrase stands, unless
/// the piece holds clearly more speech than the phrase takes: then Whisper decodes once
/// more without the phrase's first word to start with. A real thank-you comes out
/// again (in lowercase) and the phrase stays; a sentence comes out instead of it.
fn recheck_closing(
    context: &whisper_rs::WhisperContext,
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    piece: &Piece,
    speech_s: Option<f32>,
) -> Result<String, SttError> {
    let prompt = piece.prompt.as_deref();
    let other = |text: &str| !text.is_empty() && !closing::only_closing(text);
    let (again, _) = whisper_text_with(state, samples, code, prompt, Redo::Timestamps)?;
    if other(&again) {
        log::info!("stt: a closing phrase stood in for the clip; the second decode replaced it");
        return Ok(again);
    }
    if speech_s.is_none_or(|s| s <= closing::LONGER_THAN_A_PHRASE_S) {
        return Ok(piece.text.clone());
    }
    let word = closing::first_word(&piece.text).unwrap_or_default();
    let mut tokens = Vec::new();
    for start in [format!(" {word}"), word.to_string()] {
        if let Some(&first) = context
            .tokenize(&start, 8)
            .map_err(|e| SttError::Inference(e.to_string()))?
            .first()
        {
            tokens.push(first);
        }
    }
    let avoid = closing::AvoidStart {
        tokens,
        timestamp_begin: context.token_beg(),
    };
    let (third, _) = whisper_text_with(state, samples, code, prompt, Redo::AvoidStart(&avoid))?;
    if other(&third) {
        log::info!("stt: a closing phrase stood in for {speech_s:?} s of speech; replaced");
        return Ok(third);
    }
    Ok(piece.text.clone())
}

/// The last `max` characters of `text`, from the start of a word.
fn tail(text: &str, max: usize) -> &str {
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    let cut = &text[text.char_indices().nth(count - max).map_or(0, |(i, _)| i)..];
    cut.find(' ')
        .map_or(cut, |space| cut[space + 1..].trim_start())
}

/// Whisper's text in `code`, with the prompt built for that language. If the text still
/// comes out in the other allowed language, the previous sentence pulled it there (it
/// was misjudged, or the clip's language was): decode once more without it and keep
/// that result, whatever its language, so a genuinely mixed sentence is never lost.
fn whisper_transcribe(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    allowed: &[String],
    prompt: Option<&Prompt>,
) -> Result<(String, String, Option<String>), SttError> {
    let full = prompt.and_then(|p| p.for_language(code));
    let (text, language) = whisper_text(state, samples, code, full.as_deref())?;
    let terms = prompt.and_then(Prompt::terms_only);
    if full != terms && flipped(&text, code, allowed) {
        log::info!("stt: text not in {code} with the previous sentence; decoding without it");
        let (text, language) = whisper_text(state, samples, code, terms.as_deref())?;
        return Ok((text, language, terms));
    }
    Ok((text, language, full))
}

/// Whisper's text and detected language; empty text when it only described a sound or
/// repeated its prompt.
fn whisper_text(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    prompt: Option<&str>,
) -> Result<(String, String), SttError> {
    whisper_text_with(state, samples, code, prompt, Redo::None)
}

fn whisper_text_with(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
    code: &str,
    prompt: Option<&str>,
    redo: Redo,
) -> Result<(String, String), SttError> {
    state
        .full(params_for(code, prompt, redo), samples)
        .map_err(|e| SttError::Inference(e.to_string()))?;
    let language = whisper_rs::get_lang_str(state.full_lang_id_from_state())
        .unwrap_or(code)
        .to_string();
    // No no-speech check here: whisper.cpp reads that probability after the task tokens,
    // where large-v3-turbo never predicts it (it stays near 0 on pure noise).
    let text = state
        .as_iter()
        .map(|s| {
            s.to_str_lossy()
                .map(|s| s.trim().to_owned())
                .map_err(|e| SttError::Inference(e.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join(" ");
    let text = if sound_only(&text) || echoes(&text, prompt) {
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
    fn sound_descriptions_are_not_speech() {
        for noise in [
            "*Sigh*",
            "*sad sigh*",
            "[Music]",
            "♪",
            "*click click click click cli",
            "*clap* *clap* *clap*",
            "Sigh. Sigh. Sigh.",
            "Shhhh!",
            "Pfff.",
        ] {
            assert!(sound_only(noise), "{noise}");
        }
        for speech in [
            "Okay.",
            "Oh.",
            "Hmm.",
            "Ah! Ah! Ah!",
            "Haha, nice.",
            "Oh, that works.",
            "*Sigh* Fine, merge it.",
            "Ship it (after the tests).",
            "(I agree.)",
        ] {
            assert!(!sound_only(speech), "{speech}");
        }
    }
    #[test]
    fn text_far_too_short_for_its_speech() {
        assert!(too_short("K u wel.", 20.0));
        assert!(too_short("", 5.0));
        assert!(
            !too_short("Ja, doe maar.", 1.5),
            "short clips are never judged"
        );
        // A slow speaker with long words: 2 words in 4 s is still enough.
        assert!(!too_short("Uitstekend, bedankt.", 4.0));
        assert!(!too_short(&"woord ".repeat(12), 20.0));
    }
    #[test]
    fn punctuation_filter() {
        assert!(punctuation_only(" ... ! "));
        assert!(!punctuation_only("hé!"));
        assert!(!punctuation_only("42."));
    }
}
