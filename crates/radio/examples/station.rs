//! Run the station headless with the real writer, ComfyUI and voice, to measure it.
//! `cargo run --release -p delulu-radio --example station -- <data-dir> <items> [host]`
//! Needs ComfyUI running with YuE2, the Gemma model and `delulu-cleanup`.
use delulu_cleanup::{Cleaner, Sampling};
use delulu_radio::comfy::{Comfy, JobState, SubmitError};
use delulu_radio::model::{Direction, Draft, Host};
use delulu_radio::voice::Voice;
use delulu_radio::{Backend, Next, RadioError, Station};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Real {
    cleaner: Mutex<Cleaner>,
    comfy: Comfy,
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
    fn speak(&self, text: &str, out: &Path) -> Result<(), RadioError> {
        let started = Instant::now();
        let r = self.voice.speak(text, out, &|| false);
        eprintln!("[speak] {} ms", started.elapsed().as_millis());
        r
    }
    fn write_workflow(
        &self,
        p: &Path,
        d: &Draft,
        seed: u64,
        s: u32,
        prefix: &str,
    ) -> Result<(), RadioError> {
        self.comfy.write_workflow(p, d, seed, s, prefix)
    }
    fn submit(&self, w: &Path) -> Result<String, SubmitError> {
        self.comfy.submit(w)
    }
    fn find_submitted(&self, w: &Path) -> Result<Option<String>, RadioError> {
        self.comfy.find_submitted(w)
    }
    fn status(&self, id: &str) -> Result<JobState, RadioError> {
        self.comfy.status(id)
    }
    fn cancel(&self, id: &str) {
        self.comfy.cancel(id)
    }
    fn download(&self, id: &str, dir: &Path) -> Result<Vec<PathBuf>, RadioError> {
        self.comfy.download(id, dir)
    }
    fn changed(&self) {}
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("data dir"));
    let items: usize = args.next().map_or(1, |s| s.parse().unwrap());
    let host = args.next().is_some();
    let helper = delulu_cleanup::helper_path().expect("delulu-cleanup helper");
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
        comfy: Comfy::from_env(),
        voice: Voice::new(),
    };
    eprintln!("[readiness] {:?}", backend.comfy.readiness());
    let station = Station::open(&root).expect("open");
    if host {
        station.set_direction(Direction {
            host: Host::Often,
            ..station.snapshot().direction
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

fn dirs_model() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
    home.join(".local/share/delulu-talks/models")
        .join(delulu_cleanup::MODEL_FILE)
}
