//! ACE-Step 1.5 turbo songs for Delulu FM, through acestep.cpp (vendored in
//! `vendor/acestep.cpp`, MIT, built against delulu-engine's one ggml).
//!
//! A song runs in two stages inside one process: the 5 Hz language model writes the
//! song's metadata and audio codes, is freed, and then the text encoder, the turbo
//! DiT and the VAE turn those codes into 48 kHz stereo. `delulu-engine music` runs
//! one song per process, like YuE2, so all graphics memory is gone when it exits.
//!
//! Weights: `Serveurperso/ACE-Step-1.5-GGUF` (MIT; the text encoder is Qwen3-
//! Embedding-0.6B, Apache-2.0), rows in `crates/models`.
mod ffi;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub use ffi::tensor_layout_matches;

pub const CANCELLED: &str = "cancelled";
pub const SAMPLE_RATE: u32 = 48_000;
/// The LM writes 5 audio codes per second of music.
pub const CODES_PER_SECOND: f32 = 5.0;
/// Folder of the ACE files inside the app's models folder.
pub const DIR: &str = "ace-step-1.5";
pub const TEXT_ENCODER: &str = "Qwen3-Embedding-0.6B-Q8_0.gguf";
pub const DIT: &str = "acestep-v15-turbo-Q8_0.gguf";
pub const VAE: &str = "vae-BF16.gguf";

pub const MIN_SECONDS: f32 = 10.0;
pub const MAX_SECONDS: f32 = 600.0;
/// Free graphics memory from which the 4B LM is chosen: it peaks at about 5.5 GiB
/// with the KV cache sized to the song, and the desktop needs room too.
pub const LARGE_LM_MIN_FREE: u64 = 8 << 30;
/// Below this much free memory the VAE decodes in 256-frame tiles (2.2 GiB peak)
/// instead of 512 (3.7 GiB). Never acestep.cpp's default 1024: it asks for ~9 GiB.
pub const SMALL_VAE_CHUNK_BELOW: u64 = 5 << 30;
/// Turbo DiT steps (acestep.cpp's default for turbo models).
const DIT_STEPS: usize = 8;
const VAE_OVERLAP: usize = 64;
/// Latent frames per second (48 kHz / 1920).
const LATENT_PER_SECOND: f32 = 25.0;
/// Room for the prompt template and metadata the LM writes, on top of the caption
/// and lyrics, which are counted at one token per byte (BPE never does worse).
const PROMPT_OVERHEAD_TOKENS: usize = 512;
const MAX_SEQ_LIMIT: usize = 8192;

/// The song request `delulu-engine music` reads for `"engine": "acestep"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    /// Comma-separated caption: genre, mood, instruments, voice. Sent as written.
    pub style: String,
    /// Section-tagged lyrics (`[Verse]`, `[Chorus]`, …).
    #[serde(default)]
    pub lyrics: String,
    pub seed: u64,
    /// The song's length: ACE delivers exactly this.
    pub seconds: f32,
    /// None lets the LM choose.
    #[serde(default)]
    pub bpm: Option<u32>,
    /// Vocal language (`en`, `nl`, …); pinning it keeps a Dutch song Dutch.
    #[serde(default)]
    pub language: Option<String>,
    /// No vocals: the lyrics become `[Instrumental]`.
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub lm: LmChoice,
}

/// Which language model writes the codes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LmChoice {
    /// 4B with enough free graphics memory, otherwise 0.6B.
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "0.6b")]
    Small,
    #[serde(rename = "4b")]
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Lm {
    /// 0.6B: 1.6 GiB, fastest; follows lyrics less reliably.
    #[serde(rename = "0.6b")]
    Small,
    /// 4B: follows the lyrics as well as YuE2 (spike E4).
    #[serde(rename = "4b")]
    Large,
}

impl Lm {
    pub fn file(self) -> &'static str {
        match self {
            Lm::Small => "acestep-5Hz-lm-0.6B-Q8_0.gguf",
            Lm::Large => "acestep-5Hz-lm-4B-Q8_0.gguf",
        }
    }
    fn other(self) -> Lm {
        match self {
            Lm::Small => Lm::Large,
            Lm::Large => Lm::Small,
        }
    }
}

/// Pick the LM. `free` is the graphics memory free before the song (None: no GPU),
/// `installed` says whether an LM's file is there. A manual choice is honoured or
/// fails; Auto falls back to the other size when its first pick is not installed.
pub fn choose_lm(
    choice: LmChoice,
    free: Option<u64>,
    installed: impl Fn(Lm) -> bool,
) -> Result<Lm, MissingLm> {
    let wanted = match choice {
        LmChoice::Small => {
            return installed(Lm::Small)
                .then_some(Lm::Small)
                .ok_or(MissingLm(Lm::Small))
        }
        LmChoice::Large => {
            return installed(Lm::Large)
                .then_some(Lm::Large)
                .ok_or(MissingLm(Lm::Large))
        }
        LmChoice::Auto if free.is_some_and(|f| f >= LARGE_LM_MIN_FREE) => Lm::Large,
        LmChoice::Auto => Lm::Small,
    };
    [wanted, wanted.other()]
        .into_iter()
        .find(|&lm| installed(lm))
        .ok_or(MissingLm(wanted))
}

/// No usable LM file; carries the one that was wanted.
#[derive(Debug, PartialEq, Eq)]
pub struct MissingLm(pub Lm);

/// The compute device a song will use, as ggml reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// ggml device name (`Vulkan0`), or None for the CPU.
    pub name: Option<String>,
    pub description: String,
    pub free: Option<u64>,
}

/// The GPU with the most free memory, like the YuE2 engine picks; the CPU when
/// there is none or `DELULU_MUSIC_CPU` is set.
pub fn best_device() -> Device {
    ffi::best_device()
}

/// Everything one run needs, resolved from a [`Song`].
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub caption: String,
    pub lyrics: String,
    /// Empty lets the LM decide.
    pub language: String,
    /// 0 lets the LM decide.
    pub bpm: u32,
    pub seconds: f32,
    pub seed: u32,
    pub lm: Lm,
    pub lm_path: PathBuf,
    pub text_encoder_path: PathBuf,
    pub dit_path: PathBuf,
    pub vae_path: PathBuf,
    pub device: Device,
    /// KV cache length: the prompt and every code must fit, or acestep.cpp
    /// silently computes nothing for the overflowing tokens.
    pub max_seq: usize,
    pub vae_chunk: usize,
}

impl Plan {
    /// Audio codes the LM must write before it may end the song.
    pub fn min_codes(&self) -> usize {
        (self.seconds * CODES_PER_SECOND) as usize
    }
    pub fn vae_tiles(&self) -> usize {
        let frames = (self.seconds * LATENT_PER_SECOND).ceil() as usize;
        if frames <= self.vae_chunk {
            return 1;
        }
        frames.div_ceil(self.vae_chunk - 2 * VAE_OVERLAP)
    }
}

/// Check the request and the installed files and fix every setting of the run.
/// `models` is the app's models folder; the ACE files live in [`DIR`] inside it.
pub fn plan(models: &Path, song: &Song, device: Device) -> Result<Plan, String> {
    if !(MIN_SECONDS..=MAX_SECONDS).contains(&song.seconds) {
        return Err(format!(
            "seconds must be {MIN_SECONDS}–{MAX_SECONDS}, not {}",
            song.seconds
        ));
    }
    if song.bpm.is_some_and(|b| !(30..=300).contains(&b)) {
        return Err(format!("bpm must be 30–300, not {}", song.bpm.unwrap_or(0)));
    }
    let caption = song.style.trim().to_string();
    if caption.is_empty() {
        return Err("the song has no style".into());
    }
    let instrumental = song.instrumental || song.lyrics.trim().is_empty();
    let (lyrics, language) = if instrumental {
        ("[Instrumental]".to_string(), "unknown".to_string())
    } else {
        let language = song.language.as_deref().unwrap_or("").trim().to_lowercase();
        (song.lyrics.trim().to_string(), language)
    };

    let dir = models.join(DIR);
    let mut missing: Vec<&str> = [TEXT_ENCODER, DIT, VAE]
        .into_iter()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    let lm = match choose_lm(song.lm, device.free, |lm| dir.join(lm.file()).is_file()) {
        Ok(lm) => Some(lm),
        Err(MissingLm(lm)) => {
            missing.push(lm.file());
            None
        }
    };
    if !missing.is_empty() {
        return Err(format!(
            "ACE-Step is not installed: {} missing in {}. Install ACE-Step on the Delulu FM page.",
            missing.join(", "),
            dir.display()
        ));
    }
    let lm = lm.expect("checked above");

    let min_codes = (song.seconds * CODES_PER_SECOND) as usize;
    // The LM may write up to 100 codes past the minimum (acestep.cpp's own limit).
    let need = caption.len() + lyrics.len() + PROMPT_OVERHEAD_TOKENS + min_codes + 100;
    if need > MAX_SEQ_LIMIT {
        return Err(format!(
            "lyrics too long for a {} s song: shorten them or the song",
            song.seconds
        ));
    }
    let max_seq = need.next_multiple_of(256).max(2048);
    let vae_chunk = match device.free {
        Some(free) if free >= SMALL_VAE_CHUNK_BELOW => 512,
        _ => 256,
    };

    Ok(Plan {
        caption,
        lyrics,
        language,
        bpm: song.bpm.unwrap_or(0),
        seconds: song.seconds,
        // acestep.cpp uses the low 32 bits of its seeds.
        seed: song.seed as u32,
        lm,
        lm_path: dir.join(lm.file()),
        text_encoder_path: dir.join(TEXT_ENCODER),
        dit_path: dir.join(DIT),
        vae_path: dir.join(VAE),
        device,
        max_seq,
        vae_chunk,
    })
}

/// What is happening, for progress display; the same phases the YuE2 engine
/// reports, so the radio's progress mapping covers both.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "phase"
)]
pub enum Progress {
    Loading { model: &'static str },
    Music { seconds: f32, max_seconds: f32 },
    Shaping { step: usize, steps: usize },
    Rendering { tile: usize, tiles: usize },
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub engine: &'static str,
    pub device: String,
    pub lm: Option<Lm>,
    pub seconds: f32,
    pub codes: usize,
    /// The song's metadata after the LM filled what the request left open.
    pub bpm: u32,
    pub keyscale: String,
    pub timesignature: String,
    pub lm_ms: u64,
    pub dit_ms: u64,
    pub vae_ms: u64,
    pub max_seq: usize,
    pub vae_chunk: usize,
    pub free_bytes_before: Option<u64>,
    /// Graphics memory this process used at its peak, from the device's free memory.
    pub peak_gpu_bytes: Option<u64>,
}

#[derive(Debug)]
pub struct Output {
    /// Interleaved stereo at [`SAMPLE_RATE`].
    pub samples: Vec<f32>,
    pub report: Report,
}

/// Which part of the song a tick comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// One LM token.
    Lm,
    /// One DiT step.
    Dit,
    /// One VAE tile.
    Vae,
}

/// What a pipeline run returns before the checks in [`finish`].
#[derive(Debug, Default)]
pub struct Raw {
    /// Planar stereo: all left samples, then all right.
    pub planar: Vec<f32>,
    pub sample_rate: u32,
    pub codes: usize,
    pub bpm: u32,
    pub keyscale: String,
    pub timesignature: String,
    pub lm_ms: u64,
    pub dit_ms: u64,
    pub vae_ms: u64,
}

#[derive(Debug, PartialEq)]
pub enum RunError {
    Cancelled,
    Failed(String),
}

/// Runs a plan; `tick` is called between LM tokens, DiT steps and VAE tiles and
/// returns true to stop. The real one is acestep.cpp; tests use a fake.
pub trait Pipeline {
    fn run(&self, plan: &Plan, tick: &mut dyn FnMut(Stage) -> bool) -> Result<Raw, RunError>;
}

/// acestep.cpp through the C shim.
pub struct AceStep;

impl Pipeline for AceStep {
    fn run(&self, plan: &Plan, tick: &mut dyn FnMut(Stage) -> bool) -> Result<Raw, RunError> {
        ffi::run(plan, tick)
    }
}

/// Make the planned song. `cancel` is checked between LM tokens, DiT steps and
/// VAE tiles.
pub fn generate(
    plan: &Plan,
    progress: &mut dyn FnMut(Progress),
    cancel: &dyn Fn() -> bool,
) -> Result<Output, String> {
    generate_with(&AceStep, plan, progress, cancel, &mut || {
        ffi::free_memory(&plan.device)
    })
}

/// [`generate`] with any pipeline; `free_memory` samples the device for the peak.
pub fn generate_with(
    pipeline: &dyn Pipeline,
    plan: &Plan,
    progress: &mut dyn FnMut(Progress),
    cancel: &dyn Fn() -> bool,
    free_memory: &mut dyn FnMut() -> Option<u64>,
) -> Result<Output, String> {
    let baseline = plan.device.free;
    let mut lowest = baseline;
    let mut stage = None;
    let mut counts = [0usize; 3];
    let tiles = plan.vae_tiles();

    progress(Progress::Loading {
        model: "language model",
    });
    let result = pipeline.run(plan, &mut |s| {
        if cancel() {
            return true;
        }
        if stage != Some(s) {
            stage = Some(s);
            if s == Stage::Dit {
                progress(Progress::Loading { model: "synthesis" });
            }
        }
        let n = &mut counts[s as usize];
        *n += 1;
        match s {
            // Every 5 s of music; the count includes the LM's few metadata tokens.
            Stage::Lm if *n % 25 == 0 => progress(Progress::Music {
                seconds: (*n as f32 / CODES_PER_SECOND).min(plan.seconds),
                max_seconds: plan.seconds,
            }),
            Stage::Lm => {}
            Stage::Dit => progress(Progress::Shaping {
                step: (*n).min(DIT_STEPS),
                steps: DIT_STEPS,
            }),
            Stage::Vae => progress(Progress::Rendering {
                tile: (*n).min(tiles),
                tiles,
            }),
        }
        // Each stage keeps its buffers until it ends, so its peak is there at a tick.
        if let Some(free) = free_memory() {
            lowest = Some(lowest.map_or(free, |l| l.min(free)));
        }
        false
    });
    let raw = match result {
        Ok(raw) => raw,
        Err(RunError::Cancelled) => return Err(CANCELLED.into()),
        Err(RunError::Failed(e)) => return Err(e),
    };
    if let Some(free) = free_memory() {
        lowest = Some(lowest.map_or(free, |l| l.min(free)));
    }
    let peak = baseline.zip(lowest).map(|(b, l)| b.saturating_sub(l));
    finish(plan, raw, peak)
}

/// The checks every song passes before it counts: right format, every code the
/// length needs, and audio of the requested length.
pub fn finish(plan: &Plan, raw: Raw, peak_gpu_bytes: Option<u64>) -> Result<Output, String> {
    if raw.sample_rate != SAMPLE_RATE {
        return Err(format!(
            "ACE-Step returned {} Hz audio, expected {SAMPLE_RATE}",
            raw.sample_rate
        ));
    }
    if raw.codes < plan.min_codes() {
        return Err(format!(
            "ACE-Step's language model stopped early: {} of {} codes",
            raw.codes,
            plan.min_codes()
        ));
    }
    let frames = raw.planar.len() / 2;
    let seconds = frames as f32 / SAMPLE_RATE as f32;
    if !raw.planar.len().is_multiple_of(2) || seconds < 0.9 * plan.seconds {
        return Err(format!(
            "ACE-Step made {seconds:.1} s of audio for a {} s song",
            plan.seconds
        ));
    }
    let (left, right) = raw.planar.split_at(frames);
    let samples = left.iter().zip(right).flat_map(|(&l, &r)| [l, r]).collect();
    Ok(Output {
        samples,
        report: Report {
            engine: "acestep",
            device: plan.device.description.clone(),
            lm: Some(plan.lm),
            seconds,
            codes: raw.codes,
            bpm: raw.bpm,
            keyscale: raw.keyscale,
            timesignature: raw.timesignature,
            lm_ms: raw.lm_ms,
            dit_ms: raw.dit_ms,
            vae_ms: raw.vae_ms,
            max_seq: plan.max_seq,
            vae_chunk: plan.vae_chunk,
            free_bytes_before: plan.device.free,
            peak_gpu_bytes,
        },
    })
}

#[cfg(test)]
mod tests;
