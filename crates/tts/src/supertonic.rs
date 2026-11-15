//! Supertonic 3 inference on ONNX Runtime.
//!
//! The text preprocessing is a port of upstream `py/helper.py` (MIT License,
//! Copyright (c) 2025 Supertone Inc.); it was validated in spike E3 against the
//! upstream reference: identical token ids and durations, waveforms at 85–97 dB SNR.
use crate::Error;
use ndarray::{Array1, Array2, Array3};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use regex::Regex;
use std::path::Path;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// The language tags the model knows.
const LANGS: &[&str] = &[
    "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
    "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
];

fn model_err(context: &str) -> impl Fn(ort::Error) -> Error + '_ {
    move |e| Error::Model(format!("{context}: {e}"))
}

pub struct Style {
    ttl: Array3<f32>,
    dp: Array3<f32>,
}

#[derive(serde::Deserialize)]
struct StyleComponent {
    data: serde_json::Value,
    dims: Vec<usize>,
}

#[derive(serde::Deserialize)]
struct StyleFile {
    style_ttl: StyleComponent,
    style_dp: StyleComponent,
}

fn flatten(v: &serde_json::Value, out: &mut Vec<f32>) {
    match v {
        serde_json::Value::Array(a) => a.iter().for_each(|x| flatten(x, out)),
        serde_json::Value::Number(n) => out.push(n.as_f64().unwrap_or(0.0) as f32),
        _ => {}
    }
}

pub fn load_style(path: &Path) -> Result<Style, Error> {
    let bytes =
        std::fs::read(path).map_err(|e| Error::Model(format!("{}: {e}", path.display())))?;
    let file: StyleFile = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Model(format!("{}: {e}", path.display())))?;
    let array = |c: &StyleComponent| -> Result<Array3<f32>, Error> {
        let mut v = Vec::new();
        flatten(&c.data, &mut v);
        let (a, b) = match c.dims[..] {
            [1, a, b] => (a, b),
            _ => {
                return Err(Error::Model(format!(
                    "{}: unexpected style shape {:?}",
                    path.display(),
                    c.dims
                )))
            }
        };
        Array3::from_shape_vec((1, a, b), v)
            .map_err(|e| Error::Model(format!("{}: {e}", path.display())))
    };
    Ok(Style {
        ttl: array(&file.style_ttl)?,
        dp: array(&file.style_dp)?,
    })
}

/// Port of upstream `UnicodeProcessor._preprocess_text`, plus the language wrapper.
pub fn preprocess(text: &str, lang: &str) -> Result<String, Error> {
    static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new("[\u{1f600}-\u{1f64f}\u{1f300}-\u{1f5ff}\u{1f680}-\u{1f6ff}\u{1f700}-\u{1f77f}\u{1f780}-\u{1f7ff}\u{1f800}-\u{1f8ff}\u{1f900}-\u{1f9ff}\u{1fa00}-\u{1fa6f}\u{1fa70}-\u{1faff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}]+").expect("emoji")
    });
    static SYMBOLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[♥☆♡©\\]").expect("symbols"));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("spaces"));
    static END: LazyLock<Regex> =
        LazyLock::new(|| Regex::new("[.!?;:,'\"')\\]}…。」』】〉》›»]$").expect("end"));
    if !LANGS.contains(&lang) {
        return Err(Error::Input(format!("unsupported language {lang}")));
    }
    let mut t: String = text.nfkd().collect();
    t = EMOJI.replace_all(&t, "").into_owned();
    for (k, v) in [
        ("–", "-"),
        ("‑", "-"),
        ("—", "-"),
        ("_", " "),
        ("\u{201c}", "\""),
        ("\u{201d}", "\""),
        ("\u{2018}", "'"),
        ("\u{2019}", "'"),
        ("´", "'"),
        ("`", "'"),
        ("[", " "),
        ("]", " "),
        ("|", " "),
        ("/", " "),
        ("#", " "),
        ("→", " "),
        ("←", " "),
    ] {
        t = t.replace(k, v);
    }
    t = SYMBOLS.replace_all(&t, "").into_owned();
    for (k, v) in [
        ("@", " at "),
        ("e.g.,", "for example, "),
        ("i.e.,", "that is, "),
    ] {
        t = t.replace(k, v);
    }
    for (k, v) in [
        (" ,", ","),
        (" .", "."),
        (" !", "!"),
        (" ?", "?"),
        (" ;", ";"),
        (" :", ":"),
        (" '", "'"),
    ] {
        t = t.replace(k, v);
    }
    while t.contains("\"\"") {
        t = t.replace("\"\"", "\"");
    }
    while t.contains("''") {
        t = t.replace("''", "'");
    }
    t = SPACES.replace_all(&t, " ").trim().to_string();
    if !END.is_match(&t) {
        t.push('.');
    }
    Ok(format!("<{lang}>{t}</{lang}>"))
}

pub struct Options {
    pub threads: usize,
}

pub struct Model {
    indexer: Vec<i64>,
    duration: Session,
    encoder: Session,
    estimator: Session,
    vocoder: Session,
    pub sample_rate: u32,
    base_chunk: usize,
    compress: usize,
    latent_dim: usize,
}

fn session(path: &Path, o: &Options) -> Result<Session, Error> {
    let context = path.display().to_string();
    Session::builder()
        .map_err(model_err(&context))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| Error::Model(format!("{context}: {e}")))?
        .with_intra_threads(o.threads)
        .map_err(|e| Error::Model(format!("{context}: {e}")))?
        .commit_from_file(path)
        .map_err(model_err(&context))
}

fn config_usize(cfg: &serde_json::Value, a: &str, b: &str) -> Result<usize, Error> {
    cfg[a][b]
        .as_u64()
        .map(|v| v as usize)
        .ok_or_else(|| Error::Model(format!("tts.json lacks {a}.{b}")))
}

impl Model {
    /// Loads the four ONNX graphs and the configuration from `onnx_dir`.
    pub fn load(onnx_dir: &Path, o: &Options) -> Result<Model, Error> {
        let read = |name: &str| {
            let path = onnx_dir.join(name);
            std::fs::read(&path).map_err(|e| Error::Model(format!("{}: {e}", path.display())))
        };
        let cfg: serde_json::Value = serde_json::from_slice(&read("tts.json")?)
            .map_err(|e| Error::Model(format!("tts.json: {e}")))?;
        let indexer: Vec<i64> = serde_json::from_slice(&read("unicode_indexer.json")?)
            .map_err(|e| Error::Model(format!("unicode_indexer.json: {e}")))?;
        Ok(Model {
            indexer,
            duration: session(&onnx_dir.join("duration_predictor.onnx"), o)?,
            encoder: session(&onnx_dir.join("text_encoder.onnx"), o)?,
            estimator: session(&onnx_dir.join("vector_estimator.onnx"), o)?,
            vocoder: session(&onnx_dir.join("vocoder.onnx"), o)?,
            sample_rate: config_usize(&cfg, "ae", "sample_rate")? as u32,
            base_chunk: config_usize(&cfg, "ae", "base_chunk_size")?,
            compress: config_usize(&cfg, "ttl", "chunk_compress_factor")?,
            latent_dim: config_usize(&cfg, "ttl", "latent_dim")?,
        })
    }

    fn ids(&self, text: &str, lang: &str) -> Result<Vec<i64>, Error> {
        let p = preprocess(text, lang)?;
        // Upstream: np.uint16(ord(c)) then the indexer; unknown symbols are -1 there
        // (which would break the embedding), so they are dropped here.
        Ok(p.chars()
            .filter_map(|c| self.indexer.get(c as u32 as u16 as usize).copied())
            .filter(|&i| i >= 0)
            .collect())
    }

    /// One chunk of speech (upstream `_infer`, batch size 1). `cancelled` is checked
    /// before each stage and between denoising steps (50–100 ms each on a CPU).
    #[allow(clippy::too_many_arguments)]
    pub fn infer(
        &mut self,
        text: &str,
        lang: &str,
        style: &Style,
        steps: usize,
        speed: f32,
        seed: u64,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<f32>, Error> {
        let check = || {
            if cancelled() {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        };
        let ids = self.ids(text, lang)?;
        let n = ids.len();
        let text_ids =
            Array2::from_shape_vec((1, n), ids).map_err(|e| Error::Model(e.to_string()))?;
        let text_mask = Array3::<f32>::ones((1, 1, n));
        let tensor = |e: ort::Error| Error::Model(e.to_string());

        check()?;
        let out = self
            .duration
            .run(ort::inputs! {
                "text_ids" => TensorRef::from_array_view(&text_ids).map_err(tensor)?,
                "style_dp" => TensorRef::from_array_view(&style.dp).map_err(tensor)?,
                "text_mask" => TensorRef::from_array_view(&text_mask).map_err(tensor)?,
            })
            .map_err(model_err("duration predictor"))?;
        let duration = out["duration"]
            .try_extract_array::<f32>()
            .map_err(tensor)?
            .iter()
            .next()
            .copied()
            .ok_or_else(|| Error::Model("empty duration".into()))?
            / speed;
        drop(out);

        check()?;
        let out = self
            .encoder
            .run(ort::inputs! {
                "text_ids" => TensorRef::from_array_view(&text_ids).map_err(tensor)?,
                "style_ttl" => TensorRef::from_array_view(&style.ttl).map_err(tensor)?,
                "text_mask" => TensorRef::from_array_view(&text_mask).map_err(tensor)?,
            })
            .map_err(model_err("text encoder"))?;
        let text_emb = out["text_emb"]
            .try_extract_array::<f32>()
            .map_err(tensor)?
            .to_owned();
        drop(out);

        // Upstream computes these in float32: wav_len = int(dur * sr), latent_len =
        // ceil(dur * sr / chunk).
        let wav_len_f: f32 = duration * self.sample_rate as f32;
        let wav_len = wav_len_f.max(0.0) as usize;
        let chunk = self.base_chunk * self.compress;
        let latent_len = (((wav_len_f + (chunk - 1) as f32) / chunk as f32) as usize).max(1);
        let latent_valid = wav_len.div_ceil(chunk);
        let dim = self.latent_dim * self.compress;

        let mut rng = StdRng::seed_from_u64(seed);
        let mut latent_mask = Array3::<f32>::zeros((1, 1, latent_len));
        for t in 0..latent_valid.min(latent_len) {
            latent_mask[[0, 0, t]] = 1.0;
        }
        let noise: Vec<f32> = (0..dim * latent_len).map(|_| gaussian(&mut rng)).collect();
        let mut xt = Array3::from_shape_vec((1, dim, latent_len), noise)
            .map_err(|e| Error::Model(e.to_string()))?;
        for d in 0..dim {
            for t in 0..latent_len {
                xt[[0, d, t]] *= latent_mask[[0, 0, t]];
            }
        }
        let total = Array1::from_elem(1, steps as f32);
        for step in 0..steps {
            check()?;
            let current = Array1::from_elem(1, step as f32);
            let out = self
                .estimator
                .run(ort::inputs! {
                    "noisy_latent" => TensorRef::from_array_view(&xt).map_err(tensor)?,
                    "text_emb" => TensorRef::from_array_view(&text_emb).map_err(tensor)?,
                    "style_ttl" => TensorRef::from_array_view(&style.ttl).map_err(tensor)?,
                    "text_mask" => TensorRef::from_array_view(&text_mask).map_err(tensor)?,
                    "latent_mask" => TensorRef::from_array_view(&latent_mask).map_err(tensor)?,
                    "current_step" => TensorRef::from_array_view(&current).map_err(tensor)?,
                    "total_step" => TensorRef::from_array_view(&total).map_err(tensor)?,
                })
                .map_err(model_err("vector estimator"))?;
            xt = out["denoised_latent"]
                .try_extract_array::<f32>()
                .map_err(tensor)?
                .to_owned()
                .into_dimensionality()
                .map_err(|e| Error::Model(e.to_string()))?;
        }

        check()?;
        let out = self
            .vocoder
            .run(ort::inputs! { "latent" => TensorRef::from_array_view(&xt).map_err(tensor)? })
            .map_err(model_err("vocoder"))?;
        let wav = out["wav_tts"].try_extract_array::<f32>().map_err(tensor)?;
        let keep = ((self.sample_rate as f64 * duration as f64) as usize).min(wav.len());
        Ok(wav.iter().take(keep).copied().collect())
    }
}

/// Standard normal noise (Box–Muller), as upstream's `np.random.randn`.
fn gaussian(rng: &mut StdRng) -> f32 {
    let u1: f64 = rng.random::<f64>().max(f64::MIN_POSITIVE);
    let u2: f64 = rng.random();
    ((-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocessing_matches_upstream_rules() {
        assert_eq!(
            preprocess("Hello  “world” — ok", "en").unwrap(),
            "<en>Hello \"world\" - ok.</en>"
        );
        assert_eq!(preprocess("Klaar 🙂!", "nl").unwrap(), "<nl>Klaar!</nl>");
        assert_eq!(preprocess("a/b_c #1", "en").unwrap(), "<en>a b c 1.</en>");
        assert!(preprocess("x", "xx").is_err());
    }
}
