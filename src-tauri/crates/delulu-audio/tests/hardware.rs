//! Hardware smoke test: records from the default input (with a listening
//! capture open at the same time), then plays a short tone and a capture cue.
//! Run with `cargo test -p delulu-audio -- --ignored --nocapture`.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use delulu_audio::*;

fn wait_for<T>(receiver: &mpsc::Receiver<T>, timeout: Duration, mut accept: impl FnMut(&T) -> bool) -> Vec<T> {
    let deadline = Instant::now() + timeout;
    let mut seen = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(left) {
            Ok(item) => {
                let done = accept(&item);
                seen.push(item);
                if done {
                    return seen;
                }
            }
            Err(_) => break,
        }
    }
    panic!("timed out after {timeout:?}");
}

fn tone(frequency: f64, rate: u32, seconds: f64) -> Vec<u8> {
    let count = (rate as f64 * seconds) as usize;
    (0..count)
        .flat_map(|i| {
            let fade = (i.min(count - i) as f64 / (rate as f64 * 0.01)).min(1.0);
            let value = (2.0 * std::f64::consts::PI * frequency * i as f64 / rate as f64).sin() * 0.3 * fade;
            ((value * 32767.0) as i16).to_le_bytes()
        })
        .collect()
}

#[test]
#[ignore]
fn records_and_plays_on_this_machine() {
    eprintln!("host: {}", host_name());
    let inputs = inputs();
    let outputs = outputs();
    eprintln!("inputs: {inputs:#?}\noutputs: {outputs:#?}");
    assert_eq!(inputs[0].device_id, DEFAULT_DEVICE_ID);
    assert!(inputs.len() > 1, "no physical microphone listed");
    assert!(outputs.len() > 1, "no physical output listed");

    let (playback_tx, playback_rx) = mpsc::channel();
    let player = Player::new(move |event| {
        let _ = playback_tx.send(event);
    });

    // A listening capture shares the microphone with dictation.
    let (listen_tx, listen_rx) = mpsc::channel();
    let listen = ListenCapture::start(
        "listen-1",
        ListenConfig {
            device_id: DEFAULT_DEVICE_ID.into(),
            sensitivity: 0.5,
            silence_ms: 900,
            min_speech_ms: 200,
            pre_roll_ms: 500,
            barge_in: true,
            barge_in_ms: 300,
            max_utterance_ms: 60_000,
        },
        Some(player.clone()),
        move |_, event| {
            let _ = listen_tx.send(event);
        },
    );
    wait_for(&listen_rx, Duration::from_secs(5), |event| {
        assert!(!matches!(event, ListenEvent::State { state: ListenState::Failed, .. }), "{event:?}");
        matches!(event, ListenEvent::State { state: ListenState::Listening, .. })
    });

    let (tx, rx) = mpsc::channel();
    let recorder = Recorder::new(move |session, event| {
        let _ = tx.send((session.to_owned(), event));
    });
    let opened = Instant::now();
    recorder
        .start(RecorderOptions {
            session_id: "rec-1".into(),
            device_id: DEFAULT_DEVICE_ID.into(),
            trailing_silence: None,
            max_duration: None,
            cue_volume: Some(0.4),
        })
        .unwrap();
    assert!(recorder.start(RecorderOptions {
        session_id: "rec-2".into(),
        device_id: DEFAULT_DEVICE_ID.into(),
        trailing_silence: None,
        max_duration: None,
        cue_volume: None,
    })
    .is_err());
    wait_for(&rx, Duration::from_secs(5), |(session, event)| {
        assert_eq!(session, "rec-1");
        assert!(!matches!(event, RecorderEvent::Failed(_)), "{event:?}");
        *event == RecorderEvent::Started
    });
    eprintln!("microphone open after {:?}", opened.elapsed());
    std::thread::sleep(Duration::from_millis(600));
    recorder.pause("rec-1").unwrap();
    std::thread::sleep(Duration::from_millis(400));
    recorder.resume("rec-1").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let recording = recorder.stop("rec-1").unwrap();
    let events: Vec<RecorderEvent> = rx.try_iter().map(|(_, event)| event).collect();
    let levels = events.iter().filter(|e| matches!(e, RecorderEvent::Level(_))).count();
    eprintln!(
        "recorded {} ms ({} bytes), {levels} level events, capture end {:.1} ms, encode {:.1} ms, {:?}",
        recording.duration_ms,
        recording.wav.len(),
        recording.capture_end_ms,
        recording.preprocessing_ms,
        recording.diagnostics
    );
    assert!(events.contains(&RecorderEvent::PauseChanged(true)));
    assert!(events.contains(&RecorderEvent::PauseChanged(false)));
    assert!(levels >= 10, "{levels} level events");
    // ~1.1 s captured; the paused 0.4 s is excluded.
    assert!((900..1500).contains(&recording.duration_ms), "{} ms", recording.duration_ms);
    let samples_16k = (recording.wav.len() - 44) as i64 / 2;
    assert!((samples_16k - recording.duration_ms as i64 * 16).abs() <= 16);
    assert_eq!(&recording.wav[..4], b"RIFF");
    assert!(recording.diagnostics.peak_amplitude > 0.0, "the microphone delivered pure digital silence");
    assert!(recorder.active_session().is_none());

    // Past the 3 s stall limit: both record streams kept delivering audio.
    std::thread::sleep(Duration::from_secs(2));
    assert!(!listen.is_finished(), "{:?}", listen_rx.try_iter().collect::<Vec<_>>());
    listen.stop();
    let stopped = listen_rx.try_iter().any(|e| e == ListenEvent::State { state: ListenState::Stopped, message: None });
    assert!(stopped);

    // A short tone in two chunks through the default output.
    let pcm = tone(660.0, 24_000, 0.5);
    let (first, second) = pcm.split_at(pcm.len() / 2);
    for (index, part) in [first, second].into_iter().enumerate() {
        player.play(PlaybackChunk {
            utterance_id: "beep".into(),
            chunk: index as u32,
            last: index == 1,
            sample_rate: 24_000,
            pcm: part.to_vec(),
            volume: 0.5,
            output_device_id: DEFAULT_DEVICE_ID.into(),
        });
    }
    let mut loudest = -120.0f64;
    let mut playing_seen = false;
    let played = wait_for(&playback_rx, Duration::from_secs(5), |event| {
        loudest = loudest.max(player.output_level_db());
        playing_seen |= player.is_playing();
        assert_ne!(event.event, PlaybackEventKind::Failed, "{event:?}");
        event.chunk == 1 && event.event == PlaybackEventKind::Ended
    });
    let summary: Vec<String> = played.iter().map(|e| format!("{}:{:?}", e.chunk, e.event)).collect();
    eprintln!("playback: {summary:?}, loudest reference {loudest:.1} dBFS");
    assert_eq!(summary, ["0:Started", "0:Ended", "1:Started", "1:Ended"]);
    assert!(playing_seen && loudest > -40.0);

    let cues = Cues::new();
    cues.play(Cue::Stop, 0.5);
    std::thread::sleep(Duration::from_millis(400));
}
