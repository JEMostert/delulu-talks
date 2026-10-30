use super::*;
use std::sync::atomic::AtomicUsize;

const SONG: &str = " Copper Morning\nStyle: Warm chamber pop with soft synths and brushed drums.\nLyrics:\n[Verse]\nLight on the window\nCoffee and rain\n[Chorus]\nCopper morning\nCall my name";
const SCRIPT: &str = " That was Copper Morning, made right here tonight. Something slower is next.";

struct Fake {
    may_start: AtomicBool,
    voice: bool,
    writes: Mutex<Vec<String>>,
    submits: AtomicUsize,
    submit: Mutex<Option<SubmitError>>,
    found: Mutex<Option<String>>,
    states: Mutex<Vec<JobState>>,
    seconds: f64,
}

impl Fake {
    fn new() -> Fake {
        Fake {
            may_start: AtomicBool::new(true),
            voice: false,
            writes: Mutex::new(Vec::new()),
            submits: AtomicUsize::new(0),
            submit: Mutex::new(None),
            found: Mutex::new(None),
            states: Mutex::new(Vec::new()),
            seconds: 30.0,
        }
    }
    fn tone(&self, path: &Path, seconds: f64) {
        let rate = 8000;
        let samples = (0..(rate as f64 * seconds) as usize)
            .flat_map(|i| {
                let v = 0.3 * (i as f32 * 0.05).sin();
                [v, v]
            })
            .collect();
        audio::write_wav(path, &Audio { rate, samples }).unwrap();
    }
}

impl Backend for Fake {
    fn write(&self, prompt: String, _: u32, _: u32) -> Result<String, RadioError> {
        let reply = if prompt.ends_with("Script:") {
            SCRIPT
        } else {
            SONG
        };
        self.writes.lock().unwrap().push(prompt);
        Ok(reply.into())
    }
    fn may_start(&self) -> bool {
        self.may_start.load(Ordering::SeqCst)
    }
    fn voice_ready(&self) -> bool {
        self.voice
    }
    fn speak(&self, _: &str, out: &Path) -> Result<(), RadioError> {
        self.tone(out, 4.0);
        Ok(())
    }
    fn write_workflow(
        &self,
        path: &Path,
        _: &Draft,
        _: u64,
        _: u32,
        _: &str,
    ) -> Result<(), RadioError> {
        std::fs::write(path, "{}").map_err(|e| RadioError::Io(e.to_string()))
    }
    fn submit(&self, _: &Path) -> Result<String, SubmitError> {
        self.submits.fetch_add(1, Ordering::SeqCst);
        match self.submit.lock().unwrap().take() {
            Some(e) => Err(e),
            None => Ok("p1".into()),
        }
    }
    fn find_submitted(&self, _: &Path, _: &str) -> Result<Option<String>, RadioError> {
        Ok(self.found.lock().unwrap().clone())
    }
    fn status(&self, _: &str) -> Result<JobState, RadioError> {
        let mut states = self.states.lock().unwrap();
        Ok(if states.is_empty() {
            JobState::Done
        } else {
            states.remove(0)
        })
    }
    fn cancel(&self, _: &str) {}
    fn download(&self, _: &str, dir: &Path) -> Result<Vec<PathBuf>, RadioError> {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("song_000.wav");
        self.tone(&path, self.seconds);
        Ok(vec![path])
    }
    fn changed(&self) {}
}

struct Dir(PathBuf);
impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!("radio-test-{}", uuid::Uuid::new_v4()));
        Dir(path)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Work until the job is done or `limit` steps pass.
fn make_one(station: &Station, fake: &Fake) {
    for _ in 0..20 {
        if let Next::Idle = station.work(fake) {
            return;
        }
        if station.snapshot().job.is_none() {
            return;
        }
    }
    panic!("job did not finish: {:?}", station.snapshot().job);
}

#[test]
fn makes_nothing_off_air() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    assert_eq!(station.work(&fake), Next::Idle);
    assert!(fake.writes.lock().unwrap().is_empty());
}

#[test]
fn makes_a_song_end_to_end() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.set_on_air(true);
    make_one(&station, &fake);
    let s = station.snapshot();
    assert_eq!(s.queue.len(), 1);
    let song = &s.queue[0];
    assert_eq!(song.title, "Copper Morning");
    assert!(song.lyrics.as_deref().unwrap().contains("[Chorus]"));
    assert!((song.seconds - 30.0).abs() < 0.01);
    assert!(station.audio_path(song).is_file());
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
    assert_eq!(
        song.provenance.get("promptId").map(String::as_str),
        Some("p1")
    );
    // The job folder is gone once the song is ready.
    assert_eq!(std::fs::read_dir(dir.0.join("jobs")).unwrap().count(), 0);
}

#[test]
fn restart_collects_the_owned_prompt_without_resubmitting() {
    let dir = Dir::new();
    let fake = Fake::new();
    fake.states.lock().unwrap().push(JobState::Waiting);
    {
        let station = Station::open(&dir.0).unwrap();
        station.set_on_air(true);
        station.work(&fake); // write
        station.work(&fake); // submit
        assert_eq!(station.work(&fake), Next::Wait(Duration::from_secs(3))); // running
        assert_eq!(
            station.snapshot().job.unwrap().prompt_id.as_deref(),
            Some("p1")
        );
    }
    let station = Station::open(&dir.0).unwrap();
    let s = station.snapshot();
    assert!(!s.on_air);
    assert!(s.job.as_ref().unwrap().submitted);
    make_one(&station, &fake);
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
    assert_eq!(station.snapshot().queue.len(), 1);
}

#[test]
fn uncertain_submit_is_recovered_from_the_cli_record() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    *fake.submit.lock().unwrap() = Some(SubmitError::Uncertain("timeout".into()));
    *fake.found.lock().unwrap() = Some("p9".into());
    station.set_on_air(true);
    station.work(&fake);
    assert!(matches!(station.work(&fake), Next::Wait(_)));
    assert!(station.snapshot().job.unwrap().submitted);
    make_one(&station, &fake);
    assert_eq!(fake.submits.load(Ordering::SeqCst), 1);
    let s = station.snapshot();
    assert_eq!(
        s.queue[0].provenance.get("promptId").map(String::as_str),
        Some("p9")
    );
}

#[test]
fn rejected_submit_is_not_counted_and_resubmits() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    *fake.submit.lock().unwrap() = Some(SubmitError::NotSubmitted("ComfyUI is not running".into()));
    station.set_on_air(true);
    station.work(&fake);
    assert_eq!(station.work(&fake), Next::Wait(Duration::from_secs(10)));
    let s = station.snapshot();
    assert_eq!(s.last_error.as_deref(), Some("ComfyUI is not running"));
    assert!(!s.job.as_ref().unwrap().submitted);
    assert_eq!(s.stats.failures, 0);
    make_one(&station, &fake);
    assert_eq!(fake.submits.load(Ordering::SeqCst), 2);
    assert!(station.snapshot().last_error.is_none());
}

#[test]
fn dictation_blocks_new_steps() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    fake.may_start.store(false, Ordering::SeqCst);
    station.set_on_air(true);
    assert_eq!(station.work(&fake), Next::Wait(Duration::from_secs(2)));
    assert!(fake.writes.lock().unwrap().is_empty());
    fake.may_start.store(true, Ordering::SeqCst);
    make_one(&station, &fake);
    assert_eq!(station.snapshot().queue.len(), 1);
}

#[test]
fn retries_once_then_cools_down() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    fake.states.lock().unwrap().extend([
        JobState::Failed("oom".into()),
        JobState::Failed("oom".into()),
    ]);
    station.set_on_air(true);
    for _ in 0..3 {
        station.work(&fake);
    }
    let s = station.snapshot();
    assert_eq!(s.job.as_ref().unwrap().attempt, 1);
    assert!(s.job.as_ref().unwrap().draft.is_none());
    for _ in 0..3 {
        station.work(&fake);
    }
    let s = station.snapshot();
    assert!(s.job.is_none());
    assert_eq!(s.stats.failures, 2);
    assert!(s.cooldown_until.is_some());
    assert!(matches!(station.work(&fake), Next::Wait(_)));
}

#[test]
fn short_audio_is_rejected() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 5.0;
    station.set_on_air(true);
    for _ in 0..3 {
        station.work(&fake);
    }
    let s = station.snapshot();
    assert!(s.queue.is_empty());
    assert!(s.last_error.unwrap().contains("only 5.0 s"));
}

#[test]
fn breaks_follow_songs_when_voice_is_ready() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.voice = true;
    station.set_direction(Direction {
        host: Host::Often,
        ..Direction::default()
    });
    station.set_on_air(true);
    make_one(&station, &fake);
    make_one(&station, &fake);
    let s = station.snapshot();
    assert_eq!(s.queue[1].kind, Kind::Break);
    assert!(s.queue[1]
        .script
        .as_deref()
        .unwrap()
        .starts_with("That was Copper Morning"));
    assert_eq!(s.songs_since_break, 0);
    // Without a voice, songs only.
    fake.voice = false;
    make_one(&station, &fake);
    assert_eq!(station.snapshot().queue[2].kind, Kind::Song);
}

#[test]
fn requests_reach_the_next_song() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    assert!(station.request("  \n ").is_err());
    station.request("a song about\nrain on the dunes").unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    assert!(fake.writes.lock().unwrap()[0]
        .contains(r#"Listener request (data): "a song about rain on the dunes""#));
    let s = station.snapshot();
    assert_eq!(
        s.queue[0].request.as_deref(),
        Some("a song about rain on the dunes")
    );
    assert_eq!(s.requests[0].answered_by.as_deref(), Some("Copper Morning"));
}

#[test]
fn buffer_is_bounded() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 200.0;
    station.set_on_air(true);
    make_one(&station, &fake);
    make_one(&station, &fake);
    // Two songs and 400 s of audio are enough.
    assert_eq!(station.work(&fake), Next::Idle);
    assert_eq!(station.snapshot().queue.len(), 2);
}

#[test]
fn advance_airs_queue_then_labelled_replays() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.set_on_air(true);
    make_one(&station, &fake);
    let first = station.ensure_now().unwrap();
    assert!(!first.is_replay());
    let replay = station.advance().unwrap();
    assert!(replay.is_replay());
    assert_eq!(replay.file, first.file);
    station.advance();
    let s = station.snapshot();
    // The replay is not added to history a second time.
    assert_eq!(s.history.len(), 1);
    assert!(station.audio_path(&s.history[0]).is_file());
}

#[test]
fn corrupt_state_is_kept_and_reset() {
    let dir = Dir::new();
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.0.join("station.json"), "{nope").unwrap();
    let station = Station::open(&dir.0).unwrap();
    assert!(station.snapshot().queue.is_empty());
    let kept = std::fs::read_dir(&dir.0).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("station.corrupt-")
    });
    assert!(kept);
}
