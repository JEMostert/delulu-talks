//! The dictation state machine.
//!
//! ```text
//!          start             stop                text           cleaned / failed
//!  Idle ──────────▶ Recording ─────▶ Transcribing ─────▶ Cleaning ─────────────▶ Inserting ──▶ Idle
//!   ▲                  │                 │  │ empty          (cleanup off: Transcribing ──▶ Inserting)
//!   └── cancel / failure from any busy phase; empty transcript ─────────────────────────────────┘
//! ```
//!
//! The machine never performs work. [`Dictation::handle`] returns the effects the
//! caller must carry out (start the microphone, send audio to the speech engine,
//! insert text, …). Every dictation gets a fresh [`JobId`]; results for any other
//! job are stale and ignored, which is what makes cancel safe while an engine is
//! still busy with the cancelled work.
//!
//! Failure rules: a capture, transcription or insertion failure ends the
//! dictation with [`Outcome::Failed`]. A cleanup failure is not fatal: the raw
//! transcript is inserted instead, and the outcome records the cleanup error.

use crate::gesture::{Command, Gesture, KeyEvent};

pub type JobId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Phase {
    #[default]
    Idle,
    Recording,
    Transcribing,
    Cleaning,
    Inserting,
}

impl Phase {
    pub const ALL: [Phase; 5] = [
        Phase::Idle,
        Phase::Recording,
        Phase::Transcribing,
        Phase::Cleaning,
        Phase::Inserting,
    ];
    /// Busy phases ignore new start requests; the hotkey is only tracked.
    pub fn is_busy(self) -> bool {
        matches!(
            self,
            Phase::Transcribing | Phase::Cleaning | Phase::Inserting
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Config {
    /// Run the transcript through the cleanup model before inserting it.
    pub cleanup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// Toggle from the CLI, tray or UI: start when idle, stop when recording.
    Toggle,
    /// A hotkey event with the time it arrived, in milliseconds on any monotonic clock.
    Key(KeyEvent, u64),
    /// Abandon the current dictation, whatever phase it is in.
    Cancel,
    /// The speech engine finished. `text` may be empty when nothing was heard.
    Transcribed {
        job: JobId,
        text: String,
        language: String,
    },
    /// The cleanup model finished.
    Cleaned { job: JobId, text: String },
    /// The text reached the target (or the clipboard).
    Inserted { job: JobId, delivery: Delivery },
    /// The work of phase `during` failed: the microphone while recording, the
    /// speech engine while transcribing, the cleanup model while cleaning, the
    /// inserter while inserting. A failure reported for a phase the job has
    /// already left is stale.
    Failed {
        job: JobId,
        during: Phase,
        error: String,
    },
}

/// How inserted text arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Typed,
    /// Left on the clipboard, for example because the key was still held.
    Copied {
        reason: Option<String>,
    },
    /// Insertion is switched off.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Open the microphone and start buffering audio for `job`.
    StartCapture { job: JobId },
    /// Stop the microphone and send the clip to the speech engine.
    Transcribe { job: JobId },
    /// Stop the microphone and drop the audio.
    DiscardCapture { job: JobId },
    /// Ask the cleanup model to clean `text`.
    Cleanup {
        job: JobId,
        text: String,
        language: String,
    },
    /// Save `text` to history and insert it into the focused window.
    Insert {
        job: JobId,
        text: String,
        /// The transcript before cleanup, when cleanup changed or failed on it.
        raw: Option<String>,
    },
    /// Stop engine work for `job` if any is still running; its result will be ignored.
    CancelJob { job: JobId },
}

/// How a dictation ended. Reported once, on the transition back to idle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Done {
        job: JobId,
        text: String,
        raw: Option<String>,
        delivery: Delivery,
        /// Cleanup failed and the raw transcript was used instead.
        cleanup_error: Option<String>,
    },
    NothingHeard {
        job: JobId,
    },
    Cancelled {
        job: JobId,
        during: Phase,
    },
    Failed {
        job: JobId,
        during: Phase,
        error: String,
        /// Text that was ready but could not be inserted, so it can still be offered.
        text: Option<String>,
    },
}

/// Why an input changed nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ignored {
    /// A start was requested while transcribing, cleaning or inserting.
    Busy,
    /// Nothing to stop or cancel.
    Idle,
    /// A result for a job that is no longer current, or arriving in the wrong phase.
    Stale,
    /// A key event that did not complete a gesture.
    NoCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Changed {
        from: Phase,
        to: Phase,
        effects: Vec<Effect>,
        outcome: Option<Outcome>,
    },
    Ignored(Ignored),
}

#[derive(Debug, Default)]
pub struct Dictation {
    config: Config,
    phase: Phase,
    job: JobId,
    /// The transcript while cleaning; the final text while inserting.
    text: String,
    raw: Option<String>,
    language: String,
    cleanup_error: Option<String>,
    gesture: Gesture,
}

impl Dictation {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    /// The current job, or the last one when idle. 0 before the first dictation.
    pub fn job(&self) -> JobId {
        self.job
    }
    pub fn config(&self) -> Config {
        self.config
    }
    /// Takes effect from the next transcript on.
    pub fn set_config(&mut self, config: Config) {
        self.config = config;
    }
    /// The hotkey is physically held (as far as the events tell).
    pub fn keys_down(&self) -> bool {
        self.gesture.keys_down()
    }

    pub fn handle(&mut self, input: Input) -> Step {
        let from = self.phase;
        match input {
            Input::Toggle => match from {
                Phase::Idle => self.start(),
                Phase::Recording => self.stop(),
                _ => Step::Ignored(Ignored::Busy),
            },
            Input::Key(event, now) => self.key(event, now),
            Input::Cancel => self.cancel(),
            Input::Transcribed {
                job,
                text,
                language,
            } => {
                if !self.current(job, Phase::Transcribing) {
                    return Step::Ignored(Ignored::Stale);
                }
                let text = text.trim().to_owned();
                if text.is_empty() {
                    return self.finish(Vec::new(), Outcome::NothingHeard { job });
                }
                self.language = language;
                if self.config.cleanup {
                    self.text = text.clone();
                    self.to(
                        Phase::Cleaning,
                        vec![Effect::Cleanup {
                            job,
                            text,
                            language: self.language.clone(),
                        }],
                    )
                } else {
                    self.insert(text, None)
                }
            }
            Input::Cleaned { job, text } => {
                if !self.current(job, Phase::Cleaning) {
                    return Step::Ignored(Ignored::Stale);
                }
                let raw = std::mem::take(&mut self.text);
                let text = text.trim().to_owned();
                if text.is_empty() {
                    // A cleanup that erases everything is a cleanup failure, not silence.
                    self.cleanup_error = Some("cleanup returned no text".into());
                    return self.insert(raw, None);
                }
                let raw = (raw != text).then_some(raw);
                self.insert(text, raw)
            }
            Input::Inserted { job, delivery } => {
                if !self.current(job, Phase::Inserting) {
                    return Step::Ignored(Ignored::Stale);
                }
                let outcome = Outcome::Done {
                    job,
                    text: std::mem::take(&mut self.text),
                    raw: self.raw.take(),
                    delivery,
                    cleanup_error: self.cleanup_error.take(),
                };
                self.finish(Vec::new(), outcome)
            }
            Input::Failed { job, during, error } => {
                if !self.current(job, during) || from == Phase::Idle {
                    return Step::Ignored(Ignored::Stale);
                }
                match from {
                    Phase::Idle => unreachable!(),
                    Phase::Recording => self.finish(
                        vec![Effect::DiscardCapture { job }],
                        Outcome::Failed {
                            job,
                            during: from,
                            error,
                            text: None,
                        },
                    ),
                    Phase::Transcribing => self.finish(
                        Vec::new(),
                        Outcome::Failed {
                            job,
                            during: from,
                            error,
                            text: None,
                        },
                    ),
                    Phase::Cleaning => {
                        self.cleanup_error = Some(error);
                        let raw = std::mem::take(&mut self.text);
                        self.insert(raw, None)
                    }
                    Phase::Inserting => {
                        let text = Some(std::mem::take(&mut self.text));
                        self.finish(
                            Vec::new(),
                            Outcome::Failed {
                                job,
                                during: from,
                                error,
                                text,
                            },
                        )
                    }
                }
            }
        }
    }

    fn key(&mut self, event: KeyEvent, now: u64) -> Step {
        if self.phase.is_busy() {
            self.gesture.track(event);
            return Step::Ignored(Ignored::Busy);
        }
        match (self.gesture.feed(event, now), self.phase) {
            (Some(Command::Start), Phase::Idle) => self.start(),
            (Some(Command::Stop), Phase::Recording) => self.stop(),
            // Recording was started by a toggle, so the gesture thinks it is idle:
            // a press means "stop" to the user.
            (Some(Command::Start), Phase::Recording) => self.stop(),
            (Some(Command::Stop), _) => Step::Ignored(Ignored::Idle),
            (None, _) => Step::Ignored(Ignored::NoCommand),
            (Some(Command::Start), _) => Step::Ignored(Ignored::Busy),
        }
    }

    fn start(&mut self) -> Step {
        self.job += 1;
        self.text.clear();
        self.raw = None;
        self.cleanup_error = None;
        self.language.clear();
        let job = self.job;
        self.to(Phase::Recording, vec![Effect::StartCapture { job }])
    }

    fn stop(&mut self) -> Step {
        let job = self.job;
        self.to(Phase::Transcribing, vec![Effect::Transcribe { job }])
    }

    fn cancel(&mut self) -> Step {
        let job = self.job;
        let during = self.phase;
        let effect = match during {
            Phase::Idle => return Step::Ignored(Ignored::Idle),
            Phase::Recording => Effect::DiscardCapture { job },
            _ => Effect::CancelJob { job },
        };
        self.finish(vec![effect], Outcome::Cancelled { job, during })
    }

    fn insert(&mut self, text: String, raw: Option<String>) -> Step {
        let job = self.job;
        self.text = text.clone();
        self.raw = raw.clone();
        self.to(Phase::Inserting, vec![Effect::Insert { job, text, raw }])
    }

    fn current(&self, job: JobId, phase: Phase) -> bool {
        job == self.job && self.phase == phase
    }

    fn to(&mut self, to: Phase, effects: Vec<Effect>) -> Step {
        let from = std::mem::replace(&mut self.phase, to);
        Step::Changed {
            from,
            to,
            effects,
            outcome: None,
        }
    }

    fn finish(&mut self, effects: Vec<Effect>, outcome: Outcome) -> Step {
        let from = std::mem::replace(&mut self.phase, Phase::Idle);
        self.text.clear();
        self.raw = None;
        self.cleanup_error = None;
        // A finished dictation forgets the gesture, as the app does today, so a
        // release or a stale "recording" flag never leaks into the next one.
        self.gesture.reset();
        Step::Changed {
            from,
            to: Phase::Idle,
            effects,
            outcome: Some(outcome),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    fn effects(step: &Step) -> &[Effect] {
        match step {
            Step::Changed { effects, .. } => effects,
            Step::Ignored(_) => &[],
        }
    }
    fn outcome(step: Step) -> Option<Outcome> {
        match step {
            Step::Changed { outcome, .. } => outcome,
            Step::Ignored(_) => None,
        }
    }
    fn transcribed(job: JobId, text: &str) -> Input {
        Input::Transcribed {
            job,
            text: text.into(),
            language: "nl".into(),
        }
    }

    /// Drives a fresh machine with cleanup on into `phase` and returns it.
    fn machine_in(phase: Phase) -> Dictation {
        let mut d = Dictation::new(Config { cleanup: true });
        let steps: &[Input] = match phase {
            Phase::Idle => &[],
            Phase::Recording => &[Input::Toggle],
            Phase::Transcribing => &[Input::Toggle, Input::Toggle],
            Phase::Cleaning => &[Input::Toggle, Input::Toggle],
            Phase::Inserting => &[Input::Toggle, Input::Toggle],
        };
        for input in steps {
            d.handle(input.clone());
        }
        if matches!(phase, Phase::Cleaning | Phase::Inserting) {
            d.handle(transcribed(1, "hallo wereld"));
        }
        if phase == Phase::Inserting {
            d.handle(Input::Cleaned {
                job: 1,
                text: "Hallo wereld.".into(),
            });
        }
        assert_eq!(d.phase(), phase);
        d
    }

    #[test]
    fn full_dictation_with_cleanup() {
        let mut d = Dictation::new(Config { cleanup: true });
        let s = d.handle(Input::Toggle);
        assert_eq!(effects(&s), [Effect::StartCapture { job: 1 }]);
        let s = d.handle(Input::Toggle);
        assert_eq!(effects(&s), [Effect::Transcribe { job: 1 }]);
        let s = d.handle(transcribed(1, " hallo wereld "));
        assert_eq!(
            effects(&s),
            [Effect::Cleanup {
                job: 1,
                text: "hallo wereld".into(),
                language: "nl".into()
            }]
        );
        let s = d.handle(Input::Cleaned {
            job: 1,
            text: "Hallo wereld.".into(),
        });
        assert_eq!(
            effects(&s),
            [Effect::Insert {
                job: 1,
                text: "Hallo wereld.".into(),
                raw: Some("hallo wereld".into())
            }]
        );
        let s = d.handle(Input::Inserted {
            job: 1,
            delivery: Delivery::Typed,
        });
        assert_eq!(
            outcome(s),
            Some(Outcome::Done {
                job: 1,
                text: "Hallo wereld.".into(),
                raw: Some("hallo wereld".into()),
                delivery: Delivery::Typed,
                cleanup_error: None,
            })
        );
        assert_eq!(d.phase(), Phase::Idle);
        // The next dictation gets a new job id.
        assert_eq!(
            effects(&d.handle(Input::Toggle)),
            [Effect::StartCapture { job: 2 }]
        );
    }

    #[test]
    fn cleanup_off_goes_straight_to_inserting() {
        let mut d = Dictation::new(Config { cleanup: false });
        d.handle(Input::Toggle);
        d.handle(Input::Toggle);
        let s = d.handle(transcribed(1, "hi"));
        assert_eq!(
            effects(&s),
            [Effect::Insert {
                job: 1,
                text: "hi".into(),
                raw: None
            }]
        );
    }

    #[test]
    fn unchanged_cleanup_keeps_no_raw_copy() {
        let mut d = machine_in(Phase::Cleaning);
        let s = d.handle(Input::Cleaned {
            job: 1,
            text: "hallo wereld".into(),
        });
        assert!(matches!(&effects(&s)[0], Effect::Insert { raw: None, .. }));
    }

    #[test]
    fn empty_transcript_is_nothing_heard() {
        let mut d = machine_in(Phase::Transcribing);
        let s = d.handle(transcribed(1, "   "));
        assert_eq!(outcome(s), Some(Outcome::NothingHeard { job: 1 }));
        assert_eq!(d.phase(), Phase::Idle);
    }

    #[test]
    fn cleanup_erasing_everything_inserts_the_raw_text() {
        let mut d = machine_in(Phase::Cleaning);
        let s = d.handle(Input::Cleaned {
            job: 1,
            text: "".into(),
        });
        assert!(
            matches!(&effects(&s)[0], Effect::Insert { text, raw: None, .. } if text == "hallo wereld")
        );
        let s = d.handle(Input::Inserted {
            job: 1,
            delivery: Delivery::Typed,
        });
        assert!(matches!(
            outcome(s),
            Some(Outcome::Done {
                cleanup_error: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn toggle_while_busy_is_refused() {
        for phase in [Phase::Transcribing, Phase::Cleaning, Phase::Inserting] {
            let mut d = machine_in(phase);
            assert_eq!(d.handle(Input::Toggle), Step::Ignored(Ignored::Busy));
            assert_eq!(d.phase(), phase);
        }
    }

    #[test]
    fn cancel_in_every_phase() {
        for phase in Phase::ALL {
            let mut d = machine_in(phase);
            let job = d.job();
            let step = d.handle(Input::Cancel);
            match phase {
                Phase::Idle => assert_eq!(step, Step::Ignored(Ignored::Idle)),
                _ => {
                    let expected = if phase == Phase::Recording {
                        Effect::DiscardCapture { job }
                    } else {
                        Effect::CancelJob { job }
                    };
                    assert_eq!(effects(&step), [expected], "{phase:?}");
                    assert_eq!(
                        outcome(step),
                        Some(Outcome::Cancelled { job, during: phase })
                    );
                }
            }
            assert_eq!(d.phase(), Phase::Idle);
            // Late results from the cancelled job change nothing.
            for late in [
                transcribed(job, "late"),
                Input::Cleaned {
                    job,
                    text: "late".into(),
                },
                Input::Inserted {
                    job,
                    delivery: Delivery::Typed,
                },
                Input::Failed {
                    job,
                    during: phase,
                    error: "late".into(),
                },
            ] {
                assert_eq!(d.handle(late), Step::Ignored(Ignored::Stale));
            }
            // And the machine is ready for a new dictation.
            assert_eq!(
                effects(&d.handle(Input::Toggle)),
                [Effect::StartCapture { job: job + 1 }]
            );
        }
    }

    #[test]
    fn failure_in_every_phase() {
        for phase in Phase::ALL {
            let mut d = machine_in(phase);
            let job = d.job();
            let step = d.handle(Input::Failed {
                job,
                during: phase,
                error: "boom".into(),
            });
            match phase {
                Phase::Idle => {
                    assert_eq!(step, Step::Ignored(Ignored::Stale));
                }
                Phase::Recording => {
                    assert_eq!(effects(&step), [Effect::DiscardCapture { job }]);
                    assert!(matches!(
                        outcome(step),
                        Some(Outcome::Failed {
                            during: Phase::Recording,
                            text: None,
                            ..
                        })
                    ));
                }
                Phase::Transcribing => {
                    assert!(effects(&step).is_empty());
                    assert!(matches!(
                        outcome(step),
                        Some(Outcome::Failed {
                            during: Phase::Transcribing,
                            text: None,
                            ..
                        })
                    ));
                }
                Phase::Cleaning => {
                    // Not fatal: the raw transcript is inserted instead.
                    assert_eq!(
                        effects(&step),
                        [Effect::Insert {
                            job,
                            text: "hallo wereld".into(),
                            raw: None
                        }]
                    );
                    assert_eq!(d.phase(), Phase::Inserting);
                    let done = d.handle(Input::Inserted {
                        job,
                        delivery: Delivery::Typed,
                    });
                    assert_eq!(
                        outcome(done),
                        Some(Outcome::Done {
                            job,
                            text: "hallo wereld".into(),
                            raw: None,
                            delivery: Delivery::Typed,
                            cleanup_error: Some("boom".into()),
                        })
                    );
                }
                Phase::Inserting => {
                    assert_eq!(
                        outcome(step),
                        Some(Outcome::Failed {
                            job,
                            during: Phase::Inserting,
                            error: "boom".into(),
                            text: Some("Hallo wereld.".into()),
                        })
                    );
                }
            }
            assert_eq!(d.phase(), Phase::Idle, "{phase:?}");
        }
    }

    #[test]
    fn results_for_other_jobs_or_phases_are_stale() {
        let mut d = machine_in(Phase::Transcribing);
        assert_eq!(
            d.handle(transcribed(99, "x")),
            Step::Ignored(Ignored::Stale)
        );
        assert_eq!(
            d.handle(Input::Cleaned {
                job: 1,
                text: "x".into()
            }),
            Step::Ignored(Ignored::Stale)
        );
        assert_eq!(
            d.handle(Input::Failed {
                job: 99,
                during: Phase::Transcribing,
                error: "x".into()
            }),
            Step::Ignored(Ignored::Stale)
        );
        assert_eq!(d.phase(), Phase::Transcribing);
    }

    #[test]
    fn a_late_failure_of_an_earlier_phase_is_stale() {
        // The microphone reports an error after transcription already moved on
        // to cleaning: it must not count as a cleanup failure.
        let mut d = machine_in(Phase::Cleaning);
        assert_eq!(
            d.handle(Input::Failed {
                job: 1,
                during: Phase::Recording,
                error: "mic gone".into()
            }),
            Step::Ignored(Ignored::Stale)
        );
        assert_eq!(d.phase(), Phase::Cleaning);
    }

    #[test]
    fn hold_records_while_held() {
        let mut d = Dictation::new(Config::default());
        let s = d.handle(Input::Key(KeyEvent::Pressed, 0));
        assert_eq!(effects(&s), [Effect::StartCapture { job: 1 }]);
        let s = d.handle(Input::Key(KeyEvent::Released, 900));
        assert_eq!(effects(&s), [Effect::Transcribe { job: 1 }]);
    }

    #[test]
    fn tap_starts_and_next_press_stops() {
        let mut d = Dictation::new(Config::default());
        d.handle(Input::Key(KeyEvent::Pressed, 0));
        assert_eq!(
            d.handle(Input::Key(KeyEvent::Released, 100)),
            Step::Ignored(Ignored::NoCommand)
        );
        assert_eq!(d.phase(), Phase::Recording);
        let s = d.handle(Input::Key(KeyEvent::Pressed, 2000));
        assert_eq!(effects(&s), [Effect::Transcribe { job: 1 }]);
        // The release of the stopping press goes to the tracker while busy.
        assert_eq!(
            d.handle(Input::Key(KeyEvent::Released, 2100)),
            Step::Ignored(Ignored::Busy)
        );
        assert!(!d.keys_down());
    }

    #[test]
    fn press_while_busy_never_starts_and_its_release_never_stops_later() {
        let mut d = machine_in(Phase::Transcribing);
        assert_eq!(
            d.handle(Input::Key(KeyEvent::Pressed, 10)),
            Step::Ignored(Ignored::Busy)
        );
        assert!(d.keys_down());
        d.handle(transcribed(1, "hallo"));
        d.handle(Input::Cleaned {
            job: 1,
            text: "Hallo.".into(),
        });
        d.handle(Input::Inserted {
            job: 1,
            delivery: Delivery::Typed,
        });
        assert_eq!(d.phase(), Phase::Idle);
        // Release of the busy press after returning to idle: nothing happens.
        assert_eq!(
            d.handle(Input::Key(KeyEvent::Released, 5000)),
            Step::Ignored(Ignored::NoCommand)
        );
        // A fresh press starts as usual.
        let s = d.handle(Input::Key(KeyEvent::Pressed, 6000));
        assert_eq!(effects(&s), [Effect::StartCapture { job: 2 }]);
    }

    #[test]
    fn hotkey_press_stops_a_toggle_started_recording() {
        let mut d = Dictation::new(Config::default());
        d.handle(Input::Toggle);
        let s = d.handle(Input::Key(KeyEvent::Pressed, 0));
        assert_eq!(effects(&s), [Effect::Transcribe { job: 1 }]);
    }

    #[test]
    fn toggle_stops_a_hotkey_started_recording_and_the_next_tap_starts() {
        let mut d = Dictation::new(Config::default());
        d.handle(Input::Key(KeyEvent::Pressed, 0));
        d.handle(Input::Key(KeyEvent::Released, 50));
        d.handle(Input::Toggle);
        d.handle(transcribed(1, "hi"));
        d.handle(Input::Inserted {
            job: 1,
            delivery: Delivery::Typed,
        });
        // Without the reset on finish the gesture would still think it records
        // and turn this press into a stop.
        let s = d.handle(Input::Key(KeyEvent::Pressed, 1000));
        assert_eq!(effects(&s), [Effect::StartCapture { job: 2 }]);
    }

    /// Random input sequences keep the machine's invariants: exactly one outcome
    /// per started job, effects only for the current job, and a start only from idle.
    #[test]
    fn random_sequences_keep_invariants() {
        for seed in 0..300 {
            let mut rng = Rng::new(seed);
            let mut d = Dictation::new(Config {
                cleanup: rng.below(2) == 0,
            });
            let mut started = 0u64;
            let mut finished = std::collections::HashSet::new();
            let mut now = 0;
            for _ in 0..200 {
                now += rng.below(800);
                // Engine results usually target the current job, sometimes an old one.
                let job = if rng.below(5) == 0 {
                    d.job().saturating_sub(1)
                } else {
                    d.job()
                };
                let input = match rng.below(9) {
                    0 => Input::Toggle,
                    1 => Input::Key(KeyEvent::Pressed, now),
                    2 => Input::Key(KeyEvent::Released, now),
                    3 => Input::Cancel,
                    4 => transcribed(job, if rng.below(4) == 0 { "" } else { "tekst" }),
                    5 => Input::Cleaned {
                        job,
                        text: "Tekst.".into(),
                    },
                    6 => Input::Inserted {
                        job,
                        delivery: Delivery::Typed,
                    },
                    7 => Input::Failed {
                        job,
                        during: Phase::ALL[rng.below(5) as usize],
                        error: "x".into(),
                    },
                    _ => Input::Key(KeyEvent::Activated, now),
                };
                let before = d.phase();
                let current = d.job();
                let step = d.handle(input);
                let Step::Changed {
                    from,
                    to,
                    effects,
                    outcome,
                } = step
                else {
                    assert_eq!(d.phase(), before, "seed {seed}: ignored input moved state");
                    continue;
                };
                assert_eq!(from, before);
                assert_eq!(to, d.phase());
                assert_ne!(from, to, "seed {seed}: no self-transitions");
                if to == Phase::Recording {
                    assert_eq!(from, Phase::Idle, "seed {seed}");
                    started += 1;
                    assert_eq!(d.job(), started, "seed {seed}: one job per start");
                } else {
                    assert_eq!(d.job(), current, "seed {seed}: job changed without a start");
                }
                for effect in &effects {
                    let job = match effect {
                        Effect::StartCapture { job }
                        | Effect::Transcribe { job }
                        | Effect::DiscardCapture { job }
                        | Effect::Cleanup { job, .. }
                        | Effect::Insert { job, .. }
                        | Effect::CancelJob { job } => *job,
                    };
                    assert_eq!(job, d.job(), "seed {seed}: effect for another job");
                }
                assert_eq!(
                    outcome.is_some(),
                    to == Phase::Idle,
                    "seed {seed}: outcome exactly on return to idle"
                );
                if outcome.is_some() {
                    assert!(finished.insert(d.job()), "seed {seed}: second outcome");
                }
            }
        }
    }
}
