// Generated from crates/proto by `UPDATE_GENERATED=1 cargo test -p delulu-proto --test generated`.
// Do not edit by hand.

export const PROTOCOL_VERSION = 1;

export type AppState = { 
/**
 * The `seq` of the last event this snapshot already reflects. A client that
 * subscribes before reading the snapshot drops events with a `seq` at or below it.
 */
seq: number, daemon: DaemonInfo, dictation: DictationState, hotkey: HotkeyState, insert: InsertState, settings: Settings | null, 
/**
 * The newest history entries (the Home screen's "last 5" and History's first page).
 */
history: HistoryPage | null, vocabulary: Vocabulary | null, models: ModelsState | null, radio: RadioState | null, voice: VoiceState | null, 
/**
 * First-run and consent flags from `state.json` and the settings; null
 * when this daemon does not own them.
 */
setup: Setup | null, };

export type DaemonInfo = { 
/**
 * Daemon version, like "1.5.0".
 */
version: string, protocol: number, mode: DaemonMode, pid: number, startedAt: number, };

export type DaemonMode = "normal" | "demo";

export type DictationPhase = "idle" | "recording" | "transcribing" | "cleaning" | "inserting";

export type DictationState = { phase: DictationPhase, 
/**
 * Dictation can be started. False while models load or when this daemon
 * does not run dictation yet; `unavailableReason` says why.
 */
available: boolean, unavailableReason: string | null, 
/**
 * The current (or last) dictation's id; 0 before the first one.
 */
job: number, 
/**
 * When the current phase began.
 */
phaseSince: number, 
/**
 * How the last dictation ended.
 */
last: DictationOutcome | null, stt: WorkerStatus, cleanup: WorkerStatus, };

export type DictationOutcome = { "kind": "done", job: number, at: number, text: string, 
/**
 * The transcript before cleanup, when cleanup changed it.
 */
raw: string | null, delivery: Delivery, 
/**
 * Cleanup failed and the raw transcript was used.
 */
cleanupError: string | null, 
/**
 * The saved history entry, when history is on.
 */
historyId: string | null, 
/**
 * The text was delivered but could not be saved to History.
 */
historyError: string | null, } | { "kind": "nothingHeard", job: number, at: number, } | { "kind": "cancelled", job: number, at: number, during: DictationPhase, } | { "kind": "failed", job: number, at: number, during: DictationPhase, error: string, 
/**
 * Text that was ready but not inserted, so the UI can offer to copy it.
 */
text: string | null, };

export type Delivery = { "kind": "typed" } | { "kind": "copied", reason: string | null, } | { "kind": "skipped" };

/**
 * One engine worker as the UI sees it.
 */
export type WorkerStatus = { state: WorkerState, model: string | null, 
/**
 * The compute device, like "Vulkan: NVIDIA GeForce RTX 4090".
 */
device: string | null, error: string | null, 
/**
 * While the worker's model downloads.
 */
progress: Progress | null, };

export type WorkerState = "off" | "starting" | "loading" | "ready" | "busy" | "paused" | "error";

export type HotkeyState = { bound: boolean, 
/**
 * The trigger as the desktop describes it, like "Super+Z".
 */
trigger: string | null, error: string | null, 
/**
 * Why the shortcut is not bound, for clients to branch on; `error` says it
 * for people. Null when bound, or for an older daemon.
 */
problem: HotkeyProblem | null, };

export type HotkeyProblem = "notSet" | "appRunning" | "firstRunPending" | "unavailable";

export type Setup = { firstRunDone: boolean, 
/**
 * The user agreed to download the cleanup model, so it may start by itself.
 */
cleanupModelOk: boolean, };

export type Progress = { doneBytes: number, totalBytes: number, };

export type InsertState = { 
/**
 * Typing into other windows is permitted (RemoteDesktop portal granted).
 */
ready: boolean, error: string | null, };

/**
 * Settings, one field per row of the screen list (architecture §4.3).
 */
export type Settings = { version: number, 
/**
 * Input device id; null = system default.
 */
microphone: string | null, startAtLogin: boolean, 
/**
 * "auto" or a language code.
 */
language: string, 
/**
 * With "auto": the languages detection may choose from. Empty = any.
 */
languages: Array<string>, smartContext: boolean, insert: InsertMode, restoreClipboard: boolean, cleanup: boolean, theme: Theme, 
/**
 * Show the recording pill.
 */
pill: boolean, sounds: boolean, showRadio: boolean, showVoice: boolean, 
/**
 * Days to keep history; null = forever.
 */
historyDays: number | null, 
/**
 * The chosen model per role, by registry id.
 */
models: RoleModels, };

export type InsertMode = "shift-insert" | "ctrl-v" | "ctrl-shift-v" | "off";

export type Theme = "system" | "light" | "dark";

export type RoleModels = { stt: string, cleanup: string | null, tts: string | null, music: string | null, chat: string | null, };

export type HistoryPage = { 
/**
 * The search this page answers; null = newest first.
 */
query: string | null, offset: number, 
/**
 * Matching entries in total, for paging.
 */
total: number, entries: Array<HistoryEntry>, };

export type HistoryEntry = { id: string, createdAt: number, text: string, raw: string | null, 
/**
 * What cleanup thought it was about, like "programming".
 */
topic: string | null, language: string, model: string, audioMs: number, sttMs: number, cleanupMs: number | null, 
/**
 * Key release to text delivered.
 */
totalMs: number, };

export type Vocabulary = { shelves: Array<Shelf>, 
/**
 * Starter shelves the user has not added yet.
 */
presets: Array<Preset>, 
/**
 * Distinct terms on enabled shelves.
 */
activeTerms: number, 
/**
 * How many of those the cleanup prompt uses; it caps count and length.
 */
usedTerms: number, 
/**
 * Terms seen in recent dictations that could go on a shelf.
 */
suggested: Array<string>, };

export type Shelf = { id: string, name: string, enabled: boolean, terms: Array<string>, };

export type Preset = { key: string, name: string, terms: Array<string>, };

export type ModelsState = { 
/**
 * Every model in the registry, grouped by role in the UI.
 */
models: Array<ModelInfo>, downloads: Array<Download>, gpu: GpuInfo | null, };

export type ModelRole = "stt" | "llm" | "tts" | "music" | "chat";

export type ModelInfo = { id: string, role: ModelRole, label: string, bytes: number, vramMb: number, license: string, 
/**
 * Needs a one-time licence acknowledgement before download (YuE2).
 */
nonCommercial: boolean, languages: Array<string>, state: ModelState, 
/**
 * The chosen model for its role.
 */
active: boolean, };

export type ModelState = "missing" | "downloading" | "ready" | "error";

export type Download = { modelId: string, state: DownloadState, doneBytes: number, totalBytes: number, bytesPerSec: number | null, error: string | null, };

export type DownloadState = "queued" | "running" | "done" | "failed" | "cancelled";

export type GpuInfo = { device: string, totalBytes: number, freeBytes: number, 
/**
 * Bytes the app's own loaded models use.
 */
usedByAppBytes: number, };

export type RadioState = { 
/**
 * The station can run on this machine (engine, model and GPU present).
 */
available: boolean, error: string | null, onAir: boolean, playing: boolean, 
/**
 * Silent while you dictate.
 */
held: boolean, 
/**
 * 0..1.
 */
volume: number, now: RadioItem | null, 
/**
 * Seconds into `now`.
 */
position: number, queue: Array<RadioItem>, history: Array<RadioItem>, making: RadioMaking | null, requests: Array<RadioRequest>, mix: RadioMix, stations: Array<RadioStation>, 
/**
 * Songs kept out of clean-up, newest first.
 */
saved: Array<RadioItem>, readiness: RadioReadiness | null, };

export type RadioKind = "song" | "break";

export type RadioItem = { id: string, kind: RadioKind, title: string, subtitle: string, lyrics: string | null, script: string | null, seconds: number, 
/**
 * The listener request this answers.
 */
request: string | null, 
/**
 * The genre and mood it was drawn with; None for requests and breaks.
 */
genre: string | null, mood: string | null, 
/**
 * The genre came from outside the listener's pool.
 */
surprise: boolean, 
/**
 * "like" | "dislike"
 */
feedback: string | null, 
/**
 * Kept out of clean-up.
 */
saved: boolean, replay: boolean, imported: boolean, };

export type RadioMaking = { kind: RadioKind, step: RadioStep, title: string | null, request: string | null, since: number, 
/**
 * Music only: overall 0..1.
 */
progress: number | null, 
/**
 * Music only: the engine's current stage, like "composing".
 */
stage: string | null, };

export type RadioStep = "writing" | "music" | "voice";

export type RadioRequest = { id: string, text: string, createdAt: number, answeredBy: string | null, };

/**
 * One genre or mood of the mix.
 */
export type RadioChoice = { name: string, on: boolean, 
/**
 * Added by the listener, not from the catalogue.
 */
custom: boolean, };

/**
 * What the listener steers; each song draws one genre and mood from it.
 */
export type RadioMix = { genres: Array<RadioChoice>, moods: Array<RadioChoice>, 
/**
 * Percent chance (0–100) that a song comes from a genre that is off.
 */
surprise: number, 
/**
 * "any" | "vocal" | "instrumental"
 */
vocals: string, 
/**
 * "any" | "low" | "medium" | "high"
 */
energy: string, 
/**
 * "any" | "short" | "medium" | "long"
 */
length: string, 
/**
 * "off" | "sometimes" | "often"
 */
host: string, language: string, theme: string, };

/**
 * A named mix.
 */
export type RadioStation = { id: string, name: string, builtin: boolean, 
/**
 * The mix sounds like this station now.
 */
active: boolean, };

export type RadioReadiness = { musicEngine: boolean, musicModel: boolean, gpu: boolean, writer: boolean, voice: boolean, device: string | null, };

export type VoiceState = { available: boolean, tts: WorkerStatus, conversation: Conversation, 
/**
 * Spoken agent reports, newest first.
 */
reports: Array<AgentReport>, mutedAgents: Array<string>, reportsEnabled: boolean, 
/**
 * Agent reports may interrupt the radio.
 */
reportsInterruptRadio: boolean, };

export type Conversation = { phase: ConversationPhase, 
/**
 * "agent" or "companion"; null when no session is open.
 */
brain: string | null, voice: string | null, language: string | null, turns: Array<Turn>, };

export type ConversationPhase = "closed" | "listening" | "thinking" | "speaking";

export type Turn = { speaker: Speaker, text: string, at: number, 
/**
 * Still being transcribed or spoken.
 */
partial: boolean, };

export type Speaker = "user" | "assistant";

export type AgentReport = { id: string, agent: string, project: string | null, text: string, at: number, spoken: boolean, };

export type HelloParams = { protocol: number, 
/**
 * Who is connecting: "ui", "cli", "pill", … Free text, for logs.
 */
client: string, clientVersion: string | null, };

export type HelloResult = { protocol: number, daemonVersion: string, mode: DaemonMode, 
/**
 * The methods this daemon serves.
 */
methods: Array<string>, 
/**
 * This daemon runs dictation (shortcut, microphone, typing, History), so a
 * window must be its client instead of running dictation itself.
 */
dictation: boolean, };

export type GetStateParams = Record<symbol, never>;

export type SubscribeParams = { topics: Array<Topic>, };

export type UnsubscribeParams = { topics: Array<Topic>, };

/**
 * The topics the connection is subscribed to now. Topics this daemon does not
 * know are left out rather than refused, so a newer UI can ask for more.
 */
export type Subscribed = { topics: Array<Topic>, };

export type ToggleParams = Record<symbol, never>;

export type CancelParams = Record<symbol, never>;

export type HistoryListParams = { 
/**
 * Words to search for; null or empty = all entries.
 */
query: string | null, offset: number, 
/**
 * At most this many entries; 0 means the daemon's default page size.
 */
limit: number, };

/**
 * The reply of a method that only reports success.
 */
export type Acknowledged = Record<symbol, never>;

export type HistoryDeleteParams = { id: string, };

export type HistoryClearParams = Record<symbol, never>;

export type HistoryReinsertParams = { id: string, 
/**
 * Type what was said before cleanup, when the entry has it.
 */
raw: boolean, };

export type SettingsSetParams = { settings: Settings, };

export type SetupFinishParams = Record<symbol, never>;

export type VocabularyGetParams = Record<symbol, never>;

/**
 * One change to the vocabulary shelves.
 */
export type VocabularyChangeParams = { "op": "addShelf", name: string, } | { "op": "addPreset", key: string, } | { "op": "renameShelf", id: string, name: string, } | { "op": "deleteShelf", id: string, } | { "op": "setEnabled", id: string, enabled: boolean, } | { "op": "addTerms", id: string, text: string, } | { "op": "removeTerm", id: string, term: string, };

export type CleanupStartParams = Record<symbol, never>;

export type CleanupCancelParams = Record<symbol, never>;

export type MicTestParams = { on: boolean, };

export type PermissionsRequestParams = Record<symbol, never>;

export type Permissions = { hotkey: HotkeyState, insert: InsertState, };

export type HotkeyConfigureParams = Record<symbol, never>;

export type ModelsRefreshParams = Record<symbol, never>;

export type DictationReply = { 
/**
 * The phase after the request.
 */
phase: DictationPhase, job: number, };

export type Topic = "dictation" | "hotkey" | "insert" | "settings" | "history" | "vocabulary" | "models" | "downloads" | "radio" | "voice" | "levels";

/**
 * A state change, sent to connections subscribed to its topic.
 */
export type Event = { "kind": "dictation", state: DictationState, } | { "kind": "hotkey", state: HotkeyState, } | { "kind": "insert", state: InsertState, } | { "kind": "settings", settings: Settings, } | { "kind": "history", page: HistoryPage, } | { "kind": "vocabulary", vocabulary: Vocabulary, } | { "kind": "models", models: ModelsState, } | { "kind": "download", download: Download, } | { "kind": "radio", radio: RadioState, } | { "kind": "voice", voice: VoiceState, } | { "kind": "level", level: number, } | { "kind": "lagged", missed: number, } | { "kind": "shuttingDown" };

/**
 * Stable error codes. Clients branch on these, never on `message`.
 */
export type ErrorCode = "parse_error" | "invalid_request" | "line_too_long" | "unknown_method" | "invalid_params" | "version_mismatch" | "handshake_required" | "not_available" | "busy" | "internal";

export type ApiError = { code: ErrorCode, 
/**
 * For people, not for branching.
 */
message: string, 
/**
 * Structured details, like the two versions for `version_mismatch`.
 */
data?: unknown, };

/**
 * A request line as sent by a client.
 */
export type RequestMessage = { id: number, method: string, params?: unknown, };

export type ResultMessage = { id: number, result: unknown, };

export type ErrorMessage = { id: number | null, error: ApiError, };

export type EventMessage = { seq: number, event: Event, };

/**
 * Any line the daemon sends.
 */
export type ServerMessage = ResultMessage | ErrorMessage | EventMessage;

export type Methods = {
  "hello": { params: HelloParams; result: HelloResult };
  "state.get": { params: GetStateParams; result: AppState };
  "subscribe": { params: SubscribeParams; result: Subscribed };
  "unsubscribe": { params: UnsubscribeParams; result: Subscribed };
  "dictation.toggle": { params: ToggleParams; result: DictationReply };
  "dictation.cancel": { params: CancelParams; result: DictationReply };
  "history.list": { params: HistoryListParams; result: HistoryPage };
  "history.delete": { params: HistoryDeleteParams; result: Acknowledged };
  "history.clear": { params: HistoryClearParams; result: Acknowledged };
  "history.reinsert": { params: HistoryReinsertParams; result: Delivery };
  "settings.set": { params: SettingsSetParams; result: Settings };
  "setup.finish": { params: SetupFinishParams; result: Setup };
  "vocabulary.get": { params: VocabularyGetParams; result: Vocabulary };
  "vocabulary.change": { params: VocabularyChangeParams; result: Vocabulary };
  "cleanup.start": { params: CleanupStartParams; result: Acknowledged };
  "cleanup.cancel": { params: CleanupCancelParams; result: Acknowledged };
  "mic.test": { params: MicTestParams; result: Acknowledged };
  "permissions.request": { params: PermissionsRequestParams; result: Permissions };
  "hotkey.configure": { params: HotkeyConfigureParams; result: Acknowledged };
  "models.refresh": { params: ModelsRefreshParams; result: Acknowledged };
};
