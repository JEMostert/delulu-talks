export type Page =
  "home" | "magic" | "lab" | "models" | "vocabulary" | "history" | "settings";

export type ModelId = "r2t2" | "qwen3Asr";
export type MagicModelId = "qwen35Small" | "qwen35Medium" | "qwen35Large";
export type MagicPreset = "polish" | "concise" | "structured" | "prompt";
export type DictationPhase =
  "idle" | "preparing" | "loading" | "listening" | "transcribing" | "error";
export type EnginePhase =
  "missing" | "unloaded" | "settingUp" | "loading" | "ready" | "error";
export type MagicPhase =
  "idle" | "preparing" | "loading" | "rewriting" | "error";
export type TranscriptSource = "dictation" | "file";
export type ExportFormat = "txt" | "json";

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
  model: ModelId;
  language: string;
  pythonCommand: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
  autoPaste: boolean;
  copyToClipboard: boolean;
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
  includedInferences: boolean;
};

export type DictationStatus = {
  speechModel?: ModelId;
  retryAvailable?: boolean;
  migrationRequired?: boolean;
  phase: DictationPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: ModelId | null;
  progress?: number | null;
};

export type TranscriptRecord = {
  id: string;
  createdAt: number;
  durationMs: number;
  text: string;
  personalizedText?: string | null;
  editedText?: string | null;
  magicText?: string | null;
  magicModel?: MagicModelId | null;
  magicPreset?: MagicPreset | null;
  magicIncludedInferences?: boolean;
  magicProcessingTimeMs?: number;
  model: ModelId;
  language: string;
  source: TranscriptSource;
  sourceName?: string | null;
  processingTimeMs: number;
};

export type ModelInfo = {
  runtime: string;
  downloadSize: string;
  id: ModelId;
  hfId: string;
  name: string;
  description: string;
  recommended?: boolean;
};

export type MagicModelInfo = {
  id: MagicModelId;
  hfId: string;
  name: string;
  role: string;
  description: string;
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
};

export type RecordingSubmission = {
  wav: Uint8Array;
  durationMs: number;
};

export type MicrophoneDevice = {
  deviceId: string;
  label: string;
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
  getSettings(): Promise<AppSettings>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  pasteLastTranscript(): Promise<void>;
  retryRecording(): Promise<void>;
  discardFailedRecording(): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
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
  recordingStarted(): Promise<void>;
  recorderReady(): Promise<void>;
  recordingFailed(message: string): Promise<void>;
  recordingLevel(level: number): void;
  submitRecording(recording: RecordingSubmission): Promise<void>;
  onStatus(callback: (status: DictationStatus) => void): () => void;
  onMagicStatus(callback: (status: MagicStatus) => void): () => void;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
  onNavigate(callback: (page: Page) => void): () => void;
  onShortcutStatus(callback: (status: ShortcutStatus) => void): () => void;
  onTranscript(callback: (record: TranscriptRecord) => void): () => void;
  onRecorderCommand(callback: (command: RecorderCommand) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
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
  checkedAt: number;
};
