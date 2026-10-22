//! Domain error contract shared with the renderer (`src/domainErrors.ts`).
//!
//! Every IPC invocation resolves to an [`Envelope`]. Failures carry only a
//! safe category: backend messages can contain transcript text or local
//! paths, so the cause keeps a name/code pair and never its message.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DomainErrorCode {
    InvalidRequest,
    UntrustedSender,
    Busy,
    Cancelled,
    Timeout,
    RuntimeSetupTimeout,
    RuntimeSetupFailed,
    OperationInterrupted,
    WorkerUnavailable,
    WorkerExited,
    WorkerProtocol,
    BackendFailure,
    OperationFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryPolicy {
    Never,
    AfterIdle,
    ReloadRuntime,
    RepairRuntime,
    Manual,
}

impl DomainErrorCode {
    pub fn retry(self) -> RetryPolicy {
        use DomainErrorCode::*;
        match self {
            InvalidRequest | UntrustedSender | Cancelled => RetryPolicy::Never,
            Busy => RetryPolicy::AfterIdle,
            Timeout | OperationInterrupted | WorkerExited => RetryPolicy::ReloadRuntime,
            RuntimeSetupTimeout | RuntimeSetupFailed | WorkerUnavailable | WorkerProtocol => {
                RetryPolicy::RepairRuntime
            }
            BackendFailure | OperationFailed => RetryPolicy::Manual,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CancellationEffect {
    #[default]
    None,
    WorkerStopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureCause {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Serialized failure, identical to the TypeScript `DomainFailure`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainFailure {
    pub schema_version: u8,
    pub code: DomainErrorCode,
    pub operation_id: String,
    pub operation: String,
    pub message: String,
    pub retry: RetryPolicy,
    pub cancelled: bool,
    pub cancellation_effect: CancellationEffect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<FailureCause>,
}

/// An error raised by any service. Operation identity is filled in by the IPC
/// router when the error crosses the boundary, unless the service set it.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct DomainError {
    pub code: DomainErrorCode,
    pub message: String,
    pub operation_id: Option<String>,
    pub operation: Option<String>,
    pub cancellation_effect: CancellationEffect,
    pub cause: Option<FailureCause>,
}

const MAX_MESSAGE_CHARS: usize = 2000;

impl DomainError {
    pub fn new(code: DomainErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            operation_id: None,
            operation: None,
            cancellation_effect: CancellationEffect::None,
            cause: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::InvalidRequest, message)
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::Busy, message)
    }
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::Cancelled, message)
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::OperationFailed, message)
    }
    pub fn backend(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::BackendFailure, message)
    }
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(DomainErrorCode::Timeout, message)
    }

    pub fn with_operation(mut self, operation_id: impl Into<String>, operation: impl Into<String>) -> Self {
        self.operation_id = Some(operation_id.into());
        self.operation = Some(operation.into());
        self
    }
    pub fn with_cancellation_effect(mut self, effect: CancellationEffect) -> Self {
        self.cancellation_effect = effect;
        self
    }
    /// Records a safe cause category. `name` must look like `SomethingError`
    /// and `code` like `ENOENT`; anything else is dropped.
    pub fn with_cause(mut self, name: &str, code: Option<&str>) -> Self {
        let safe_name = if is_error_name(name) { name } else { "Error" };
        let safe_code = code.filter(|c| is_error_code(c)).map(str::to_owned);
        self.cause = Some(FailureCause { name: safe_name.to_owned(), code: safe_code });
        self
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == DomainErrorCode::Cancelled
    }

    pub fn to_failure(&self, operation_id: &str, operation: &str) -> DomainFailure {
        DomainFailure {
            schema_version: 1,
            code: self.code,
            operation_id: self.operation_id.clone().unwrap_or_else(|| operation_id.to_owned()),
            operation: self.operation.clone().unwrap_or_else(|| operation.to_owned()),
            message: self.message.chars().take(MAX_MESSAGE_CHARS).collect(),
            retry: self.code.retry(),
            cancelled: self.code == DomainErrorCode::Cancelled,
            cancellation_effect: self.cancellation_effect,
            cause: self.cause.clone(),
        }
    }
}

fn is_error_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && name.ends_with("Error")
        && name.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_error_code(code: &str) -> bool {
    let mut chars = code.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
        && code.len() <= 64
        && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

impl From<std::io::Error> for DomainError {
    fn from(error: std::io::Error) -> Self {
        let code = io_error_code(&error);
        DomainError::failed(error.to_string()).with_cause("IoError", code)
    }
}

impl From<serde_json::Error> for DomainError {
    fn from(error: serde_json::Error) -> Self {
        DomainError::failed(error.to_string()).with_cause("SyntaxError", None)
    }
}

/// Node-style error codes, so diagnostics stay comparable with the old app.
pub fn io_error_code(error: &std::io::Error) -> Option<&'static str> {
    use std::io::ErrorKind::*;
    Some(match error.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        InvalidInput => "EINVAL",
        TimedOut => "ETIMEDOUT",
        BrokenPipe => "EPIPE",
        WouldBlock => "EAGAIN",
        Interrupted => "EINTR",
        StorageFull => "ENOSPC",
        DirectoryNotEmpty => "ENOTEMPTY",
        IsADirectory => "EISDIR",
        NotADirectory => "ENOTDIR",
        _ => return None,
    })
}

pub type DomainResult<T> = Result<T, DomainError>;

/// The IPC result envelope (`OperationResult` in TypeScript).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Envelope<T: Serialize> {
    Ok { transport: &'static str, ok: bool, value: T },
    Err { transport: &'static str, ok: bool, error: DomainFailure },
}

pub const TRANSPORT: &str = "delulu-operation-v1";

impl<T: Serialize> Envelope<T> {
    pub fn ok(value: T) -> Self {
        Envelope::Ok { transport: TRANSPORT, ok: true, value }
    }
    pub fn err(error: DomainFailure) -> Self {
        Envelope::Err { transport: TRANSPORT, ok: false, error }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_matches_typescript_shape() {
        let error = DomainError::busy("Setup is running").with_cause("TypeError", Some("ENOENT"));
        let json = serde_json::to_value(error.to_failure("op-1", "runtime:setup")).unwrap();
        assert_eq!(json["code"], "BUSY");
        assert_eq!(json["retry"], "after-idle");
        assert_eq!(json["cancellationEffect"], "none");
        assert_eq!(json["cause"]["name"], "TypeError");
        assert_eq!(json["cause"]["code"], "ENOENT");
        assert_eq!(json["operationId"], "op-1");
    }

    #[test]
    fn unsafe_cause_fields_are_dropped() {
        let error = DomainError::failed("x").with_cause("my error", Some("/home/me"));
        let cause = error.cause.unwrap();
        assert_eq!(cause.name, "Error");
        assert!(cause.code.is_none());
    }

    #[test]
    fn envelope_serializes_like_operation_result() {
        let ok = serde_json::to_value(Envelope::ok(3)).unwrap();
        assert_eq!(ok, serde_json::json!({"transport":"delulu-operation-v1","ok":true,"value":3}));
        let failure = DomainError::cancelled("stop").to_failure("a", "b");
        let err = serde_json::to_value(Envelope::<()>::err(failure)).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"]["cancelled"], true);
    }
}
