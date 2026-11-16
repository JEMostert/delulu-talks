//! The application state snapshot: everything the UI renders.
//!
//! `state.get` returns an [`AppState`]; subscriptions then deliver the changed
//! section as an [`crate::api::Event`]. A section that is `null` is not served by
//! this daemon (yet); the UI shows it as unavailable rather than empty.
//!
//! Times are milliseconds since the Unix epoch; sizes are bytes; durations are
//! milliseconds unless a name says otherwise.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// The `seq` of the last event this snapshot already reflects. A client that
    /// subscribes before reading the snapshot drops events with a `seq` at or below it.
    pub seq: u64,
    pub daemon: DaemonInfo,
    pub dictation: DictationState,
    pub hotkey: HotkeyState,
    pub insert: InsertState,
    pub settings: Option<Settings>,
    /// The newest history entries (the Home screen's "last 5" and History's first page).
    pub history: Option<HistoryPage>,
    pub vocabulary: Option<Vocabulary>,
    pub models: Option<ModelsState>,
    pub radio: Option<RadioState>,
    pub voice: Option<VoiceState>,
    /// First-run and consent flags from `state.json` and the settings; null
    /// when this daemon does not own them.
    #[serde(default)]
    pub setup: Option<Setup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub first_run_done: bool,
    /// The user agreed to download the cleanup model, so it may start by itself.
    pub cleanup_model_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    /// Daemon version, like "1.5.0".
    pub version: String,
    pub protocol: u32,
    pub mode: DaemonMode,
    pub pid: u32,
    pub started_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DaemonMode {
    Normal,
    /// Canned state and scripted changes; no models, microphone or portals.
    Demo,
}

// ---------------------------------------------------------------- dictation

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DictationPhase {
    Idle,
    Recording,
    Transcribing,
    Cleaning,
    Inserting,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DictationState {
    pub phase: DictationPhase,
    /// Dictation can be started. False while models load or when this daemon
    /// does not run dictation yet; `unavailableReason` says why.
    pub available: bool,
    pub unavailable_reason: Option<String>,
    /// The current (or last) dictation's id; 0 before the first one.
    pub job: u64,
    /// When the current phase began.
    pub phase_since: u64,
    /// How the last dictation ended.
    pub last: Option<DictationOutcome>,
    pub stt: WorkerStatus,
    pub cleanup: WorkerStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DictationOutcome {
    Done {
        job: u64,
        at: u64,
        text: String,
        /// The transcript before cleanup, when cleanup changed it.
        raw: Option<String>,
        delivery: Delivery,
        /// Cleanup failed and the raw transcript was used.
        cleanup_error: Option<String>,
        /// The saved history entry, when history is on.
        history_id: Option<String>,
        /// The text was delivered but could not be saved to History.
        #[serde(default)]
        history_error: Option<String>,
    },
    NothingHeard {
        job: u64,
        at: u64,
    },
    Cancelled {
        job: u64,
        at: u64,
        during: DictationPhase,
    },
    Failed {
        job: u64,
        at: u64,
        during: DictationPhase,
        error: String,
        /// Text that was ready but not inserted, so the UI can offer to copy it.
        text: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Delivery {
    Typed,
    /// Left on the clipboard; `reason` says why it was not typed.
    Copied {
        reason: Option<String>,
    },
    /// Insertion is off.
    Skipped,
}

/// One engine worker as the UI sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatus {
    pub state: WorkerState,
    pub model: Option<String>,
    /// The compute device, like "Vulkan: NVIDIA GeForce RTX 4090".
    pub device: Option<String>,
    pub error: Option<String>,
    /// While the worker's model downloads.
    #[serde(default)]
    pub progress: Option<Progress>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done_bytes: u64,
    pub total_bytes: u64,
}

impl WorkerStatus {
    pub fn off() -> Self {
        Self {
            state: WorkerState::Off,
            model: None,
            device: None,
            error: None,
            progress: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum WorkerState {
    Off,
    Starting,
    Loading,
    Ready,
    Busy,
    Paused,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyState {
    pub bound: bool,
    /// The trigger as the desktop describes it, like "Super+Z".
    pub trigger: Option<String>,
    pub error: Option<String>,
    /// Why the shortcut is not bound, for clients to branch on; `error` says it
    /// for people. Null when bound, or for an older daemon.
    #[serde(default)]
    pub problem: Option<HotkeyProblem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyProblem {
    /// The desktop answered without a key, for example after the first shortcut
    /// dialog was cancelled on KDE. Asking again would not show a dialog; the
    /// user sets the key in the desktop's shortcut settings.
    NotSet,
    /// The Delulu Talks app is running and holds the shortcut itself. The
    /// daemon binds once the app has quit, so a press never dictates twice.
    AppRunning,
    /// First run is not finished, so the daemon opens no permission dialog yet.
    FirstRunPending,
    /// The shortcut portal failed or is switched off; `error` says why.
    Unavailable,
    /// A value from a newer daemon.
    #[serde(other)]
    #[ts(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InsertState {
    /// Typing into other windows is permitted (RemoteDesktop portal granted).
    pub ready: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------- settings

/// Settings, one field per row of the screen list (architecture §4.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Input device id; null = system default.
    pub microphone: Option<String>,
    pub start_at_login: bool,
    /// "auto" or a language code.
    pub language: String,
    /// With "auto": the languages detection may choose from. Empty = any.
    pub languages: Vec<String>,
    pub smart_context: bool,
    pub insert: InsertMode,
    pub restore_clipboard: bool,
    pub cleanup: bool,
    pub theme: Theme,
    /// Show the recording pill.
    pub pill: bool,
    pub sounds: bool,
    pub show_radio: bool,
    pub show_voice: bool,
    /// Days to keep history; null = forever.
    pub history_days: Option<u32>,
    /// The chosen model per role, by registry id.
    pub models: RoleModels,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum InsertMode {
    ShiftInsert,
    CtrlV,
    CtrlShiftV,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RoleModels {
    pub stt: String,
    pub cleanup: Option<String>,
    pub tts: Option<String>,
    pub music: Option<String>,
    pub chat: Option<String>,
}

// ---------------------------------------------------------------- history

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// The search this page answers; null = newest first.
    pub query: Option<String>,
    pub offset: u32,
    /// Matching entries in total, for paging.
    pub total: u32,
    pub entries: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub created_at: u64,
    pub text: String,
    pub raw: Option<String>,
    /// What cleanup thought it was about, like "programming".
    pub topic: Option<String>,
    pub language: String,
    pub model: String,
    pub audio_ms: u64,
    pub stt_ms: u64,
    pub cleanup_ms: Option<u64>,
    /// Key release to text delivered.
    pub total_ms: u64,
}

// ---------------------------------------------------------------- vocabulary

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Vocabulary {
    pub shelves: Vec<Shelf>,
    /// Starter shelves the user has not added yet.
    pub presets: Vec<Preset>,
    /// Distinct terms on enabled shelves.
    pub active_terms: u32,
    /// How many of those the cleanup prompt uses; it caps count and length.
    pub used_terms: u32,
    /// Terms seen in recent dictations that could go on a shelf.
    pub suggested: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub key: String,
    pub name: String,
    pub terms: Vec<String>,
}

// ---------------------------------------------------------------- models

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelsState {
    /// Every model in the registry, grouped by role in the UI.
    pub models: Vec<ModelInfo>,
    pub downloads: Vec<Download>,
    pub gpu: Option<GpuInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelRole {
    Stt,
    Llm,
    Tts,
    Music,
    Chat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub role: ModelRole,
    pub label: String,
    pub bytes: u64,
    pub vram_mb: u32,
    pub license: String,
    /// Needs a one-time licence acknowledgement before download (YuE2).
    pub non_commercial: bool,
    pub languages: Vec<String>,
    pub state: ModelState,
    /// The chosen model for its role.
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModelState {
    Missing,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub model_id: String,
    pub state: DownloadState,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub bytes_per_sec: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DownloadState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub device: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    /// Bytes the app's own loaded models use.
    pub used_by_app_bytes: u64,
}

// ---------------------------------------------------------------- radio

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioState {
    /// The station can run on this machine (engine, model and GPU present).
    pub available: bool,
    pub error: Option<String>,
    pub on_air: bool,
    pub playing: bool,
    /// Silent while you dictate.
    pub held: bool,
    /// 0..1.
    pub volume: f64,
    pub now: Option<RadioItem>,
    /// Seconds into `now`.
    pub position: f64,
    pub queue: Vec<RadioItem>,
    pub history: Vec<RadioItem>,
    pub making: Option<RadioMaking>,
    pub requests: Vec<RadioRequest>,
    pub mix: RadioMix,
    pub stations: Vec<RadioStation>,
    /// Songs kept out of clean-up, newest first.
    pub saved: Vec<RadioItem>,
    pub readiness: Option<RadioReadiness>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RadioKind {
    Song,
    Break,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioItem {
    pub id: String,
    pub kind: RadioKind,
    pub title: String,
    pub subtitle: String,
    pub lyrics: Option<String>,
    pub script: Option<String>,
    pub seconds: f64,
    /// The listener request this answers.
    pub request: Option<String>,
    /// The genre and mood it was drawn with; None for requests and breaks.
    pub genre: Option<String>,
    pub mood: Option<String>,
    /// The genre came from outside the listener's pool.
    pub surprise: bool,
    /// "like" | "dislike"
    pub feedback: Option<String>,
    /// Kept out of clean-up.
    pub saved: bool,
    pub replay: bool,
    pub imported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioMaking {
    pub kind: RadioKind,
    pub step: RadioStep,
    pub title: Option<String>,
    pub request: Option<String>,
    pub since: u64,
    /// Music only: overall 0..1.
    pub progress: Option<f64>,
    /// Music only: the engine's current stage, like "composing".
    pub stage: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RadioStep {
    Writing,
    Music,
    Voice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioRequest {
    pub id: String,
    pub text: String,
    pub created_at: u64,
    pub answered_by: Option<String>,
}

/// One genre or mood of the mix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioChoice {
    pub name: String,
    pub on: bool,
    /// Added by the listener, not from the catalogue.
    pub custom: bool,
}

/// What the listener steers; each song draws one genre and mood from it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioMix {
    pub genres: Vec<RadioChoice>,
    pub moods: Vec<RadioChoice>,
    /// Percent chance (0–100) that a song comes from a genre that is off.
    pub surprise: u32,
    /// "any" | "vocal" | "instrumental"
    pub vocals: String,
    /// "any" | "low" | "medium" | "high"
    pub energy: String,
    /// "any" | "short" | "medium" | "long"
    pub length: String,
    /// "off" | "sometimes" | "often"
    pub host: String,
    pub language: String,
    pub theme: String,
}

/// A named mix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioStation {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    /// The mix sounds like this station now.
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RadioReadiness {
    pub music_engine: bool,
    pub music_model: bool,
    pub gpu: bool,
    pub writer: bool,
    pub voice: bool,
    pub device: Option<String>,
}

// ---------------------------------------------------------------- voice

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    pub available: bool,
    pub tts: WorkerStatus,
    pub conversation: Conversation,
    /// Spoken agent reports, newest first.
    pub reports: Vec<AgentReport>,
    pub muted_agents: Vec<String>,
    pub reports_enabled: bool,
    /// Agent reports may interrupt the radio.
    pub reports_interrupt_radio: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub phase: ConversationPhase,
    /// "agent" or "companion"; null when no session is open.
    pub brain: Option<String>,
    pub voice: Option<String>,
    pub language: Option<String>,
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConversationPhase {
    Closed,
    Listening,
    Thinking,
    Speaking,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub speaker: Speaker,
    pub text: String,
    pub at: u64,
    /// Still being transcribed or spoken.
    pub partial: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Speaker {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReport {
    pub id: String,
    pub agent: String,
    pub project: Option<String>,
    pub text: String,
    pub at: u64,
    pub spoken: bool,
}
