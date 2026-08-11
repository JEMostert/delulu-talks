export type Page = "home" | "magic" | "lab" | "models" | "vocabulary" | "history" | "settings";

export type ModelId = "crisperSmall" | "crisperMedium" | "crisperTurbo" | "crisperLarge";
export type MagicModelId = "qwen35Small" | "qwen35Medium" | "qwen35Large";
export type MagicPreset = "polish" | "concise" | "structured" | "prompt";
export type TranscriptionMode = "intended" | "verbatim" | "dual";
export type TranscriptVersion = "intended" | "verbatim";
export type AsrBackend = "auto" | "ct2" | "transformers";
export type ComputeType = "auto" | "float16" | "int8Float16" | "int8" | "float32";
export type DictationPhase = "idle" | "preparing" | "loading" | "listening" | "transcribing" | "error";
export type EnginePhase = "missing" | "unloaded" | "settingUp" | "loading" | "ready" | "error";
export type MagicPhase = "idle" | "preparing" | "loading" | "rewriting" | "error";
export type TranscriptSource = "dictation" | "file" | "verbatimize" | "forcedAlign";
export type LabOperation = "transcribe" | "verbatimize" | "forcedAlign";
export type ExportFormat = "txt" | "json" | "srt" | "vtt";

export type CustomWord = {
  id: string;
  term: string;
  soundsLike: string;
  replacement: string;
  enabled: boolean;
};

export type AppSettings = {
  shortcut: string;
  model: ModelId;
  language: string;
  pythonCommand: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
  transcriptionMode: TranscriptionMode;
  pasteVersion: "intended" | "verbatim";
  autoPaste: boolean;
  copyToClipboard: boolean;
  keepHistory: boolean;
  showOverlay: boolean;
  preloadModel: boolean;
  magicEnabled: boolean;
  magicModel: MagicModelId;
  magicPreset: MagicPreset;
  magicAllowInferences: boolean;
  preloadMagicModel: boolean;
  modelIdleMinutes: number;
  backend: AsrBackend;
  computeType: ComputeType;
  speculativeDecoding: boolean;
  wordTimestamps: boolean;
  launchAtLogin: boolean;
  modelLicenseAccepted: boolean;
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
  text: string;
  model: MagicModelId;
  processingTimeMs: number;
  inputCharacters: number;
  outputCharacters: number;
  includedInferences: boolean;
};

export type DictationStatus = {
  phase: DictationPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: ModelId | null;
  backend?: Exclude<AsrBackend, "auto"> | null;
  progress?: number | null;
};

export type WordTimestamp = {
  word: string;
  start: number;
  end: number;
};

export type SpeechInsights = {
  fillerCount: number;
  repetitionCount: number;
  cutOffCount: number;
  vocalEventCount: number;
  wordsPerMinute: number;
  speakingSeconds: number;
};

export type TranscriptRecord = {
  id: string;
  createdAt: number;
  durationMs: number;
  text: string;
  intendedText: string;
  verbatimText: string;
  editedIntendedText?: string | null;
  editedVerbatimText?: string | null;
  magicText?: string | null;
  magicModel?: MagicModelId | null;
  magicPreset?: MagicPreset | null;
  magicIncludedInferences?: boolean;
  magicProcessingTimeMs?: number;
  mode: TranscriptionMode | "forcedAlign" | "verbatimize";
  model: ModelId;
  language: string;
  words: WordTimestamp[];
  verbatimWords: WordTimestamp[];
  insights: SpeechInsights;
  source: TranscriptSource;
  sourceName?: string | null;
  processingTimeMs: number;
};

export type ModelInfo = {
  id: ModelId;
  shorthand: "small" | "medium" | "turbo" | "large";
  hfId: string;
  name: string;
  role: string;
  description: string;
  size: string;
  memory: string;
  latency: string;
  accent: "coral" | "blue" | "violet" | "yellow";
  badges: string[];
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
  operation: LabOperation;
  path: string;
  referenceText?: string;
  mode?: TranscriptionMode;
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
  wayland: boolean;
};

export type ShortcutStatus = {
  accelerator: string;
  registered: boolean;
  method: "portal" | "native";
  message: string;
  lastTriggeredAt?: number | null;
};

export type DeluluApi = {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  getStatus(): Promise<DictationStatus>;
  getMagicStatus(): Promise<MagicStatus>;
  getShortcutStatus(): Promise<ShortcutStatus>;
  getHistory(): Promise<TranscriptRecord[]>;
  getCapabilities(): Promise<PlatformCapabilities>;
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
  updateTranscript(id: string, version: TranscriptVersion, text: string | null): Promise<TranscriptRecord>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  chooseAudioFile(): Promise<AudioFileSelection | null>;
  runLab(request: LabRequest): Promise<TranscriptRecord>;
  exportTranscript(id: string, format: ExportFormat): Promise<string | null>;
  recordingStarted(): Promise<void>;
  recordingFailed(message: string): Promise<void>;
  submitRecording(recording: RecordingSubmission): Promise<void>;
  onStatus(callback: (status: DictationStatus) => void): () => void;
  onMagicStatus(callback: (status: MagicStatus) => void): () => void;
  onShortcutStatus(callback: (status: ShortcutStatus) => void): () => void;
  onTranscript(callback: (record: TranscriptRecord) => void): () => void;
  onRecorderCommand(callback: (command: RecorderCommand) => void): () => void;
};
