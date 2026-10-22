//! `electron/ipc/paste.ts`: paste recovery, clipboard, platform facts.

use std::time::Duration;

use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("paste:recovery", |state, _| async move { Ok(state.speech.transcripts.paste_recovery()) })
        .handle("paste:dismissRecovery", |state, args| async move {
            let id: String = args.get(0)?;
            state.speech.transcripts.dismiss_recovery(&id);
            Ok(())
        })
        .handle("paste:copyInstead", |state, args| async move {
            let id: String = args.get(0)?;
            state.speech.copy_instead(&id).await
        })
        .handle("platform:capabilities", |state, _| async move {
            let mut capabilities = delulu_desktop::platform_capabilities(&state.paste, &state.pill);
            let target = delulu_runtime::TargetPlatform::current();
            capabilities.large_speech_available = Some(delulu_runtime::platform::large_speech_supported(&target));
            Ok(capabilities)
        })
        .handle("clipboard:copy", |state, args| async move {
            let text: String = args.get(0)?;
            state.paste.copy(&text, None).await
        })
        .handle("paste:authorize", |state, _| async move { state.paste.authorize().await })
        .handle("paste:test", |state, _| async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            state.paste.paste("Delulu Talks paste test", false, None).await.map(|_| ())
        });
}
