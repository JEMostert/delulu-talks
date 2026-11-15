use super::*;
use std::cell::Cell;
use std::sync::atomic::AtomicUsize;

const SONG: &str = " Copper Morning\nStyle: Warm chamber pop with soft synths and brushed drums.\nLyrics:\n[Verse]\nLight on the window\nCoffee and rain\n[Chorus]\nCopper morning\nCall my name";
const SCRIPT: &str = " That was Copper Morning, made right here tonight. Something slower is next.";

struct Fake {
    may_start: AtomicBool,
    voice: bool,
    writes: Mutex<Vec<String>>,
    composes: AtomicUsize,
    /// Outcomes for the next compose calls; empty = success.
    outcomes: Mutex<Vec<RadioError>>,
    seconds: f64,
}

impl Fake {
    fn new() -> Fake {
        Fake {
            may_start: AtomicBool::new(true),
            voice: false,
            writes: Mutex::new(Vec::new()),
            composes: AtomicUsize::new(0),
            outcomes: Mutex::new(Vec::new()),
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
    fn compose(
        &self,
        _: &Draft,
        _: u64,
        _: u32,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError> {
        self.composes.fetch_add(1, Ordering::SeqCst);
        let mut outcomes = self.outcomes.lock().unwrap();
        if !outcomes.is_empty() {
            return Err(outcomes.remove(0));
        }
        self.tone(out, self.seconds);
        Ok(BTreeMap::from([("device".to_string(), "fake".to_string())]))
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
    assert!(song.file.ends_with(".opus"));
    assert!(song.loudness.is_some());
    assert!(station.audio_path(song).is_file());
    assert_eq!(fake.composes.load(Ordering::SeqCst), 1);
    assert_eq!(
        song.provenance.get("device").map(String::as_str),
        Some("fake")
    );
    // The job folder is gone once the song is ready.
    assert_eq!(std::fs::read_dir(dir.0.join("jobs")).unwrap().count(), 0);
}

#[test]
fn restart_keeps_the_written_draft() {
    let dir = Dir::new();
    let fake = Fake::new();
    fake.outcomes.lock().unwrap().push(RadioError::Cancelled);
    {
        let station = Station::open(&dir.0).unwrap();
        station.set_on_air(true);
        station.work(&fake); // write
        assert_eq!(station.work(&fake), Next::Wait(Duration::from_secs(1))); // stopped
    }
    let station = Station::open(&dir.0).unwrap();
    let s = station.snapshot();
    assert!(!s.on_air);
    assert!(s.job.as_ref().unwrap().draft.is_some());
    assert_eq!(station.work(&fake), Next::Idle);
    station.set_on_air(true);
    make_one(&station, &fake);
    assert_eq!(fake.writes.lock().unwrap().len(), 1);
    assert_eq!(fake.composes.load(Ordering::SeqCst), 2);
    assert_eq!(station.snapshot().queue.len(), 1);
    assert_eq!(station.snapshot().stats.failures, 0);
}

#[test]
fn missing_model_waits_without_counting_a_failure() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    fake.outcomes
        .lock()
        .unwrap()
        .push(RadioError::Unavailable("Download the music model".into()));
    station.set_on_air(true);
    station.work(&fake);
    assert_eq!(station.work(&fake), Next::Wait(Duration::from_secs(10)));
    let s = station.snapshot();
    assert_eq!(s.last_error.as_deref(), Some("Download the music model"));
    assert_eq!(s.stats.failures, 0);
    make_one(&station, &fake);
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
    fake.outcomes.lock().unwrap().extend([
        RadioError::Music("broken".into()),
        RadioError::Music("broken".into()),
    ]);
    station.set_on_air(true);
    for _ in 0..2 {
        station.work(&fake);
    }
    let s = station.snapshot();
    assert_eq!(s.job.as_ref().unwrap().attempt, 1);
    assert!(s.job.as_ref().unwrap().draft.is_none());
    for _ in 0..2 {
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

// ---- WAV to Opus conversion ----

fn stored(id: &str, kind: Kind, file: &str) -> Item {
    Item {
        id: id.into(),
        kind,
        title: id.into(),
        subtitle: String::new(),
        lyrics: None,
        script: None,
        seconds: 3.0,
        file: file.into(),
        created_at: 0,
        request: None,
        provenance: BTreeMap::new(),
        loudness: None,
    }
}

/// A station from before Opus: WAV files at the rates the station has met, a
/// replay airing (it shares its source's file), two ready items and history.
/// Returns the state and each file's length in seconds.
fn wav_station(root: &Path) -> (State, BTreeMap<String, f64>) {
    std::fs::create_dir_all(root.join("audio")).unwrap();
    let mut seconds = BTreeMap::new();
    for (file, rate, length, left, right) in [
        ("song-a.wav", 48000, 3.4, 0.8, 0.7),
        ("break-b.wav", 24000, 3.1, 0.5, 0.5),
        ("song-c.wav", 44100, 2.7, 0.6, 0.3),
        ("song-d.wav", 8000, 2.2, 0.4, 0.4),
    ] {
        let frames = (rate as f64 * length) as usize;
        let samples = (0..frames)
            .flat_map(|i| {
                let v = (i as f32 * 0.07).sin();
                [v * left, v * right]
            })
            .collect();
        let audio = Audio { rate, samples };
        seconds.insert(file.to_string(), audio.seconds());
        audio::write_wav(&root.join("audio").join(file), &audio).unwrap();
    }
    let mut replay = stored("replay-1", Kind::Song, "song-a.wav");
    replay.provenance.insert("replay".into(), "true".into());
    let state = State {
        now: Some(replay),
        queue: vec![
            stored("break-b", Kind::Break, "break-b.wav"),
            stored("song-c", Kind::Song, "song-c.wav"),
        ],
        history: vec![
            stored("song-a", Kind::Song, "song-a.wav"),
            stored("song-d", Kind::Song, "song-d.wav"),
        ],
        ..State::default()
    };
    let json = serde_json::to_vec_pretty(&state).unwrap();
    std::fs::write(root.join("station.json"), json).unwrap();
    (state, seconds)
}

fn saved(root: &Path) -> State {
    serde_json::from_slice(&std::fs::read(root.join("station.json")).unwrap()).unwrap()
}

/// The saved state has every item of `before`, in place, each naming a file
/// that exists and is that item's WAV or its Opus.
fn assert_consistent(root: &Path, before: &State) {
    let after = saved(root);
    let ids = |s: &State| items(s).map(|i| i.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&after), ids(before));
    for (old, new) in items(before).zip(items(&after)) {
        assert!(
            new.file == old.file || new.file == opus_name(&old.file),
            "{} -> {}",
            old.file,
            new.file
        );
        assert!(root.join("audio").join(&new.file).is_file(), "{}", new.file);
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn conversion_survives_a_kill_at_every_step() {
    for step in [Step::Writing, Step::Written, Step::Saved] {
        let dir = Dir::new();
        let (before, seconds) = wav_station(&dir.0);
        {
            let station = Station::open(&dir.0).unwrap();
            let file = Cell::new(0);
            // The process dies at `step` while storing the second file.
            let kill = |at: Step| {
                if at == Step::Writing {
                    file.set(file.get() + 1);
                }
                !(at == step && file.get() == 2)
            };
            let result = station.convert_with(&AtomicBool::new(false), &kill);
            assert!(matches!(result, Err(RadioError::Cancelled)), "{step:?}");
        }
        assert_consistent(&dir.0, &before);
        let breaks = saved(&dir.0).queue[0].file.clone();
        let audio = names(&dir.0.join("audio"));
        match step {
            Step::Writing => {
                assert_eq!(names(&dir.0.join("convert")), ["break-b.opus.part"]);
                assert_eq!(breaks, "break-b.wav");
            }
            Step::Written => {
                assert!(audio.contains(&"break-b.opus".to_string()));
                assert_eq!(breaks, "break-b.wav");
            }
            Step::Saved => {
                assert!(audio.contains(&"break-b.wav".to_string()));
                assert_eq!(breaks, "break-b.opus");
            }
        }

        // The next start continues where the kill left off.
        let station = Station::open(&dir.0).unwrap();
        let done = station.convert(&AtomicBool::new(false));
        assert_eq!(done.failed, 0, "{step:?}");
        // Only a file whose Opus name was saved counts as done.
        let left = if step == Step::Saved { 2 } else { 3 };
        assert_eq!(done.converted, left, "{step:?}");
        assert_consistent(&dir.0, &before);
        let s = saved(&dir.0);
        assert_eq!(s, station.snapshot());
        let mut files: Vec<String> = items(&s).map(|i| i.file.clone()).collect();
        files.sort();
        files.dedup();
        assert_eq!(
            names(&dir.0.join("audio")),
            files,
            "{step:?}: no WAV or stray file is left"
        );
        assert!(names(&dir.0.join("convert")).is_empty());
        // The replay still shares its source's file.
        assert_eq!(s.now.as_ref().unwrap().file, s.history[0].file);
        for item in items(&s) {
            assert!(item.file.ends_with(".opus"), "{}", item.file);
            assert!(item.loudness.is_some_and(|l| l.lufs > -70.0));
            let wav = item.file.replace(".opus", ".wav");
            let decoded = audio::decode(&station.audio_path(item)).unwrap();
            assert!(
                (decoded.seconds() - seconds[&wav]).abs() < 0.001,
                "{step:?} {}: {} s, was {} s",
                item.file,
                decoded.seconds(),
                seconds[&wav]
            );
        }
    }
}

#[test]
fn mixed_library_plays_in_order() {
    let dir = Dir::new();
    wav_station(&dir.0);
    let station = Station::open(&dir.0).unwrap();
    station.set_on_air(true);
    make_one(&station, &Fake::new());
    let made = station.snapshot().queue[2].clone();
    assert!(made.file.ends_with(".opus"));
    let mut aired = Vec::new();
    let mut next = station.ensure_now();
    for _ in 0..5 {
        let item = next.expect("something to air");
        let audio = station.load_audio(&item).unwrap();
        assert!(audio.peak() > 0.01 && audio.seconds() > 2.0, "{}", item.id);
        aired.push(if item.is_replay() {
            format!("replay of {}", item.file)
        } else {
            item.id.clone()
        });
        next = station.advance();
    }
    assert_eq!(
        aired,
        [
            "replay of song-a.wav".to_string(),
            "break-b".into(),
            "song-c".into(),
            made.id.clone(),
            // Not the song that just ended.
            "replay of song-c.wav".into(),
        ]
    );
}

/// The app copies an item, then reads its audio; the conversion may replace the
/// WAV in between.
#[test]
fn a_copy_taken_before_conversion_still_plays_with_its_gain() {
    let dir = Dir::new();
    wav_station(&dir.0);
    let station = Station::open(&dir.0).unwrap();
    let copy = station.snapshot().queue[1].clone();
    assert_eq!(copy.file, "song-c.wav");
    assert_eq!(station.convert(&AtomicBool::new(false)).converted, 4);
    assert!(!dir.0.join("audio/song-c.wav").exists());
    let played = station.load_audio(&copy).unwrap();
    let current = station.snapshot().queue[1].clone();
    let mut evened = audio::decode(&station.audio_path(&current)).unwrap();
    assert!(
        audio::playback_gain(current.loudness) < 1.0,
        "a loud tone is turned down"
    );
    audio::even_out(&mut evened, current.loudness);
    assert_eq!(played.samples, evened.samples);
}
