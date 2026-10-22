//! Delayed paste of the latest transcript (`electron/services/pasteLast.ts`).
//! The countdown is cancellable until delivery starts; a recording or a
//! changed/removed transcript cancels it.

use std::sync::Arc;
use std::time::Duration;

use delulu_core::DomainResult;
use delulu_desktop::{is_clipboard_copy_error, DeliveryTimings};
use delulu_domain::{DeliveryState, PasteLastPhase, PasteLastStatus};
use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::ports::Delivery;
use crate::support::{chars, plain};

/// The delivered text of a record that still exists.
pub type CurrentText = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// `(record id, state, detail, method)`.
pub type RecordDelivery =
    Arc<dyn Fn(&str, DeliveryState, Option<String>, Option<String>) + Send + Sync>;

pub struct PasteLastPorts {
    pub capture_active: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The delivered text of a record that still exists.
    pub current_text: CurrentText,
    pub delivery: Arc<dyn Delivery>,
    /// Records the delivery outcome on the transcript.
    pub record: RecordDelivery,
    /// Publishes the status (`dictation:pasteLastChanged`).
    pub changed: Arc<dyn Fn(&PasteLastStatus) + Send + Sync>,
}

struct State {
    status: PasteLastStatus,
    timer: Option<JoinHandle<()>>,
}

struct Inner {
    ports: PasteLastPorts,
    runtime: Handle,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct PasteLastService {
    inner: Arc<Inner>,
}

impl PasteLastService {
    /// Must be created inside a Tokio runtime.
    pub fn new(ports: PasteLastPorts) -> Self {
        Self {
            inner: Arc::new(Inner {
                ports,
                runtime: Handle::current(),
                state: Mutex::new(State {
                    status: PasteLastStatus {
                        phase: PasteLastPhase::Idle,
                        operation_id: None,
                        due_at: None,
                        remaining_seconds: 0.0,
                        message: String::new(),
                    },
                    timer: None,
                }),
            }),
        }
    }

    /// `dictation:pasteLastStatus`.
    pub fn status(&self) -> PasteLastStatus {
        self.inner.state.lock().status.clone()
    }

    fn publish(&self, patch: impl FnOnce(&mut PasteLastStatus)) {
        let status = {
            let mut state = self.inner.state.lock();
            patch(&mut state.status);
            state.status.clone()
        };
        (self.inner.ports.changed)(&status);
    }

    fn clear_timer(&self) {
        if let Some(timer) = self.inner.state.lock().timer.take() {
            timer.abort();
        }
    }

    /// Schedules `text` of `record_id` to paste after `delay_seconds`.
    pub fn start(
        &self,
        record_id: &str,
        text: &str,
        delay_seconds: f64,
    ) -> DomainResult<PasteLastStatus> {
        if matches!(
            self.status().phase,
            PasteLastPhase::Pending | PasteLastPhase::Delivering
        ) {
            return Err(plain(
                "A paste is already scheduled or being attempted. Cancel the countdown before scheduling another.",
            ));
        }
        if (self.inner.ports.capture_active)() {
            return Err(plain("Finish the current recording first"));
        }
        if delay_seconds.fract() != 0.0 || !(1.0..=30.0).contains(&delay_seconds) {
            return Err(plain(
                "Paste delay must be a whole number from 1 to 30 seconds",
            ));
        }
        self.clear_timer();
        let operation_id = delulu_core::uuid();
        let due_at = delulu_core::now_ms() + delay_seconds as u64 * 1000;
        // The countdown runs on the monotonic clock; `dueAt` is for display.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(delay_seconds as u64);
        self.publish(|status| {
            *status = PasteLastStatus {
                phase: PasteLastPhase::Pending,
                operation_id: Some(operation_id.clone()),
                due_at: Some(due_at),
                remaining_seconds: delay_seconds,
                message: "Focus the intended text field. You can cancel until the countdown ends."
                    .into(),
            }
        });
        let this = self.clone();
        let record_id = record_id.to_owned();
        let text = text.to_owned();
        let timer = self.inner.runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            interval.tick().await;
            loop {
                interval.tick().await;
                if !this.tick(&operation_id, &record_id, &text, deadline).await {
                    return;
                }
            }
        });
        self.inner.state.lock().timer = Some(timer);
        Ok(self.status())
    }

    /// One countdown step; `false` ends the timer.
    async fn tick(
        &self,
        operation_id: &str,
        record_id: &str,
        text: &str,
        deadline: tokio::time::Instant,
    ) -> bool {
        let status = self.status();
        if status.operation_id.as_deref() != Some(operation_id)
            || status.phase != PasteLastPhase::Pending
        {
            return false;
        }
        if (self.inner.ports.capture_active)() {
            self.cancel(operation_id, "Paste cancelled because a recording started.");
            return false;
        }
        if (self.inner.ports.current_text)(record_id).as_deref() != Some(text) {
            self.cancel(
                operation_id,
                "Paste cancelled because the transcript was removed or changed.",
            );
            return false;
        }
        let left = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis() as u64;
        let remaining = left.div_ceil(1000) as f64;
        if remaining != status.remaining_seconds {
            self.publish(|status| status.remaining_seconds = remaining);
        }
        if remaining > 0.0 {
            return true;
        }
        // The timer ends here; detach it so delivery is not aborted with it.
        self.inner.state.lock().timer = None;
        self.publish(|status| {
            status.phase = PasteLastPhase::Delivering;
            status.due_at = None;
            status.message =
                "Attempting delivery. Cancellation is no longer available once delivery starts."
                    .into();
        });
        self.deliver(operation_id, text, record_id).await;
        false
    }

    async fn deliver(&self, operation_id: &str, text: &str, record_id: &str) {
        let ports = &self.inner.ports;
        let clipboard_only = ports.delivery.clipboard_only();
        let mut timings = DeliveryTimings::default();
        let result = if clipboard_only {
            ports.delivery.copy(text, &mut timings).await.map(|_| None)
        } else {
            ports
                .delivery
                .paste(text, false, &mut timings)
                .await
                .map(Some)
        };
        let current = || self.status().operation_id.as_deref() == Some(operation_id);
        match result {
            Ok(None) => {
                (ports.record)(record_id, DeliveryState::Copied, None, None);
                self.publish(|status| {
                    status.phase = PasteLastPhase::Copied;
                    status.message = "Copied to clipboard. Automatic paste is unavailable on this desktop; paste manually in the intended field.".into();
                });
            }
            Ok(Some(method)) => {
                (ports.record)(
                    record_id,
                    DeliveryState::PasteAttempted,
                    Some("Paste command sent; destination receipt is not confirmed".into()),
                    Some(method),
                );
                if current() {
                    self.publish(|status| {
                        status.phase = PasteLastPhase::Attempted;
                        status.message = "Paste keystrokes sent. Check the intended field; the destination has not confirmed insertion.".into();
                    });
                }
            }
            Err(error) => {
                let state = if clipboard_only || is_clipboard_copy_error(&error) {
                    DeliveryState::Transcribed
                } else {
                    DeliveryState::Copied
                };
                (ports.record)(record_id, state, Some(chars(&error.message, 500)), None);
                if current() {
                    self.publish(|status| {
                        status.phase = PasteLastPhase::Error;
                        status.message = error.message.clone();
                    });
                }
            }
        }
    }

    /// `dictation:cancelPasteLast`. Only a pending countdown can be cancelled.
    pub fn cancel(&self, operation_id: &str, message: &str) -> PasteLastStatus {
        let status = self.status();
        if status.operation_id.as_deref() != Some(operation_id)
            || status.phase != PasteLastPhase::Pending
        {
            return status;
        }
        self.clear_timer();
        self.publish(|status| {
            status.phase = PasteLastPhase::Cancelled;
            status.due_at = None;
            status.remaining_seconds = 0.0;
            status.message = message.to_owned();
        });
        self.status()
    }

    pub fn cancel_pending(&self, message: &str) {
        if let Some(operation_id) = self.status().operation_id {
            self.cancel(&operation_id, message);
        }
    }

    pub fn shutdown(&self) {
        self.clear_timer();
    }
}
