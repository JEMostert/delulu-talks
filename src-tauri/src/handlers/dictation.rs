//! `electron/ipc/dictation.ts`. Capture events no longer come from the
//! renderer: the native recorder reports to the dictation service directly.

use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("dictation:pasteLast", |state, _| async move { state.speech.schedule_paste_last() })
        .handle("dictation:pasteLastStatus", |state, _| async move { Ok(state.speech.paste_last.status()) })
        .handle("dictation:cancelPasteLast", |state, args| async move {
            let id: String = args.get(0)?;
            Ok(state.speech.paste_last.cancel(&id, "Scheduled paste cancelled."))
        })
        .handle("dictation:discardFailed", |state, _| async move {
            state.speech.dictation.discard_failure();
            Ok(())
        })
        .handle("dictation:retry", |state, _| async move { state.speech.dictation.retry().await })
        .handle("dictation:start", |state, _| async move {
            state.speech.dictation.start();
            Ok(())
        })
        .handle("dictation:stop", |state, _| async move {
            state.speech.dictation.stop();
            Ok(())
        })
        .handle("dictation:toggle", |state, _| async move {
            state.speech.dictation.toggle();
            Ok(())
        })
        .handle("dictation:pause", |state, _| async move {
            state.speech.dictation.pause();
            Ok(())
        })
        .handle("dictation:resume", |state, _| async move {
            state.speech.dictation.resume();
            Ok(())
        })
        .handle("dictation:cancel", |state, _| async move {
            state.speech.dictation.cancel();
            Ok(())
        });
}
