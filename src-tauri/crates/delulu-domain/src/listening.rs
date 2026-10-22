//! Shared contracts for persistent listening sessions: a coding agent starts a
//! session once, Delulu keeps the microphone and speech model running, and the
//! agent collects one completed utterance per short waiting call.
//!
//! Delivery is at-least-once with a cursor: every event in a session has a
//! monotonically increasing `seq`. `next` returns the first event after the
//! cursor and keeps it until acknowledged. Passing `after: N` acknowledges every
//! event up to N (they are dropped), so a retried or reconnected waiter that
//! passes the same `after` gets the same event again instead of losing it.
//! See docs/VOICE.md.

use serde::{Deserialize, Serialize};

use crate::serde_js;

string_enum! {
    pub enum ListenSessionState {
        Starting = "starting",
        Listening = "listening",
        Paused = "paused",
        Stopped = "stopped",
        Failed = "failed",
    }
}

/// The user's completed utterance, transcribed (`type: "utterance"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenUtteranceEvent {
    pub seq: u64,
    pub session_id: String,
    /// Stable utterance id, e.g. "utt_…".
    pub id: String,
    pub text: String,
    pub at: u64,
    pub duration_ms: u64,
    /// Set when this utterance interrupted a spoken response.
    pub interrupted_response_id: Option<String>,
}

/// Delulu stopped speaking because the user started talking; a transcript
/// follows (`type: "interrupted"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenInterruptedEvent {
    pub seq: u64,
    pub session_id: String,
    /// The spoken response that was cut off (from `say --response`), if known.
    pub response_id: Option<String>,
    pub at: u64,
}

/// The session ended; no further events follow (`type: "stopped"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenStoppedEvent {
    pub seq: u64,
    pub session_id: String,
    pub reason: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ListenEvent {
    #[serde(rename = "utterance")]
    Utterance(ListenUtteranceEvent),
    #[serde(rename = "interrupted")]
    Interrupted(ListenInterruptedEvent),
    #[serde(rename = "stopped")]
    Stopped(ListenStoppedEvent),
}

impl ListenEvent {
    pub fn seq(&self) -> u64 {
        match self {
            ListenEvent::Utterance(event) => event.seq,
            ListenEvent::Interrupted(event) => event.seq,
            ListenEvent::Stopped(event) => event.seq,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenSessionInfo {
    pub id: String,
    /// Who started it, e.g. "claude-code". Only that client can reuse it by name.
    pub client: String,
    pub state: ListenSessionState,
    pub started_at: u64,
    /// Highest seq acknowledged; events up to it are gone.
    pub acked_seq: u64,
    /// Highest seq produced so far.
    pub last_seq: u64,
    /// Events after the cursor waiting to be collected.
    pub queued: u64,
    /// The user is speaking right now (an utterance is being captured).
    pub user_speaking: bool,
    /// An utterance is being transcribed.
    pub transcribing: bool,
    /// Open `next` calls.
    pub waiters: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ListenNextResult {
    Event { event: ListenEvent, session: ListenSessionInfo },
    Timeout { session: ListenSessionInfo },
    Stopped { reason: String, session: ListenSessionInfo },
}

/// `LISTEN_LIMITS`.
#[derive(Debug, Clone, Copy)]
pub struct ListenLimits {
    /// Longest single wait; clients loop for longer.
    pub max_wait_seconds: u64,
    pub default_wait_seconds: u64,
    /// Unacknowledged events kept per session before the oldest are dropped.
    pub queue: usize,
    /// Longest utterance before it is finalized anyway.
    pub max_utterance_ms: u64,
}

pub const LISTEN_LIMITS: ListenLimits =
    ListenLimits { max_wait_seconds: 3_600, default_wait_seconds: 600, queue: 200, max_utterance_ms: 60_000 };

/// Capture tuning for a listening session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenCaptureConfig {
    pub device_id: String,
    /// 0 (only clear, loud speech) … 1 (picks up quiet speech).
    #[serde(serialize_with = "serde_js::f64")]
    pub sensitivity: f64,
    /// Quiet pause that ends an utterance.
    #[serde(serialize_with = "serde_js::f64")]
    pub silence_ms: f64,
    /// Sustained speech needed before an utterance starts.
    #[serde(serialize_with = "serde_js::f64")]
    pub min_speech_ms: f64,
    /// Audio kept from before speech onset so first words are not clipped.
    #[serde(serialize_with = "serde_js::f64")]
    pub pre_roll_ms: f64,
    /// Interrupt Delulu's speech when the user talks over it.
    pub barge_in: bool,
    /// Sustained speech over playback needed to interrupt.
    #[serde(serialize_with = "serde_js::f64")]
    pub barge_in_ms: f64,
    #[serde(serialize_with = "serde_js::f64")]
    pub max_utterance_ms: f64,
}

/// What the Voice page and tray show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenStatus {
    pub session: Option<ListenSessionInfo>,
    /// Recent utterances in the current or last session, newest first.
    #[serde(with = "tagged_utterances")]
    pub recent: Vec<ListenUtteranceEvent>,
    /// Whether Delulu's microphone capture is running.
    pub capturing: bool,
    pub message: String,
}

/// Where the agent skill was installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSkillInstall {
    pub paths: Vec<String>,
}

/// Serializes utterances with their `type: "utterance"` tag.
mod tagged_utterances {
    use super::{ListenEvent, ListenUtteranceEvent};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(items: &[ListenUtteranceEvent], serializer: S) -> Result<S::Ok, S::Error> {
        let tagged: Vec<ListenEvent> = items.iter().cloned().map(ListenEvent::Utterance).collect();
        tagged.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ListenUtteranceEvent>, D::Error> {
        let events = Vec::<ListenEvent>::deserialize(deserializer)?;
        Ok(events
            .into_iter()
            .filter_map(|event| match event {
                ListenEvent::Utterance(utterance) => Some(utterance),
                _ => None,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_and_results_carry_their_discriminants() {
        let event = ListenEvent::Stopped(ListenStoppedEvent { seq: 3, session_id: "s".into(), reason: "done".into(), at: 9 });
        let session = ListenSessionInfo {
            id: "s".into(),
            client: "delulu".into(),
            state: ListenSessionState::Stopped,
            started_at: 1,
            acked_seq: 2,
            last_seq: 3,
            queued: 1,
            user_speaking: false,
            transcribing: false,
            waiters: 0,
            error: None,
        };
        let value = serde_json::to_value(ListenNextResult::Event { event, session }).unwrap();
        assert_eq!(value["status"], "event");
        assert_eq!(value["event"], json!({"type":"stopped","seq":3,"sessionId":"s","reason":"done","at":9}));
        assert_eq!(value["session"]["error"], json!(null));
        let status = ListenStatus {
            session: None,
            recent: vec![ListenUtteranceEvent {
                seq: 1,
                session_id: "s".into(),
                id: "utt_1".into(),
                text: "hi".into(),
                at: 2,
                duration_ms: 300,
                interrupted_response_id: None,
            }],
            capturing: false,
            message: String::new(),
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["recent"][0]["type"], "utterance");
        assert_eq!(serde_json::from_value::<ListenStatus>(value).unwrap(), status);
    }
}
