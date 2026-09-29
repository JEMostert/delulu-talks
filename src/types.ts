import type { PersonalProfileCommand } from "./personalProfileCommands";
import type { PersonalProfileDocument } from "./personalProfiles";

export type Page =
  "home" | "lab" | "models" | "vocabulary" | "history" | "settings";

export type SpeechModelId = "r2t2" | "r2t2Mlx";
/** Historical Qwen speech results retain their identity; it is never an active engine. */
export type ModelId = SpeechModelId | "qwen3Asr";
export type MagicModelId = "qwen35Small" | "qwen35Medium" | "qwen35Large";
export type MagicPreset = "polish" | "concise" | "structured" | "prompt";
export type DictationPhase =
  "idle" | "preparing" | "loading" | "listening" | "transcribing" | "error";
export type EnginePhase =
  "missing" | "unloaded" | "settingUp" | "loading" | "ready" | "error";
export type MagicPhase =
  "idle" | "preparing" | "loading" | "rewriting" | "error";
export type TranscriptSource = "dictation" | "file";
export type ExportFormat = "txt" | "json" | "md";

export type CustomWord = {
  kind?: "correction" | "shortcut";
  id: string;
  term: string;
  soundsLike: string;
  replacement: string;
  enabled: boolean;
};

export type AppSettings = {
  workflowVersion: 1;
  onboardingComplete: boolean;
  theme: "system" | "light" | "dark";
  shortcut: string;
  shortcutMode: "hold" | "toggle";
  model: SpeechModelId;
  language: string;
  pythonCommand: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
  autoPaste: boolean;
  pasteLastDelaySeconds: number;
  copyToClipboard: boolean;
  spokenFormattingCommands: boolean;
  pastePortalToken: string;
  keepHistory: boolean;
  showOverlay: boolean;
  preloadModel: boolean;
  magicEnabled: boolean;
  magicModel: MagicModelId;
  magicPreset: MagicPreset;
  magicAllowInferences: boolean;
  preloadMagicModel: boolean;
  modelIdleMinutes: number;
  launchAtLogin: boolean;
  customWords: CustomWord[];
  /** Stored contract only; no active profile or automatic behavior change. */
  personalProfiles?: PersonalProfileDocument;
};

export type MagicStatus = {
  phase: MagicPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: MagicModelId | null;
  device?: string | null;
  progress?: number | null;
};

export type MagicRewriteRequest = {
  text: string;
  preset: MagicPreset;
  instructions?: string;
  allowInferences: boolean;
};

export type MagicRewriteResult = {
  preset?: MagicPreset;
  text: string;
  model: MagicModelId;
  processingTimeMs: number;
  inputCharacters: number;
  outputCharacters: number;
  /** Records permission to add assumptions, not evidence that any were added. */
  includedInferences: boolean;
};

export type RetryAudioState = {
  phase: "empty" | "available" | "retrying";
  byteLength: number;
  durationMs: number | null;
  discarded: boolean;
  sessionOnly: true;
};

export type DictationStatus = {
  speechModel?: SpeechModelId;
  retryAvailable?: boolean;
  retryAudio?: RetryAudioState;
  migrationRequired?: boolean;
  phase: DictationPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: SpeechModelId | null;
  progress?: number | null;
};

/**
 * Speech backends currently provide no calibrated confidence evidence.
 * Do not infer confidence from timing, length, model identity, or rewrites.
 * Add score/uncertainty UI only with a backend calibration contract.
 */
export type TranscriptRecord = {
  id: string;
  title?: string | null;
  createdAt: number;
  durationMs: number;
  text: string;
  personalizedText?: string | null;
  editedText?: string | null;
  magicText?: string | null;
  magicModel?: MagicModelId | null;
  magicPreset?: MagicPreset | null;
  /** Historical name: assumptions were allowed; their presence is not detected. */
  magicIncludedInferences?: boolean;
  magicProcessingTimeMs?: number;
  model: ModelId;
  language: string;
  /** Decoder hint, not a detected-language claim. Absent on legacy records. */
  requestedLanguage?: string | null;
  /** Language reported by the backend; forced prompts may influence it. */
  recognizedLanguage?: string | null;
  source: TranscriptSource;
  sourceName?: string | null;
  processingTimeMs: number;
};

export type ModelProvenance = {
  licenseName: string;
  licenseUrl: string;
  variants: {
    label: string;
    revision: string | null;
    conversion: string;
    attributionUrl?: string;
  }[];
};

export type ModelInfo = {
  runtime: string;
  downloadSize: string;
  id: SpeechModelId;
  hfId: string;
  name: string;
  description: string;
  provenance: ModelProvenance;
  recommended?: boolean;
};

export type MagicModelInfo = {
  id: MagicModelId;
  hfId: string;
  name: string;
  role: string;
  description: string;
  provenance: ModelProvenance;
  parameters: string;
  memory: string;
  speed: string;
  recommended?: boolean;
};

export type AudioFileSelection = {
  path: string;
  name: string;
  size: number;
};

export type LabRequest = {
  path: string;
};

export type RecorderCommand = {
  action: "start" | "stop" | "cancel";
  inputDeviceId: string;
  /** Native commands identify their capture; standalone capture can omit this. */
  sessionId?: string;
};

export type RecordingSubmission = {
  sessionId: string;
  wav: Uint8Array;
  durationMs: number;
};

export type MicrophoneDevice = {
  deviceId: string;
  label: string;
  /** False when privacy permissions hide the real label; default tracks inventory visibility. */
  labelKnown?: boolean;
};

export type PlatformCapabilities = {
  platform: "linux" | "darwin" | "win32";
  desktop: string;
  sessionType: string;
  pasteMethod: string;
  overlayMethod: "layer-shell" | "unavailable";
  overlayDetail?: string;
  wayland: boolean;
};

export type ShortcutStatus = {
  accelerator: string;
  registered: boolean;
  method: "portal" | "native";
  message: string;
  lastTriggeredAt?: number | null;
};

export type UpdateStatus = {
  phase:
    | "unsupported"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "upToDate"
    | "error";
  currentVersion: string;
  version?: string;
  message: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

export type DeluluApi = {
  getRendererRecoveryState(): Promise<RendererRecoveryState>;
  reloadWorkspace(): Promise<void>;
  rendererControllerFailed(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  pasteLastTranscript(): Promise<PasteLastStatus>;
  getPasteLastStatus(): Promise<PasteLastStatus>;
  cancelPasteLast(operationId: string): Promise<PasteLastStatus>;
  retryRecording(): Promise<void>;
  discardFailedRecording(): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  managePersonalProfile(command: PersonalProfileCommand): Promise<AppSettings>;
  getStatus(): Promise<DictationStatus>;
  getMagicStatus(): Promise<MagicStatus>;
  getShortcutStatus(): Promise<ShortcutStatus>;
  configureShortcut(): Promise<void>;
  getHistory(): Promise<TranscriptRecord[]>;
  getCapabilities(): Promise<PlatformCapabilities>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  toggleDictation(): Promise<void>;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  cancelDictation(): Promise<void>;
  setupModel(): Promise<void>;
  loadModel(): Promise<void>;
  unloadModel(): Promise<void>;
  resetPythonEnvironment(): Promise<void>;
  setupMagic(): Promise<void>;
  loadMagic(): Promise<void>;
  unloadMagic(): Promise<void>;
  rewriteMagic(request: MagicRewriteRequest): Promise<MagicRewriteResult>;
  copyText(text: string): Promise<void>;
  authorizePaste(): Promise<void>;
  testPaste(): Promise<void>;
  updateTranscript(id: string, text: string | null): Promise<TranscriptRecord>;
  setTranscriptTitle(id: string, title: string | null): Promise<TranscriptRecord>;
  setTranscriptRewrite(
    id: string,
    result: MagicRewriteResult | null,
    sourceText: string,
  ): Promise<TranscriptRecord>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  chooseAudioFile(): Promise<AudioFileSelection | null>;
  runLab(request: LabRequest): Promise<TranscriptRecord>;
  exportTranscript(id: string, format: ExportFormat): Promise<string | null>;
  recordingStarted(sessionId: string): Promise<void>;
  recordingLimitReached(sessionId: string): Promise<void>;
  recorderReady(): Promise<void>;
  recordingFailed(message: string, sessionId: string): Promise<void>;
  recordingLevel(level: number): void;
  submitRecording(recording: RecordingSubmission): Promise<void>;
  onPasteLastStatus(callback: (status: PasteLastStatus) => void): () => void;
  onStatus(callback: (status: DictationStatus) => void): () => void;
  onMagicStatus(callback: (status: MagicStatus) => void): () => void;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
  onNavigate(callback: (page: Page) => void): () => void;
  onShortcutStatus(callback: (status: ShortcutStatus) => void): () => void;
  onTranscript(callback: (record: TranscriptRecord) => void): () => void;
  onRecorderCommand(callback: (command: RecorderCommand) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
};

export type RendererRecoveryState = {
  canReload: boolean;
  reason: string | null;
  canStopRecording: boolean;
};

export type AccessibilityPermission = {
  state: "granted" | "denied" | "unknown" | "not-applicable";
  canAttemptPaste: boolean;
  detail: string;
};

export type RuntimeDiagnostics = {
  platform: string;
  arch: string;
  memoryGB: number;
  freeMemoryGB: number;
  python: string;
  ffmpeg: string;
  dataDirectory: string;
  runtimeInstalled: boolean;
  packages: Record<string, string>;
  accessibility?: AccessibilityPermission;
  checkedAt: number;
};

export type PasteLastStatus = {
  phase:
    | "idle"
    | "pending"
    | "delivering"
    | "attempted"
    | "copied"
    | "cancelled"
    | "error";
  operationId: string | null;
  dueAt: number | null;
  remainingSeconds: number;
  message: string;
};
