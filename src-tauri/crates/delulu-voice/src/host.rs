//! What the app crate provides. These traits stand in for the Electron
//! `StorageService`/`persistSettings` (owned by `delulu-data` and the app) and
//! the `AsrService` calls `main.ts` made for listening sessions (owned by
//! `delulu-speech`), so this crate does not depend on either.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use delulu_core::{AppPaths, DomainResult};
use delulu_domain::AppSettings;
use serde_json::Value;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Settings and profile access.
pub trait VoiceProfile: Send + Sync {
    /// The current saved settings. Replaces `storage.getSettings()`.
    fn settings(&self) -> AppSettings;

    /// Profile and resource locations. Replaces `storage.dataDirectory`,
    /// `storage.voiceDirectory` (`voice_dir()`), `storage.voiceVenvDirectory`
    /// (`voice_venv()`), `storage.modelCacheDirectory` (`models()`),
    /// `storage.cacheDirectory` (`audio_cache()`), `process.resourcesPath` and
    /// `app.getPath("home")`.
    fn paths(&self) -> &AppPaths;

    /// Validates, saves and applies a partial settings update and returns the
    /// saved settings. Replaces `persistSettings(patch)` in `main.ts`, which
    /// `voice:chooseReference` / `voice:removeReference` call with
    /// `{ voiceClone }`. The implementation runs the app's normal settings
    /// path, including [`crate::VoiceSystem::settings_changed`] and the
    /// `settings:changed` broadcast.
    fn persist_settings(&self, patch: Value) -> BoxFuture<'_, DomainResult<AppSettings>>;
}

/// Transcription for listening sessions; the speech service implements it.
pub trait ListenTranscriber: Send + Sync {
    /// Makes sure speech can be transcribed and loads the model, which stays
    /// loaded while the session runs. Replaces `prepareSpeech` in `main.ts`:
    /// `asr.isEnvironmentReady(settings)` (failing with "Set up a speech model
    /// on the Models page before listening." when it is not) followed by
    /// `asr.ensureLoaded(settings)`.
    ///
    /// The speech service should also keep its model resident while
    /// [`crate::ListeningService::active`] is true (the `canUnload` callback
    /// `main.ts` passed to `AsrService`).
    fn prepare(&self, settings: &AppSettings) -> BoxFuture<'_, DomainResult<()>>;

    /// Transcribes one utterance (a 16 kHz mono WAV the caller deletes
    /// afterwards) and returns its text, or "" when there is none. Replaces
    /// `asr.transcribe({ audioPath, durationMs }, storage.getSettings())`
    /// followed by `result.text`.
    fn transcribe(&self, audio_path: &Path, duration_ms: u64) -> BoxFuture<'_, DomainResult<String>>;
}
