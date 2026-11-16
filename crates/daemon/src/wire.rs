//! Conversions from the shared crates' types to the wire types in `delulu-proto`.

use delulu_core::dictation::{self as fsm, Outcome};
use delulu_desktop::hotkey::HotkeyStatus;
use delulu_desktop::insert::InsertStatus;
use delulu_dictation::cleanup::CleanupStatus;
use delulu_proto::state::*;

pub fn phase(phase: fsm::Phase) -> DictationPhase {
    match phase {
        fsm::Phase::Idle => DictationPhase::Idle,
        fsm::Phase::Recording => DictationPhase::Recording,
        fsm::Phase::Transcribing => DictationPhase::Transcribing,
        fsm::Phase::Cleaning => DictationPhase::Cleaning,
        fsm::Phase::Inserting => DictationPhase::Inserting,
    }
}

pub fn delivery(delivery: fsm::Delivery) -> Delivery {
    match delivery {
        fsm::Delivery::Typed => Delivery::Typed,
        fsm::Delivery::Copied { reason } => Delivery::Copied { reason },
        fsm::Delivery::Skipped => Delivery::Skipped,
    }
}

/// How a dictation ended, with what History made of it.
pub fn outcome(
    outcome: Outcome,
    now: u64,
    history_id: Option<String>,
    history_error: Option<String>,
) -> DictationOutcome {
    match outcome {
        Outcome::Done {
            job,
            text,
            raw,
            delivery: how,
            cleanup_error,
        } => DictationOutcome::Done {
            job,
            at: now,
            text,
            raw,
            delivery: delivery(how),
            cleanup_error,
            history_id,
            history_error,
        },
        Outcome::NothingHeard { job } => DictationOutcome::NothingHeard { job, at: now },
        Outcome::Cancelled { job, during } => DictationOutcome::Cancelled {
            job,
            at: now,
            during: phase(during),
        },
        Outcome::Failed {
            job,
            during,
            error,
            text,
        } => DictationOutcome::Failed {
            job,
            at: now,
            during: phase(during),
            error,
            text,
        },
    }
}

pub fn history_entry(entry: delulu_store::HistoryEntry) -> HistoryEntry {
    HistoryEntry {
        id: entry.id,
        created_at: entry.created_at.max(0) as u64,
        text: entry.text,
        raw: entry.raw,
        topic: entry.topic,
        language: entry.language,
        model: entry.model,
        audio_ms: entry.audio_ms,
        stt_ms: entry.stt_ms,
        cleanup_ms: entry.cleanup_ms,
        total_ms: entry.total_ms,
    }
}

/// The settings as the protocol shows them. Read-only for now: the window still
/// edits `settings.json` through its own commands (work package C3c).
pub fn settings(s: &delulu_store::Settings) -> Settings {
    use delulu_store::{InsertMode as StoreInsert, Theme as StoreTheme};
    Settings {
        version: s.version,
        microphone: s.microphone.clone(),
        start_at_login: s.start_at_login,
        language: s.language.clone(),
        languages: s.allowed_languages.clone(),
        smart_context: s.smart_context,
        insert: match s.insert {
            StoreInsert::ShiftInsert => InsertMode::ShiftInsert,
            StoreInsert::CtrlV => InsertMode::CtrlV,
            StoreInsert::CtrlShiftV => InsertMode::CtrlShiftV,
            StoreInsert::Off => InsertMode::Off,
        },
        restore_clipboard: false,
        cleanup: s.cleanup,
        theme: match s.theme {
            StoreTheme::System => Theme::System,
            StoreTheme::Light => Theme::Light,
            StoreTheme::Dark => Theme::Dark,
        },
        pill: s.overlay,
        sounds: false,
        show_radio: s.radio,
        show_voice: false,
        history_days: (s.history_retention_days > 0).then_some(s.history_retention_days),
        models: RoleModels {
            stt: s.model.clone(),
            cleanup: Some(delulu_models::GEMMA_4_E4B.id.into()),
            tts: None,
            music: None,
            chat: None,
        },
    }
}

pub fn cleanup_worker(status: &CleanupStatus) -> WorkerStatus {
    let state = match status.state {
        "off" | "missing" => WorkerState::Off,
        "downloading" | "loading" => WorkerState::Loading,
        "ready" => WorkerState::Ready,
        _ => WorkerState::Error,
    };
    let error = match status.state {
        "missing" => Some(
            status
                .error
                .clone()
                .unwrap_or_else(|| "The cleanup model is not downloaded".into()),
        ),
        "downloading" => Some(format!(
            "Downloading the cleanup model ({}%)",
            delulu_dictation::cleanup::percent(status.done_bytes, status.total_bytes)
        )),
        _ => status.error.clone(),
    };
    WorkerStatus {
        state,
        model: Some(delulu_models::GEMMA_4_E4B.id.into()),
        device: status.backend.clone(),
        error,
    }
}

/// An empty trigger is how KDE answers once the first shortcut dialog was
/// cancelled: the shortcut exists without a key, and asking again shows no
/// dialog. Report it as not set, so the user is sent to the shortcut settings.
pub fn hotkey(status: HotkeyStatus) -> HotkeyState {
    let trigger = status.trigger.filter(|t| !t.trim().is_empty());
    if status.bound && trigger.is_none() {
        return HotkeyState {
            bound: false,
            trigger: None,
            error: Some(
                "The shortcut has no key. Set one for Delulu Talks in the desktop's shortcut settings."
                    .into(),
            ),
            problem: Some(HotkeyProblem::NotSet),
        };
    }
    let problem = (!status.bound).then_some(match status.error {
        Some(_) => HotkeyProblem::Unavailable,
        None => HotkeyProblem::NotSet,
    });
    HotkeyState {
        bound: status.bound,
        trigger,
        error: status.error,
        problem,
    }
}

pub fn insert(status: InsertStatus) -> InsertState {
    InsertState {
        ready: status.ready,
        error: status.error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_trigger_is_a_shortcut_without_a_key() {
        let state = hotkey(HotkeyStatus {
            bound: true,
            trigger: Some(String::new()),
            error: None,
        });
        assert!(!state.bound);
        assert_eq!(state.problem, Some(HotkeyProblem::NotSet));
        let state = hotkey(HotkeyStatus {
            bound: true,
            trigger: Some("Meta+Z".into()),
            error: None,
        });
        assert!(state.bound && state.problem.is_none());
        let state = hotkey(HotkeyStatus {
            bound: false,
            trigger: None,
            error: Some("portal gone".into()),
        });
        assert_eq!(state.problem, Some(HotkeyProblem::Unavailable));
    }
}
