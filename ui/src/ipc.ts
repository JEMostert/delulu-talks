import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
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
  /** The languages Automatic may pick from; never empty. */
  allowedLanguages: string[];
  insert: "shift-insert" | "ctrl-v" | "ctrl-shift-v" | "off";
  theme: "system" | "light" | "dark";
  overlay: boolean;
  firstRunDone: boolean;
  cleanup: boolean;
  /** Carry what recent dictations were about to the next one. */
  smartContext: boolean;
  cleanupModelOk: boolean;
  /** Show the optional Delulu FM radio. */
  radio: boolean;
  /** Delete transcripts older than this many days; 0 keeps them forever. */
  historyRetentionDays: number;
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
  /** Short licence name. */
  license: string;
  /** Who made the model, shown with its licence at download; null when not needed. */
  credit: string | null;
  licenseUrl: string | null;
  /** A retired model this one replaces, while its files are still here. */
  replaces: string | null;
};
export type VoiceStatus = {
  cliPath?: string;
  /** `delulu speak` can speak now. */
  ready: boolean;
  installing: boolean;
  /** The voice model is downloaded. */
  model: boolean;
  /** The voice engine (delulu-engine) is installed. */
  engine: boolean;
  /** Agents' voice and Delulu FM's host, like "F1" or "M1". */
  voice: string;
  radioVoice: string;
  voices: string[];
  modelLabel: string;
  modelBytes: number;
  /** Shown before the download, as the model's licence requires. */
  terms: { name: string; url: string; credit: string; text: string };
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
export const setVoice = (role: "agent" | "radio", voice: string) =>
  invoke<void>("set_voice", { role, voice });
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
/** Open a folder in the file manager. */
export const openFolder = (path: string) =>
  mock ? Promise.resolve() : openPath(path);
/** Open a model's licence page in the browser. */
export const openLicence = (url: string) =>
  mock
    ? Promise.resolve(window.open(url, "_blank", "noopener")).then(() => {})
    : openUrl(url);
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
export type RadioFeedback = "like" | "dislike";
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
  /** The genre and mood the song was drawn with; null for requests, host
   * breaks and songs from before the mix. */
  genre: string | null;
  mood: string | null;
  /** The genre came from outside the listener's pool (the surprise chance). */
  surprise: boolean;
  feedback: RadioFeedback | null;
  /** Kept out of clean-up; listed in `Radio.saved`. */
  saved: boolean;
};
/** One genre or mood of the mix. `custom` is set by the station: the listener
 * added it. Catalogue entries cannot be removed, only turned off. */
export type RadioChoice = { name: string; on: boolean; custom: boolean };
/** What the listener steers. Each new song draws one enabled genre (or, with
 * `surprise` percent chance, one that is off), one enabled mood, and a value for
 * every "any". No genre on = any genre. Applies to songs not written yet. */
export type RadioMix = {
  genres: RadioChoice[];
  moods: RadioChoice[];
  /** 0–100. */
  surprise: number;
  vocals: "any" | "vocal" | "instrumental";
  energy: "any" | "low" | "medium" | "high";
  /** Each song's length is drawn between these, in seconds, within
   * `Radio.lengthLimits`; equal values give a fixed length. */
  lengthMinSeconds: number;
  lengthMaxSeconds: number;
  host: "off" | "sometimes" | "often";
  language: string;
  /** Optional free text every song is written around. */
  theme: string;
};
/** A named mix. Built-in stations cannot be renamed or deleted. */
export type RadioStation = {
  id: string;
  name: string;
  builtin: boolean;
  /** The mix sounds like this station now. */
  active: boolean;
};
/** Only `genre` is drawn until unlocked, or for `left` more songs. */
export type RadioLock = { genre: string; left: number | null };
export type RadioRequest = {
  id: string;
  text: string;
  createdAt: number;
  answeredBy?: string;
};
export type RadioReadiness = {
  music: {
    /** The delulu-engine binary (music role) is installed. */
    engine: boolean;
    /** The YuE2 model is downloaded (Settings → Models). */
    model: boolean;
    /** ACE-Step's files: text encoder + turbo DiT + VAE, and its language models. */
    ace: { turbo: boolean; lmSmall: boolean; lmLarge: boolean };
    /** The compute device the engine found. */
    device: string | null;
    /** A graphics card; the processor alone is far too slow. */
    gpu: boolean;
  };
  writer: boolean;
  voice: boolean;
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
    /** Music only: overall 0..1. */
    progress: number | null;
    phase: "loading" | "score" | "composing" | "shaping" | "rendering" | null;
    /** ACE-Step's first song with this engine build: the graphics driver
     * prepares its shaders once, which takes a few minutes. */
    preparing: boolean;
    /** What the song being made was drawn to be (songs only). */
    genre: string | null;
    mood: string | null;
    surprise: boolean;
  } | null;
  lastError: string | null;
  requests: RadioRequest[];
  mix: RadioMix;
  /** Built-in stations first, then the listener's. */
  stations: RadioStation[];
  /** Saved songs, newest first. */
  saved: RadioItem[];
  lock: RadioLock | null;
  /** Songs a genre lock lasts when `radioLock` gets no count. */
  lockSongs: number;
  /** Genre (lowercase) → draw weight from likes and dislikes, 0.25–4; a genre
   * that is absent weighs 1. */
  weights: Record<string, number>;
  /** The song lengths the mix may ask for (seconds, 60–300); both engines reach
   * them. */
  lengthLimits: { min: number; max: number };
  lastSongSeconds: number | null;
  lastSongAudioSeconds: number | null;
  readiness: RadioReadiness | null;
  music: RadioMusic;
};
export type MusicEngine = "yue2" | "acestep";
export type AceLm = "auto" | "0.6b" | "4b";
export type RadioMusic = {
  engine: MusicEngine;
  aceLm: AceLm;
  aceWarm?: string;
};
export const radioMusic = (engine: MusicEngine, aceLm: AceLm) =>
  invoke<Radio>("radio_music", { engine, aceLm });
export const getRadio = () => invoke<Radio>("get_radio");
export const checkRadio = () => invoke<Radio>("check_radio");
export const radioPlay = () => invoke<Radio>("radio_play");
export const radioPause = () => invoke<Radio>("radio_pause");
export const radioOff = () => invoke<Radio>("radio_off");
export const radioSkip = () => invoke<Radio>("radio_skip");
export const radioVolume = (volume: number) =>
  invoke<void>("radio_volume", { volume });
export const radioMix = (mix: RadioMix) => invoke<Radio>("radio_mix", { mix });
/** A random mix (a few genres and moods, surprise 0–40 %), rolled by the station. */
export const radioShuffle = () => invoke<Radio>("radio_shuffle");
/** Save the mix as a station; a station of yours with that name is updated. */
export const radioStationSave = (name: string) =>
  invoke<Radio>("radio_station_save", { name });
export const radioStationRename = (id: string, name: string) =>
  invoke<Radio>("radio_station_rename", { id, name });
export const radioStationDelete = (id: string) =>
  invoke<Radio>("radio_station_delete", { id });
/** Tune the mix to a station; host and language stay. */
export const radioStationActivate = (id: string) =>
  invoke<Radio>("radio_station_activate", { id });
/** Like or dislike a song (null takes it back); moves its genre's weight.
 * Disliking the song on air also skips it. */
export const radioFeedback = (id: string, feedback: RadioFeedback | null) =>
  invoke<Radio>("radio_feedback", { id, feedback });
/** Forget likes and dislikes of one genre, or all with null. */
export const radioResetFeedback = (genre: string | null = null) =>
  invoke<Radio>("radio_reset_feedback", { genre });
/** Stay on the genre of the song on air: `songs` songs (null: `lockSongs`),
 * or until unlocked with 0. */
export const radioLock = (songs: number | null = null) =>
  invoke<Radio>("radio_lock", { songs });
export const radioUnlock = () => invoke<Radio>("radio_unlock");
/** Keep a song (any item id) out of clean-up. */
export const radioSave = (id: string) => invoke<Radio>("radio_save", { id });
export const radioUnsave = (id: string) =>
  invoke<Radio>("radio_unsave", { id });
/** Play a saved song now, as a replay; starts the station if it was off. */
export const radioPlaySaved = (id: string) =>
  invoke<Radio>("radio_play_saved", { id });
export const radioRequest = (text: string) =>
  invoke<Radio>("radio_request", { text });
export type ModelTerms = {
  name: string;
  url: string;
  credit: string;
  text: string;
};
export type MusicModelRow = {
  id: string;
  engine: "yue" | "acestep";
  label: string;
  license: string;
  bytes: number;
  state: "missing" | "downloading" | "ready";
  terms: ModelTerms | null;
  /** Why this model's last download failed. */
  error?: string | null;
};
/** Every music model, and the download in progress (over all its models). */
export type MusicModel = {
  models: MusicModelRow[];
  doneBytes: number;
  totalBytes: number;
  error: string | null;
  /** This window cannot see or change the music models (a daemon's client). */
  unavailable?: boolean;
};
export const getMusicModel = () => invoke<MusicModel>("get_music_model");
/** Download these models one after another; already downloaded ones are skipped. */
export const downloadMusicModel = (ids: string[]) =>
  invoke<MusicModel>("download_music_model", { ids });
export const cancelMusicDownload = () => invoke<void>("cancel_music_download");
export const deleteMusicModel = (id: string) =>
  invoke<MusicModel>("delete_music_model", { id });
export const onMusicModel = (
  fn: (value: MusicModel) => void,
): Promise<UnlistenFn> =>
  listen<MusicModel>("music-model", (e) => fn(e.payload));
export const onRadio = (fn: (value: Radio) => void): Promise<UnlistenFn> =>
  listen<Radio>("radio", (e) => fn(e.payload));
export const onRadioError = (
  fn: (value: string) => void,
): Promise<UnlistenFn> => listen<string>("radio-error", (e) => fn(e.payload));

export const isMac =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
