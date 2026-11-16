//! Run the station headless with the real writer, music engine and voice, to measure it.
//! `cargo run --release -p delulu-radio --example station -- <data-dir> <items> [host]`
//! Needs the Gemma and YuE2 models in the app's models folder and `delulu-engine`
//! (set `DELULU_ENGINE` in a checkout). `DELULU_MUSIC_ENGINE=acestep` makes the
//! music with ACE-Step instead (its files in the same models folder).
use delulu_cleanup::{Cleaner, Sampling};
use delulu_radio::model::{AceLm, Draft, Host, Music, MusicEngine};
use delulu_radio::music::{self, Composer, Order};
use delulu_radio::voice::Voice;
use delulu_radio::Mix;
use delulu_radio::{Backend, Next, RadioError, Station};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Real {
    cleaner: Mutex<Cleaner>,
    composer: Composer,
    voice: Voice,
}

impl Backend for Real {
    fn write(&self, prompt: String, max_tokens: u32, seed: u32) -> Result<String, RadioError> {
        let started = Instant::now();
        let sampling = Sampling {
            seed,
            temperature: 0.9,
            top_p: 0.95,
        };
        let out = self
            .cleaner
            .lock()
            .unwrap()
            .generate(prompt, max_tokens, Some(sampling), Duration::from_secs(120))
            .map_err(|e| RadioError::Writer(e.to_string()))?;
        eprintln!(
            "[write] {} ms, truncated {}",
            started.elapsed().as_millis(),
            out.truncated
        );
        Ok(out.text)
    }
    fn may_start(&self) -> bool {
        true
    }
    fn voice_ready(&self) -> bool {
        self.voice.ready()
    }
    fn speak(&self, text: &str, lang: &str, out: &Path) -> Result<String, RadioError> {
        let started = Instant::now();
        let r = self.voice.speak(text, lang, None, out, &|| false);
        eprintln!("[speak] {} ms", started.elapsed().as_millis());
        r.map(|()| "Supertonic 3 (AI voice)".into())
    }
    fn compose(
        &self,
        draft: &Draft,
        seed: u64,
        seconds: u32,
        settings: &Music,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError> {
        let helper = music::helper_path().expect("delulu-engine");
        let order = Order::new(draft, seed, seconds, settings, &models());
        let report = self
            .composer
            .compose(&helper, &order, out, &|| false, &mut |s| {
                eprintln!("[music] {} {:.0}%", s.phase, s.fraction * 100.0)
            })?;
        eprintln!("[music] {report}");
        Ok(music::provenance(&report))
    }
    fn changed(&self) {}
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("data dir"));
    let items: usize = args.next().map_or(1, |s| s.parse().unwrap());
    let host = args.next().is_some();
    let helper = delulu_cleanup::helper_path().expect("delulu-engine");
    let model = dirs_model();
    let started = Instant::now();
    let cleaner =
        Cleaner::start(&helper, &model, Duration::from_secs(180), |_| {}).expect("helper");
    eprintln!(
        "[helper] {} in {} ms",
        cleaner.backend(),
        started.elapsed().as_millis()
    );
    let backend = Real {
        cleaner: Mutex::new(cleaner),
        composer: Composer::default(),
        voice: Voice::new(),
    };
    let station = Station::open(&root).expect("open");
    if std::env::var("DELULU_MUSIC_ENGINE").as_deref() == Ok("acestep") {
        station.set_music(MusicEngine::AceStep, AceLm::Auto);
    }
    if host {
        station.set_mix(Mix {
            host: Host::Often,
            ..station.snapshot().mix
        });
    }
    station.set_on_air(true);
    let target = station.snapshot().queue.len() + items;
    let started = Instant::now();
    while station.snapshot().queue.len() < target {
        let step = Instant::now();
        match station.work(&backend) {
            Next::Idle => break,
            Next::Wait(d) => std::thread::sleep(d.min(Duration::from_secs(3))),
            Next::Continue => {}
        }
        let s = station.snapshot();
        if let Some(e) = &s.last_error {
            eprintln!("[error] {e}");
        }
        let _ = step;
    }
    station.set_on_air(false);
    let s = station.snapshot();
    for item in &s.queue {
        println!(
            "{:?} {:?} {:.1}s audio, made in {}s, writer {}s\n{}",
            item.kind,
            item.title,
            item.seconds,
            item.provenance
                .get("madeSeconds")
                .cloned()
                .unwrap_or_default(),
            item.provenance
                .get("writerSeconds")
                .cloned()
                .unwrap_or_default(),
            item.lyrics
                .as_deref()
                .or(item.script.as_deref())
                .unwrap_or("")
        );
    }
    println!(
        "total {} s, failures {}",
        started.elapsed().as_secs(),
        s.stats.failures
    );
}

fn models() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
    home.join(".local/share/delulu-talks/models")
}

fn dirs_model() -> PathBuf {
    models().join(delulu_cleanup::MODEL_FILE)
}
