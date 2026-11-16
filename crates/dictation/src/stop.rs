//! The dictation stop path: from the recorded clip to text in the focused window
//! and an entry in History.
//!
//! [`run_stop`] holds the rules; [`StopPorts`] is everything it needs from the
//! process that runs it (recorder, speech engine, cleanup, store, inserter), so it
//! runs in tests without audio, a GPU or a desktop.
use crate::cleanup;
use delulu_desktop::insert::{InsertOutcome, Inserter, PasteKey};
use delulu_store::{HistoryEntry, InsertMode, NewEntry, Settings};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InsertResult {
    Pasted,
    Copied { reason: Option<String> },
    Failed { reason: String },
}
#[derive(Clone, Serialize)]
pub struct TranscriptEvent {
    pub entry: HistoryEntry,
    pub insert: InsertResult,
}
pub fn paste_key(mode: InsertMode) -> Option<PasteKey> {
    match mode {
        InsertMode::ShiftInsert => Some(PasteKey::ShiftInsert),
        InsertMode::CtrlV => Some(PasteKey::CtrlV),
        InsertMode::CtrlShiftV => Some(PasteKey::CtrlShiftV),
        InsertMode::Off => None,
    }
}
pub async fn deliver(
    inserter: &Inserter,
    text: &str,
    mode: InsertMode,
    held: bool,
    no_portals: bool,
) -> InsertResult {
    if held || no_portals || mode == InsertMode::Off {
        return match inserter.copy(text) {
            Ok(()) => InsertResult::Copied {
                reason: if no_portals {
                    Some("Portals disabled for unattended tests".into())
                } else {
                    held.then(|| "Hotkey still held".into())
                },
            },
            Err(e) => InsertResult::Failed {
                reason: e.to_string(),
            },
        };
    }
    match inserter
        .insert(text, paste_key(mode).expect("non-off mode"))
        .await
    {
        Ok(InsertOutcome::Pasted) => InsertResult::Pasted,
        Ok(InsertOutcome::CopiedOnly { reason }) => InsertResult::Copied {
            reason: Some(reason),
        },
        Err(e) => InsertResult::Failed {
            reason: e.to_string(),
        },
    }
}
pub async fn wait_release(mut down: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while down() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

/// `DELULU_LOG_TEXT=1` puts dictated text in the log, for debugging only. By default
/// the log (which ends up in the journal) never holds what the user said.
pub fn log_text() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| text_logging(std::env::var("DELULU_LOG_TEXT").ok().as_deref()))
}
fn text_logging(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Everything the stop path decides with, captured when the hotkey stopped recording.
pub struct StopRequest {
    pub started: Instant,
    /// The hotkey was still down when recording stopped (toggle press).
    pub was_held: bool,
    pub log_text: bool,
}

/// How a dictation ended. The caller turns it into the pill, the phase and the event.
pub enum StopOutcome {
    /// The pill word and the status message; the phase becomes "error".
    Failed {
        word: &'static str,
        message: String,
    },
    NothingHeard,
    Delivered(TranscriptEvent),
    /// The text was delivered, but History could not save it; the phase becomes "error".
    Unsaved {
        insert: InsertResult,
        message: String,
    },
}

/// The recorded samples, or the pill word and message for a recorder failure.
pub type Recorded = Result<Vec<f32>, (&'static str, String)>;

/// What the stop path needs from the app. The app implements it over its Tauri state;
/// tests use a fake, so the path runs without audio, a GPU or a desktop.
// The callers name their concrete ports type, so the futures' auto traits are known.
#[allow(async_fn_in_trait)]
pub trait StopPorts {
    async fn stop_recording(&self) -> Recorded;
    /// Read after the recorder stopped, so a change saved meanwhile applies.
    fn settings(&self) -> Settings;
    fn whisper_prompt(&self) -> Option<delulu_stt::Prompt>;
    async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: delulu_stt::Language,
        prompt: Option<delulu_stt::Prompt>,
    ) -> Result<delulu_stt::Transcript, String>;
    async fn clean(&self, language: &str, raw: String) -> cleanup::Cleaned;
    fn remember(&self, topic: Option<String>, text: &str);
    fn add_history(&self, entry: NewEntry) -> Result<HistoryEntry, String>;
    /// True once the hotkey is up, false if it stayed down too long.
    async fn wait_release(&self) -> bool;
    async fn deliver(&self, text: &str, mode: InsertMode, held: bool) -> InsertResult;
    /// When the hotkey went up after recording stopped, if it did.
    fn last_release(&self) -> Option<Instant>;
    fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, String>;
    fn log(&self, line: String);
}

pub async fn run_stop(ports: &impl StopPorts, req: StopRequest) -> StopOutcome {
    let samples = match ports.stop_recording().await {
        Ok(samples) => samples,
        Err((word, message)) => return StopOutcome::Failed { word, message },
    };
    let settings = ports.settings();
    let transcript = match transcribe_clip(ports, &settings, samples).await {
        Ok(t) => t,
        Err(message) => {
            return StopOutcome::Failed {
                word: "Not transcribed",
                message,
            }
        }
    };
    if transcript.text.is_empty() {
        return StopOutcome::NothingHeard;
    }
    let cleaned = clean_transcript(ports, &settings, &transcript).await;
    deliver_and_save(ports, settings, &req, &transcript, cleaned).await
}

// The three stages of `run_stop`. The daemon runs them one at a time, as the
// dictation state machine asks for each, with the settings read once after the
// recording stopped.

/// The clip to a transcript: the language rules and, with smart context, the
/// Whisper prompt from the last dictation, which the engine fits to the clip's
/// language. An empty text means nothing was heard.
pub async fn transcribe_clip(
    ports: &impl StopPorts,
    settings: &Settings,
    samples: Vec<f32>,
) -> Result<delulu_stt::Transcript, String> {
    let prompt = if settings.smart_context {
        ports.whisper_prompt()
    } else {
        None
    };
    ports
        .transcribe(
            samples,
            delulu_stt::Language::from_setting(&settings.language, &settings.allowed_languages),
            prompt,
        )
        .await
}

/// Cleanup (which falls back to the raw text by itself), then, with smart
/// context, remember what this dictation was about for the next one.
pub async fn clean_transcript(
    ports: &impl StopPorts,
    settings: &Settings,
    transcript: &delulu_stt::Transcript,
) -> cleanup::Cleaned {
    let cleaned = ports
        .clean(&transcript.language, transcript.text.clone())
        .await;
    if settings.smart_context {
        ports.remember(cleaned.topic.clone(), &cleaned.text);
    }
    cleaned
}

/// Save to History, wait for the hotkey to come up, deliver the text, record the
/// delivery timing and log the dictation line (with text only when opted in).
pub async fn deliver_and_save(
    ports: &impl StopPorts,
    settings: Settings,
    req: &StopRequest,
    transcript: &delulu_stt::Transcript,
    cleaned: cleanup::Cleaned,
) -> StopOutcome {
    let start = req.started;
    let text = cleaned.text.clone();
    let entry = ports.add_history(NewEntry {
        text: cleaned.text,
        raw: cleaned.raw,
        cleanup_ms: cleaned.cleanup_ms,
        topic: cleaned.topic,
        language: transcript.language.clone(),
        model: settings.model,
        audio_ms: transcript.audio_ms,
        stt_ms: transcript.elapsed_ms,
        total_ms: start.elapsed().as_millis() as u64,
    });
    // Deliver even when History can't save it: the text must not be lost.
    let released = ports.wait_release().await;
    let delivery_start = Instant::now();
    let insert = ports.deliver(&text, settings.insert, !released).await;
    let entry = match entry {
        Ok(entry) => entry,
        Err(e) => {
            return StopOutcome::Unsaved {
                insert,
                message: format!("Not saved to History: {e}"),
            };
        }
    };
    let total = total_ms(start, req.was_held, ports.last_release(), Instant::now());
    let entry = match ports.set_total_ms(&entry.id, total) {
        Ok(updated) => updated,
        Err(e) => {
            ports.log(format!("save delivery timing: {e}"));
            entry
        }
    };
    let mut line = format!(
        "dictation audio={}ms stt={}ms cleanup={}ms insert={}ms total={}ms lang={} model={} topic={} delivery={} chars={} raw_chars={} history={}",
        transcript.audio_ms,
        transcript.elapsed_ms,
        entry.cleanup_ms.map_or("-".into(), |ms| ms.to_string()),
        delivery_start.elapsed().as_millis(),
        start.elapsed().as_millis(),
        transcript.language,
        entry.model,
        entry.topic.as_deref().unwrap_or("-"),
        insert_kind(&insert),
        entry.text.chars().count(),
        entry.raw.as_ref().map_or("-".into(), |r| r.chars().count().to_string()),
        entry.id
    );
    if req.log_text {
        line.push_str(&format!(" transcript={:?} raw={:?}", entry.text, entry.raw));
    }
    ports.log(line);
    StopOutcome::Delivered(TranscriptEvent { entry, insert })
}

fn insert_kind(insert: &InsertResult) -> &'static str {
    match insert {
        InsertResult::Pasted => "pasted",
        InsertResult::Copied { .. } => "copied",
        InsertResult::Failed { .. } => "failed",
    }
}

/// Milliseconds from the moment the user finished to `now`. After a toggle press the
/// user finishes when they let go of the key, not when recording stopped.
pub fn total_ms(
    start: Instant,
    was_held: bool,
    last_release: Option<Instant>,
    now: Instant,
) -> u64 {
    let from = if was_held {
        last_release.unwrap_or(start)
    } else {
        start
    };
    now.saturating_duration_since(from).as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::{choose, CleanResult};
    use std::cell::{Cell, RefCell};

    const RAW: &str = "eh so the secret plan is ready";
    const CLEAN: &str = "So the secret plan is ready.";

    /// A scripted app: answers from the fields, records what the stop path did.
    struct Fake {
        recording: RefCell<Option<Recorded>>,
        transcript: RefCell<Option<Result<delulu_stt::Transcript, String>>>,
        cleanup: Cell<Option<CleanResult>>,
        history_error: Option<String>,
        released: bool,
        last_release: Option<Instant>,
        history: RefCell<Vec<HistoryEntry>>,
        delivered: RefCell<Vec<(String, bool)>>,
        remembered: RefCell<Vec<(Option<String>, String)>>,
        logs: RefCell<Vec<String>>,
    }

    fn fake(text: &str) -> Fake {
        Fake {
            recording: RefCell::new(Some(Ok(vec![0.0; 16]))),
            transcript: RefCell::new(Some(Ok(delulu_stt::Transcript {
                text: text.into(),
                language: "en".into(),
                audio_ms: 2400,
                elapsed_ms: 180,
            }))),
            cleanup: Cell::new(Some(CleanResult::Done(Some(delulu_cleanup::Cleaned {
                text: CLEAN.into(),
                topic: Some("work".into()),
            })))),
            history_error: None,
            released: true,
            last_release: None,
            history: RefCell::default(),
            delivered: RefCell::default(),
            remembered: RefCell::default(),
            logs: RefCell::default(),
        }
    }

    fn request() -> StopRequest {
        StopRequest {
            started: Instant::now(),
            was_held: false,
            log_text: false,
        }
    }

    impl StopPorts for Fake {
        async fn stop_recording(&self) -> Recorded {
            self.recording.take().expect("recorder stopped once")
        }
        fn settings(&self) -> Settings {
            Settings::default()
        }
        fn whisper_prompt(&self) -> Option<delulu_stt::Prompt> {
            None
        }
        async fn transcribe(
            &self,
            _: Vec<f32>,
            _: delulu_stt::Language,
            _: Option<delulu_stt::Prompt>,
        ) -> Result<delulu_stt::Transcript, String> {
            self.transcript.take().expect("transcribed once")
        }
        async fn clean(&self, _: &str, raw: String) -> cleanup::Cleaned {
            choose(raw, self.cleanup.take().expect("cleaned once"), 900)
        }
        fn remember(&self, topic: Option<String>, text: &str) {
            self.remembered.borrow_mut().push((topic, text.into()));
        }
        fn add_history(&self, e: NewEntry) -> Result<HistoryEntry, String> {
            if let Some(error) = &self.history_error {
                return Err(error.clone());
            }
            let entry = HistoryEntry {
                id: "h1".into(),
                created_at: 0,
                text: e.text,
                language: e.language,
                model: e.model,
                audio_ms: e.audio_ms,
                stt_ms: e.stt_ms,
                total_ms: e.total_ms,
                raw: e.raw,
                cleanup_ms: e.cleanup_ms,
                topic: e.topic,
            };
            self.history.borrow_mut().push(entry.clone());
            Ok(entry)
        }
        async fn wait_release(&self) -> bool {
            self.released
        }
        async fn deliver(&self, text: &str, _: InsertMode, held: bool) -> InsertResult {
            self.delivered.borrow_mut().push((text.into(), held));
            if held {
                InsertResult::Copied {
                    reason: Some("Hotkey still held".into()),
                }
            } else {
                InsertResult::Pasted
            }
        }
        fn last_release(&self) -> Option<Instant> {
            self.last_release
        }
        fn set_total_ms(&self, id: &str, total_ms: u64) -> Result<HistoryEntry, String> {
            let mut history = self.history.borrow_mut();
            let entry = history.iter_mut().find(|e| e.id == id).ok_or("missing")?;
            entry.total_ms = total_ms;
            Ok(entry.clone())
        }
        fn log(&self, line: String) {
            self.logs.borrow_mut().push(line);
        }
    }

    fn delivered(outcome: StopOutcome) -> TranscriptEvent {
        match outcome {
            StopOutcome::Delivered(event) => event,
            StopOutcome::NothingHeard => panic!("expected a delivery, got Nothing heard"),
            StopOutcome::Failed { word, message } => {
                panic!("expected a delivery, got {word}: {message}")
            }
            StopOutcome::Unsaved { message, .. } => panic!("expected a delivery, got {message}"),
        }
    }

    #[tokio::test]
    async fn released_hotkey_types_the_cleaned_text_and_keeps_the_raw() {
        let app = fake(RAW);
        let event = delivered(run_stop(&app, request()).await);
        assert!(matches!(event.insert, InsertResult::Pasted));
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), false)]);
        let stored = &app.history.borrow()[0];
        assert_eq!(
            (stored.text.as_str(), stored.raw.as_deref()),
            (CLEAN, Some(RAW))
        );
        assert_eq!((stored.audio_ms, stored.stt_ms), (2400, 180));
        assert_eq!(event.entry.text, CLEAN);
        assert_eq!(
            *app.remembered.borrow(),
            [(Some("work".to_string()), CLEAN.to_string())]
        );
    }

    #[tokio::test]
    async fn hotkey_still_held_copies_and_counts_from_release() {
        let mut app = fake(RAW);
        app.released = false;
        let started = Instant::now() - Duration::from_secs(2);
        app.last_release = Some(started + Duration::from_millis(1500));
        let req = StopRequest {
            started,
            was_held: true,
            ..request()
        };
        let event = delivered(run_stop(&app, req).await);
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), true)]);
        assert!(matches!(event.insert, InsertResult::Copied { .. }));
        // From the release 0.5 s ago, not from the stop 2 s ago.
        let total = app.history.borrow()[0].total_ms;
        assert!((500..1500).contains(&total), "total {total} ms");
        assert_eq!(event.entry.total_ms, total);
    }

    #[tokio::test]
    async fn empty_transcript_is_nothing_heard() {
        let app = fake("");
        assert!(matches!(
            run_stop(&app, request()).await,
            StopOutcome::NothingHeard
        ));
        assert!(app.history.borrow().is_empty());
        assert!(app.delivered.borrow().is_empty());
    }

    #[tokio::test]
    async fn failures_end_in_error_without_typing() {
        let recorder = fake(RAW);
        recorder.recording.replace(Some(Err((
            "No microphone",
            "microphone not found: usb".into(),
        ))));
        let engine = fake(RAW);
        engine
            .transcript
            .replace(Some(Err("inference: out of memory".into())));
        for (app, want_word, want_message) in [
            (recorder, "No microphone", "microphone not found: usb"),
            (engine, "Not transcribed", "inference: out of memory"),
        ] {
            match run_stop(&app, request()).await {
                StopOutcome::Failed { word, message } => {
                    assert_eq!((word, message.as_str()), (want_word, want_message))
                }
                _ => panic!("{want_word}: expected a failure"),
            }
            assert!(app.delivered.borrow().is_empty(), "{want_word}");
            assert!(app.history.borrow().is_empty(), "{want_word}");
        }
    }

    #[tokio::test]
    async fn history_save_failure_still_types_the_text() {
        let mut app = fake(RAW);
        app.history_error = Some("store: disk full".into());
        match run_stop(&app, request()).await {
            StopOutcome::Unsaved { insert, message } => {
                assert!(matches!(insert, InsertResult::Pasted));
                assert_eq!(message, "Not saved to History: store: disk full");
            }
            _ => panic!("expected the text delivered and the save failure reported"),
        }
        assert_eq!(*app.delivered.borrow(), [(CLEAN.to_string(), false)]);
    }

    #[tokio::test]
    async fn cleanup_failure_types_the_raw_text() {
        let app = fake(RAW);
        app.cleanup.set(Some(CleanResult::Failed));
        let event = delivered(run_stop(&app, request()).await);
        assert_eq!(*app.delivered.borrow(), [(RAW.to_string(), false)]);
        assert_eq!(
            (event.entry.text.as_str(), event.entry.raw.as_deref()),
            (RAW, None)
        );
    }

    #[tokio::test]
    async fn log_holds_dictated_text_only_when_opted_in() {
        let app = fake(RAW);
        delivered(run_stop(&app, request()).await);
        let logs = app.logs.take();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("audio=2400ms stt=180ms"), "{}", logs[0]);
        for text in [RAW, CLEAN, "secret"] {
            assert!(!logs[0].contains(text), "leaked {text:?}: {}", logs[0]);
        }

        let app = fake(RAW);
        let req = StopRequest {
            log_text: true,
            ..request()
        };
        delivered(run_stop(&app, req).await);
        let logs = app.logs.take();
        assert!(
            logs[0].contains(RAW) && logs[0].contains(CLEAN),
            "{}",
            logs[0]
        );

        assert!(text_logging(Some("1")));
        assert!(!text_logging(None) && !text_logging(Some("0")));
    }

    #[test]
    fn total_counts_from_release_only_after_a_toggle() {
        let start = Instant::now();
        let at = |ms| start + Duration::from_millis(ms);
        let release = Some(at(300));
        assert_eq!(total_ms(start, false, release, at(1000)), 1000);
        assert_eq!(total_ms(start, true, release, at(1000)), 700);
        assert_eq!(total_ms(start, true, None, at(1000)), 1000);
        // A release stamped after `now` never underflows.
        assert_eq!(total_ms(start, true, Some(at(2000)), at(1000)), 0);
    }

    #[tokio::test]
    async fn waits_for_release_and_times_out() {
        let mut polls = 0;
        assert!(
            wait_release(
                || {
                    polls += 1;
                    polls < 3
                },
                Duration::from_millis(100)
            )
            .await
        );
        assert!(!wait_release(|| true, Duration::from_millis(15)).await);
        assert!(wait_release(|| false, Duration::ZERO).await);
    }
}
