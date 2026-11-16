//! The streaming synthesizer: plan the reply, speak one segment at a time, trim the
//! model's padding and hand each sentence to the caller as soon as it exists.
use crate::supertonic::{self, Model, Style};
use crate::{
    plan, trim, Error, LangChoice, Lexicon, DEFAULT_SPEED, DEFAULT_STEPS, DEFAULT_VOICE, MAX_STEPS,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct SynthOptions {
    pub voice: String,
    pub lang: LangChoice,
    pub steps: usize,
    pub speed: f32,
    /// Fixes the noise, so the same text gives the same audio.
    pub seed: u64,
}

impl Default for SynthOptions {
    fn default() -> Self {
        SynthOptions {
            voice: DEFAULT_VOICE.into(),
            lang: LangChoice::Auto,
            steps: DEFAULT_STEPS,
            speed: DEFAULT_SPEED,
            seed: 42,
        }
    }
}

/// What one request produced.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spoken {
    pub samples: usize,
    pub segments: usize,
    /// From the call to the first sentence's audio, in ms.
    pub first_audio_ms: u64,
    pub total_ms: u64,
}

pub struct Synthesizer {
    model: Model,
    voice_dir: PathBuf,
    voices: HashMap<String, Style>,
    lexicon: Lexicon,
}

impl Synthesizer {
    /// Loads the model from Supertonic's folder layout: `onnx/` and `voice_styles/`.
    pub fn load(model_dir: &Path, threads: usize, lexicon: Lexicon) -> Result<Synthesizer, Error> {
        let model = Model::load(
            &model_dir.join("onnx"),
            &supertonic::Options {
                threads: threads.max(1),
            },
        )?;
        Ok(Synthesizer {
            model,
            voice_dir: model_dir.join("voice_styles"),
            voices: HashMap::new(),
            lexicon,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.model.sample_rate
    }

    fn style(&mut self, voice: &str) -> Result<&Style, Error> {
        if !crate::is_voice(voice) {
            return Err(Error::Input(format!(
                "unknown voice {voice}; choose one of {}",
                crate::VOICES.join(", ")
            )));
        }
        if !self.voices.contains_key(voice) {
            let style = supertonic::load_style(&self.voice_dir.join(format!("{voice}.json")))?;
            self.voices.insert(voice.to_string(), style);
        }
        Ok(&self.voices[voice])
    }

    /// Speaks `text`, calling `on_audio(samples)` once per segment with the trimmed
    /// speech followed by its pause (none after the last). Mono f32 at
    /// [`Self::sample_rate`]. An `Err` from `on_audio` stops the request.
    pub fn speak(
        &mut self,
        text: &str,
        opts: &SynthOptions,
        cancelled: &dyn Fn() -> bool,
        on_audio: &mut dyn FnMut(&[f32]) -> Result<(), Error>,
    ) -> Result<Spoken, Error> {
        let started = Instant::now();
        if !(1..=MAX_STEPS).contains(&opts.steps) {
            return Err(Error::Input(format!(
                "steps must be between 1 and {MAX_STEPS}"
            )));
        }
        if !(opts.speed.is_finite() && (0.5..=2.0).contains(&opts.speed)) {
            return Err(Error::Input("speed must be between 0.5 and 2".into()));
        }
        self.style(&opts.voice)?;
        let segments = plan(text, opts.lang, &self.lexicon);
        if segments.is_empty() {
            return Err(Error::Input("nothing to say".into()));
        }
        let rate = self.model.sample_rate;
        let mut spoken = Spoken {
            samples: 0,
            segments: segments.len(),
            first_audio_ms: 0,
            total_ms: 0,
        };
        for (i, segment) in segments.iter().enumerate() {
            let style = &self.voices[&opts.voice];
            // Per-segment seeds keep a sentence's audio independent of its neighbours.
            let raw = self.model.infer(
                &segment.text,
                segment.lang.code(),
                style,
                opts.steps,
                opts.speed,
                opts.seed.wrapping_add(i as u64),
                cancelled,
            )?;
            let mut audio = trim::trim(&raw, rate);
            if audio.is_empty() {
                continue;
            }
            audio.extend(trim::silence(segment.pause_after_ms, rate));
            if spoken.samples == 0 {
                spoken.first_audio_ms = started.elapsed().as_millis() as u64;
            }
            spoken.samples += audio.len();
            on_audio(&audio)?;
        }
        if spoken.samples == 0 {
            return Err(Error::Model("the model returned only silence".into()));
        }
        spoken.total_ms = started.elapsed().as_millis() as u64;
        Ok(spoken)
    }
}
