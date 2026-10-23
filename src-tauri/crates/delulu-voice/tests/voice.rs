//! Port of `electron/services/voice.test.ts`.

mod support;

use std::time::Duration;

use delulu_core::RecordingSink;
use delulu_domain::voice::{VoiceEngineId, VoiceSource, VoiceSpeakRequest, VoiceUtteranceOutcome};
use delulu_domain::{AppSettings, EnginePhase};
use delulu_voice::voice_agent_setup;
use support::{until, voice_fixture};

fn request(text: &str) -> VoiceSpeakRequest {
    VoiceSpeakRequest { text: text.into(), source: None, agent: None, interrupt: None, normalize: None, response_id: None }
}

fn defaults() -> AppSettings {
    AppSettings::default()
}

#[tokio::test]
async fn speaks_every_chunk_in_order_and_reports_measured_timestamps() {
    let f = voice_fixture(|s| s.voice_engine = VoiceEngineId::Kokoro, 1_000.0, true, true);
    f.service.initialize(&defaults()).await;
    let text = [
        "Done.",
        "All of the tests pass and the cache path fix is merged into main now.",
        "The release notes still need a line about speech models.",
        "Want me to write that line and open the pull request for you right away?",
    ]
    .join(" ");
    let result = f.service.speak(request(&format!("{text} [laugh]"))).await.unwrap();
    assert_eq!(result.outcome, VoiceUtteranceOutcome::Spoken);
    let synthesized = f.worker.synthesized.lock().len();
    assert!(synthesized > 1);
    // The first sentence is synthesized on its own so audio starts right away.
    assert_eq!(f.worker.synthesized.lock()[0]["parts"], serde_json::json!([{ "kind": "text", "text": "Done." }]));
    let played: Vec<u32> = f.playback.played.lock().iter().map(|chunk| chunk.chunk).collect();
    assert_eq!(played, (0..synthesized as u32).collect::<Vec<_>>());
    assert!(f.playback.played.lock().last().unwrap().last);
    assert_eq!(result.timestamps[0].start_ms, 0.0);
    for pair in result.timestamps.windows(2) {
        assert_eq!(pair[1].start_ms, pair[0].end_ms);
    }
    assert_eq!(result.duration_ms, synthesized as f64 * 1_000.0);
    assert_eq!(result.unsupported, vec!["laugh".to_owned()]);
    let recent = &f.service.get_status().recent[0];
    assert_eq!((recent.id.as_str(), recent.outcome, recent.source), (result.id.as_str(), VoiceUtteranceOutcome::Spoken, VoiceSource::App));
}

#[tokio::test]
async fn passes_the_voice_speed_and_clone_reference_to_the_worker() {
    let f = voice_fixture(
        |s| {
            s.voice_engine = VoiceEngineId::ChatterboxTurbo;
            s.voice_clone = "clip.wav".into();
            s.voice_speed = 1.2;
        },
        1_000.0,
        true,
        true,
    );
    f.service.initialize(&defaults()).await;
    f.service.speak(request("<whisper>Between us.</whisper>")).await.unwrap();
    let first = f.worker.synthesized.lock()[0].clone();
    assert_eq!(first["engine"], "chatterbox-turbo");
    assert_eq!(first["speed"], 1.2);
    assert_eq!(first["styles"], serde_json::json!(["whisper"]));
    assert!(first["reference"].as_str().unwrap().ends_with(&format!("references{}clip.wav", std::path::MAIN_SEPARATOR)));
}

#[tokio::test]
async fn stop_ends_the_current_utterance_and_everything_queued() {
    let f = voice_fixture(|_| {}, 1_000.0, false, true);
    f.service.initialize(&defaults()).await;
    let first = f.service.enqueue(request("First message to speak.")).unwrap();
    let second = f.service.enqueue(request("Second message to speak.")).unwrap();
    assert_eq!(second.queued.position, 1);
    until(|| f.service.get_status().current.is_some(), "speech start").await;
    f.service.stop("user");
    let (a, b) = tokio::join!(first.done(), second.done());
    assert_eq!(a.outcome, VoiceUtteranceOutcome::Stopped);
    assert_eq!(b.outcome, VoiceUtteranceOutcome::Stopped);
    assert!(f.playback.stops.lock().contains(&None));
    until(|| f.service.get_status().current.is_none(), "idle").await;
    assert!(!f.service.is_speaking());
}

#[tokio::test]
async fn interrupting_replaces_what_is_being_said() {
    let f = voice_fixture(|_| {}, 1_000.0, false, true);
    f.service.initialize(&defaults()).await;
    let first = f.service.enqueue(request("A long status update.")).unwrap();
    until(|| f.service.get_status().current.is_some(), "speech start").await;
    let second = f.service.enqueue(VoiceSpeakRequest { interrupt: Some(true), ..request("Urgent.") }).unwrap();
    assert_eq!(first.done().await.outcome, VoiceUtteranceOutcome::Stopped);
    let id = second.queued.id.clone();
    until(|| f.service.get_status().current.is_some_and(|current| current.id == id), "interrupting utterance").await;
    f.service.stop("user");
    assert_eq!(second.done().await.outcome, VoiceUtteranceOutcome::Stopped);
}

#[tokio::test]
async fn dictation_interrupts_speech_only_when_that_setting_is_on() {
    let on = voice_fixture(|_| {}, 1_000.0, false, true);
    on.service.initialize(&defaults()).await;
    let spoken = on.service.enqueue(request("Hello there.")).unwrap();
    until(|| on.service.is_speaking(), "speaking").await;
    on.service.interrupt_for_dictation();
    assert_eq!(spoken.done().await.outcome, VoiceUtteranceOutcome::Stopped);

    let off = voice_fixture(|s| s.voice_interrupt_on_dictation = false, 1_000.0, false, true);
    off.service.initialize(&defaults()).await;
    let kept = off.service.enqueue(request("Hello there.")).unwrap();
    until(|| off.service.is_speaking(), "speaking").await;
    off.service.interrupt_for_dictation();
    tokio::task::yield_now().await;
    assert!(off.service.is_speaking());
    off.service.stop("user");
    assert_eq!(kept.done().await.outcome, VoiceUtteranceOutcome::Stopped);
}

#[tokio::test]
async fn agents_cannot_speak_while_voice_is_turned_off_but_the_app_can() {
    let f = voice_fixture(|s| s.voice_enabled = false, 1_000.0, true, true);
    f.service.initialize(&defaults()).await;
    let refused = f.service.enqueue(VoiceSpeakRequest { source: Some(VoiceSource::Agent), ..request("Hi") });
    assert!(refused.err().unwrap().message.contains("turned off"));
    let spoken = f.service.speak(VoiceSpeakRequest { source: Some(VoiceSource::App), ..request("Hi") }).await.unwrap();
    assert_eq!(spoken.outcome, VoiceUtteranceOutcome::Spoken);
}

#[tokio::test]
async fn rejects_empty_oversized_and_overflowing_requests() {
    let f = voice_fixture(|_| {}, 1_000.0, false, true);
    f.service.initialize(&defaults()).await;
    let empty = f.service.enqueue(request("[pause] <whisper></whisper>")).err().unwrap();
    assert!(empty.message.contains("nothing to say"), "{}", empty.message);
    let long = f.service.enqueue(request(&"a".repeat(15_001))).err().unwrap();
    assert!(long.message.contains("limited"));
    let queued: Vec<_> = (0..21).map(|index| f.service.enqueue(request(&format!("Message {index}."))).unwrap()).collect();
    until(|| f.service.get_status().current.is_some(), "speech start").await;
    let full = f.service.enqueue(request("One too many.")).err().unwrap();
    assert!(full.message.contains("already waiting"));
    f.service.stop("user");
    for item in queued {
        item.done().await;
    }
}

#[tokio::test]
async fn silent_playback_cannot_stall_the_queue() {
    let f = voice_fixture(|_| {}, 10.0, false, true);
    f.service.initialize(&defaults()).await;
    let pending = f.service.enqueue(request("Nobody is listening.")).unwrap();
    until(|| !f.playback.played.lock().is_empty(), "first chunk").await;
    f.service.playback_lost();
    assert_eq!(pending.done().await.outcome, VoiceUtteranceOutcome::Spoken);
}

#[tokio::test(start_paused = true)]
async fn the_grace_timer_finishes_chunks_playback_never_reports() {
    let f = voice_fixture(|_| {}, 10.0, false, true);
    f.service.initialize(&defaults()).await;
    let pending = f.service.enqueue(request("Nobody is listening.")).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), pending.done()).await.unwrap();
    assert_eq!(result.outcome, VoiceUtteranceOutcome::Spoken);
}

#[tokio::test]
async fn setup_is_required_before_speaking() {
    let f = voice_fixture(|_| {}, 1_000.0, true, false);
    f.service.initialize(&defaults()).await;
    assert_eq!(f.service.get_status().engine, EnginePhase::Missing);
    assert!(f.service.enqueue(request("Hello")).err().unwrap().message.contains("Set up"));
}

#[tokio::test]
async fn an_interrupted_response_never_resumes_and_the_next_one_can_be_interrupted() {
    let f = voice_fixture(|_| {}, 1_000.0, false, true);
    f.service.initialize(&defaults()).await;
    let first = f
        .service
        .enqueue(VoiceSpeakRequest {
            response_id: Some("rsp_a".into()),
            ..request("One. Two sentences that go on for a while. Three more words here.")
        })
        .unwrap();
    let first_id = first.queued.id.clone();
    until(|| !f.playback.played.lock().is_empty(), "first chunk").await;
    assert_eq!(f.service.interrupt(), vec!["rsp_a".to_owned()]);
    let result = first.done().await;
    assert_eq!((result.outcome, result.response_id.as_str()), (VoiceUtteranceOutcome::Interrupted, "rsp_a"));
    let sent = f.playback.played.lock().len();
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Synthesis that finished after the interruption is never sent to playback.
    assert_eq!(f.playback.played.lock().iter().filter(|chunk| chunk.utterance_id == first_id).count(), sent);
    let second = f
        .service
        .enqueue(VoiceSpeakRequest { response_id: Some("rsp_b".into()), ..request("Okay, go ahead.") })
        .unwrap();
    let second_id = second.queued.id.clone();
    until(|| f.playback.played.lock().iter().any(|chunk| chunk.utterance_id == second_id), "second response").await;
    assert_eq!(f.service.interrupt(), vec!["rsp_b".to_owned()]);
    assert_eq!(second.done().await.outcome, VoiceUtteranceOutcome::Interrupted);
}

#[tokio::test]
async fn reference_clips_are_copied_selected_and_removed() {
    let f = voice_fixture(|_| {}, 1_000.0, true, true);
    let source = f.dir.path().join("me.WAV");
    std::fs::write(&source, b"RIFF").unwrap();
    let saved = f.service.choose_reference(&source).await.unwrap();
    assert!(saved.voice_clone.ends_with(".wav"));
    let copy = f.dir.path().join("voice").join("references").join(&saved.voice_clone);
    assert!(copy.exists());
    let replaced = f.service.choose_reference(&source).await.unwrap();
    assert!(!copy.exists(), "the previous clip is removed");
    let removed = f.service.remove_reference().await.unwrap();
    assert_eq!(removed.voice_clone, "");
    assert!(!f.dir.path().join("voice").join("references").join(replaced.voice_clone).exists());
    std::fs::write(f.dir.path().join("notes.txt"), b"x").unwrap();
    assert!(f.service.choose_reference(&f.dir.path().join("notes.txt")).await.is_err());
}

#[tokio::test]
async fn status_changes_reach_listeners() {
    let f = voice_fixture(|_| {}, 1_000.0, true, true);
    let sink = RecordingSink::new();
    let recorder = sink.clone();
    f.service.on_status(move |status| delulu_core::emit(recorder.as_ref(), "voice:statusChanged", status));
    f.service.initialize(&defaults()).await;
    f.service.speak(request("Hello.")).await.unwrap();
    let events = sink.channel("voice:statusChanged");
    assert!(events.iter().any(|status| status["phase"] == "speaking"));
    assert_eq!(events.last().unwrap()["recent"][0]["outcome"], "spoken");
}

#[test]
fn agent_setup_runs_the_app_with_the_mcp_subcommand() {
    let setup = voice_agent_setup(std::path::Path::new("/opt/Delulu Talks/delulu-talks"), false);
    assert_eq!(setup.command, vec!["/opt/Delulu Talks/delulu-talks".to_owned(), "mcp".to_owned()]);
    assert!(!setup.node_found);
    assert_eq!(setup.claude_code, "claude mcp add --scope user delulu-voice -- '/opt/Delulu Talks/delulu-talks' mcp");
    assert_eq!(setup.codex, "codex mcp add delulu-voice -- '/opt/Delulu Talks/delulu-talks' mcp");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&setup.json).unwrap(),
        serde_json::json!({ "mcpServers": { "delulu-voice": { "command": "/opt/Delulu Talks/delulu-talks", "args": ["mcp"] } } })
    );
    assert_eq!(setup.shell, "'/opt/Delulu Talks/delulu-talks' mcp say 'Done, all tests pass.'");
    let appimage = voice_agent_setup(std::path::Path::new("/home/me/Apps/Delulu-Talks.AppImage"), false);
    assert_eq!(appimage.claude_code, "claude mcp add --scope user delulu-voice -- /home/me/Apps/Delulu-Talks.AppImage mcp");
    let windows = voice_agent_setup(std::path::Path::new(r"C:\Program Files\Delulu Talks\Delulu Talks.exe"), true);
    assert_eq!(
        windows.claude_code,
        r#"claude mcp add --scope user delulu-voice -- "C:\Program Files\Delulu Talks\Delulu Talks.exe" mcp"#
    );
    assert_eq!(windows.shell, r#"& "C:\Program Files\Delulu Talks\Delulu Talks.exe" mcp say "Done, all tests pass.""#);
}

#[test]
fn the_legacy_script_is_installed_only_when_it_changed() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.mjs");
    std::fs::write(&source, "console.log(1)\n").unwrap();
    let voice = root.path().join("voice");
    let target = delulu_voice::install_voice_agent_script(&voice, &source).unwrap();
    assert_eq!(target, voice.join("delulu-voice-mcp.mjs"));
    let modified = std::fs::metadata(&target).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    delulu_voice::install_voice_agent_script(&voice, &source).unwrap();
    assert_eq!(std::fs::metadata(&target).unwrap().modified().unwrap(), modified);
    std::fs::write(&source, "console.log(2)\n").unwrap();
    delulu_voice::install_voice_agent_script(&voice, &source).unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "console.log(2)\n");
}
