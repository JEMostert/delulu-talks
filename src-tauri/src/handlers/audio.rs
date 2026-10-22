//! Native audio devices and the capture-cue test (new in the Tauri app).

use delulu_audio::Cue;

use crate::handlers::blocking;
use crate::ipc::Router;
use crate::state::AppState;

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("audio:inputs", |_, _| async move { blocking(|| Ok(delulu_audio::inputs())).await })
        .handle("audio:outputs", |_, _| async move { blocking(|| Ok(delulu_audio::outputs())).await })
        .handle("audio:testCue", |state, _| async move {
            // A test plays even when cues are muted for dictation.
            let volume = state.storage.get_settings().capture_sound_volume as f32;
            state.cues.play(Cue::Start, volume);
            Ok(())
        });
}
