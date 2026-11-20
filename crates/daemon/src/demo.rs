//! `--demo`: realistic canned state, a fake engine for dictation, and a script
//! of background changes, so the UI and screenshots run against the real
//! protocol without models, a microphone or portals.
//!
//! Everything here is pure: the server owns timing and publishing.

use delulu_core::dictation::{Delivery as FsmDelivery, Effect, Input, Outcome};
use delulu_proto::api::Event;
use delulu_proto::state::*;
use std::time::Duration;

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;

/// (what Whisper heard, what cleanup made of it, language)
const SAMPLES: [(&str, &str, &str); 4] = [
    (
        "eh can you check why the the build fails on the arm runner",
        "Can you check why the build fails on the ARM runner?",
        "en",
    ),
    (
        "oké dus de daemon moet eh eerst de socket openen en dan pas de modellen laden",
        "Oké, dus de daemon moet eerst de socket openen en dan pas de modellen laden.",
        "nl",
    ),
    (
        "rename use app state to use daemon state and drop the mock file",
        "Rename useAppState to useDaemonState and drop the mock file.",
        "en",
    ),
    (
        "zet de radio iets zachter als er een agent rapport binnenkomt",
        "Zet de radio iets zachter als er een agentrapport binnenkomt.",
        "nl",
    ),
];

fn sample(job: u64) -> (&'static str, &'static str, &'static str) {
    SAMPLES[(job.saturating_sub(1) % SAMPLES.len() as u64) as usize]
}

/// Demo mode's effects: a fake engine with canned results.
pub struct DemoEffects;

impl crate::server::Effects for DemoEffects {
    fn run(&self, daemon: &crate::server::Daemon, effect: Effect) {
        DemoEffects::fake_engine(daemon, effect);
    }
    fn record(&self, outcome: Outcome, now: u64) -> (DictationOutcome, Option<HistoryEntry>) {
        record(outcome, now)
    }
}

/// The fake engine's answer to an effect, and how long it "takes".
pub fn engine_result(effect: &Effect) -> Option<(Duration, Input)> {
    match effect {
        Effect::Transcribe { job } => {
            let (raw, _, language) = sample(*job);
            Some((
                Duration::from_millis(650),
                Input::Transcribed {
                    job: *job,
                    text: raw.into(),
                    language: language.into(),
                },
            ))
        }
        Effect::Cleanup { job, .. } => Some((
            Duration::from_millis(300),
            Input::Cleaned {
                job: *job,
                text: sample(*job).1.into(),
            },
        )),
        Effect::Insert { job, .. } => Some((
            Duration::from_millis(80),
            Input::Inserted {
                job: *job,
                delivery: FsmDelivery::Typed,
            },
        )),
        Effect::StartCapture { .. } | Effect::DiscardCapture { .. } | Effect::CancelJob { .. } => {
            None
        }
    }
}

/// A speech-like microphone level for frame `n` (about 30 per second), 0..1.
pub fn level(n: u64) -> f32 {
    let t = n as f32 / 30.0;
    let syllables = (t * 9.0).sin().abs();
    let phrases = ((t * 0.9).sin() * 0.5 + 0.5).powf(0.7);
    (0.08 + 0.7 * syllables * phrases).min(1.0)
}

/// Maps the machine's outcome to the wire form; returns the history entry a
/// finished dictation adds.
pub fn record(outcome: Outcome, now: u64) -> (DictationOutcome, Option<HistoryEntry>) {
    match outcome {
        Outcome::Done {
            job,
            text,
            raw,
            delivery,
            cleanup_error,
        } => {
            let (_, _, language) = sample(job);
            let entry = HistoryEntry {
                id: format!("demo-{job}-{now}"),
                created_at: now,
                text: text.clone(),
                raw: raw.clone(),
                topic: Some("programming".into()),
                language: language.into(),
                model: "large-v3-turbo-q5_0".into(),
                audio_ms: 3_200 + job % 7 * 410,
                stt_ms: 240,
                cleanup_ms: Some(180),
                total_ms: 560,
            };
            let last = DictationOutcome::Done {
                job,
                at: now,
                text,
                raw,
                delivery: match delivery {
                    FsmDelivery::Typed => Delivery::Typed,
                    FsmDelivery::Copied { reason } => Delivery::Copied { reason },
                    FsmDelivery::Skipped => Delivery::Skipped,
                },
                cleanup_error,
                history_id: Some(entry.id.clone()),
                history_error: None,
            };
            (last, Some(entry))
        }
        Outcome::NothingHeard { job } => (DictationOutcome::NothingHeard { job, at: now }, None),
        Outcome::Cancelled { job, during } => (
            DictationOutcome::Cancelled {
                job,
                at: now,
                during: crate::server::phase(during),
            },
            None,
        ),
        Outcome::Failed {
            job,
            during,
            error,
            text,
        } => (
            DictationOutcome::Failed {
                job,
                at: now,
                during: crate::server::phase(during),
                error,
                text,
            },
            None,
        ),
    }
}

/// One second of scripted background life. Returns the events to publish.
pub fn tick(state: &mut AppState, n: u64, now: u64) -> Vec<Event> {
    let mut events = Vec::new();
    if let Some(models) = state.models.as_mut() {
        if let Some(download) = models.downloads.first_mut() {
            match download.state {
                DownloadState::Running => {
                    download.done_bytes =
                        (download.done_bytes + 48 * 1024 * 1024).min(download.total_bytes);
                    if download.done_bytes == download.total_bytes {
                        download.state = DownloadState::Done;
                        download.bytes_per_sec = None;
                        set_model_state(models, DownloadState::Done);
                        events.push(Event::Models {
                            models: models.clone(),
                        });
                    }
                    events.push(Event::Download {
                        download: models.downloads[0].clone(),
                    });
                }
                // Start over a little later, so the demo always has a download to show.
                _ if n.is_multiple_of(15) => {
                    download.state = DownloadState::Running;
                    download.done_bytes = 0;
                    download.bytes_per_sec = Some(48 * 1024 * 1024);
                    set_model_state(models, DownloadState::Running);
                    events.push(Event::Models {
                        models: models.clone(),
                    });
                }
                _ => {}
            }
        }
    }
    if let Some(radio) = state.radio.as_mut() {
        if radio.playing {
            radio.position += 1.0;
        }
        if let Some(making) = radio.making.as_mut() {
            making.progress = Some((making.progress.unwrap_or(0.0) + 0.01).min(0.99));
        }
        let ended = radio
            .now
            .as_ref()
            .is_some_and(|now| radio.position >= now.seconds);
        if ended && !radio.queue.is_empty() {
            let next = radio.queue.remove(0);
            if let Some(done) = radio.now.replace(next) {
                radio.history.insert(0, done.clone());
                radio.history.truncate(20);
                // Keep the queue going round.
                radio.queue.push(done);
            }
            radio.position = 0.0;
        }
        if ended || n.is_multiple_of(5) {
            events.push(Event::Radio {
                radio: radio.clone(),
            });
        }
    }
    if let Some(voice) = state.voice.as_mut() {
        if n.is_multiple_of(40) {
            let (agent, project, text) = REPORTS[(n / 40) as usize % REPORTS.len()];
            voice.reports.insert(
                0,
                AgentReport {
                    id: format!("report-{n}"),
                    agent: agent.into(),
                    project: Some(project.into()),
                    text: text.into(),
                    at: now,
                    spoken: true,
                },
            );
            voice.reports.truncate(20);
            events.push(Event::Voice {
                voice: voice.clone(),
            });
        }
    }
    events
}

fn set_model_state(models: &mut ModelsState, download: DownloadState) {
    let id = models.downloads[0].model_id.clone();
    if let Some(model) = models.models.iter_mut().find(|m| m.id == id) {
        model.state = match download {
            DownloadState::Done => ModelState::Ready,
            _ => ModelState::Downloading,
        };
    }
}

const REPORTS: [(&str, &str, &str); 3] = [
    (
        "Claude Code",
        "delulu-talks",
        "The daemon skeleton builds and all tests pass.",
    ),
    (
        "Codex",
        "website",
        "I fixed the broken link on the pricing page; the preview is ready.",
    ),
    (
        "Claude Code",
        "delulu-talks",
        "The radio now ducks while a report plays. Ready for review.",
    ),
];

/// The canned snapshot `--demo` starts from.
pub fn state(now: u64) -> AppState {
    let history = SAMPLES
        .iter()
        .cycle()
        .take(8)
        .enumerate()
        .map(|(i, (raw, clean, language))| HistoryEntry {
            id: format!("demo-h{i}"),
            created_at: now - (i as u64 + 1) * 37 * MIN,
            text: (*clean).into(),
            raw: Some((*raw).into()),
            topic: Some(
                if i % 2 == 0 {
                    "programming"
                } else {
                    "daemon design"
                }
                .into(),
            ),
            language: (*language).into(),
            model: "large-v3-turbo-q5_0".into(),
            audio_ms: 2_400 + i as u64 * 530,
            stt_ms: 210 + i as u64 * 9,
            cleanup_ms: Some(160 + i as u64 * 23),
            total_ms: 480 + i as u64 * 41,
        })
        .collect::<Vec<_>>();
    let song = |id: &str, title: &str, genre: &str, seconds: f64, lyrics: Option<&str>| RadioItem {
        id: id.into(),
        kind: RadioKind::Song,
        title: title.into(),
        subtitle: format!("Warm · {genre}"),
        lyrics: lyrics.map(Into::into),
        script: None,
        seconds,
        request: None,
        genre: Some(genre.into()),
        mood: Some("Warm".into()),
        surprise: false,
        feedback: None,
        saved: false,
        replay: false,
        imported: false,
    };
    let choice = |name: &str, on: bool| RadioChoice {
        name: name.into(),
        on,
        custom: false,
    };
    AppState {
        seq: 0,
        daemon: DaemonInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: delulu_proto::PROTOCOL_VERSION,
            mode: DaemonMode::Demo,
            pid: std::process::id(),
            started_at: now,
        },
        dictation: DictationState {
            phase: DictationPhase::Idle,
            available: true,
            unavailable_reason: None,
            job: 0,
            phase_since: now,
            last: None,
            stt: WorkerStatus {
                state: WorkerState::Ready,
                model: Some("large-v3-turbo-q5_0".into()),
                device: Some("Vulkan: NVIDIA GeForce RTX 4090".into()),
                error: None,
                progress: None,
            },
            cleanup: WorkerStatus {
                state: WorkerState::Ready,
                model: Some("gemma-4-e4b-it-qat-q4_0".into()),
                device: Some("Vulkan: NVIDIA GeForce RTX 4090".into()),
                error: None,
                progress: None,
            },
        },
        hotkey: HotkeyState {
            bound: true,
            trigger: Some("Super+Z".into()),
            error: None,
            problem: None,
        },
        insert: InsertState {
            ready: true,
            error: None,
        },
        settings: Some(Settings {
            version: 2,
            microphone: None,
            start_at_login: true,
            language: "auto".into(),
            languages: vec!["nl".into(), "en".into()],
            smart_context: true,
            insert: InsertMode::ShiftInsert,
            restore_clipboard: true,
            cleanup: true,
            theme: Theme::System,
            pill: true,
            sounds: false,
            show_radio: true,
            show_voice: true,
            history_days: None,
            models: RoleModels {
                stt: "large-v3-turbo-q5_0".into(),
                cleanup: Some("gemma-4-e4b-it-qat-q4_0".into()),
                tts: Some("supertonic-3".into()),
                music: Some("ace-step-1.5-turbo".into()),
                chat: None,
            },
        }),
        history: Some(HistoryPage {
            query: None,
            offset: 0,
            total: 566,
            entries: history,
        }),
        vocabulary: Some(Vocabulary {
            shelves: vec![
                Shelf {
                    id: "s1".into(),
                    name: "Code".into(),
                    enabled: true,
                    terms: ["Tauri", "WebKitGTK", "ggml", "llama.cpp", "systemd", "useAppState"]
                        .map(Into::into)
                        .to_vec(),
                },
                Shelf {
                    id: "s2".into(),
                    name: "People".into(),
                    enabled: true,
                    terms: ["Joran", "Noctis"].map(Into::into).to_vec(),
                },
                Shelf {
                    id: "s3".into(),
                    name: "Music".into(),
                    enabled: false,
                    terms: ["YuE2", "ACE-Step", "Delulu FM"].map(Into::into).to_vec(),
                },
            ],
            presets: vec![Preset {
                key: "rust".into(),
                name: "Rust".into(),
                terms: ["cargo", "clippy", "rustfmt", "tokio", "serde"]
                    .map(Into::into)
                    .to_vec(),
            }],
            active_terms: 8,
            used_terms: 8,
            suggested: vec!["delulud".into(), "Supertonic".into()],
        }),
        models: Some(ModelsState {
            models: vec![
                model("large-v3-turbo-q5_0", ModelRole::Stt, "Whisper large-v3 turbo", 574_041_195, 1_600, "MIT", ModelState::Ready, true),
                model("gemma-4-e4b-it-qat-q4_0", ModelRole::Llm, "Gemma 4 E4B (QAT)", 3_160_000_000, 2_800, "Gemma", ModelState::Ready, true),
                model("supertonic-3", ModelRole::Tts, "Supertonic 3", 265_000_000, 400, "OpenRAIL-M", ModelState::Missing, true),
                ModelInfo {
                    non_commercial: true,
                    ..model("ace-step-1.5-turbo", ModelRole::Music, "ACE-Step 1.5 Turbo (2B)", 3_671_094_952, 3_671, "MIT, Apache-2.0", ModelState::Downloading, true)
                },
            ],
            downloads: vec![Download {
                model_id: "ace-step-1.5-turbo".into(),
                state: DownloadState::Running,
                done_bytes: 1_310_000_000,
                total_bytes: 4_120_000_000,
                bytes_per_sec: Some(48 * 1024 * 1024),
                error: None,
            }],
            gpu: Some(GpuInfo {
                device: "NVIDIA GeForce RTX 4090".into(),
                total_bytes: 24 * 1024 * 1024 * 1024,
                free_bytes: 17 * 1024 * 1024 * 1024,
                used_by_app_bytes: 4_400 * 1024 * 1024,
            }),
        }),
        radio: Some(RadioState {
            available: true,
            error: None,
            on_air: true,
            playing: true,
            held: false,
            volume: 0.6,
            now: Some(song(
                "r1",
                "Socket at Midnight",
                "Soul",
                148.0,
                Some("[verse]\nThe daemon hums beneath the floor\nA socket waiting by the door\n[chorus]\nHold the key and say it twice\nDelulu makes the words come nice"),
            )),
            position: 41.0,
            queue: vec![
                song("r2", "Pearl Diver", "Lo-fi", 132.0, None),
                song("r3", "Reef Static", "House", 175.0, None),
            ],
            history: vec![song("r0", "Jar of Words", "Jazz", 121.0, None)],
            making: Some(RadioMaking {
                kind: RadioKind::Song,
                step: RadioStep::Music,
                title: Some("Tide Tables".into()),
                request: None,
                since: now - 2 * MIN,
                progress: Some(0.42),
                stage: Some("composing".into()),
            }),
            requests: vec![RadioRequest {
                id: "q1".into(),
                text: "something warm for a rainy afternoon".into(),
                created_at: now - HOUR,
                answered_by: Some("r1".into()),
            }],
            mix: RadioMix {
                genres: vec![
                    choice("Soul", true),
                    choice("Jazz", true),
                    choice("Lo-fi", true),
                    choice("Ambient", false),
                    choice("House", true),
                ],
                moods: vec![choice("Warm", true), choice("Calm", false)],
                surprise: 15,
                vocals: "any".into(),
                energy: "any".into(),
                language: "English".into(),
                length_min_seconds: 120,
                length_max_seconds: 270,
                host: "sometimes".into(),
                theme: "late-night coding".into(),
            },
            stations: vec![RadioStation {
                id: "groove".into(),
                name: "Groove".into(),
                builtin: true,
                active: false,
            }],
            saved: Vec::new(),
            readiness: Some(RadioReadiness {
                music_engine: true,
                music_model: true,
                gpu: true,
                writer: true,
                voice: true,
                device: Some("Vulkan: NVIDIA GeForce RTX 4090".into()),
            }),
        }),
        voice: Some(VoiceState {
            available: true,
            tts: WorkerStatus {
                state: WorkerState::Off,
                model: Some("supertonic-3".into()),
                device: None,
                error: None,
                progress: None,
            },
            conversation: Conversation {
                phase: ConversationPhase::Closed,
                brain: None,
                voice: None,
                language: None,
                turns: Vec::new(),
            },
            reports: vec![AgentReport {
                id: "report-0".into(),
                agent: "Claude Code".into(),
                project: Some("delulu-talks".into()),
                text: "Wave A is merged; the release notes are drafted.".into(),
                at: now - 12 * MIN,
                spoken: true,
            }],
            muted_agents: Vec::new(),
            reports_enabled: true,
            reports_interrupt_radio: true,
        }),
        setup: Some(Setup {
            first_run_done: true,
            cleanup_model_ok: true,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
fn model(
    id: &str,
    role: ModelRole,
    label: &str,
    bytes: u64,
    vram_mb: u32,
    license: &str,
    state: ModelState,
    active: bool,
) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        role,
        label: label.into(),
        bytes,
        vram_mb,
        license: license.into(),
        non_commercial: false,
        languages: vec!["nl".into(), "en".into()],
        state,
        active,
    }
}
