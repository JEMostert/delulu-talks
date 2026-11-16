use super::*;
use std::cell::{Cell, RefCell};

const GIB: u64 = 1 << 30;

fn song(json: serde_json::Value) -> Song {
    serde_json::from_value(json).unwrap()
}

fn gpu(free: u64) -> Device {
    Device {
        name: Some("Vulkan0".into()),
        description: "Test GPU".into(),
        free: Some(free),
    }
}

/// A models folder holding the given ACE files (empty files are enough to plan).
fn models(files: &[&str]) -> std::path::PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "delulu-ace-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(dir.join(DIR)).unwrap();
    for f in files {
        std::fs::write(dir.join(DIR).join(f), b"").unwrap();
    }
    dir
}

fn all_files() -> std::path::PathBuf {
    models(&[TEXT_ENCODER, DIT, VAE, Lm::Small.file(), Lm::Large.file()])
}

#[test]
fn a_minimal_request_gets_the_defaults() {
    let s = song(serde_json::json!({
        "engine": "acestep", "style": "folk, guitar", "seed": 7, "seconds": 150
    }));
    assert_eq!(s.lyrics, "");
    assert_eq!((s.bpm, s.language, s.instrumental), (None, None, false));
    assert_eq!(s.lm, LmChoice::Auto);

    for (name, lm) in [
        ("auto", LmChoice::Auto),
        ("0.6b", LmChoice::Small),
        ("4b", LmChoice::Large),
    ] {
        let s = song(serde_json::json!({"style": "x", "seed": 1, "seconds": 60, "lm": name}));
        assert_eq!(s.lm, lm);
    }
    // The 1.7B LM stops early in this port; it is not offered.
    assert!(serde_json::from_value::<Song>(
        serde_json::json!({"style": "x", "seed": 1, "seconds": 60, "lm": "1.7b"})
    )
    .is_err());
}

#[test]
fn the_lm_follows_free_memory_unless_chosen_or_missing() {
    use Lm::{Large, Small};
    const BOTH: &[Lm] = &[Small, Large];
    let cases = [
        (LmChoice::Auto, Some(12 * GIB), BOTH, Ok(Large)),
        (LmChoice::Auto, Some(8 * GIB), BOTH, Ok(Large)),
        (LmChoice::Auto, Some(8 * GIB - 1), BOTH, Ok(Small)),
        (LmChoice::Auto, None, BOTH, Ok(Small)),
        // Auto takes the installed one rather than failing.
        (LmChoice::Auto, Some(12 * GIB), &[Small], Ok(Small)),
        (LmChoice::Auto, Some(2 * GIB), &[Large], Ok(Large)),
        // A manual choice wins over memory, and is never swapped.
        (LmChoice::Large, Some(2 * GIB), BOTH, Ok(Large)),
        (
            LmChoice::Small,
            Some(12 * GIB),
            &[Large],
            Err(MissingLm(Small)),
        ),
        (LmChoice::Auto, Some(12 * GIB), &[], Err(MissingLm(Large))),
    ];
    for (choice, free, installed, want) in cases {
        let got = choose_lm(choice, free, |lm| installed.contains(&lm));
        assert_eq!(got, want, "{choice:?} {free:?} {installed:?}");
    }
}

#[test]
fn missing_files_give_installation_guidance() {
    let dir = models(&[TEXT_ENCODER, Lm::Small.file()]);
    let s = song(serde_json::json!({"style": "x", "seed": 1, "seconds": 60, "lm": "4b"}));
    let e = plan(&dir, &s, gpu(12 * GIB)).unwrap_err();
    for file in [DIT, VAE, Lm::Large.file()] {
        assert!(e.contains(file), "{e}");
    }
    assert!(!e.contains(TEXT_ENCODER), "{e}");
    assert!(e.contains("Install ACE-Step"), "{e}");
}

#[test]
fn a_plan_pins_language_sizes_the_cache_and_keeps_vae_tiles_small() {
    let dir = all_files();
    let lyrics = "[Verse]\nDe trein rijdt door de nacht\n".repeat(20);
    let s = song(serde_json::json!({
        "style": "Dutch folk, accordion", "lyrics": lyrics, "seed": 4_294_967_298u64,
        "seconds": 240, "bpm": 96, "language": "NL"
    }));
    let p = plan(&dir, &s, gpu(12 * GIB)).unwrap();
    assert_eq!(
        (p.language.as_str(), p.bpm, p.seed, p.lm),
        ("nl", 96, 2, Lm::Large)
    );
    assert_eq!(p.min_codes(), 1200);
    // Prompt (one token per byte at worst) and every code fit, as the spike's 4096 did.
    let need = p.caption.len() + p.lyrics.len() + 1200 + 100;
    assert!(p.max_seq >= need && p.max_seq <= 4096, "{}", p.max_seq);
    assert_eq!(p.vae_chunk, 512);
    assert_eq!(plan(&dir, &s, gpu(3 * GIB)).unwrap().vae_chunk, 256);

    let instrumental = song(serde_json::json!({
        "style": "ambient", "lyrics": "[Verse]\nla la", "seed": 1, "seconds": 120,
        "language": "en", "instrumental": true
    }));
    let p = plan(&dir, &instrumental, gpu(12 * GIB)).unwrap();
    assert_eq!(
        (p.lyrics.as_str(), p.language.as_str()),
        ("[Instrumental]", "unknown")
    );

    let too_long = song(serde_json::json!({
        "style": "x", "lyrics": "la ".repeat(3000), "seed": 1, "seconds": 600
    }));
    assert!(plan(&dir, &too_long, gpu(12 * GIB))
        .unwrap_err()
        .contains("too long"));
    let too_short = song(serde_json::json!({"style": "x", "seed": 1, "seconds": 5}));
    assert!(plan(&dir, &too_short, gpu(12 * GIB)).is_err());
}

fn test_plan(seconds: f32) -> Plan {
    let dir = all_files();
    let s = song(
        serde_json::json!({"style": "x", "lyrics": "[Verse]\nla", "seed": 1, "seconds": seconds}),
    );
    plan(&dir, &s, gpu(12 * GIB)).unwrap()
}

fn raw(seconds: f32, codes: usize) -> Raw {
    let frames = (seconds * SAMPLE_RATE as f32) as usize;
    let mut planar = vec![0.25; frames];
    planar.extend(vec![-0.5; frames]);
    Raw {
        planar,
        sample_rate: SAMPLE_RATE,
        codes,
        ..Raw::default()
    }
}

#[test]
fn only_a_full_length_song_counts() {
    let p = test_plan(60.0);
    let out = finish(&p, raw(60.0, 300), None).unwrap();
    assert_eq!(out.samples.len(), 60 * SAMPLE_RATE as usize * 2);
    assert_eq!(&out.samples[..4], &[0.25, -0.5, 0.25, -0.5]);
    assert_eq!(out.report.lm, Some(p.lm));

    let short = finish(&p, raw(40.0, 300), None).unwrap_err();
    assert!(short.contains("40.0 s of audio"), "{short}");
    let empty = finish(&p, raw(0.0, 300), None).unwrap_err();
    assert!(empty.contains("0.0 s of audio"), "{empty}");
    let early = finish(&p, raw(60.0, 120), None).unwrap_err();
    assert!(early.contains("stopped early"), "{early}");
}

/// Ticks through a song like acestep.cpp: LM tokens, DiT steps, VAE tiles, and
/// stops as soon as a tick asks to.
struct Fake {
    lm_tokens: usize,
    result: RefCell<Option<Result<Raw, RunError>>>,
    ticks: Cell<usize>,
}

impl Pipeline for Fake {
    fn run(&self, plan: &Plan, tick: &mut dyn FnMut(Stage) -> bool) -> Result<Raw, RunError> {
        let stages = std::iter::repeat_n(Stage::Lm, self.lm_tokens)
            .chain(std::iter::repeat_n(Stage::Dit, DIT_STEPS))
            .chain(std::iter::repeat_n(Stage::Vae, plan.vae_tiles()));
        for stage in stages {
            self.ticks.set(self.ticks.get() + 1);
            if tick(stage) {
                return Err(RunError::Cancelled);
            }
        }
        self.result.take().unwrap()
    }
}

fn fake(lm_tokens: usize, result: Result<Raw, RunError>) -> Fake {
    Fake {
        lm_tokens,
        result: RefCell::new(Some(result)),
        ticks: Cell::new(0),
    }
}

#[test]
fn progress_covers_every_stage_and_peak_memory_is_measured() {
    let p = test_plan(60.0);
    let pipeline = fake(310, Ok(raw(60.0, 300)));
    let mut seen = Vec::new();
    let free = Cell::new(12 * GIB);
    let out = generate_with(&pipeline, &p, &mut |e| seen.push(e), &|| false, &mut || {
        free.set(free.get() - 100);
        Some(free.get())
    })
    .unwrap();
    let phases: Vec<_> = seen
        .iter()
        .map(|e| {
            serde_json::to_value(e).unwrap()["phase"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    for phase in ["loading", "music", "shaping", "rendering"] {
        assert!(phases.contains(&phase.to_string()), "{phases:?}");
    }
    assert!(seen.contains(&Progress::Music {
        seconds: 60.0,
        max_seconds: 60.0
    }));
    assert!(seen.contains(&Progress::Shaping { step: 8, steps: 8 }));
    assert!(out.report.peak_gpu_bytes.is_some_and(|b| b > 0));
}

#[test]
fn cancel_stops_at_the_next_tick() {
    let p = test_plan(60.0);
    let pipeline = fake(300, Ok(raw(60.0, 300)));
    let calls = Cell::new(0);
    let cancel = || {
        calls.set(calls.get() + 1);
        calls.get() > 5
    };
    let e = generate_with(&pipeline, &p, &mut |_| {}, &cancel, &mut || None).err();
    assert_eq!(e.as_deref(), Some(CANCELLED));
    assert_eq!(pipeline.ticks.get(), 6);
}

#[test]
fn a_failed_run_reports_why() {
    let p = test_plan(60.0);
    let pipeline = fake(
        10,
        Err(RunError::Failed(
            "ACE-Step decoding produced no audio".into(),
        )),
    );
    let e = generate_with(&pipeline, &p, &mut |_| {}, &|| false, &mut || None).err();
    assert_eq!(e.as_deref(), Some("ACE-Step decoding produced no audio"));
}

/// Fails when llama-cpp-sys-2's ggml was built without the GGML_MAX_NAME that
/// acestep.cpp uses (a stale build cache): every song would corrupt memory.
#[test]
fn acestep_and_the_linked_ggml_agree_on_tensor_layout() {
    assert!(tensor_layout_matches());
}

#[test]
fn the_files_loaded_are_the_ones_the_registry_downloads() {
    let registry = |m: &delulu_models::Model| -> Vec<String> {
        m.files.iter().map(|f| f.file.to_string()).collect()
    };
    let turbo = registry(&delulu_models::ACE_STEP_TURBO);
    for f in [TEXT_ENCODER, DIT, VAE] {
        assert!(turbo.contains(&format!("{DIR}/{f}")), "{f}");
    }
    assert_eq!(
        registry(&delulu_models::ACE_STEP_LM_SMALL),
        [format!("{DIR}/{}", Lm::Small.file())]
    );
    assert_eq!(
        registry(&delulu_models::ACE_STEP_LM_LARGE),
        [format!("{DIR}/{}", Lm::Large.file())]
    );
}
