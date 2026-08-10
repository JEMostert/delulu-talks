export type Page = "home" | "lab" | "models" | "vocabulary" | "history" | "settings";

export type ModelId = "crisperSmall" | "crisperMedium" | "crisperTurbo" | "crisperLarge";
export type TranscriptionMode = "intended" | "verbatim" | "dual";
export type AsrBackend = "auto" | "ct2" | "transformers";
export type ComputeType = "auto" | "float16" | "int8Float16" | "int8" | "float32";
export type DictationPhase = "idle" | "preparing" | "loading" | "listening" | "transcribing" | "error";
export type EnginePhase = "missing" | "unloaded" | "settingUp" | "loading" | "ready" | "error";
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
  backend: AsrBackend;
  computeType: ComputeType;
  speculativeDecoding: boolean;
  wordTimestamps: boolean;
  launchAtLogin: boolean;
  modelLicenseAccepted: boolean;
  customWords: CustomWord[];
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

export type DeluluApi = {
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  getStatus(): Promise<DictationStatus>;
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
  copyText(text: string): Promise<void>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  chooseAudioFile(): Promise<AudioFileSelection | null>;
  runLab(request: LabRequest): Promise<TranscriptRecord>;
  exportTranscript(id: string, format: ExportFormat): Promise<string | null>;
  recordingStarted(): Promise<void>;
  recordingFailed(message: string): Promise<void>;
  submitRecording(recording: RecordingSubmission): Promise<void>;
  onStatus(callback: (status: DictationStatus) => void): () => void;
  onTranscript(callback: (record: TranscriptRecord) => void): () => void;
  onRecorderCommand(callback: (command: RecorderCommand) => void): () => void;
};
