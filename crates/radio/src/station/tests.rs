use super::*;
use crate::music;
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
    /// The music settings and length each compose call got.
    music: Mutex<Vec<(Music, u32)>>,
    /// The drafts the music was made from.
    drafts: Mutex<Vec<Draft>>,
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
            music: Mutex::new(Vec::new()),
            drafts: Mutex::new(Vec::new()),
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
    fn speak(&self, _: &str, lang: &str, out: &Path) -> Result<String, RadioError> {
        self.tone(out, 4.0);
        Ok(format!("test voice ({lang})"))
    }
    fn compose(
        &self,
        draft: &Draft,
        _: u64,
        seconds: u32,
        music: &Music,
        out: &Path,
    ) -> Result<BTreeMap<String, String>, RadioError> {
        self.composes.fetch_add(1, Ordering::SeqCst);
        self.music.lock().unwrap().push((music.clone(), seconds));
        self.drafts.lock().unwrap().push(draft.clone());
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
    station
        .set_mix(Mix {
            host: Host::Often,
            ..Mix::default()
        })
        .unwrap();
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
    station.ensure_now();
    make_one(&station, &fake);
    assert_eq!(station.snapshot().queue[1].kind, Kind::Song);
}

#[test]
fn a_dutch_station_has_its_host_write_and_speak_dutch() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.voice = true;
    station
        .set_mix(Mix {
            host: Host::Often,
            language: "Dutch".into(),
            ..Mix::default()
        })
        .unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    make_one(&station, &fake);
    let writes = fake.writes.lock().unwrap();
    let break_prompt = writes.iter().find(|w| w.ends_with("Script:")).unwrap();
    assert!(break_prompt.contains("in Dutch (Nederlands)."));
    assert!(!break_prompt.contains("in English."));
    let s = station.snapshot();
    assert_eq!(s.queue[1].kind, Kind::Break);
    assert_eq!(s.queue[1].provenance["voice"], "test voice (nl)");
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
fn the_engine_choice_reaches_the_next_song() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station
        .set_mix(Mix {
            length_min_seconds: 180,
            length_max_seconds: 180,
            ..Mix::default()
        })
        .unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    station.set_music(MusicEngine::AceStepXl, AceLm::Large);
    make_one(&station, &fake);
    let calls = fake.music.lock().unwrap().clone();
    assert_eq!(calls[0].0.engine, MusicEngine::AceStep);
    assert_eq!(
        (calls[1].0.engine, calls[1].0.ace_lm, calls[1].1),
        (MusicEngine::AceStepXl, AceLm::Large, 180)
    );
    // The choice survives a restart.
    drop(station);
    let reopened = Station::open(&dir.0).unwrap();
    assert_eq!(reopened.snapshot().music.engine, MusicEngine::AceStepXl);
}

/// ACE-Step makes a song in under a minute: the station keeps one song ready next
/// to the one on air instead of YuE2's two, and makes the next as soon as one airs.
#[test]
fn fast_songs_keep_a_short_programme() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 180.0;
    station.set_music(MusicEngine::AceStep, AceLm::Auto);
    station.set_on_air(true);
    make_one(&station, &fake);
    assert_eq!(station.work(&fake), Next::Idle);
    assert_eq!(station.snapshot().queue.len(), 1);
    // On air now: the next one is made right away.
    station.ensure_now();
    make_one(&station, &fake);
    assert_eq!(station.work(&fake), Next::Idle);
    let s = station.snapshot();
    assert_eq!(
        (s.queue.len(), fake.composes.load(Ordering::SeqCst)),
        (1, 2)
    );
    // Short songs: two ready at most.
    let mut short = Fake::new();
    short.seconds = 60.0;
    station.advance();
    for _ in 0..3 {
        make_one(&station, &short);
    }
    assert_eq!(station.snapshot().queue.len(), ACE_BUFFER_ITEMS);
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
fn corrupt_state_is_kept_and_reset_without_losing_audio() {
    let dir = Dir::new();
    std::fs::create_dir_all(dir.0.join("audio")).unwrap();
    std::fs::write(dir.0.join("audio/saved-song.opus"), b"song").unwrap();
    std::fs::write(dir.0.join("station.json"), "{nope").unwrap();
    let station = Station::open(&dir.0).unwrap();
    assert!(station.snapshot().queue.is_empty());
    let kept = |prefix: &str| -> Vec<PathBuf> {
        std::fs::read_dir(&dir.0)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
            .map(|e| e.path())
            .collect()
    };
    assert_eq!(kept("station.corrupt-").len(), 1);
    // The audio the unreadable file listed is set aside with it, not cleaned up.
    let aside = kept("audio.corrupt-");
    assert_eq!(aside.len(), 1);
    assert_eq!(
        std::fs::read(aside[0].join("saved-song.opus")).unwrap(),
        b"song"
    );
    // The fresh station still cleans up its own folder as before.
    station.advance();
    assert!(aside[0].join("saved-song.opus").is_file());
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
        genre: None,
        mood: None,
        surprise: false,
        feedback: None,
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
    let mut made = None;
    let mut aired = Vec::new();
    let mut next = station.ensure_now();
    for _ in 0..5 {
        let item = next.expect("something to air");
        let audio = station.load_audio(&item).unwrap();
        assert!(audio.peak() > 0.01 && audio.seconds() > 2.0, "{}", item.id);
        if aired.len() == 1 {
            make_one(&station, &Fake::new());
            let song = station.snapshot().queue.last().unwrap().clone();
            assert!(song.file.ends_with(".opus"));
            made = Some(song.id);
        }
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
            made.unwrap(),
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

// ---- the mix ----

fn mix_of(genres: &[&str]) -> Mix {
    let mut mix = Mix {
        surprise: 0,
        ..Mix::default()
    };
    for g in mix.genres.iter_mut() {
        g.on = genres.contains(&g.name.as_str());
    }
    mix
}

/// Move everything ready into history, as listening would.
fn listen_all(station: &Station) {
    while !station.snapshot().queue.is_empty() {
        station.advance();
    }
}

#[test]
fn each_song_gets_a_drawn_genre_that_reaches_the_writer_and_the_engine() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    let pool = ["Soul", "Jazz", "Folk", "Techno"];
    station.set_mix(mix_of(&pool)).unwrap();
    station.set_on_air(true);
    for _ in 0..6 {
        make_one(&station, &fake);
        listen_all(&station);
    }
    let s = station.snapshot();
    let songs: Vec<&Item> = s.now.iter().chain(&s.history).collect();
    assert_eq!(songs.len(), 6);
    let genres: HashSet<&str> = songs.iter().map(|i| i.genre.as_deref().unwrap()).collect();
    // Job seeds are random here; the rules guarantee no song repeats the last
    // genre (the draw tests cover the spread under fixed seeds).
    assert!(genres.len() >= 2, "{genres:?}");
    assert!(genres.iter().all(|g| pool.contains(g)));
    // Newest first in history, so the prompts and drafts run the other way.
    let writes = fake.writes.lock().unwrap();
    let drafts = fake.drafts.lock().unwrap();
    for (i, item) in songs.iter().rev().enumerate() {
        let genre = item.genre.as_deref().unwrap();
        let mood = item.mood.as_deref().unwrap();
        assert!(
            writes[i].contains(&format!("\"genres\":[\"{genre}\"]")),
            "{}",
            writes[i]
        );
        assert!(writes[i].contains(&format!("\"mood\":\"{mood}\"")));
        assert!(drafts[i].style.contains(genre), "{}", drafts[i].style);
        assert!(item.subtitle.contains(genre));
    }
    // Each song's drawn length is what the engine was asked for, within the range.
    let asked: Vec<u32> = fake.music.lock().unwrap().iter().map(|m| m.1).collect();
    for (item, seconds) in songs.iter().rev().zip(&asked) {
        assert_eq!(item.provenance["targetSeconds"], seconds.to_string());
        assert!((120..=270).contains(seconds));
    }
    assert!(asked.iter().any(|s| *s != asked[0]), "{asked:?}");
}

#[test]
fn a_mix_change_redraws_only_the_song_not_written_yet() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 20.0;
    station.set_mix(mix_of(&["Soul"])).unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    // The next job is planned but not written.
    fake.may_start.store(false, Ordering::SeqCst);
    station.work(&fake);
    assert_eq!(
        station
            .snapshot()
            .job
            .unwrap()
            .draw
            .unwrap()
            .genre
            .as_deref(),
        Some("Soul")
    );
    station.set_mix(mix_of(&["Metal"])).unwrap();
    let s = station.snapshot();
    assert_eq!(s.job.unwrap().draw.unwrap().genre.as_deref(), Some("Metal"));
    assert_eq!(s.queue[0].genre.as_deref(), Some("Soul"));
}

#[test]
fn a_request_song_leaves_its_style_to_the_request() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.request("a sea shanty about the dunes").unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    let song = &station.snapshot().queue[0];
    assert_eq!((song.genre.as_deref(), song.mood.as_deref()), (None, None));
    assert!(song.request.is_some());
    let prompt = &fake.writes.lock().unwrap()[0];
    assert!(!prompt.contains("\"genres\"") && !prompt.contains("\"mood\""));
}

#[test]
fn an_old_station_file_loads_and_sounds_as_before() {
    let dir = Dir::new();
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(
        dir.0.join("station.json"),
        r#"{"version":1,"onAir":true,"direction":{"mood":"tender","genres":["acoustic ballad","folk"],"energy":"low","vocals":"either","language":"Dutch","length":"short","host":"off","theme":"the sea"},"requests":[],"volume":0.5,
            "job":{"id":"song-old","kind":"song","attempt":0,"seed":11,"startedAt":1}}"#,
    )
    .unwrap();
    let station = Station::open(&dir.0).unwrap();
    let s = station.snapshot();
    assert_eq!(s.mix.enabled_genres(), ["Folk", "acoustic ballad"]);
    assert_eq!(s.mix.enabled_moods(), ["tender"]);
    assert_eq!(
        (s.mix.surprise, s.mix.energy, s.mix.host),
        (0, Some(Energy::Low), Host::Off)
    );
    assert_eq!(
        (s.mix.length_min_seconds, s.mix.length_max_seconds),
        Length::Short.range()
    );
    assert_eq!(
        (s.mix.language.as_str(), s.mix.theme.as_str(), s.volume),
        ("Dutch", "the sea", 0.5)
    );
    // Saved in the new form only.
    let saved = std::fs::read_to_string(dir.0.join("station.json")).unwrap();
    assert!(saved.contains("\"mix\"") && !saved.contains("\"direction\""));
    assert!(saved.contains(&format!("\"version\": {SCHEMA}")));
    // The job from before the mix is drawn from the migrated mix and finishes.
    let fake = Fake::new();
    station.set_on_air(true);
    make_one(&station, &fake);
    let song = &station.snapshot().queue[0];
    assert!(["Folk", "acoustic ballad"].contains(&song.genre.as_deref().unwrap()));
    assert_eq!(song.mood.as_deref(), Some("tender"));
    // Its length is drawn from the range the old short songs became.
    let seconds = fake.music.lock().unwrap()[0].1;
    assert!((75..=120).contains(&seconds), "{seconds}");
    assert_eq!(song.provenance["targetSeconds"], seconds.to_string());
}

#[test]
fn likes_and_dislikes_move_the_genre_weight_once() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.set_mix(mix_of(&["Soul"])).unwrap();
    station.set_on_air(true);
    make_one(&station, &fake);
    let id = station.snapshot().queue[0].id.clone();
    station.feedback(&id, Some(Feedback::Like)).unwrap();
    station.feedback(&id, Some(Feedback::Like)).unwrap();
    assert_eq!(
        mix::weight(&station.snapshot().weights, "Soul"),
        mix::WEIGHT_STEP
    );
    station.feedback(&id, Some(Feedback::Dislike)).unwrap();
    let s = station.snapshot();
    assert!((mix::weight(&s.weights, "soul") - 1.0 / mix::WEIGHT_STEP).abs() < 1e-4);
    assert_eq!(s.queue[0].feedback, Some(Feedback::Dislike));
    // Taking it back and resetting both return to neutral.
    station.feedback(&id, None).unwrap();
    assert!(station.snapshot().weights.is_empty());
    station.feedback(&id, Some(Feedback::Like)).unwrap();
    station.reset_feedback(None);
    let s = station.snapshot();
    assert!(s.weights.is_empty() && s.queue[0].feedback.is_none());
    assert!(station.feedback("gone", Some(Feedback::Like)).is_err());
    // Persisted.
    station.feedback(&id, Some(Feedback::Like)).unwrap();
    drop(station);
    let reopened = Station::open(&dir.0).unwrap();
    assert_eq!(
        mix::weight(&reopened.snapshot().weights, "Soul"),
        mix::WEIGHT_STEP
    );
}

#[test]
fn a_genre_lock_holds_for_its_songs_then_lets_go() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 20.0;
    station.set_mix(mix_of(&["Jazz"])).unwrap();
    station.set_on_air(true);
    // Nothing airs yet: nothing to lock.
    assert!(station.lock_genre(Some(2)).is_err());
    make_one(&station, &fake);
    station.advance();
    station
        .set_mix(mix_of(&["Soul", "Folk", "Techno"]))
        .unwrap();
    let lock = station.lock_genre(Some(2)).unwrap();
    assert_eq!((lock.genre.as_str(), lock.left), ("Jazz", Some(2)));
    make_one(&station, &fake);
    assert_eq!(station.snapshot().lock.unwrap().left, Some(1));
    make_one(&station, &fake);
    assert!(station.snapshot().lock.is_none());
    listen_all(&station);
    make_one(&station, &fake);
    let s = station.snapshot();
    let genres: Vec<&str> = s
        .queue
        .iter()
        .chain(s.now.iter())
        .chain(&s.history)
        .filter_map(|i| i.genre.as_deref())
        .collect();
    assert_eq!(
        genres.iter().filter(|g| **g == "Jazz").count(),
        3,
        "{genres:?}"
    );
    assert_ne!(s.queue[0].genre.as_deref(), Some("Jazz"));
}

#[test]
fn saved_songs_outlive_clean_up_and_play_again() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.set_on_air(true);
    make_one(&station, &fake);
    let song = station.snapshot().queue[0].clone();
    station.save_song(&song.id).unwrap();
    station.save_song(&song.id).unwrap();
    assert_eq!(station.snapshot().saved.len(), 1);
    // Retention drops it from the programme; the saved copy keeps the audio.
    {
        let mut s = station.lock();
        s.queue.clear();
        station.prune(&mut s);
        station.save(&s).unwrap();
    }
    assert!(station.audio_path(&song).is_file());
    drop(station);
    let station = Station::open(&dir.0).unwrap();
    assert_eq!(station.snapshot().saved[0].id, song.id);
    let aired = station.air_saved(&song.id).unwrap();
    assert!(aired.is_replay() && aired.file == song.file);
    assert_eq!(station.snapshot().now.unwrap().id, aired.id);
    // Unsaving through the airing replay lets the audio go once it is done.
    station.unsave_song(&aired.id);
    assert!(station.snapshot().saved.is_empty());
    station.advance();
    assert!(!station.audio_path(&song).is_file());
}

#[test]
fn a_save_that_cannot_be_written_is_refused() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let fake = Fake::new();
    station.set_on_air(true);
    make_one(&station, &fake);
    let song = station.snapshot().queue[0].clone();
    // The state file cannot be replaced: its temporary name is taken by a folder.
    let blocker = dir.0.join("station.json.tmp");
    std::fs::create_dir(&blocker).unwrap();
    assert!(station.save_song(&song.id).is_err());
    assert!(station.snapshot().saved.is_empty());
    std::fs::remove_dir(&blocker).unwrap();
    station.save_song(&song.id).unwrap();
    assert_eq!(saved(&dir.0).saved[0].id, song.id);
}

#[test]
fn a_saved_song_whose_audio_is_gone_leaves_playback_alone() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 20.0;
    station.set_on_air(true);
    make_one(&station, &fake);
    make_one(&station, &fake);
    let airing = station.advance().unwrap();
    let song = station.snapshot().queue[0].clone();
    station.save_song(&song.id).unwrap();
    std::fs::remove_file(station.audio_path(&song)).unwrap();
    assert!(station.air_saved(&song.id).is_err());
    let s = station.snapshot();
    assert_eq!(s.now.unwrap().id, airing.id);
    assert_eq!(s.queue[0].id, song.id);
    assert!(s.history.is_empty());
}

#[test]
fn ending_a_song_that_already_ended_leaves_the_next_one_on() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let mut fake = Fake::new();
    fake.seconds = 20.0;
    station.set_on_air(true);
    make_one(&station, &fake);
    make_one(&station, &fake);
    let disliked = station.advance().unwrap();
    // Playback moves on between the listener's dislike and its skip.
    let next = station.advance().unwrap();
    assert!(station.advance_from(&disliked.id).is_none());
    let s = station.snapshot();
    assert_eq!(s.now.unwrap().id, next.id);
    assert_eq!(s.history.len(), 1);
    // While it still airs, it ends.
    assert!(station.advance_from(&next.id).is_some());
    assert_ne!(station.snapshot().now.map(|i| i.id), Some(next.id));
}

#[test]
fn taking_back_a_verdict_past_the_weight_bound_is_exact() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    {
        let mut s = station.lock();
        for n in 0..5 {
            let mut item = stored(&format!("soul-{n}"), Kind::Song, &format!("soul-{n}.opus"));
            item.genre = Some("Soul".into());
            s.history.push(item);
        }
    }
    for n in 0..5 {
        station
            .feedback(&format!("soul-{n}"), Some(Feedback::Like))
            .unwrap();
    }
    let soul = |st: &Station| mix::weight(&st.snapshot().weights, "Soul");
    assert_eq!(soul(&station), mix::WEIGHT_MAX);
    // Four likes remain: still at the bound.
    station.feedback("soul-4", None).unwrap();
    assert_eq!(soul(&station), mix::WEIGHT_MAX);
    station.feedback("soul-3", None).unwrap();
    station.feedback("soul-2", None).unwrap();
    assert!((soul(&station) - mix::WEIGHT_STEP.powi(2)).abs() < 1e-4);
    // A dislike instead of a like moves two steps.
    station.feedback("soul-1", Some(Feedback::Dislike)).unwrap();
    assert!(station.snapshot().weights.is_empty());
}

#[test]
fn stations_save_rename_delete_and_tune_the_mix() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    let all = station.stations();
    assert!(all.iter().any(|s| s.id == "groove" && s.builtin));
    let groove = station.activate_station("groove").unwrap();
    assert_eq!(groove.enabled_genres(), ["Soul", "Jazz", "House", "Funk"]);
    assert_eq!(
        Station::active_station(&station.stations(), &station.snapshot().mix).as_deref(),
        Some("groove")
    );
    assert!(station.save_station("groove").is_err());
    assert!(station.rename_station("groove", "Mine").is_err());
    assert!(station.delete_station("drift").is_err());
    station.set_mix(mix_of(&["Metal", "Punk rock"])).unwrap();
    let mine = station.save_station(" Loud ").unwrap();
    assert_eq!(mine.name, "Loud");
    station.activate_station("drift").unwrap();
    station.activate_station(&mine.id).unwrap();
    assert_eq!(
        station.snapshot().mix.enabled_genres(),
        ["Punk rock", "Metal"]
    );
    assert!(station.rename_station(&mine.id, "Drift").is_err());
    station.rename_station(&mine.id, "Louder").unwrap();
    // Saving under an existing name of the listener's updates that station.
    station.set_mix(mix_of(&["Metal"])).unwrap();
    station.save_station("louder").unwrap();
    let s = station.snapshot();
    assert_eq!(s.stations.len(), 1);
    assert_eq!(s.stations[0].preset.genres, ["Metal"]);
    station.delete_station(&mine.id).unwrap();
    assert!(station.snapshot().stations.is_empty());
}

#[test]
fn failed_mix_write_keeps_the_previous_mix_and_draw_until_retry() {
    let dir = Dir::new();
    let station = Station::open(&dir.0).unwrap();
    station.set_mix(mix_of(&["Soul"])).unwrap();
    {
        let mut state = station.lock();
        state.job = Some(station.plan(&mut state, false));
        station.save(&state).unwrap();
    }
    let before = station.snapshot();
    let blocked = dir.0.join("station.json.tmp");
    std::fs::create_dir(&blocked).unwrap();
    let next = mix_of(&["Metal"]);
    assert!(station.set_mix(next.clone()).is_err());
    assert_eq!(station.snapshot(), before);
    let persisted: State =
        serde_json::from_slice(&std::fs::read(dir.0.join("station.json")).unwrap()).unwrap();
    assert_eq!(persisted, before);
    std::fs::remove_dir(blocked).unwrap();
    station.set_mix(next.clone()).unwrap();
    assert_eq!(Station::open(&dir.0).unwrap().snapshot().mix, next);
    assert_eq!(
        station
            .snapshot()
            .job
            .unwrap()
            .draw
            .unwrap()
            .genre
            .as_deref(),
        Some("Metal")
    );
}

/// Write the station format emitted before ACE-Step Turbo became the default.
fn open_yue2_station(root: &Path) -> Station {
    let (before, _) = wav_station(root);
    let models = root.join("models");
    std::fs::create_dir_all(&models).unwrap();
    let legacy = models.join(music::MODEL_FILE);
    std::fs::write(&legacy, b"existing checkpoint").unwrap();
    let path = root.join("station.json");
    let mut json = serde_json::to_value(&before).unwrap();
    json["music"] = serde_json::json!({"engine":"yue2","aceLm":"0.6b"});
    std::fs::write(&path, json.to_string()).unwrap();
    let station = Station::open(root).unwrap();
    let after = station.snapshot();
    assert_eq!(after.history, before.history);
    for item in &after.history {
        assert!(station.load_audio(item).unwrap().peak() > 0.01);
    }
    assert_eq!(after.music.engine, MusicEngine::AceStep);
    assert_eq!(after.music.ace_lm, AceLm::Small);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(persisted["music"]["engine"], "acestep");
    assert_eq!(std::fs::read(legacy).unwrap(), b"existing checkpoint");
    station
}

#[test]
fn upgraded_yue2_station_makes_its_next_song_with_turbo() {
    let dir = Dir::new();
    let station = open_yue2_station(&dir.0);
    station.advance();
    station.set_on_air(true);
    let fake = Fake::new();
    make_one(&station, &fake);
    let music = &fake.music.lock().unwrap()[0].0;
    assert_eq!(
        (music.engine, music.ace_lm),
        (MusicEngine::AceStep, AceLm::Small)
    );
    assert!(station
        .snapshot()
        .queue
        .last()
        .unwrap()
        .file
        .ends_with(".opus"));
}

/// Run explicitly with a native release helper. Downloads both real bundles.
#[test]
#[ignore = "requires the release engine and about 11 GB of model downloads"]
fn native_fm_song_smoke() {
    use delulu_models::{download, ACE_STEP_LM_SMALL, ACE_STEP_TURBO, ACE_STEP_XL_TURBO};
    let dir = Dir::new();
    let station = open_yue2_station(&dir.0);
    let models = dir.0.join("models");
    let cancel = AtomicBool::new(false);
    assert!(!ACE_STEP_TURBO.installed(&models));
    download(&models, &ACE_STEP_LM_SMALL, &mut |_, _| {}, &cancel).unwrap();
    let draft = serde_json::from_value(serde_json::json!({
        "title":"Pulse", "subtitle":"", "style":"instrumental synth pop, bright bass, drums, 110 BPM",
        "instrumental":true
    })).unwrap();
    for generator in [&ACE_STEP_TURBO, &ACE_STEP_XL_TURBO] {
        if generator.id == ACE_STEP_XL_TURBO.id {
            station.set_music(MusicEngine::AceStepXl, station.snapshot().music.ace_lm);
        }
        download(&models, generator, &mut |_, _| {}, &cancel).unwrap();
        let settings = station.snapshot().music;
        let order = music::Order::new(&draft, 42, 10, &settings, &models);
        let out = dir.0.join("song.wav");
        let report = music::Composer::default()
            .compose(
                &music::helper_path().unwrap(),
                &order,
                &out,
                &|| false,
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(report["xl"], generator.id == ACE_STEP_XL_TURBO.id);
        let audio = audio::decode(&out).unwrap();
        let rms = (audio
            .samples
            .iter()
            .map(|v| f64::from(*v).powi(2))
            .sum::<f64>()
            / audio.samples.len() as f64)
            .sqrt();
        assert!(audio.seconds() >= 9.0 && audio.rate == 48000 && rms > 0.0001);
        eprintln!(
            "{} seed=42 target=10s decoded={}s stereo {}Hz RMS={rms} peak={} {report}",
            generator.id,
            audio.seconds(),
            audio.rate,
            audio.peak()
        );
        std::fs::remove_file(out).unwrap();
    }
}
