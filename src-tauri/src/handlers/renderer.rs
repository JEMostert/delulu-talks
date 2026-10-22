//! `electron/ipc/renderer.ts`: window visibility and renderer recovery.

use delulu_domain::{RendererRecoveryState, UpdatePhase};

use crate::ipc::Router;
use crate::state::{plain, AppState};

/// `rendererRecoveryState`: read authoritative service state at request time.
pub fn recovery_state(state: &AppState) -> RendererRecoveryState {
    let capture_active = state.speech.dictation.is_active();
    let update_phase = state.updates.status().phase;
    let reason = if capture_active {
        Some("Finish the current capture or transcription before reloading.")
    } else if state.speech.asr.is_busy() {
        Some("Wait for model setup or inference to finish before reloading.")
    } else if state.settings_queue.busy() {
        Some("Wait for pending settings changes to save before reloading.")
    } else if matches!(update_phase, UpdatePhase::Checking | UpdatePhase::Downloading) {
        Some("Wait for the current update operation to finish before reloading.")
    } else {
        None
    };
    RendererRecoveryState {
        can_reload: reason.is_none(),
        reason: reason.map(str::to_owned),
        can_stop_recording: capture_active && state.speech.dictation.can_stop_recording(),
    }
}

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("app:visibility", |state, _| async move { Ok(crate::shell::window_visible(&state.app)) })
        .handle("renderer:recoveryState", |state, _| async move { Ok(recovery_state(&state)) })
        .handle("renderer:reload", |state, _| async move {
            // Check and reload without awaiting, so no operation can slip in between.
            let recovery = recovery_state(&state);
            if let Some(reason) = recovery.reason {
                return Err(plain(reason));
            }
            state.speech.paste_last.cancel_pending("Scheduled paste cancelled because the workspace reloaded.");
            if let Some(window) = crate::shell::main_window(&state.app) {
                window.reload().map_err(|error| plain(error.to_string()))?;
            }
            Ok(())
        })
        .handle("renderer:controllerFailed", |state, _| async move {
            state.speech.paste_last.cancel_pending("Scheduled paste cancelled because the workspace controller failed.");
            Ok(())
        });
}
