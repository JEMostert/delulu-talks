//! Native YuE2 music generation for Delulu FM, on ggml (Vulkan when available).
//!
//! The pipeline follows ComfyUI's YuE2 text-to-music graph: the language model writes
//! a chord-annotated ABC score from the style and lyrics, then music codec tokens at
//! 25 per second; its keys and values over those tokens condition the acoustic
//! transformer, which turns noise into VAE latents with 32 DPM-2 flow steps; the VAE
//! decodes them to 48 kHz stereo. Each model is loaded only for its phase, so the
//! peak GPU memory is one model plus its cache.
//!
//! YuE2 (m-a-p/YuE2-3B, VAE YuE2-Vae) is CC-BY-NC-4.0; the checkpoint is ComfyUI's
//! INT8 ConvRot packaging (Comfy-Org/YuE2). Its weights are used without requantizing.
pub mod checkpoint;
pub mod ggml;
pub mod qwen;
pub mod sample;
pub mod vae;

use checkpoint::Checkpoint;
use qwen::{Cache, Dit, Lm, LATENT};
use sample::{pick, Rng, Sampling};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

pub const CANCELLED: &str = "cancelled";
pub use vae::SAMPLE_RATE;

/// The checkpoint this engine reads: Comfy-Org/YuE2 at a fixed revision.
pub const MODEL_FILE: &str = "yue2_3b_int8_convrot.safetensors";
pub const MODEL_URL: &str = "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_int8_convrot.safetensors";
pub const MODEL_SHA256: &str = "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6";
pub const MODEL_BYTES: u64 = 3_960_938_800;

const EOD: u32 = 151643;
const ABC_START: u32 = 151847;
const ABC_END: u32 = 151848;
const MUSIC_START: u32 = 151851;
const MUSIC_END: u32 = 151852;
const CODEC_OFFSET: usize = 151853;
const CODEC_SIZE: usize = 32768;
const CONTEXT: usize = qwen::POSITIONS as usize;
pub const FRAMES_PER_SECOND: f32 = 25.0;
const INSTRUCTION: &str = "Generate a chord-annotated ABC transcription, then generate music with codec tokens from the given conditions.";
const MAX_ABC_TOKENS: usize = 8192;
const STEPS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub style: String,
    pub lyrics: String,
    pub seed: u64,
    pub max_seconds: f32,
}

/// What is happening, for progress display. Fractions are 0..1 within the phase.
#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "phase"
)]
pub enum Progress {
    Loading { model: &'static str },
    Score { tokens: usize },
    Music { seconds: f32, max_seconds: f32 },
    Shaping { step: usize, steps: usize },
    Rendering { tile: usize, tiles: usize },
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub device: String,
    pub abc: String,
    pub abc_tokens: usize,
    pub music_tokens: usize,
    pub seconds: f32,
    /// The music phase hit its length limit before the end token.
    pub truncated: bool,
    pub load_ms: u64,
    pub score_ms: u64,
    pub music_ms: u64,
    pub shaping_ms: u64,
    pub render_ms: u64,
    /// GPU memory in use by this process at its peak, as the driver reports free memory.
    pub peak_gpu_bytes: Option<u64>,
}

pub struct Output {
    /// Interleaved stereo at `SAMPLE_RATE`.
    pub samples: Vec<f32>,
    pub report: Report,
}

struct Tracker<'a> {
    device: &'a ggml::Device,
    baseline: Option<usize>,
    peak: usize,
}

impl Tracker<'_> {
    fn sample(&mut self) {
        if let (Some(base), Some((free, _))) = (self.baseline, self.device.memory()) {
            self.peak = self.peak.max(base.saturating_sub(free));
        }
    }
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn check(cancel: &dyn Fn() -> bool) -> Result<(), String> {
    if cancel() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

/// Generate one song. `cancel` is polled between tokens, steps and tiles.
pub fn generate(
    model: &Path,
    song: &Song,
    progress: &mut dyn FnMut(Progress),
    cancel: &dyn Fn() -> bool,
) -> Result<Output, String> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let device = ggml::Device::new(threads)?;
    let mut report = Report {
        device: device.name.clone(),
        ..Report::default()
    };
    let mut tracker = Tracker {
        baseline: device.memory().map(|m| m.0),
        peak: 0,
        device: &device,
    };
    let ck = Checkpoint::open(model)?;
    if ck.metadata.get("quantization").map(String::as_str) != Some("convrot_int8")
        || ck.metadata.get("yue2_format").map(String::as_str) != Some("1")
    {
        return Err("this is not the YuE2 INT8 ConvRot checkpoint".into());
    }
    let tokenizer =
        tokenizers::Tokenizer::from_bytes(ck.bytes("text_encoders.yue2_tokenizer_json")?)
            .map_err(|e| format!("tokenizer: {e}"))?;
    let encode = |text: &str| -> Result<Vec<u32>, String> {
        Ok(tokenizer
            .encode(text, true)
            .map_err(|e| format!("tokenizer: {e}"))?
            .get_ids()
            .to_vec())
    };
    let prompt = format!(
        "{INSTRUCTION}\n[Tags]\n{}\n[Lyrics]\n{}\n",
        song.style, song.lyrics
    );
    let mut prefix = vec![EOD];
    prefix.extend(encode(&prompt)?);
    prefix.push(ABC_START);

    progress(Progress::Loading { model: "language" });
    let started = Instant::now();
    let lm = Lm::load(&ck, &device, cancel)?;
    report.load_ms += ms(started);
    let mut rng = Rng::new(song.seed);

    // 1. The score: a chord-annotated ABC transcription.
    let started = Instant::now();
    let abc_ids = {
        let cache = Cache::new(&device, (prefix.len() + MAX_ABC_TOKENS) as i64)?;
        let sampling = Sampling {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 30,
            repetition_penalty: 1.005,
            penalty_window: 100,
            min_tokens: 32,
        };
        let mut logits = lm.step(&device, &cache, &prefix, 0)?;
        tracker.sample();
        let mut history = Vec::new();
        while history.len() < MAX_ABC_TOKENS {
            check(cancel)?;
            let token = pick(
                &logits,
                0..EOD as usize,
                ABC_END as usize,
                &history,
                &sampling,
                &mut rng,
            );
            if token == ABC_END {
                break;
            }
            history.push(token);
            if history.len() % 64 == 0 {
                progress(Progress::Score {
                    tokens: history.len(),
                });
            }
            logits = lm.step(
                &device,
                &cache,
                &[token],
                (prefix.len() + history.len() - 1) as i64,
            )?;
        }
        tracker.sample();
        history
    };
    report.abc = tokenizer
        .decode(&abc_ids, true)
        .map_err(|e| format!("tokenizer: {e}"))?;
    report.abc_tokens = abc_ids.len();
    report.score_ms = ms(started);

    // 2. Music tokens, conditioned on the (re-tokenized) score as ComfyUI does.
    let started = Instant::now();
    prefix.extend(encode(&report.abc)?);
    prefix.extend([ABC_END, MUSIC_START]);
    let wanted = (song.max_seconds * FRAMES_PER_SECOND).round().max(1.0) as usize;
    let budget = wanted
        .min(CONTEXT.saturating_sub(prefix.len()))
        .min(Dit::max_frames(prefix.len() as i64).max(0) as usize);
    if budget < 1 {
        return Err("the style and lyrics leave no room for music; shorten them".into());
    }
    let music = {
        let cache = Cache::new(&device, (prefix.len() + budget) as i64)?;
        let sampling = Sampling {
            temperature: 1.0,
            top_p: 0.95,
            top_k: 100,
            repetition_penalty: 1.2,
            penalty_window: 50,
            min_tokens: 200.min(budget),
        };
        let mut logits = lm.step(&device, &cache, &prefix, 0)?;
        let mut history = Vec::new();
        let mut ended = false;
        while history.len() < budget {
            check(cancel)?;
            let token = pick(
                &logits,
                CODEC_OFFSET..CODEC_OFFSET + CODEC_SIZE,
                MUSIC_END as usize,
                &history,
                &sampling,
                &mut rng,
            );
            if token == MUSIC_END {
                ended = true;
                break;
            }
            history.push(token);
            if history.len() % 25 == 0 {
                progress(Progress::Music {
                    seconds: history.len() as f32 / FRAMES_PER_SECOND,
                    max_seconds: budget as f32 / FRAMES_PER_SECOND,
                });
            }
            if history.len() < budget {
                logits = lm.step(
                    &device,
                    &cache,
                    &[token],
                    (prefix.len() + history.len() - 1) as i64,
                )?;
            }
        }
        tracker.sample();
        report.truncated = !ended;
        history
    };
    report.music_tokens = music.len();
    report.seconds = music.len() as f32 / FRAMES_PER_SECOND;
    report.music_ms = ms(started);

    // 3. Conditioning: the language model's keys and values over score and music.
    let started = Instant::now();
    let frames = music.len();
    let mut ids = prefix.clone();
    ids.extend(&music);
    ids.push(MUSIC_END);
    let cond = Cache::new(&device, (ids.len() + frames + 2) as i64)?;
    lm.prefill(&device, &cond, &ids)?;
    tracker.sample();
    drop(lm);
    progress(Progress::Loading { model: "acoustic" });
    let dit = Dit::load(&ck, &device, cancel)?;
    report.load_ms += ms(started);

    // 4. Shaping: DPM-2 over the flow from noise (sigma 1) to latents (sigma 0).
    let started = Instant::now();
    let noise: Vec<f32> = (0..frames * LATENT as usize)
        .map(|_| rng.normal())
        .collect();
    let x = shape(
        &dit,
        &device,
        &cond,
        ids.len() as i64,
        noise,
        cancel,
        &mut |step| {
            tracker.sample();
            progress(Progress::Shaping { step, steps: STEPS })
        },
    )?;
    drop(dit);
    drop(cond);
    report.shaping_ms = ms(started);

    // 5. Rendering: VAE decode to 48 kHz stereo.
    let started = Instant::now();
    progress(Progress::Loading { model: "vae" });
    let vae = vae::Vae::load(&ck, &device)?;
    let samples = vae.decode(&device, &x, cancel, &mut |done, total| {
        progress(Progress::Rendering {
            tile: done,
            tiles: total,
        })
    })?;
    tracker.sample();
    report.render_ms = ms(started);
    report.peak_gpu_bytes = tracker.baseline.map(|_| tracker.peak as u64);
    Ok(Output { samples, report })
}

/// ComfyUI's KSampler with `dpm_2` / `sgm_uniform` and CFG 1 (the YuE2 template):
/// from `noise` at sigma 1 to clean latents.
pub fn shape(
    dit: &Dit,
    device: &ggml::Device,
    cond: &Cache,
    prefix: i64,
    mut x: Vec<f32>,
    cancel: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(usize),
) -> Result<Vec<f32>, String> {
    let sigmas = schedule(STEPS);
    for i in 0..STEPS {
        check(cancel)?;
        progress(i);
        let (s, next) = (sigmas[i], sigmas[i + 1]);
        // The model predicts the flow velocity, which is DPM-2's derivative.
        let d = dit.velocity(device, cond, prefix, &x, s as f32)?;
        if next == 0.0 {
            axpy(&mut x, &d, (next - s) as f32);
        } else {
            let mid = ((s.ln() + next.ln()) / 2.0).exp();
            let mut x2 = x.clone();
            axpy(&mut x2, &d, (mid - s) as f32);
            let d2 = dit.velocity(device, cond, prefix, &x2, mid as f32)?;
            axpy(&mut x, &d2, (next - s) as f32);
        }
    }
    Ok(x)
}

/// ComfyUI's `sgm_uniform` sigmas for a flow model with shift 1: 32 evenly spaced
/// times from 1 down to 0.001, then 0.
pub fn schedule(steps: usize) -> Vec<f64> {
    let (start, end) = (1.0f64, 0.001f64);
    let mut sigmas: Vec<f64> = (0..steps)
        .map(|i| start + (end - start) * i as f64 / steps as f64)
        .collect();
    sigmas.push(0.0);
    sigmas
}

fn axpy(x: &mut [f32], d: &[f32], dt: f32) {
    for (a, b) in x.iter_mut().zip(d) {
        *a += b * dt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_fields_are_camel_case() {
        let p = Progress::Music {
            seconds: 1.0,
            max_seconds: 2.0,
        };
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(v["phase"], "music");
        assert_eq!(v["maxSeconds"], 2.0);
    }

    #[test]
    fn schedule_matches_sgm_uniform() {
        let s = schedule(32);
        assert_eq!(s.len(), 33);
        assert_eq!(s[0], 1.0);
        assert!((s[31] - (1.0 - 0.999 * 31.0 / 32.0)).abs() < 1e-12);
        assert_eq!(s[32], 0.0);
    }
}
