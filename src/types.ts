import type { SelectedTextApi } from "./selectedText";
export type SetupState =
  "running" | "cancelling" | "cancelled" | "complete" | "failed";
import type { DictationMode } from "./technicalDictation";
import type { ImportQueueSnapshot } from "./importQueue";
import type { ExportTemplateRequest } from "./exportTemplates";
import type {
  ActivePersonalProfile,
  CaptureProfileSnapshot,
  ProfileActivationCommand,
} from "./activePersonalProfile";
import type { PersonalProfileCommand } from "./personalProfileCommands";
import type { PersonalProfileDocument } from "./personalProfiles";
import type {
  SpeechBackendId,
  SpeechExecution,
  SpeechIdentity,
} from "./speechModels";
import type { DomainFailure } from "./domainErrors";
export type {
  DomainErrorCode,
  DomainFailure,
  RetryPolicy,
} from "./domainErrors";

import type { ProjectVocabularySnapshot } from "./projectVocabulary";
export type Page =
  | "home"
  | "lab"
  | "models"
  | "vocabulary"
  | "history"
  | "settings"
  | "technical";

export type SpeechModelId = "r2t2" | "r2t2Mlx";
/** Historical Qwen speech results retain their identity; it is never an active engine. */
export type ModelId = SpeechModelId | "qwen3Asr";
export type MagicModelId = "qwen35Small" | "qwen35Medium" | "qwen35Large";
export type MagicPreset =
  | "spoken-corrections"
  | "polish"
  | "concise"
  | "bullet-points"
  | "professional-message"
  | "structured"
  | "prompt";
export type DictationPhase =
  | "idle"
  | "preparing"
  | "loading"
  | "listening"
  | "paused"
  | "transcribing"
  | "error";
export type EnginePhase =
  "missing" | "unloaded" | "settingUp" | "loading" | "ready" | "error";
export type MagicPhase =
  "idle" | "preparing" | "loading" | "rewriting" | "error";
export type TranscriptSource = "dictation" | "file";
export type PasteShortcut = "standard" | "terminal";
export type ExportFormat = "txt" | "json" | "md";

export type HistoryDeletionState = {
  token: string;
  ids: string[];
  deadline: number;
  phase: "pending" | "failed";
  error?: string;
};
export type HistoryBatchSnapshot = {
  deletion: HistoryDeletionState | null;
  records: TranscriptRecord[];
};
export type DictationFormatting = "preserve" | "spoken";

export type CustomWord = {
  schemaVersion?: 1;
  kind?: "correction" | "shortcut";
  /** Omitted for legacy/global rules; scoped rules require a matching language. */
  language?: string;
  id: string;
  term: string;
  soundsLike: string;
  /** Literal pronunciation/recognition variants; legacy soundsLike stays supported. */
  aliases?: string[];
  replacement: string;
  enabled: boolean;
};

export type AppSettings = {
  schemaVersion?: 1;
  workflowVersion: 1;
  onboardingComplete: boolean;
  theme: "system" | "light" | "dark";
  shortcut: string;
  shortcutMode: "hold" | "toggle";
  model: SpeechModelId;
  language: string;
  dictationMode: DictationMode;
  dictationFormatting: DictationFormatting;
  pythonCommand: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
  trailingSilenceStopEnabled: boolean;
  trailingSilenceSeconds: number;
  trailingSilenceThresholdDb: number;
  autoPaste: boolean;
  pasteShortcut: PasteShortcut;
  pasteLastDelaySeconds: number;
  copyToClipboard: boolean;
  restoreClipboardAfterPaste: boolean;
  spokenFormattingCommands: boolean;
  pastePortalToken: string;
  keepHistory: boolean;
  historyRetention?: HistoryRetentionPolicy;
  showOverlay: boolean;
  captureSoundsMuted: boolean;
  /** CUDA speech engine: R2T2 (accuracy) or Nemotron (light, native streaming). */
  speechEngine: "r2t2" | "nemotron";
  /** Type text into the focused app while you speak (needs paste, no rewriting). */
  liveTyping: boolean;
  /** Saved transcripts beyond this many are removed, oldest first. */
  historyLimit: number;
  captureSoundVolume: number;
  preloadModel: boolean;
  magicEnabled: boolean;
  magicModel: MagicModelId;
  magicPreset: MagicPreset;
  magicAllowInferences: boolean;
  preloadMagicModel: boolean;
  modelIdleMinutes: number;
  memoryPolicy: "independent" | "balanced";
  launchAtLogin: boolean;
  menuBarOnly: boolean;
  customWords: CustomWord[];
  /** Saved profiles change behavior only through explicit activation. */
  personalProfiles?: PersonalProfileDocument;
  activePersonalProfile?: ActivePersonalProfile | null;
};

export type SetupStage =
  | "runtime-check"
  | "runtime-prepare"
  | "runtime-packages"
  | "runtime-download"
  | "runtime-install"
  | "runtime-build"
  | "runtime-validate"
  | "model-prepare"
  | "model-download"
  | "model-load"
  | "model-conversion"
  | "warmup"
  | "model-loaded"
  | "ready";

export type ModelResidency =
  "unknown" | "unloaded" | "loading" | "resident" | "unloading";
export type WarmupState = "unknown" | "not-started" | "warming" | "complete";
export type BackendCapabilities = {
  schemaVersion: 1;
  engine: "speech" | "writing";
  backend: "mlx" | "cuda-vllm" | "cuda-transformers" | "transformers";
  modelFamily: "r2t2" | "qwen3.5";
  timestamps: boolean;
  languageHints: { supported: boolean; languages: string[] };
  streaming: boolean;
  vocabularyBiasing: boolean;
};
export type RuntimeLifecycle = {
  residency?: ModelResidency;
  warmup?: WarmupState;
  device?: string | null;
  idleUnloadAt?: number | null;
  capabilities?: BackendCapabilities | null;
};

/** Observed downloader counters; aggregate totals may change during discovery. */
export type DownloadBytes = {
  completed: number;
  total: number | null;
  kind: "transfer" | "reconstruction";
};

export type MagicStatus = RuntimeLifecycle & {
  setupStage?: SetupStage | null;
  downloadBytes?: DownloadBytes | null;
  failure?: DomainFailure | null;
  setupState?: SetupState;
  phase: MagicPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: MagicModelId | null;
  device?: string | null;
  progress?: number | null;
};

export type MagicRewriteContext = {
  language?: string;
  fileType?: string;
  selection?: string;
};

export type MagicRewriteRequest = {
  operationId?: string;
  text: string;
  preset: MagicPreset;
  /** Optional style request for this rewrite only; never a saved preference. Max 4,000 UTF-16 units. */
  instructions?: string;
  sourceLanguage?: string;
  context?: MagicRewriteContext;
  allowInferences: boolean;
};

export type PipelineTimings = {
  captureEndMs?: number;
  preprocessingMs?: number;
  speechLoadMs?: number;
  speechRequestMs?: number;
  backendPreprocessingMs?: number;
  inferenceMs?: number;
  rewriteLoadMs?: number;
  rewritingMs?: number;
  clipboardMs?: number;
  pasteMs?: number;
};

export type MagicRewriteResult = RuntimeLifecycle & {
  timings?: PipelineTimings;
  preset?: MagicPreset;
  text: string;
  model: MagicModelId;
  processingTimeMs: number;
  inputCharacters: number;
  outputCharacters: number;
  /** Records permission to add assumptions, not evidence that any were added. */
  includedInferences: boolean;
};

export type PasteRecovery = {
  transcriptId: string;
  detail: string;
};

export type RetryAudioState = {
  phase: "empty" | "available" | "retrying";
  byteLength: number;
  durationMs: number | null;
  discarded: boolean;
  sessionOnly: true;
};

export type DictationStatus = RuntimeLifecycle & {
  setupStage?: SetupStage | null;
  speechExecution?: SpeechExecution | null;
  downloadBytes?: DownloadBytes | null;
  failure?: DomainFailure | null;
  setupState?: SetupState;
  speechModel?: SpeechModelId;
  retryAvailable?: boolean;
  captureInputNotice?: string | null;
  retryAudio?: RetryAudioState;
  silenceCountdownSeconds?: number | null;
  migrationRequired?: boolean;
  phase: DictationPhase;
  engine: EnginePhase;
  message: string;
  detail?: string | null;
  model?: SpeechModelId | null;
  progress?: number | null;
};

export type TranscriptDelivery = {
  state: "transcribed" | "copied" | "paste-attempted" | "confirmed";
  updatedAt: number;
  method?: string;
  detail?: string;
};

export type HistoryRetentionPolicy = {
  maxAgeDays: number | null;
  maxCount: number | null;
};

export type HistoryRetentionEffects = {
  originals: number;
  personalized: number;
  corrections: number;
  rewrites: number;
  importedReferences: number;
  /** Retention removes transcript records only, never source audio files. */
  audioFilesDeleted: 0;
};

export type HistoryRetentionPreview = {
  token: string;
  policy: HistoryRetentionPolicy;
  previewedAt: number;
  totalSaved: number;
  retainedCount: number;
  effects: HistoryRetentionEffects;
  affected: {
    record: TranscriptRecord;
    reason: "age" | "count" | "ageAndCount";
  }[];
};

/** Diagnostics of captured mono PCM before resampling/encoding, not hardware gain. */
export type CaptureDiagnostics = {
  sampleCount: number;
  sampleRate: number;
  peakAmplitude: number;
  rmsAmplitude: number;
  clippedSampleCount: number;
  clippingThreshold: number;
};

/**
 * Speech backends currently provide no calibrated confidence evidence.
 * Do not infer confidence from timing, length, model identity, or rewrites.
 * Add score/uncertainty UI only with a backend calibration contract.
 */
export type TranscriptRecord = {
  /** Never automatically persisted, even if history is enabled later. */
  sessionOnly?: boolean;
  dictationFormatting?: DictationFormatting;
  timings?: PipelineTimings;
  schemaVersion?: 1;
  id: string;
  title?: string | null;
  createdAt: number;
  durationMs: number;
  text: string;
  /** Monotonic version of the original/corrected source; legacy records start at zero. */
  sourceRevision?: number;
  /** Source version used for this rewrite; null means unknown legacy provenance. */
  rewriteSourceRevision?: number | null;
  personalizedText?: string | null;
  technicalText?: string | null;
  dictationMode?: DictationMode;
  editedText?: string | null;
  magicText?: string | null;
  magicModel?: MagicModelId | null;
  magicPreset?: MagicPreset | null;
  /** Historical name: assumptions were allowed; their presence is not detected. */
  magicIncludedInferences?: boolean;
  magicProcessingTimeMs?: number;
  model: ModelId;
  /** Observed at recognition time; absent on legacy records, never inferred. */
  speechExecution?: SpeechExecution;
  language: string;
  /** Decoder hint, not a detected-language claim. Absent on legacy records. */
  requestedLanguage?: string | null;
  /** Language reported by the backend; forced prompts may influence it. */
  recognizedLanguage?: string | null;
  recognizedLanguages?: string[];
  languageStatus?: "reported" | "mixed" | "unknown";
  source: TranscriptSource;
  sourceName?: string | null;
  processingTimeMs: number;
  delivery?: TranscriptDelivery;
  captureDiagnostics?: CaptureDiagnostics;
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
  identity: SpeechIdentity;
  backendIds: SpeechBackendId[];
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
  sourceMtimeMs?: number;
  path: string;
  name: string;
  size: number;
};

export type AudioFileMetadata = {
  durationSeconds: number | null;
  channels: number | null;
  sampleRate: number | null;
  decoder: "soundfile" | "FFmpeg";
  decoderReady: boolean;
  decoderDetail: string;
  estimatedPcmBytes: number | null;
  processingTimeEstimate: string;
};

export type AudioImportJob = AudioFileSelection & {
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  queueId?: string;
  queueState?: import("./importQueue").ImportJobState;
  createdAt: number;
  updatedAt: number;
  resultId?: string;
  error?: string;
  sourceAvailable?: boolean;
  sourceError?: string;
};

export type LabRequest = {
  path: string;
};

export type RecorderCommand = {
  action: "start" | "stop" | "cancel" | "pause" | "resume";
  trailingSilence?: { seconds: number; thresholdDb: number } | null;
  inputDeviceId: string;
  /** Native commands identify their capture; standalone capture can omit this. */
  sessionId?: string;
  captureProfile?: CaptureProfileSnapshot;
};

export type RecordingSubmission = {
  sessionId: string;
  timings?: PipelineTimings;
  wav: Uint8Array;
  durationMs: number;
  captureDiagnostics?: CaptureDiagnostics;
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
  overlayMethod: "layer-shell" | "mac-panel" | "unavailable";
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

export type RuleUsage = {
  counts: Record<string, number>;
  error: string | null;
};

export type ModelCacheEntry = {
  id: string;
  label: string;
  bytes: number;
  sizeComplete: boolean;
};

export type ModelCachePreview = {
  token: string;
  entries: ModelCacheEntry[];
};

export type ModelCacheCleanupResult = {
  deletedIds: string[];
  failures: { id: string; message: string }[];
};

export type DeluluApi = SelectedTextApi & {
  previewModelCache(): Promise<ModelCachePreview>;
  cleanupModelCache(
    token: string,
    ids: string[],
  ): Promise<ModelCacheCleanupResult>;
  getRuleUsage(): Promise<RuleUsage>;
  resetRuleUsage(): Promise<RuleUsage>;
  exportEncryptedHistory(passphrase: string): Promise<string | null>;
  recoverEncryptedHistory(passphrase: string): Promise<string | null>;
  getRendererRecoveryState(): Promise<RendererRecoveryState>;
  reloadWorkspace(): Promise<void>;
  rendererControllerFailed(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  getRuntimeSetupSnapshot(): Promise<RuntimeSetupSnapshot>;
  getSetupLog(kind: RuntimeSetupKind): Promise<RuntimeSetupLog>;
  getPasteRecovery(): Promise<PasteRecovery | null>;
  copyInstead(id: string): Promise<void>;
  dismissPasteRecovery(id: string): Promise<void>;
  onPasteRecovery(
    callback: (recovery: PasteRecovery | null) => void,
  ): () => void;
  getLocalDataOverview(): Promise<LocalDataOverview>;
  pasteLastTranscript(): Promise<PasteLastStatus>;
  getPasteLastStatus(): Promise<PasteLastStatus>;
  cancelPasteLast(operationId: string): Promise<PasteLastStatus>;
  retryRecording(): Promise<void>;
  discardFailedRecording(): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  managePersonalProfile(command: PersonalProfileCommand): Promise<AppSettings>;
  activatePersonalProfile(
    command: ProfileActivationCommand,
  ): Promise<AppSettings>;
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
  pauseDictation(): Promise<void>;
  resumeDictation(): Promise<void>;
  setupModel(): Promise<void>;
  cancelModelSetup(): Promise<void>;
  loadModel(): Promise<void>;
  unloadModel(): Promise<void>;
  resetPythonEnvironment(): Promise<void>;
  setupMagic(): Promise<void>;
  cancelMagicSetup(): Promise<void>;
  loadMagic(): Promise<void>;
  unloadMagic(): Promise<void>;
  rewriteMagic(request: MagicRewriteRequest): Promise<MagicRewriteResult>;
  cancelRewrite(operationId: string): Promise<boolean>;
  copyText(text: string): Promise<void>;
  authorizePaste(): Promise<void>;
  testPaste(): Promise<void>;
  updateTranscript(id: string, text: string | null): Promise<TranscriptRecord>;
  setTranscriptTitle(
    id: string,
    title: string | null,
  ): Promise<TranscriptRecord>;
  setTranscriptRewrite(
    id: string,
    result: MagicRewriteResult | null,
    sourceText: string,
    expectedSourceRevision?: number,
  ): Promise<TranscriptRecord>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  getHistoryBatchSnapshot(): Promise<HistoryBatchSnapshot>;
  stageHistoryDeletion(ids: string[]): Promise<HistoryDeletionState>;
  undoHistoryDeletion(token: string): Promise<void>;
  onHistoryBatchChanged(
    callback: (snapshot: HistoryBatchSnapshot) => void,
  ): () => void;
  exportHistorySelection(
    ids: string[],
    format: ExportFormat,
  ): Promise<string | null>;
  previewHistoryRetention(
    policy: HistoryRetentionPolicy,
  ): Promise<HistoryRetentionPreview>;
  applyHistoryRetention(token: string): Promise<string[]>;
  onHistoryRetentionApplied(
    callback: (removedIds: string[]) => void,
  ): () => void;
  chooseProjectIdentifier(input: {
    repository: string;
    rawSpeech: string;
    symbol: string;
  }): Promise<ProjectVocabularySnapshot>;
  getProjectVocabulary(): Promise<ProjectVocabularySnapshot>;
  selectProjectVocabulary(): Promise<ProjectVocabularySnapshot>;
  refreshProjectVocabulary(): Promise<ProjectVocabularySnapshot>;
  clearProjectVocabulary(): Promise<ProjectVocabularySnapshot>;
  chooseAudioFile(): Promise<AudioFileSelection | null>;
  inspectAudioFile(path: string): Promise<AudioFileMetadata>;
  chooseAudioFiles(): Promise<AudioFileSelection[]>;
  resolveAudioFiles(files: File[]): Promise<AudioFileSelection[]>;
  getAudioJobs(): Promise<AudioImportJob[]>;
  loadAudioSource(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
  removeAudioJob(path: string): Promise<void>;
  relinkAudioJob(path: string): Promise<AudioImportJob | null>;
  getImportQueue(): Promise<ImportQueueSnapshot>;
  enqueueImport(path: string): Promise<ImportQueueSnapshot>;
  pauseImportQueue(paused: boolean): Promise<ImportQueueSnapshot>;
  moveImportJob(id: string, direction: -1 | 1): Promise<ImportQueueSnapshot>;
  cancelImportJob(id: string): Promise<ImportQueueSnapshot>;
  retryImportJob(id: string): Promise<ImportQueueSnapshot>;
  clearFinishedImports(): Promise<ImportQueueSnapshot>;
  onImportQueue(callback: (snapshot: ImportQueueSnapshot) => void): () => void;
  runLab(request: LabRequest): Promise<TranscriptRecord>;
  exportTranscript(id: string, format: ExportFormat): Promise<string | null>;
  exportTranscriptTemplate(
    id: string,
    request: ExportTemplateRequest,
  ): Promise<string | null>;
  recordingStarted(sessionId: string): Promise<void>;
  recordingLimitReached(sessionId: string): Promise<void>;
  recordingPauseChanged(sessionId: string, paused: boolean): Promise<void>;
  recordingSilence(
    sessionId: string,
    remainingSeconds: number | null,
    stop: boolean,
  ): Promise<void>;
  recorderReady(): Promise<void>;
  recordingFailed(message: string, sessionId: string): Promise<void>;
  recordingInputChanged(
    sessionId: string,
    message: string,
    inputLost: boolean,
  ): Promise<void>;
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

export type MicrophonePermission = {
  state:
    | "not-determined"
    | "granted"
    | "denied"
    | "restricted"
    | "unknown"
    | "not-applicable";
  canRequestCapture: boolean;
  detail: string;
};

export type RuntimeSetupKind = "speech" | "rewrite";
export type RuntimeSetupLogEntry = {
  at: number;
  type: "stage" | "command" | "stdout" | "stderr" | "exit" | "error";
  stage: string;
  message: string;
  command?: { program: string; args: string[] };
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
};
export type RuntimeSetupLog = {
  kind: RuntimeSetupKind;
  attemptId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  outcome: "idle" | "running" | "success" | "error" | "cancelled";
  entries: RuntimeSetupLogEntry[];
  truncated: boolean;
  maxEntries: number;
  maxCharacters: number;
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
  microphone?: MicrophonePermission;
  accessibility?: AccessibilityPermission;
  checkedAt: number;
};

export type SetupRuntimeObservation = {
  kind: "speech" | "magic";
  root: string;
  directory: string | null;
  runtimeState: "present" | "missing" | "unknown";
  expectedRevision: string;
  backend: string;
  devicePreference: string;
  deviceObservation: string;
  interpreter: {
    command: string;
    status: "observed" | "missing" | "unknown" | "unsupported";
    executable: string | null;
    version: string | null;
    machine: string | null;
    modules: Array<{
      name: string;
      status: "located" | "missing" | "unknown";
      location: string | null;
    }>;
    detail: string;
  };
  bootstrap: SetupRuntimeObservation["interpreter"][];
  importProbe: string;
  cachedInventory: {
    status: "cached" | "missing" | "unreadable";
    createdAt: string | null;
    revision: string | null;
    interpreter: string | null;
    detail: string;
  };
};

export type RuntimeSetupSnapshot = {
  checkedAt: number;
  platform: string;
  arch: string;
  source: "desktop" | "preview";
  space: SetupSpaceSnapshot | null;
  runtimes: SetupRuntimeObservation[];
};

export type SetupDiskCapacity = {
  label: string;
  requestedPath: string;
  queriedPath: string | null;
  availableBytes: number | null;
  filesystem: string | null;
  status: "observed" | "unknown";
  detail: string;
};

export type SetupSpaceSnapshot = {
  magicModel: MagicModelId;
  checkedAt: number;
  disk: SetupDiskCapacity[];
  plans: Array<{
    kind: "speech" | "magic";
    modelName: string;
    modelDownloadBytes: number;
    modelInstalledBytes: number;
    modelTemporaryBytes: number;
    basis: string;
  }>;
  runtimeDownload: string;
  runtimeInstalled: string;
  runtimeTemporary: string;
  caveat: string;
};

export type LocalDataLocation = {
  path: string;
  status: "present" | "missing" | "partial";
  bytes: number;
  files: number;
  skippedLinks: number;
  problems: string[];
};

export type LocalDataOverview = {
  dataDirectory: string;
  checkedAt: number;
  categories: {
    id: "history" | "settings" | "models" | "runtimes" | "audio";
    label: string;
    description: string;
    locations: LocalDataLocation[];
  }[];
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
