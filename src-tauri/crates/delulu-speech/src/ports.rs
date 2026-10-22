//! Seams between the dictation pipeline and the concrete services, so the
//! state machine can be tested with fakes. Each has an implementation for
//! the real type: [`SpeechEngine`] for [`crate::AsrService`], [`Capture`] for
//! [`delulu_audio::Recorder`], [`Delivery`] for [`delulu_desktop::PasteService`]
//! and [`Indicator`] for [`delulu_desktop::PillService`].

use async_trait::async_trait;
use delulu_audio::{Recorder, RecorderOptions, Recording};
use delulu_core::DomainResult;
use delulu_desktop::{DeliveryTimings, OverlayMethod, PasteService, PillCommand, PillService};
use delulu_domain::{
    AppSettings, DictationPhase, DictationStatus, MagicRewriteRequest, MagicRewriteResult,
    RetryAudioState,
};
use serde_json::Value;

/// The speech runtime as dictation sees it (the `AsrService` methods
/// `dictation.ts` called).
#[async_trait]
pub trait SpeechEngine: Send + Sync {
    fn status(&self) -> DictationStatus;
    fn is_busy(&self) -> bool;
    fn set_activity(&self, phase: DictationPhase, message: &str, detail: Option<&str>);
    fn set_recovery(&self, available: bool, retry_audio: RetryAudioState);
    fn set_capture_input_notice(&self, message: Option<&str>);
    fn set_silence_countdown(&self, remaining_seconds: Option<f64>);
    /// `{ audioPath, durationMs? }` → the worker result plus timings.
    async fn transcribe(&self, payload: Value, settings: &AppSettings) -> DomainResult<Value>;
    async fn rewrite(
        &self,
        request: MagicRewriteRequest,
        settings: &AppSettings,
    ) -> DomainResult<MagicRewriteResult>;
}

/// Microphone capture. `pause`, `resume` and `stop` block; the service calls
/// them on blocking threads.
pub trait Capture: Send + Sync {
    fn start(&self, options: RecorderOptions) -> DomainResult<()>;
    fn pause(&self, session_id: &str) -> DomainResult<()>;
    fn resume(&self, session_id: &str) -> DomainResult<()>;
    fn stop(&self, session_id: &str) -> DomainResult<Recording>;
    fn cancel(&self, session_id: &str);
}

impl Capture for Recorder {
    fn start(&self, options: RecorderOptions) -> DomainResult<()> {
        Recorder::start(self, options)
    }
    fn pause(&self, session_id: &str) -> DomainResult<()> {
        Recorder::pause(self, session_id)
    }
    fn resume(&self, session_id: &str) -> DomainResult<()> {
        Recorder::resume(self, session_id)
    }
    fn stop(&self, session_id: &str) -> DomainResult<Recording> {
        Recorder::stop(self, session_id)
    }
    fn cancel(&self, session_id: &str) {
        Recorder::cancel(self, Some(session_id))
    }
}

/// Clipboard and paste delivery (`DesktopPasteAdapter`).
#[async_trait]
pub trait Delivery: Send + Sync {
    fn is_busy(&self) -> bool;
    /// Returns the paste method. Clipboard failures carry the
    /// `ClipboardCopyError` cause ([`delulu_desktop::is_clipboard_copy_error`]).
    async fn paste(
        &self,
        text: &str,
        restore_clipboard: bool,
        timings: &mut DeliveryTimings,
    ) -> DomainResult<String>;
    async fn copy(&self, text: &str, timings: &mut DeliveryTimings) -> DomainResult<()>;
    /// `capabilities().pasteMethod === "clipboard-only"`.
    fn clipboard_only(&self) -> bool;
}

#[async_trait]
impl Delivery for PasteService {
    fn is_busy(&self) -> bool {
        PasteService::is_busy(self)
    }
    async fn paste(
        &self,
        text: &str,
        restore_clipboard: bool,
        timings: &mut DeliveryTimings,
    ) -> DomainResult<String> {
        PasteService::paste(self, text, restore_clipboard, Some(timings)).await
    }
    async fn copy(&self, text: &str, timings: &mut DeliveryTimings) -> DomainResult<()> {
        PasteService::copy(self, text, Some(timings)).await
    }
    fn clipboard_only(&self) -> bool {
        self.capabilities(OverlayMethod::Unavailable, None)
            .paste_method
            == "clipboard-only"
    }
}

/// The recording pill (`DesktopIndicatorAdapter`).
pub trait Indicator: Send + Sync {
    fn show(&self, command: PillCommand);
    fn hide(&self);
    fn level(&self, value: f64);
}

impl Indicator for PillService {
    fn show(&self, command: PillCommand) {
        PillService::show(self, command)
    }
    fn hide(&self) {
        PillService::hide(self)
    }
    fn level(&self, value: f64) {
        PillService::level(self, value)
    }
}
