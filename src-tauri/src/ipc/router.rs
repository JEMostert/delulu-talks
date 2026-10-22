//! Channel router behind the three Tauri commands the renderer calls.
//!
//! The renderer keeps the Electron channel names (`settings:update`, …) and
//! positional arguments. Every request is validated twice: by the renderer's
//! `parseIpcRequest`, and here by `delulu_domain::parse_ipc_request` before a
//! handler sees it. Handlers return JSON; failures become a `DomainFailure`
//! in the same envelope the Electron registrar produced.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use delulu_core::{uuid, DomainError, DomainErrorCode, DomainResult, Envelope};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

type InvokeHandler<C> = Arc<dyn Fn(Arc<C>, Args) -> BoxFuture<DomainResult<Value>> + Send + Sync>;
type BytesHandler<C> = Arc<dyn Fn(Arc<C>, Args) -> BoxFuture<DomainResult<Vec<u8>>> + Send + Sync>;
type SendHandler<C> = Arc<dyn Fn(Arc<C>, Args) + Send + Sync>;

/// Validated positional arguments.
pub struct Args(Vec<Value>);

impl Args {
    pub fn new(values: Vec<Value>) -> Self {
        Self(values)
    }
    /// Deserializes argument `index`; a missing argument reads as `null`.
    pub fn get<T: DeserializeOwned>(&self, index: usize) -> DomainResult<T> {
        let value = self.0.get(index).cloned().unwrap_or(Value::Null);
        serde_json::from_value(value)
            .map_err(|error| DomainError::invalid(format!("Invalid argument {}: {error}", index + 1)))
    }
    pub fn raw(&self, index: usize) -> Option<&Value> {
        self.0.get(index)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub type Validator = fn(&str, Vec<Value>) -> DomainResult<Vec<Value>>;

pub struct Router<C> {
    invoke: HashMap<&'static str, InvokeHandler<C>>,
    bytes: HashMap<&'static str, BytesHandler<C>>,
    send: HashMap<&'static str, SendHandler<C>>,
    validate: Validator,
}

impl<C: Send + Sync + 'static> Router<C> {
    pub fn new(validate: Validator) -> Self {
        Self { invoke: HashMap::new(), bytes: HashMap::new(), send: HashMap::new(), validate }
    }

    /// Registers a request/response channel.
    pub fn handle<F, Fut, T>(&mut self, channel: &'static str, handler: F) -> &mut Self
    where
        F: Fn(Arc<C>, Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = DomainResult<T>> + Send + 'static,
        T: Serialize,
    {
        let handler = Arc::new(handler);
        let previous = self.invoke.insert(
            channel,
            Arc::new(move |ctx, args| {
                let future = handler(ctx, args);
                Box::pin(async move { serde_json::to_value(future.await?).map_err(DomainError::from) })
            }),
        );
        assert!(previous.is_none(), "duplicate IPC channel {channel}");
        self
    }

    /// Registers a channel whose response is a raw byte buffer.
    pub fn handle_bytes<F, Fut>(&mut self, channel: &'static str, handler: F) -> &mut Self
    where
        F: Fn(Arc<C>, Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = DomainResult<Vec<u8>>> + Send + 'static,
    {
        let handler = Arc::new(handler);
        self.bytes.insert(channel, Arc::new(move |ctx, args| Box::pin(handler(ctx, args))));
        self
    }

    /// Registers a fire-and-forget channel.
    pub fn on<F>(&mut self, channel: &'static str, handler: F) -> &mut Self
    where
        F: Fn(Arc<C>, Args) + Send + Sync + 'static,
    {
        self.send.insert(channel, Arc::new(handler));
        self
    }

    pub async fn invoke(&self, ctx: Arc<C>, trusted: bool, channel: &str, args: Vec<Value>) -> Envelope<Value> {
        let operation_id = uuid();
        let result = async {
            if !trusted {
                return Err(DomainError::new(DomainErrorCode::UntrustedSender, "Untrusted IPC sender"));
            }
            let handler = self
                .invoke
                .get(channel)
                .ok_or_else(|| DomainError::invalid(format!("Unknown IPC channel {channel}")))?
                .clone();
            let args = (self.validate)(channel, args)?;
            handler(ctx, Args(args)).await
        }
        .await;
        match result {
            Ok(value) => Envelope::ok(value),
            Err(error) => Envelope::err(error.to_failure(&operation_id, channel)),
        }
    }

    pub async fn invoke_bytes(&self, ctx: Arc<C>, trusted: bool, channel: &str, args: Vec<Value>) -> DomainResult<Vec<u8>> {
        if !trusted {
            return Err(DomainError::new(DomainErrorCode::UntrustedSender, "Untrusted IPC sender"));
        }
        let handler = self
            .bytes
            .get(channel)
            .ok_or_else(|| DomainError::invalid(format!("Unknown IPC channel {channel}")))?
            .clone();
        let args = (self.validate)(channel, args)?;
        handler(ctx, Args(args)).await
    }

    /// Fire-and-forget payloads cannot reject a caller promise, so untrusted
    /// senders and invalid input are ignored.
    pub fn send(&self, ctx: Arc<C>, trusted: bool, channel: &str, args: Vec<Value>) {
        if !trusted {
            return;
        }
        let Some(handler) = self.send.get(channel) else { return };
        if let Ok(args) = (self.validate)(channel, args) {
            handler(ctx, Args(args));
        }
    }

    pub fn channels(&self) -> impl Iterator<Item = &&'static str> {
        self.invoke.keys().chain(self.bytes.keys()).chain(self.send.keys())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accept(_: &str, args: Vec<Value>) -> DomainResult<Vec<Value>> {
        Ok(args)
    }

    fn reject(_: &str, _: Vec<Value>) -> DomainResult<Vec<Value>> {
        Err(DomainError::invalid("bad"))
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    #[test]
    fn invokes_and_wraps_results() {
        let mut router = Router::<()>::new(accept);
        router.handle("math:add", |_, args| async move { Ok(args.get::<i64>(0)? + args.get::<i64>(1)?) });
        let ok = block_on(router.invoke(Arc::new(()), true, "math:add", vec![2.into(), 3.into()]));
        assert_eq!(serde_json::to_value(ok).unwrap()["value"], 5);
        let bad = block_on(router.invoke(Arc::new(()), true, "math:add", vec!["x".into()]));
        assert_eq!(serde_json::to_value(bad).unwrap()["error"]["code"], "INVALID_REQUEST");
    }

    #[test]
    fn rejects_untrusted_unknown_and_invalid_requests() {
        let mut router = Router::<()>::new(reject);
        router.handle("a:b", |_, _| async { Ok(1) });
        let untrusted = serde_json::to_value(block_on(router.invoke(Arc::new(()), false, "a:b", vec![]))).unwrap();
        assert_eq!(untrusted["error"]["code"], "UNTRUSTED_SENDER");
        assert_eq!(untrusted["error"]["operation"], "a:b");
        let unknown = serde_json::to_value(block_on(router.invoke(Arc::new(()), true, "x:y", vec![]))).unwrap();
        assert_eq!(unknown["error"]["code"], "INVALID_REQUEST");
        let invalid = serde_json::to_value(block_on(router.invoke(Arc::new(()), true, "a:b", vec![]))).unwrap();
        assert_eq!(invalid["error"]["message"], "bad");
    }
}
