import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
// The mock is only reachable in Vite development outside a Tauri window.
const mock =
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)
    ? import("./mock")
    : null;
const invoke: typeof tauriInvoke = async (command, args) =>
  mock
    ? (await mock).invoke(command, args as Record<string, unknown> | undefined)
    : tauriInvoke(command, args);
const listen: typeof tauriListen = async (event, handler, options) =>
  mock
    ? (await mock).listen(event, handler)
    : tauriListen(event, handler, options);
export type Phase =
  | "needsSetup"
  | "loadingModel"
  | "idle"
  | "recording"
  | "transcribing"
  | "error";
export type HotkeyStatus = {
  bound: boolean;
  trigger: string | null;
  error: string | null;
};
export type InsertStatus = { ready: boolean; error: string | null };
export type Status = {
  phase: Phase;
  dataDir: string;
  message: string | null;
  hotkey: HotkeyStatus;
  insert: InsertStatus;
  backend: string | null;
  model: string | null;
};
export type InsertResult =
  | { kind: "pasted" }
  | { kind: "copied"; reason: string | null }
  | { kind: "failed"; reason: string }
  | { kind: "skipped" };
export type Settings = {
  version: number;
  microphone: string | null;
  startAtLogin: boolean;
  model: string;
  language: string;
  insert: "shift-insert" | "ctrl-v" | "ctrl-shift-v" | "off";
  theme: "system" | "light" | "dark";
  overlay: boolean;
  firstRunDone: boolean;
  cleanup: boolean;
  /** Carry what recent dictations were about to the next one. */
  smartContext: boolean;
  cleanupModelOk: boolean;
  /** Show the optional LLM FM radio. */
  radio: boolean;
};
export type InputDevice = { id: string; name: string; isDefault: boolean };
export type Language = { code: string; name: string };
export type Engine = "whisper" | "parakeet";
export type ModelStatus = {
  id: string;
  label: string;
  engine: Engine;
  bytes: number;
  downloaded: boolean;
};
export type VoiceStatus = {
  ready: boolean;
  configured: boolean;
  installing: boolean;
};
export type CleanupStatus = {
  state: "off" | "missing" | "downloading" | "loading" | "ready" | "error";
  doneBytes: number;
  totalBytes: number;
  error: string | null;
  backend: string | null;
};
export type HistoryEntry = {
  raw?: string;
  cleanupMs?: number;
  /** What cleanup thought it was about, like "programming". */
  topic?: string;
  id: string;
  createdAt: number;
  text: string;
  language: string;
  model: string;
  audioMs: number;
  sttMs: number;
  totalMs: number;
};
export type TranscriptEvent = { entry: HistoryEntry; insert: InsertResult };
export type ModelDownload = {
  id: string;
  doneBytes: number;
  totalBytes: number;
  finished: boolean;
  error: string | null;
};
export type Shelf = {
  id: string;
  name: string;
  enabled: boolean;
  terms: string[];
};
/** A ready-made shelf not added yet. */
export type Preset = { key: string; name: string; terms: string[] };
export type Vocabulary = {
  version: number;
  shelves: Shelf[];
  /** Starter shelves the user hasn't added yet. */
  presets: Preset[];
  /** Distinct terms on enabled shelves. */
  activeTerms: number;
  /** How many of those the cleanup prompt uses; it caps count and length. */
  usedTerms: number;
};
export const getVocabulary = () => invoke<Vocabulary>("get_vocabulary");
export const addShelf = (name: string) =>
  invoke<Vocabulary>("add_shelf", { name });
export const addPresetShelf = (key: string) =>
  invoke<Vocabulary>("add_preset_shelf", { key });
export const renameShelf = (id: string, name: string) =>
  invoke<Vocabulary>("rename_shelf", { id, name });
export const deleteShelf = (id: string) =>
  invoke<Vocabulary>("delete_shelf", { id });
export const setShelfEnabled = (id: string, enabled: boolean) =>
  invoke<Vocabulary>("set_shelf_enabled", { id, enabled });
/** `text` may hold several terms separated by commas or newlines. */
export const addTerms = (id: string, text: string) =>
  invoke<Vocabulary>("add_terms", { id, text });
export const removeTerm = (id: string, term: string) =>
  invoke<Vocabulary>("remove_term", { id, term });
export const getVoiceStatus = () => invoke<VoiceStatus>("get_voice_status");
export const installVoiceModel = () => invoke<void>("install_voice_model");
export const getCleanupStatus = () =>
  invoke<CleanupStatus>("get_cleanup_status");
export const startCleanup = () => invoke<void>("start_cleanup");
export const cancelCleanupDownload = () =>
  invoke<void>("cancel_cleanup_download");
export const onCleanupStatus = (
  fn: (value: CleanupStatus) => void,
): Promise<UnlistenFn> =>
  listen<CleanupStatus>("cleanup-status", (e) => fn(e.payload));
export const getStatus = () => invoke<Status>("get_status");
export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  invoke<Settings>("set_settings", { settings });
export const listMicrophones = () => invoke<InputDevice[]>("list_microphones");
export const listLanguages = () => invoke<Language[]>("list_languages");
export const listModels = () => invoke<ModelStatus[]>("list_models");
export const downloadModel = (id: string) =>
  invoke<void>("download_model", { id });
export const cancelDownload = () => invoke<void>("cancel_download");
export const startMicTest = () => invoke<void>("start_mic_test");
export const stopMicTest = () => invoke<void>("stop_mic_test");
export const startDictation = () => invoke<void>("start_dictation");
export const stopDictation = () => invoke<void>("stop_dictation");
export const prepareInsert = () => invoke<InsertStatus>("prepare_insert");
export const changeHotkey = () => invoke<void>("change_hotkey");
export const getHistory = (query: string | null, limit: number) =>
  invoke<HistoryEntry[]>("get_history", { query, limit });
export const deleteHistory = (id: string) =>
  invoke<void>("delete_history", { id });
export const clearHistory = () => invoke<void>("clear_history");
export const copyText = (text: string) => invoke<void>("copy_text", { text });
/** `raw` inserts what was said before cleanup, when the entry has it. */
export const reinsert = (id: string, raw = false) =>
  invoke<InsertResult>("reinsert", { id, raw });
export const finishFirstRun = () => invoke<void>("finish_first_run");
export const openProjectPage = () =>
  mock
    ? Promise.resolve(
        window.open(
          "https://github.com/JEMostert/delulu-talks",
          "_blank",
          "noopener",
        ),
      ).then(() => {})
    : openUrl("https://github.com/JEMostert/delulu-talks");
export const onStatus = (fn: (value: Status) => void): Promise<UnlistenFn> =>
  listen<Status>("status", (e) => fn(e.payload));
export const onMicLevel = (fn: (value: number) => void): Promise<UnlistenFn> =>
  listen<number>("mic-level", (e) => fn(e.payload));
export const onTranscript = (
  fn: (value: TranscriptEvent) => void,
): Promise<UnlistenFn> =>
  listen<TranscriptEvent>("transcript", (e) => fn(e.payload));
export const onModelDownload = (
  fn: (value: ModelDownload) => void,
): Promise<UnlistenFn> =>
  listen<ModelDownload>("model-download", (e) => fn(e.payload));

export type RadioKind = "song" | "break";
export type RadioItem = {
  id: string;
  kind: RadioKind;
  title: string;
  subtitle: string;
  lyrics: string | null;
  script: string | null;
  seconds: number;
  request: string | null;
  replay: boolean;
  imported: boolean;
};
export type RadioDirection = {
  mood: string;
  genres: string[];
  energy: "low" | "medium" | "high";
  vocals: "vocal" | "instrumental" | "either";
  language: string;
  length: "short" | "medium" | "long";
  host: "off" | "sometimes" | "often";
  theme: string;
};
export type RadioRequest = {
  id: string;
  text: string;
  createdAt: number;
  answeredBy?: string;
};
export type RadioReadiness = {
  comfy: {
    cli: boolean;
    server: boolean;
    nodes: boolean;
    checkpoint: boolean;
    url: string;
  };
  writer: boolean;
  voice: boolean;
  installCommand: string;
};
export type Radio = {
  available: boolean;
  error: string | null;
  onAir: boolean;
  playing: boolean;
  /** Silent while you dictate. */
  held: boolean;
  volume: number;
  now: RadioItem | null;
  /** Seconds into `now`. */
  position: number;
  queue: RadioItem[];
  history: RadioItem[];
  making: {
    kind: RadioKind;
    step: "writing" | "music" | "voice";
    title: string | null;
    request: string | null;
    since: number;
  } | null;
  lastError: string | null;
  requests: RadioRequest[];
  direction: RadioDirection;
  lastSongSeconds: number | null;
  lastSongAudioSeconds: number | null;
  readiness: RadioReadiness | null;
};
export const getRadio = () => invoke<Radio>("get_radio");
export const checkRadio = () => invoke<Radio>("check_radio");
export const radioPlay = () => invoke<Radio>("radio_play");
export const radioPause = () => invoke<Radio>("radio_pause");
export const radioOff = () => invoke<Radio>("radio_off");
export const radioSkip = () => invoke<Radio>("radio_skip");
export const radioVolume = (volume: number) =>
  invoke<void>("radio_volume", { volume });
export const radioDirection = (direction: RadioDirection) =>
  invoke<Radio>("radio_direction", { direction });
export const radioRequest = (text: string) =>
  invoke<Radio>("radio_request", { text });
export const onRadio = (fn: (value: Radio) => void): Promise<UnlistenFn> =>
  listen<Radio>("radio", (e) => fn(e.payload));
export const onRadioError = (
  fn: (value: string) => void,
): Promise<UnlistenFn> => listen<string>("radio-error", (e) => fn(e.payload));
