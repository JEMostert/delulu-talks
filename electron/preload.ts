import { validateRewriteInstructions } from "../src/rewriteInstructions";
import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DeluluApi,
  DictationStatus,
  ExportFormat,
  HistoryRetentionPolicy,
  LabRequest,
  MagicRewriteRequest,
  MagicStatus,
  Page,
  PasteRecovery,
  PasteLastStatus,
  RecorderCommand,
  RecordingSubmission,
  ShortcutStatus,
  TranscriptRecord,
  UpdateStatus,
} from "../src/types";

function listener<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DeluluApi = {
  getRuleUsage: () => ipcRenderer.invoke("rules:usage"),
  resetRuleUsage: () => ipcRenderer.invoke("rules:resetUsage"),
  previewModelCache: () => ipcRenderer.invoke("cache:preview"),
  cleanupModelCache: (token, ids) => ipcRenderer.invoke("cache:cleanup", token, ids),
  getRendererRecoveryState: () => ipcRenderer.invoke("renderer:recoveryState"),
  reloadWorkspace: () => ipcRenderer.invoke("renderer:reload"),
  rendererControllerFailed: () =>
    ipcRenderer.invoke("renderer:controllerFailed"),
  getDiagnostics: () => ipcRenderer.invoke("runtime:diagnostics"),
  getRuntimeSetupSnapshot: () => ipcRenderer.invoke("runtime:setupSnapshot"),
  getSetupLog: (kind) => ipcRenderer.invoke("runtime:setupLog", kind),
  getLocalDataOverview: () => ipcRenderer.invoke("storage:overview"),
  pasteLastTranscript: () => ipcRenderer.invoke("dictation:pasteLast"),
  getPasteRecovery: () => ipcRenderer.invoke("paste:recovery"),
  copyInstead: (id: string) => ipcRenderer.invoke("paste:copyInstead", id),
  dismissPasteRecovery: (id: string) => ipcRenderer.invoke("paste:dismissRecovery", id),
  onPasteRecovery: (callback: (recovery: PasteRecovery | null) => void) =>
    listener("paste:recoveryChanged", callback),
  getPasteLastStatus: () => ipcRenderer.invoke("dictation:pasteLastStatus"),
  cancelPasteLast: (operationId: string) =>
    ipcRenderer.invoke("dictation:cancelPasteLast", operationId),
  onPasteLastStatus: (callback: (status: PasteLastStatus) => void) =>
    listener("dictation:pasteLastChanged", callback),
  discardFailedRecording: () => ipcRenderer.invoke("dictation:discardFailed"),
  retryRecording: () => ipcRenderer.invoke("dictation:retry"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke("settings:update", settings),
  managePersonalProfile: (command) => ipcRenderer.invoke("profiles:manage", command),
  activatePersonalProfile: (command) => ipcRenderer.invoke("profiles:activate", command),
  getStatus: () => ipcRenderer.invoke("runtime:status"),
  getMagicStatus: () => ipcRenderer.invoke("magic:status"),
  getShortcutStatus: () => ipcRenderer.invoke("shortcut:status"),
  configureShortcut: () => ipcRenderer.invoke("shortcut:configure"),
  getHistory: () => ipcRenderer.invoke("history:get"),
  getCapabilities: () => ipcRenderer.invoke("platform:capabilities"),
  getUpdateStatus: () => ipcRenderer.invoke("updates:get"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  pauseDictation: () => ipcRenderer.invoke("dictation:pause"),
  resumeDictation: () => ipcRenderer.invoke("dictation:resume"),
  toggleDictation: () => ipcRenderer.invoke("dictation:toggle"),
  startDictation: () => ipcRenderer.invoke("dictation:start"),
  stopDictation: () => ipcRenderer.invoke("dictation:stop"),
  cancelDictation: () => ipcRenderer.invoke("dictation:cancel"),
  setupModel: () => ipcRenderer.invoke("runtime:setup"),
  loadModel: () => ipcRenderer.invoke("runtime:load"),
  unloadModel: () => ipcRenderer.invoke("runtime:unload"),
  resetPythonEnvironment: () => ipcRenderer.invoke("runtime:reset"),
  setupMagic: () => ipcRenderer.invoke("magic:setup"),
  loadMagic: () => ipcRenderer.invoke("magic:load"),
  unloadMagic: () => ipcRenderer.invoke("magic:unload"),
  rewriteMagic: (request: MagicRewriteRequest) =>
    ipcRenderer.invoke("magic:rewrite", {
      ...request,
      instructions: validateRewriteInstructions(request.instructions),
    }),
  cancelRewrite: (operationId: string) =>
    ipcRenderer.invoke("magic:cancelRewrite", operationId),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:copy", text),
  authorizePaste: () => ipcRenderer.invoke("paste:authorize"),
  testPaste: () => ipcRenderer.invoke("paste:test"),
  updateTranscript: (id: string, text: string | null) =>
    ipcRenderer.invoke("history:updateTranscript", id, text),
  setTranscriptRewrite: (id, result, sourceText, expectedSourceRevision) =>
    ipcRenderer.invoke("history:setRewrite", id, result, sourceText, expectedSourceRevision),
  setTranscriptTitle: (id: string, title: string | null) =>
    ipcRenderer.invoke("history:setTitle", id, title),
  deleteHistory: (id: string) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  previewHistoryRetention: (policy: HistoryRetentionPolicy) => ipcRenderer.invoke("history:retentionPreview", policy),
  applyHistoryRetention: (token: string) => ipcRenderer.invoke("history:retentionApply", token),
  onHistoryRetentionApplied: (callback: (removedIds: string[]) => void) =>
    listener("history:retentionApplied", callback),
  chooseProjectIdentifier: (input) => ipcRenderer.invoke("projectVocabulary:choose", input),
  getProjectVocabulary: () => ipcRenderer.invoke("projectVocabulary:get"),
  selectProjectVocabulary: () => ipcRenderer.invoke("projectVocabulary:select"),
  refreshProjectVocabulary: () => ipcRenderer.invoke("projectVocabulary:refresh"),
  clearProjectVocabulary: () => ipcRenderer.invoke("projectVocabulary:clear"),
  chooseAudioFile: () => ipcRenderer.invoke("lab:chooseAudio"),
  runLab: (request: LabRequest) => ipcRenderer.invoke("lab:run", request),
  exportTranscript: (id: string, format: ExportFormat) =>
    ipcRenderer.invoke("history:export", id, format),
  exportTranscriptTemplate: (id, request) =>
    ipcRenderer.invoke("history:exportTemplate", id, request),
  recordingStarted: (sessionId: string) =>
    ipcRenderer.invoke("recorder:started", sessionId),
  recordingLimitReached: (sessionId: string) =>
    ipcRenderer.invoke("recorder:limit", sessionId),
  recordingPauseChanged: (sessionId, paused) => ipcRenderer.invoke("recorder:pause-changed", sessionId, paused),
  recordingSilence: (sessionId, remainingSeconds, stop) =>
    ipcRenderer.invoke("recorder:silence", sessionId, remainingSeconds, stop),
  recorderReady: () => ipcRenderer.invoke("recorder:ready"),
  recordingFailed: (message: string, sessionId: string) =>
    ipcRenderer.invoke("recorder:failed", message, sessionId),
  recordingInputChanged: (sessionId, message, inputLost) =>
    ipcRenderer.invoke("recorder:inputChanged", sessionId, message, inputLost),
  recordingLevel: (level: number) => ipcRenderer.send("recorder:level", level),
  submitRecording: (recording: RecordingSubmission) =>
    ipcRenderer.invoke("recorder:submit", recording),
  onStatus: (callback: (status: DictationStatus) => void) =>
    listener("runtime:statusChanged", callback),
  onMagicStatus: (callback: (status: MagicStatus) => void) =>
    listener("magic:statusChanged", callback),
  onSettingsChanged: (callback: (settings: AppSettings) => void) =>
    listener("settings:changed", callback),
  onNavigate: (callback: (page: Page) => void) =>
    listener("app:navigate", callback),
  onShortcutStatus: (callback: (status: ShortcutStatus) => void) =>
    listener("shortcut:statusChanged", callback),
  onTranscript: (callback: (record: TranscriptRecord) => void) =>
    listener("history:added", callback),
  onRecorderCommand: (callback: (command: RecorderCommand) => void) =>
    listener("recorder:command", callback),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) =>
    listener("updates:statusChanged", callback),
};

contextBridge.exposeInMainWorld("delulu", api);
