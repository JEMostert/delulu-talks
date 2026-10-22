//! Bounded, attempt-scoped setup log (`setupLog.ts`). Sizes are measured like
//! `JSON.stringify(entry).length` (UTF-16 code units of the serialized entry).

use delulu_core::util::{truncate_utf16, utf16_len};
use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_SETUP_LOG_ENTRIES: usize = 128;
pub const MAX_SETUP_LOG_CHARACTERS: usize = 64_000;
pub const MAX_SETUP_LOG_ENTRY_CHARACTERS: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSetupKind {
    Speech,
    Rewrite,
    Voice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupLogEntryType {
    Stage,
    Command,
    Stdout,
    Stderr,
    Exit,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupCommand {
    pub program: String,
    pub args: Vec<String>,
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupLogEntry {
    pub at: u64,
    #[serde(rename = "type")]
    pub kind: SetupLogEntryType,
    pub stage: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<SetupCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    /// Absent, `null` (killed by a signal) or the exit code.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub exit_code: Option<Option<i32>>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub signal: Option<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupOutcome {
    Idle,
    Running,
    Success,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupLog {
    pub kind: RuntimeSetupKind,
    pub attempt_id: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub outcome: SetupOutcome,
    pub entries: Vec<RuntimeSetupLogEntry>,
    pub truncated: bool,
    pub max_entries: usize,
    pub max_characters: usize,
}

/// An event before it is time-stamped and bounded.
#[derive(Debug, Clone, Default)]
pub struct SetupEvent {
    pub kind: Option<SetupLogEntryType>,
    pub stage: String,
    pub message: String,
    pub command: Option<SetupCommand>,
    pub duration_ms: Option<f64>,
    pub exit_code: Option<Option<i32>>,
    pub signal: Option<Option<String>>,
}

impl SetupEvent {
    pub fn new(kind: SetupLogEntryType, stage: impl Into<String>, message: impl Into<String>) -> Self {
        Self { kind: Some(kind), stage: stage.into(), message: message.into(), ..Self::default() }
    }
    pub fn duration(mut self, ms: f64) -> Self {
        self.duration_ms = Some(ms);
        self
    }
    pub fn command(mut self, program: impl Into<String>, args: Vec<String>) -> Self {
        self.command = Some(SetupCommand { program: program.into(), args });
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalOutcome {
    Success,
    Error,
    Cancelled,
}

#[derive(Debug)]
pub struct SetupLog {
    attempt_id: Option<String>,
    kind: Option<RuntimeSetupKind>,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    outcome: SetupOutcome,
    entries: Vec<RuntimeSetupLogEntry>,
    characters: usize,
    truncated: bool,
}

impl Default for SetupLog {
    fn default() -> Self {
        Self {
            attempt_id: None,
            kind: None,
            started_at: None,
            finished_at: None,
            outcome: SetupOutcome::Idle,
            entries: Vec::new(),
            characters: 2,
            truncated: false,
        }
    }
}

fn json_length(entry: &RuntimeSetupLogEntry) -> usize {
    utf16_len(&serde_json::to_string(entry).unwrap_or_default())
}

impl SetupLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active_id(&self) -> Option<String> {
        (self.outcome == SetupOutcome::Running).then(|| self.attempt_id.clone()).flatten()
    }

    pub fn begin(&mut self, kind: RuntimeSetupKind) -> String {
        let id = delulu_core::uuid();
        *self = Self {
            attempt_id: Some(id.clone()),
            kind: Some(kind),
            started_at: Some(delulu_core::now_ms()),
            outcome: SetupOutcome::Running,
            ..Self::default()
        };
        id
    }

    pub fn record(&mut self, attempt_id: Option<&str>, event: SetupEvent) {
        let Some(attempt_id) = attempt_id else { return };
        if self.active_id().as_deref() != Some(attempt_id) {
            return;
        }
        let entry = self.sanitize(event);
        self.characters += json_length(&entry) + usize::from(!self.entries.is_empty());
        self.entries.push(entry);
        while self.entries.len() > MAX_SETUP_LOG_ENTRIES || self.characters > MAX_SETUP_LOG_CHARACTERS {
            let index = self
                .entries
                .iter()
                .position(|item| matches!(item.kind, SetupLogEntryType::Stdout | SetupLogEntryType::Stderr))
                .unwrap_or(0);
            let removed = self.entries.remove(index);
            self.characters -= json_length(&removed) + usize::from(!self.entries.is_empty());
            self.truncated = true;
        }
    }

    pub fn finish(&mut self, attempt_id: Option<&str>, outcome: FinalOutcome, message: Option<&str>) {
        let Some(id) = attempt_id else { return };
        if self.active_id().as_deref() != Some(id) {
            return;
        }
        let (kind, name) = match outcome {
            FinalOutcome::Success => (SetupLogEntryType::Stage, "success"),
            FinalOutcome::Error => (SetupLogEntryType::Error, "error"),
            FinalOutcome::Cancelled => (SetupLogEntryType::Stage, "cancelled"),
        };
        let message = message.map(str::to_owned).unwrap_or_else(|| format!("Setup {name}"));
        self.record(Some(id), SetupEvent::new(kind, "finished", message));
        self.finished_at = Some(delulu_core::now_ms());
        self.outcome = match outcome {
            FinalOutcome::Success => SetupOutcome::Success,
            FinalOutcome::Error => SetupOutcome::Error,
            FinalOutcome::Cancelled => SetupOutcome::Cancelled,
        };
    }

    pub fn snapshot(&self, kind: RuntimeSetupKind) -> RuntimeSetupLog {
        let matches = self.kind == Some(kind);
        RuntimeSetupLog {
            kind,
            attempt_id: if matches { self.attempt_id.clone() } else { None },
            started_at: if matches { self.started_at } else { None },
            finished_at: if matches { self.finished_at } else { None },
            outcome: if matches { self.outcome } else { SetupOutcome::Idle },
            entries: if matches { self.entries.clone() } else { Vec::new() },
            truncated: matches && self.truncated,
            max_entries: MAX_SETUP_LOG_ENTRIES,
            max_characters: MAX_SETUP_LOG_CHARACTERS,
        }
    }

    fn bounded(&mut self, value: &str, limit: usize) -> String {
        if utf16_len(value) > limit {
            self.truncated = true;
        }
        truncate_utf16(value, limit).to_owned()
    }

    fn sanitize(&mut self, event: SetupEvent) -> RuntimeSetupLogEntry {
        let mut entry = RuntimeSetupLogEntry {
            at: delulu_core::now_ms(),
            kind: event.kind.unwrap_or(SetupLogEntryType::Stage),
            stage: self.bounded(&event.stage, 128),
            message: self.bounded(&event.message, MAX_SETUP_LOG_ENTRY_CHARACTERS),
            command: None,
            duration_ms: event.duration_ms.filter(|ms| ms.is_finite()),
            exit_code: event.exit_code,
            signal: None,
        };
        if let Some(command) = event.command {
            if command.args.len() > 64 {
                self.truncated = true;
            }
            let program = self.bounded(&command.program, 256);
            let args = command.args.iter().take(64).map(|arg| self.bounded(arg, 128)).collect();
            entry.command = Some(SetupCommand { program, args });
        }
        if let Some(signal) = event.signal {
            entry.signal = Some(signal.map(|name| self.bounded(&name, 64)));
        }
        // Bound the serialized copy too: escaped output and command arguments count.
        while entry.command.as_ref().is_some_and(|c| !c.args.is_empty())
            && json_length(&entry) > MAX_SETUP_LOG_ENTRY_CHARACTERS
        {
            if let Some(command) = entry.command.as_mut() {
                command.args.pop();
            }
            self.truncated = true;
        }
        if json_length(&entry) > MAX_SETUP_LOG_ENTRY_CHARACTERS {
            let message = std::mem::take(&mut entry.message);
            let (mut lower, mut upper) = (0, utf16_len(&message));
            while lower < upper {
                let length = (lower + upper).div_ceil(2);
                entry.message = truncate_utf16(&message, length).to_owned();
                if json_length(&entry) <= MAX_SETUP_LOG_ENTRY_CHARACTERS {
                    lower = length;
                } else {
                    upper = length - 1;
                }
            }
            entry.message = truncate_utf16(&message, lower).to_owned();
            self.truncated = true;
        }
        entry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_is_bounded_and_attempt_scoped() {
        let mut log = SetupLog::new();
        log.record(Some("stale"), SetupEvent::new(SetupLogEntryType::Stage, "x", "ignored"));
        let id = log.begin(RuntimeSetupKind::Voice);
        for _ in 0..200 {
            log.record(Some(&id), SetupEvent::new(SetupLogEntryType::Stdout, "pip", "\"".repeat(5000)));
        }
        log.record(Some(&id), SetupEvent::new(SetupLogEntryType::Stage, "kept", "stage"));
        log.finish(Some(&id), FinalOutcome::Cancelled, None);
        let snapshot = log.snapshot(RuntimeSetupKind::Voice);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.outcome, SetupOutcome::Cancelled);
        assert!(snapshot.entries.len() <= MAX_SETUP_LOG_ENTRIES);
        let total: usize = snapshot.entries.iter().map(json_length).sum::<usize>() + snapshot.entries.len() + 1;
        assert!(total <= MAX_SETUP_LOG_CHARACTERS);
        assert!(snapshot.entries.iter().all(|entry| json_length(entry) <= MAX_SETUP_LOG_ENTRY_CHARACTERS));
        assert_eq!(snapshot.entries.last().unwrap().message, "Setup cancelled");
        assert!(snapshot.entries.iter().any(|entry| entry.stage == "kept"));
        assert_eq!(log.snapshot(RuntimeSetupKind::Speech).outcome, SetupOutcome::Idle);
        let exit = serde_json::to_value(RuntimeSetupLogEntry {
            exit_code: Some(None),
            ..snapshot.entries[0].clone()
        })
        .unwrap();
        assert!(exit["exitCode"].is_null() && exit.get("signal").is_none());
    }
}
