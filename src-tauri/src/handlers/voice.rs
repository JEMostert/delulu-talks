//! `electron/ipc/voice.ts`: voice output, listening sessions, agent setup.

use delulu_domain::voice::VoiceSpeakRequest;

use crate::dialogs::{self, Filter};
use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("voice:status", |state, _| async move { Ok(state.voice.voice().get_status()) })
        .handle("voice:setup", |state, _| async move {
            state.voice.voice().setup(&state.storage.get_settings()).await
        })
        .handle("voice:cancelSetup", |state, _| async move {
            state.voice.voice().cancel_setup().await;
            Ok(())
        })
        .handle("voice:load", |state, _| async move {
            state.voice.voice().load(&state.storage.get_settings()).await
        })
        .handle("voice:unload", |state, _| async move {
            state.voice.voice().unload().await;
            Ok(())
        })
        .handle("voice:speak", |state, args| async move {
            let request: VoiceSpeakRequest = args.get(0)?;
            state.voice.voice().speak(request).await
        })
        .handle("voice:stop", |state, _| async move {
            state.voice.voice().stop("user");
            Ok(())
        })
        .handle("voice:speakClipboard", |state, _| async move { state.voice.speak_clipboard().await })
        .handle("voice:agentSetup", |state, _| async move { Ok(state.voice.agent_setup()) })
        .handle("voice:chooseReference", |state, _| async move {
            let filter = Filter { name: "Audio", extensions: &["wav", "flac", "mp3", "ogg"] };
            let chosen = dialogs::open(&state.app, "Choose a voice clip", filter, false).await;
            let Some(path) = chosen.into_iter().next() else { return Ok(None) };
            state.voice.voice().choose_reference(&path).await.map(Some)
        })
        .handle("voice:removeReference", |state, _| async move { state.voice.voice().remove_reference().await })
        .handle("listen:status", |state, _| async move { Ok(state.voice.listening().get_status()) })
        .handle("listen:start", |state, _| async move { state.voice.listen_start().await })
        .handle("listen:stop", |state, _| async move { Ok(state.voice.listen_stop()) })
        .handle("voice:installSkill", |state, _| async move { state.voice.install_skill() });
}
