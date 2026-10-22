//! Port of `electron/services/listening.test.ts`.

mod support;

use std::sync::atomic::Ordering;

use delulu_audio::{ListenEvent as CaptureEvent, ListenState};
use delulu_domain::listening::{ListenEvent, ListenNextResult};
use delulu_voice::{is_real_turn, sounds_like_own_speech, CaptureCommand, ListenErrorCode};
use support::listen_fixture;
use tokio_util::sync::CancellationToken;

fn event(result: &ListenNextResult) -> &ListenEvent {
    match result {
        ListenNextResult::Event { event, .. } => event,
        other => panic!("expected an event, got {other:?}"),
    }
}

fn text(result: &ListenNextResult) -> String {
    match event(result) {
        ListenEvent::Utterance(utterance) => utterance.text.clone(),
        other => panic!("expected an utterance, got {other:?}"),
    }
}

#[tokio::test]
async fn turns_reuse_one_session_and_model_and_speech_between_waits_stays_queued() {
    let f = listen_fixture();
    let session = f.service.start("claude-code").await.unwrap();
    f.service.capture_event(&session.id, CaptureEvent::State { state: ListenState::Listening, message: None });
    assert_eq!(f.service.start("claude-code").await.unwrap().id, session.id);
    assert_eq!(f.transcriber.prepared.load(Ordering::SeqCst), 1);
    f.say(&session.id, "First question.").await;
    f.say(&session.id, "And a second thing.").await;
    let first = f.service.next(&session.id, None, 1000, None).await.unwrap();
    assert_eq!((event(&first).seq(), text(&first).as_str()), (1, "First question."));
    // A retry without advancing the cursor gets the same event again.
    let retry = f.service.next(&session.id, None, 1000, None).await.unwrap();
    assert_eq!(event(&retry).seq(), 1);
    let second = f.service.next(&session.id, Some(1), 1000, None).await.unwrap();
    assert_eq!((event(&second).seq(), text(&second).as_str()), (2, "And a second thing."));
    let starts = f.backend.commands.lock().iter().filter(|c| matches!(c, CaptureCommand::Start { .. })).count();
    assert_eq!(starts, 1);
}

#[tokio::test]
async fn timeouts_and_cancelled_waiters_keep_capture_running_and_lose_nothing() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
    let timed_out = f.service.next(&session.id, None, 10, None).await.unwrap();
    assert!(matches!(timed_out, ListenNextResult::Timeout { .. }));
    let cancel = CancellationToken::new();
    let waiting = {
        let service = f.service.clone();
        let id = session.id.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move { service.next(&id, None, 10_000, Some(cancel)).await })
    };
    tokio::task::yield_now().await;
    cancel.cancel();
    assert!(matches!(waiting.await.unwrap().unwrap(), ListenNextResult::Timeout { .. }));
    f.say(&session.id, "Are you still there?").await;
    assert!(f.service.active());
    assert!(!f.backend.commands.lock().iter().any(|c| matches!(c, CaptureCommand::Stop { .. })));
    let next = f.service.next(&session.id, None, 1000, None).await.unwrap();
    assert!(matches!(event(&next), ListenEvent::Utterance(_)));
}

#[tokio::test]
async fn a_waiter_wakes_when_the_utterance_arrives() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
    let waiting = {
        let service = f.service.clone();
        let id = session.id.clone();
        tokio::spawn(async move { service.next(&id, None, 5000, None).await })
    };
    support::until(|| f.service.status(None).unwrap().unwrap().waiters == 1, "waiter").await;
    f.say(&session.id, "Ship it.").await;
    assert_eq!(text(&waiting.await.unwrap().unwrap()), "Ship it.");
}

#[tokio::test]
async fn noise_fillers_and_delulus_own_words_never_become_turns() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
    f.say(&session.id, "").await;
    f.say(&session.id, "Um.").await;
    f.say(&session.id, "All two hundred tests pass.").await;
    assert_eq!(f.service.status(Some(&session.id)).unwrap().unwrap().queued, 0);
    assert!(!is_real_turn("Hmm, uh"));
    assert!(is_real_turn("No."));
    assert!(sounds_like_own_speech("the fix is merged", &["The fix is merged.".into()]));
}

#[tokio::test]
async fn barge_in_reports_the_response_then_the_utterance_that_interrupted_it() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
    f.barge_in(&session.id, &["rsp_1"]);
    // Even words Delulu just said count when the user deliberately interrupted.
    f.say(&session.id, "Wait, the fix is merged?").await;
    let interrupted = f.service.next(&session.id, None, 1000, None).await.unwrap();
    match event(&interrupted) {
        ListenEvent::Interrupted(event) => assert_eq!(event.response_id.as_deref(), Some("rsp_1")),
        other => panic!("{other:?}"),
    }
    let utterance = f.service.next(&session.id, Some(1), 1000, None).await.unwrap();
    match event(&utterance) {
        ListenEvent::Utterance(event) => assert_eq!(event.interrupted_response_id.as_deref(), Some("rsp_1")),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn other_clients_cannot_take_or_read_a_running_session() {
    let f = listen_fixture();
    let session = f.service.start("claude-code").await.unwrap();
    let busy = f.service.start("codex").await.unwrap_err();
    assert_eq!(busy.code, ListenErrorCode::SessionBusy);
    assert!(busy.message.contains("already listening"));
    let missing = f.service.next("lsn_other", None, 10, None).await.unwrap_err();
    assert!(missing.message.contains("does not exist"));
    f.service.stop(&session.id, "Stopped by request").unwrap();
    let second = f.service.start("codex").await.unwrap();
    assert_ne!(second.id, session.id);
}

#[tokio::test]
async fn stopping_releases_capture_and_resolves_waiters() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
    let waiting = {
        let service = f.service.clone();
        let id = session.id.clone();
        tokio::spawn(async move { service.next(&id, None, 10_000, None).await })
    };
    support::until(|| f.service.status(None).unwrap().unwrap().waiters == 1, "waiter").await;
    f.service.stop(&session.id, "Stopped by request").unwrap();
    let result = waiting.await.unwrap().unwrap();
    assert!(matches!(event(&result), ListenEvent::Stopped(_)));
    assert!(matches!(f.backend.commands.lock().last(), Some(CaptureCommand::Stop { .. })));
    assert!(!f.service.active());
    let after = f.service.next(&session.id, Some(event(&result).seq()), 1000, None).await.unwrap();
    assert!(matches!(after, ListenNextResult::Stopped { .. }));
}

#[tokio::test]
async fn dictation_pauses_and_resumes_the_microphone() {
    let f = listen_fixture();
    let session = f.service.start("agent").await.unwrap();
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
    let session = f.service.start("agent").await.unwrap();
    f.service.capture_event(
        &session.id,
        CaptureEvent::State { state: ListenState::Failed, message: Some("The microphone was disconnected.".into()) },
    );
    let result = f.service.next(&session.id, Some(1), 1000, None).await.unwrap();
    match result {
        ListenNextResult::Stopped { reason, .. } => assert_eq!(reason, "The microphone was disconnected."),
        other => panic!("{other:?}"),
    }
    assert!(!f.service.active());
}
