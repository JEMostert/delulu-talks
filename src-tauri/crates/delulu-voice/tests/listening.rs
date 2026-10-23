//! The listening session Talk owns: turns in order, durable recordings,
//! barge-in, levels and the microphone lifecycle.

mod support;

use std::sync::atomic::Ordering;

use delulu_audio::{ListenEvent as CaptureEvent, ListenState};
use delulu_domain::listening::ListenSessionState;
use delulu_voice::{is_real_turn, sounds_like_own_speech, CaptureCommand, Heard};
use support::{listen_fixture, listen_fixture_in};

#[tokio::test]
async fn turns_reach_the_owner_in_order_over_one_session_and_model() {
    let f = listen_fixture();
    let session = f.service.start().await.unwrap();
    f.service.capture_event(&session.id, CaptureEvent::State { state: ListenState::Listening, message: None });
    assert_eq!(f.service.start().await.unwrap().id, session.id);
    assert_eq!(f.transcriber.prepared.load(Ordering::SeqCst), 1);
    f.say("First question.").await;
    f.say("And a second thing.").await;
    let turns = f.turns();
    assert_eq!(turns.iter().map(|(text, _)| text.as_str()).collect::<Vec<_>>(), ["First question.", "And a second thing."]);
    // Recordings stay private until the owner has handled the turn.
    let first = turns[0].1.clone().unwrap();
    assert!(first.starts_with(f.dir.path().join("voice").join("pending-audio")) && first.exists());
    f.service.discard(&first);
    assert!(!first.exists() && !first.with_extension("json").exists());
    let starts = f.backend.commands.lock().iter().filter(|c| matches!(c, CaptureCommand::Start { .. })).count();
    assert_eq!(starts, 1);
}

#[tokio::test]
async fn noise_fillers_and_delulus_own_words_never_become_turns() {
    let f = listen_fixture();
    f.service.start().await.unwrap();
    f.say("").await;
    f.say("Um.").await;
    f.say("All two hundred tests pass.").await;
    assert!(f.turns().is_empty());
    assert!(f.pending_audio().is_empty(), "dropped recordings are deleted");
    assert!(!is_real_turn("Hmm, uh"));
    assert!(is_real_turn("No."));
    assert!(sounds_like_own_speech("the fix is merged", &["The fix is merged.".into()]));
}

#[tokio::test]
async fn barge_in_reports_the_cut_off_response_then_the_utterance_that_interrupted_it() {
    let f = listen_fixture();
    f.service.start().await.unwrap();
    f.barge_in(&["rsp_1"]);
    // Even words Delulu just said count when the user deliberately interrupted.
    f.say("Wait, the fix is merged?").await;
    let heard = f.heard.lock().clone();
    assert_eq!(heard[0], Heard::BargeIn { response_ids: vec!["rsp_1".into()] });
    match &heard[1] {
        Heard::Turn { turn, .. } => assert_eq!(turn.interrupted_response_id.as_deref(), Some("rsp_1")),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn unhandled_recordings_survive_a_restart_and_are_handed_over_again() {
    let f = listen_fixture();
    f.service.start().await.unwrap();
    f.say("Deploy the preview.").await;
    let (_, recording) = f.turns().remove(0);
    let recording = recording.unwrap();
    f.service.stop_active("Stopped");
    // Outstanding (not released) recordings are not handed over twice.
    f.service.start().await.unwrap();
    assert_eq!(f.turns().len(), 1);
    f.service.stop_active("Stopped");

    // A new process finds the recording and transcribes it again first.
    let restarted = listen_fixture_in(f.dir);
    restarted.transcriber.push("Deploy the preview.");
    restarted.service.start().await.unwrap();
    let turns = restarted.turns();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].0, "Deploy the preview.");
    assert_eq!(turns[0].1.as_deref(), Some(recording.as_path()));
    assert_eq!(restarted.transcriber.prepared.load(Ordering::SeqCst), 1, "recovery uses the loaded model");
}

#[tokio::test]
async fn a_failed_transcription_keeps_the_recording_and_gives_up_after_three_retries() {
    let f = listen_fixture();
    f.service.start().await.unwrap();
    f.transcriber.fail_next();
    let id = f.session_id();
    f.service.capture_event(
        &id,
        CaptureEvent::Utterance { wav: vec![0; 64], duration_ms: 900, speech_ms: 700, overlapped_playback: false },
    );
    let service = f.service.clone();
    support::until(move || !service.get_status().session.unwrap().transcribing, "transcription").await;
    assert!(f.service.active(), "one failure does not end the session");
    assert!(f.service.get_status().session.unwrap().error.unwrap().contains("Could not transcribe"));
    assert_eq!(f.pending_audio().len(), 1);
    f.service.stop_active("Stopped");
    for attempt in 1..=3 {
        f.transcriber.fail_next();
        f.service.start().await.unwrap();
        f.service.stop_active("Stopped");
        assert_eq!(f.pending_audio().len(), usize::from(attempt < 3), "attempt {attempt}");
    }
    assert!(f.turns().is_empty());
}

#[tokio::test]
async fn levels_reach_the_owner_and_a_new_microphone_reconfigures_the_capture() {
    let f = listen_fixture();
    let session = f.service.start().await.unwrap();
    f.service.capture_event(&session.id, CaptureEvent::Level { db: -42.5 });
    assert_eq!(f.heard.lock().last(), Some(&Heard::Level { db: -42.5 }));
    let settings = delulu_domain::AppSettings { input_device_id: "usb-headset".into(), ..Default::default() };
    f.service.settings_changed(&settings);
    let last = f.backend.commands.lock().last().cloned();
    match last {
        Some(CaptureCommand::Configure { config, .. }) => assert_eq!(config.device_id, "usb-headset"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn dictation_pauses_and_resumes_the_microphone() {
    let f = listen_fixture();
    let session = f.service.start().await.unwrap();
    f.service.capture_event(&session.id, CaptureEvent::State { state: ListenState::Listening, message: None });
    f.service.pause_for_dictation();
    assert_eq!(f.service.get_status().message, "Paused while you dictate");
    f.service.resume_after_dictation();
    assert_eq!(f.service.get_status().message, "Listening");
    let commands = f.backend.commands.lock();
    assert!(matches!(commands[commands.len() - 2], CaptureCommand::Pause { .. }));
    assert!(matches!(commands[commands.len() - 1], CaptureCommand::Resume { .. }));
}

#[tokio::test]
async fn a_failed_microphone_ends_the_session_with_its_reason() {
    let f = listen_fixture();
    let session = f.service.start().await.unwrap();
    f.service.capture_event(
        &session.id,
        CaptureEvent::State { state: ListenState::Failed, message: Some("The microphone was disconnected.".into()) },
    );
    let status = f.service.get_status();
    assert_eq!(status.session.unwrap().state, ListenSessionState::Failed);
    assert_eq!(status.message, "The microphone was disconnected.");
    assert!(!f.service.active());
    assert!(matches!(f.backend.commands.lock().last(), Some(CaptureCommand::Stop { .. })));
}
