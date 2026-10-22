//! Small helpers shared by the services.

use std::future::Future;

use delulu_core::{DomainError, DomainResult};
use futures::future::{BoxFuture, FutureExt, Shared};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

/// A plain TypeScript `new Error(message)`: `OPERATION_FAILED`, cause `Error`.
pub(crate) fn plain(message: impl Into<String>) -> DomainError {
    DomainError::failed(message).with_cause("Error", None)
}

/// Converts between wire-identical types owned by different crates.
pub(crate) fn convert<A: Serialize, B: DeserializeOwned>(value: &A) -> Option<B> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// A started operation several callers can await, like a stored JS promise.
pub(crate) type SharedTask = Shared<BoxFuture<'static, DomainResult<()>>>;

/// Spawns `future` at once (promises run eagerly) and shares its result.
pub(crate) fn eager(
    runtime: &tokio::runtime::Handle,
    future: impl Future<Output = DomainResult<()>> + Send + 'static,
) -> SharedTask {
    let handle = runtime.spawn(future);
    async move {
        handle
            .await
            .unwrap_or_else(|error| Err(DomainError::failed(format!("Operation stopped: {error}"))))
    }
    .boxed()
    .shared()
}

/// Runs a closure when dropped (a `finally` block that also covers cancellation).
pub(crate) struct Finally<F: FnMut()>(pub F);

impl<F: FnMut()> Drop for Finally<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

/// At most `max` characters (JavaScript `slice(0, max)` on BMP text).
pub(crate) fn chars(text: &str, max: usize) -> String {
    delulu_core::util::truncate_utf16(text, max).to_owned()
}

/// `Number(value)` when finite, else `fallback`.
pub(crate) fn numeric(value: Option<&Value>, fallback: f64) -> f64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Some(Value::Bool(flag)) => Some(f64::from(u8::from(*flag))),
        Some(Value::Null) => Some(0.0),
        _ => None,
    };
    parsed
        .filter(|number| number.is_finite())
        .unwrap_or(fallback)
}

/// Milliseconds since `started`.
pub(crate) fn elapsed_ms(started: std::time::Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}
