//! Daemon ⇄ client messages.
//!
//! Client → daemon, one per line:
//! `{"id": 1, "method": "hello", "params": {"protocol": 1, "client": "cli"}}`
//!
//! Daemon → client, one per line, told apart by their keys:
//! * `{"id": 1, "result": {…}}`: the reply to request 1.
//! * `{"id": 1, "error": {"code": "unknown_method", "message": "…"}}`: request 1
//!   failed. `id` is `null` when the line could not be read as a request at all.
//! * `{"seq": 7, "event": {"kind": "dictation", …}}`: a state change on a
//!   subscribed topic. `seq` grows by one per event the daemon publishes, so a
//!   client can see that it missed some; the daemon also says so with a
//!   `lagged` event, after which the client re-reads `state.get`.
//!
//! The first request on a connection must be `hello`; the daemon answers
//! anything else with `handshake_required`. Replies come in request order.

use crate::state::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Implemented by each method's params type: names the method and its result.
pub trait Method: Serialize {
    const NAME: &'static str;
    type Result: serde::de::DeserializeOwned;
    fn into_request(self) -> Request;
}

macro_rules! methods {
    ($( $(#[$doc:meta])* $variant:ident = $name:literal ($params:ty) -> $result:ty; )*) => {
        /// A parsed request.
        #[derive(Debug, Clone, PartialEq)]
        pub enum Request {
            $( $(#[$doc])* $variant($params), )*
        }

        /// Every method name, for `hello` and diagnostics.
        pub const METHODS: &[&str] = &[$($name),*];

        impl Request {
            pub fn method(&self) -> &'static str {
                match self { $( Request::$variant(_) => $name, )* }
            }
            pub fn params(&self) -> Value {
                match self {
                    $( Request::$variant(p) => serde_json::to_value(p).expect("params serialize"), )*
                }
            }
            /// Parses `params` for `method`. Absent or `null` params count as `{}`.
            pub fn parse(method: &str, params: Value) -> Result<Request, ApiError> {
                let params = if params.is_null() { Value::Object(Default::default()) } else { params };
                match method {
                    $( $name => serde_json::from_value::<$params>(params)
                        .map(Request::$variant)
                        .map_err(|e| ApiError::new(
                            ErrorCode::InvalidParams,
                            format!("invalid params for {}: {e}", $name),
                        )), )*
                    other => Err(ApiError::new(
                        ErrorCode::UnknownMethod,
                        format!("unknown method {other:?}"),
                    )),
                }
            }
        }

        $(
            impl Method for $params {
                const NAME: &'static str = $name;
                type Result = $result;
                fn into_request(self) -> Request { Request::$variant(self) }
            }
        )*

        /// `export type Methods = { "hello": { params: HelloParams; result: HelloResult }; … }`
        pub(crate) fn ts_methods(cfg: &ts_rs::Config) -> String {
            let mut out = String::from("export type Methods = {\n");
            $(
                out.push_str(&format!(
                    "  {:?}: {{ params: {}; result: {} }};\n",
                    $name,
                    <$params as TS>::name(cfg),
                    <$result as TS>::name(cfg),
                ));
            )*
            out.push_str("};\n");
            out
        }
    };
}

methods! {
    /// Must come first. Agrees on the protocol version.
    Hello = "hello" (HelloParams) -> HelloResult;
    /// The full snapshot.
    GetState = "state.get" (GetStateParams) -> AppState;
    /// Start receiving events for these topics (added to earlier subscriptions).
    Subscribe = "subscribe" (SubscribeParams) -> Subscribed;
    Unsubscribe = "unsubscribe" (UnsubscribeParams) -> Subscribed;
    /// Start dictation when idle, stop it when recording.
    Toggle = "dictation.toggle" (ToggleParams) -> DictationReply;
    /// Abandon the current dictation. Succeeds when idle too.
    Cancel = "dictation.cancel" (CancelParams) -> DictationReply;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol: u32,
    /// Who is connecting: "ui", "cli", "pill", … Free text, for logs.
    pub client: String,
    #[serde(default)]
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: u32,
    pub daemon_version: String,
    pub mode: DaemonMode,
    /// The methods this daemon serves.
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GetStateParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SubscribeParams {
    pub topics: Vec<Topic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct UnsubscribeParams {
    pub topics: Vec<Topic>,
}

/// The topics the connection is subscribed to now. Topics this daemon does not
/// know are left out rather than refused, so a newer UI can ask for more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Subscribed {
    pub topics: Vec<Topic>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ToggleParams {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CancelParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationReply {
    /// The phase after the request.
    pub phase: DictationPhase,
    pub job: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    Dictation,
    Hotkey,
    Insert,
    Settings,
    History,
    Vocabulary,
    Models,
    /// Fast download progress, separate from `models` so the models list is not
    /// resent many times per second.
    Downloads,
    Radio,
    Voice,
    /// Microphone level while recording, about 30 per second.
    Levels,
    /// A topic from a newer protocol revision; ignored.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

impl Topic {
    pub const ALL: [Topic; 11] = [
        Topic::Dictation,
        Topic::Hotkey,
        Topic::Insert,
        Topic::Settings,
        Topic::History,
        Topic::Vocabulary,
        Topic::Models,
        Topic::Downloads,
        Topic::Radio,
        Topic::Voice,
        Topic::Levels,
    ];
}

/// A state change, sent to connections subscribed to its topic.
// Events are built, serialized once and dropped; boxing the big sections would
// only add noise at every construction site.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Dictation {
        state: DictationState,
    },
    Hotkey {
        state: HotkeyState,
    },
    Insert {
        state: InsertState,
    },
    Settings {
        settings: Settings,
    },
    History {
        page: HistoryPage,
    },
    Vocabulary {
        vocabulary: Vocabulary,
    },
    Models {
        models: ModelsState,
    },
    Download {
        download: Download,
    },
    Radio {
        radio: RadioState,
    },
    Voice {
        voice: VoiceState,
    },
    /// Microphone level, 0..1.
    Level {
        level: f32,
    },
    /// Sent to every subscriber: `missed` events were dropped because this
    /// connection read too slowly. Re-read `state.get`.
    Lagged {
        missed: u64,
    },
    /// Sent to every subscriber: the daemon is stopping.
    ShuttingDown,
}

impl Event {
    /// The topic a connection must subscribe to; `None` goes to every subscriber.
    pub fn topic(&self) -> Option<Topic> {
        Some(match self {
            Event::Dictation { .. } => Topic::Dictation,
            Event::Hotkey { .. } => Topic::Hotkey,
            Event::Insert { .. } => Topic::Insert,
            Event::Settings { .. } => Topic::Settings,
            Event::History { .. } => Topic::History,
            Event::Vocabulary { .. } => Topic::Vocabulary,
            Event::Models { .. } => Topic::Models,
            Event::Download { .. } => Topic::Downloads,
            Event::Radio { .. } => Topic::Radio,
            Event::Voice { .. } => Topic::Voice,
            Event::Level { .. } => Topic::Levels,
            Event::Lagged { .. } | Event::ShuttingDown => return None,
        })
    }
}

/// Stable error codes. Clients branch on these, never on `message`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The line is not valid JSON (or not UTF-8).
    ParseError,
    /// Valid JSON, but not a request object with a numeric `id` and a `method`.
    InvalidRequest,
    /// The line exceeded the size limit and was dropped.
    LineTooLong,
    UnknownMethod,
    InvalidParams,
    /// `hello` named a protocol this daemon does not speak; see `data`.
    VersionMismatch,
    /// A request came before `hello`.
    HandshakeRequired,
    /// The feature is not available in this daemon (mode, missing model, …).
    NotAvailable,
    /// The request conflicts with work in progress; retry later.
    Busy,
    Internal,
    /// A code from a newer daemon.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ApiError {
    pub code: ErrorCode,
    /// For people, not for branching.
    pub message: String,
    /// Structured details, like the two versions for `version_mismatch`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown", optional)]
    pub data: Option<Value>,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = serde_json::to_value(self.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown".into());
        write!(f, "{} ({code})", self.message)
    }
}

impl std::error::Error for ApiError {}

/// Checks a client's `hello` against this build.
pub fn check_protocol(client: u32) -> Result<(), ApiError> {
    if client == crate::PROTOCOL_VERSION {
        return Ok(());
    }
    let daemon = crate::PROTOCOL_VERSION;
    let advice = if client > daemon {
        "the daemon is older than this client; restart it after updating (systemctl --user restart delulu)"
    } else {
        "this client is older than the daemon; update or restart it"
    };
    Err(ApiError::new(
        ErrorCode::VersionMismatch,
        format!(
            "protocol version mismatch: client speaks {client}, daemon speaks {daemon}; {advice}"
        ),
    )
    .with_data(serde_json::json!({ "client": client, "daemon": daemon })))
}

/// A request line as sent by a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RequestMessage {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    #[ts(type = "unknown", optional)]
    pub params: Value,
}

impl RequestMessage {
    pub fn new(id: u64, request: &Request) -> Self {
        Self {
            id,
            method: request.method().into(),
            params: request.params(),
        }
    }
}

/// Reads one request line. On failure returns the request id when one could be
/// read, so the error reply can still carry it.
pub fn parse_request(line: &str) -> Result<(u64, Request), (Option<u64>, ApiError)> {
    let value: Value = serde_json::from_str(line).map_err(|e| {
        (
            None,
            ApiError::new(ErrorCode::ParseError, format!("not JSON: {e}")),
        )
    })?;
    let Value::Object(mut object) = value else {
        return Err((
            None,
            ApiError::new(ErrorCode::InvalidRequest, "a request must be a JSON object"),
        ));
    };
    let id = object.get("id").and_then(Value::as_u64);
    let Some(id) = id else {
        return Err((
            None,
            ApiError::new(ErrorCode::InvalidRequest, "a request needs a numeric id"),
        ));
    };
    let Some(Value::String(method)) = object.remove("method") else {
        return Err((
            Some(id),
            ApiError::new(ErrorCode::InvalidRequest, "a request needs a method name"),
        ));
    };
    let params = object.remove("params").unwrap_or(Value::Null);
    Request::parse(&method, params)
        .map(|request| (id, request))
        .map_err(|e| (Some(id), e))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ResultMessage {
    pub id: u64,
    #[ts(type = "unknown")]
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ErrorMessage {
    pub id: Option<u64>,
    pub error: ApiError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EventMessage {
    pub seq: u64,
    pub event: Event,
}

/// Any line the daemon sends.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum ServerMessage {
    Result(ResultMessage),
    Error(ErrorMessage),
    Event(EventMessage),
}

impl<'de> Deserialize<'de> for ServerMessage {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("a server message must be a JSON object"))?;
        let message = if object.contains_key("event") {
            serde_json::from_value(value).map(ServerMessage::Event)
        } else if object.contains_key("error") {
            serde_json::from_value(value).map(ServerMessage::Error)
        } else if object.contains_key("result") {
            serde_json::from_value(value).map(ServerMessage::Result)
        } else {
            return Err(D::Error::custom(
                "a server message needs a result, error or event",
            ));
        };
        message.map_err(D::Error::custom)
    }
}

impl ServerMessage {
    pub fn reply(id: u64, result: Result<Value, ApiError>) -> Self {
        match result {
            Ok(result) => ServerMessage::Result(ResultMessage { id, result }),
            Err(error) => ServerMessage::Error(ErrorMessage {
                id: Some(id),
                error,
            }),
        }
    }
    /// One line, newline included.
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("server messages serialize");
        line.push('\n');
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_round_trip_through_their_wire_form() {
        let requests = [
            HelloParams {
                protocol: 1,
                client: "cli".into(),
                client_version: Some("1.5.0".into()),
            }
            .into_request(),
            GetStateParams {}.into_request(),
            SubscribeParams {
                topics: vec![Topic::Dictation, Topic::Levels],
            }
            .into_request(),
            ToggleParams {}.into_request(),
        ];
        assert_eq!(METHODS.len(), 6);
        for request in requests {
            let line = serde_json::to_string(&RequestMessage::new(9, &request)).unwrap();
            assert_eq!(parse_request(&line), Ok((9, request)));
        }
    }

    #[test]
    fn unknown_fields_are_tolerated() {
        let line = r#"{"id":1,"method":"hello","trace":"x","params":{"protocol":1,"client":"ui","future":true}}"#;
        let (_, request) = parse_request(line).unwrap();
        assert!(matches!(
            request,
            Request::Hello(HelloParams { protocol: 1, .. })
        ));
        // A newer daemon's reply with extra fields still reads.
        let reply: ServerMessage = serde_json::from_value(json!({
            "id": 1, "extra": 1,
            "error": {"code": "busy", "message": "m", "hint": "new"}
        }))
        .unwrap();
        assert!(matches!(
            reply,
            ServerMessage::Error(ErrorMessage {
                error: ApiError {
                    code: ErrorCode::Busy,
                    ..
                },
                ..
            })
        ));
    }

    #[test]
    fn missing_or_null_params_mean_empty() {
        assert_eq!(
            parse_request(r#"{"id":2,"method":"state.get"}"#),
            Ok((2, Request::GetState(GetStateParams {})))
        );
        assert_eq!(
            parse_request(r#"{"id":2,"method":"dictation.toggle","params":null}"#),
            Ok((2, Request::Toggle(ToggleParams {})))
        );
    }

    #[test]
    fn bad_requests_get_stable_codes_and_keep_the_id_when_known() {
        let code = |line: &str| parse_request(line).unwrap_err();
        assert_eq!(code("{nope").0, None);
        assert_eq!(code("{nope").1.code, ErrorCode::ParseError);
        assert_eq!(code("[1,2]").1.code, ErrorCode::InvalidRequest);
        assert_eq!(
            code(r#"{"method":"hello"}"#).1.code,
            ErrorCode::InvalidRequest
        );
        let (id, e) = code(r#"{"id":3,"method":"radio.explode"}"#);
        assert_eq!((id, e.code), (Some(3), ErrorCode::UnknownMethod));
        let (id, e) = code(r#"{"id":4,"method":"hello","params":{"protocol":"one"}}"#);
        assert_eq!((id, e.code), (Some(4), ErrorCode::InvalidParams));
    }

    #[test]
    fn version_mismatch_says_both_versions() {
        assert!(check_protocol(crate::PROTOCOL_VERSION).is_ok());
        let e = check_protocol(crate::PROTOCOL_VERSION + 1).unwrap_err();
        assert_eq!(e.code, ErrorCode::VersionMismatch);
        assert!(
            e.message.contains("client speaks 2, daemon speaks 1"),
            "{}",
            e.message
        );
        assert_eq!(e.data, Some(json!({"client": 2, "daemon": 1})));
    }

    #[test]
    fn unknown_topics_and_codes_from_newer_peers_are_tolerated() {
        let (_, request) = parse_request(
            r#"{"id":1,"method":"subscribe","params":{"topics":["dictation","telepathy"]}}"#,
        )
        .unwrap();
        assert_eq!(
            request,
            Request::Subscribe(SubscribeParams {
                topics: vec![Topic::Dictation, Topic::Unknown]
            })
        );
        let e: ApiError = serde_json::from_value(json!({"code": "quota", "message": "m"})).unwrap();
        assert_eq!(e.code, ErrorCode::Unknown);
    }

    #[test]
    fn server_messages_are_told_apart_by_their_keys() {
        for message in [
            ServerMessage::reply(1, Ok(json!({"phase": "idle", "job": 0}))),
            ServerMessage::reply(2, Err(ApiError::new(ErrorCode::Busy, "busy"))),
            ServerMessage::Error(ErrorMessage {
                id: None,
                error: ApiError::new(ErrorCode::ParseError, "x"),
            }),
            ServerMessage::Event(EventMessage {
                seq: 3,
                event: Event::Lagged { missed: 4 },
            }),
        ] {
            let line = message.to_line();
            assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
            assert_eq!(
                serde_json::from_str::<ServerMessage>(&line).unwrap(),
                message
            );
        }
    }
}
