import { MAX_AUDIO_BATCH_FILES } from "../src/audioFormats";
import { validateRewriteInstructions } from "../src/rewriteInstructions";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { parseIpcRequest } from "../src/ipcRequests";
import type { IpcRequestChannel } from "../src/ipcRequests";
import { encodeDomainFailure, type OperationResult } from "../src/domainErrors";
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

async function invoke(
  channel: IpcRequestChannel,
  ...args: unknown[]
): Promise<any> {
  const result = (await ipcRenderer.invoke(
    channel,
    ...parseIpcRequest(channel, args),
  )) as OperationResult<unknown>;
  if (!result || result.transport !== "delulu-operation-v1")
    throw new Error("Desktop operation transport mismatch. Restart the app.");
  if (result.ok === false) throw encodeDomainFailure(result.error);
  return result.value;
}

function send(channel: IpcRequestChannel, ...args: unknown[]): void {
  ipcRenderer.send(channel, ...parseIpcRequest(channel, args));
}

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
  inspectAudioFile: (path) => invoke("lab:inspectAudio", path),
  getSelectedTextState: () => invoke("selectedText:state"),
  enableSelectedText: (enabled) => invoke("selectedText:enable", enabled),
  discardSelectedText: (id) => invoke("selectedText:discard", id),
  replaceSelectedText: (id, text) => invoke("selectedText:replace", id, text),
  onSelectedTextState: (callback) => listener("selectedText:changed", callback),
  getRuleUsage: () => invoke("rules:usage"),
  resetRuleUsage: () => invoke("rules:resetUsage"),
  previewModelCache: () => invoke("cache:preview"),
  cleanupModelCache: (token, ids) => invoke("cache:cleanup", token, ids),
  getRendererRecoveryState: () => invoke("renderer:recoveryState"),
  reloadWorkspace: () => invoke("renderer:reload"),
  exportEncryptedHistory: (passphrase) =>
    invoke("history:encryptedExport", passphrase),
  recoverEncryptedHistory: (passphrase) =>
    invoke("history:encryptedRecover", passphrase),
  rendererControllerFailed: () => invoke("renderer:controllerFailed"),
  getDiagnostics: () => invoke("runtime:diagnostics"),
  getRuntimeSetupSnapshot: () => invoke("runtime:setupSnapshot"),
  getSetupLog: (kind) => invoke("runtime:setupLog", kind),
  getLocalDataOverview: () => invoke("storage:overview"),
  pasteLastTranscript: () => invoke("dictation:pasteLast"),
  getPasteRecovery: () => invoke("paste:recovery"),
  copyInstead: (id: string) => invoke("paste:copyInstead", id),
  dismissPasteRecovery: (id: string) => invoke("paste:dismissRecovery", id),
  onPasteRecovery: (callback: (recovery: PasteRecovery | null) => void) =>
    listener("paste:recoveryChanged", callback),
  getPasteLastStatus: () => invoke("dictation:pasteLastStatus"),
  cancelPasteLast: (operationId: string) =>
    invoke("dictation:cancelPasteLast", operationId),
  onPasteLastStatus: (callback: (status: PasteLastStatus) => void) =>
    listener("dictation:pasteLastChanged", callback),
  discardFailedRecording: () => invoke("dictation:discardFailed"),
  retryRecording: () => invoke("dictation:retry"),
  getSettings: () => invoke("settings:get"),
  updateSettings: (settings: Partial<AppSettings>) =>
    invoke("settings:update", settings),
  managePersonalProfile: (command) => invoke("profiles:manage", command),
  activatePersonalProfile: (command) => invoke("profiles:activate", command),
  getStatus: () => invoke("runtime:status"),
  getMagicStatus: () => invoke("magic:status"),
  getShortcutStatus: () => invoke("shortcut:status"),
  configureShortcut: () => invoke("shortcut:configure"),
  getHistory: () => invoke("history:get"),
  getCapabilities: () => invoke("platform:capabilities"),
  getUpdateStatus: () => invoke("updates:get"),
  checkForUpdates: () => invoke("updates:check"),
  downloadUpdate: () => invoke("updates:download"),
  installUpdate: () => invoke("updates:install"),
  pauseDictation: () => invoke("dictation:pause"),
  resumeDictation: () => invoke("dictation:resume"),
  toggleDictation: () => invoke("dictation:toggle"),
  startDictation: () => invoke("dictation:start"),
  stopDictation: () => invoke("dictation:stop"),
  cancelDictation: () => invoke("dictation:cancel"),
  setupModel: () => invoke("runtime:setup"),
  loadModel: () => invoke("runtime:load"),
  unloadModel: () => invoke("runtime:unload"),
  resetPythonEnvironment: () => invoke("runtime:reset"),
  setupMagic: () => invoke("magic:setup"),
  loadMagic: () => invoke("magic:load"),
  unloadMagic: () => invoke("magic:unload"),
  cancelModelSetup: () => invoke("runtime:cancelSetup"),
  cancelMagicSetup: () => invoke("magic:cancelSetup"),
  rewriteMagic: (request: MagicRewriteRequest) =>
    invoke("magic:rewrite", {
      ...request,
      instructions: validateRewriteInstructions(request.instructions),
    }),
  cancelRewrite: (operationId: string) =>
    invoke("magic:cancelRewrite", operationId),
  copyText: (text: string) => invoke("clipboard:copy", text),
  authorizePaste: () => invoke("paste:authorize"),
  testPaste: () => invoke("paste:test"),
  updateTranscript: (id: string, text: string | null) =>
    invoke("history:updateTranscript", id, text),
  setTranscriptRewrite: (id, result, sourceText, expectedSourceRevision) =>
    invoke(
      "history:setRewrite",
      id,
      result,
      sourceText,
      expectedSourceRevision,
    ),
  setTranscriptTitle: (id: string, title: string | null) =>
    invoke("history:setTitle", id, title),
  deleteHistory: (id: string) => invoke("history:delete", id),
  clearHistory: () => invoke("history:clear"),
  previewHistoryRetention: (policy: HistoryRetentionPolicy) =>
    invoke("history:retentionPreview", policy),
  applyHistoryRetention: (token: string) =>
    invoke("history:retentionApply", token),
  getHistoryBatchSnapshot: () => invoke("history:batchSnapshot"),
  stageHistoryDeletion: (ids) => invoke("history:stageDeletion", ids),
  undoHistoryDeletion: (token) => invoke("history:undoDeletion", token),
  onHistoryBatchChanged: (callback) =>
    listener("history:batchChanged", callback),
  exportHistorySelection: (ids, format) =>
    invoke("history:exportSelection", ids, format),
  onHistoryRetentionApplied: (callback: (removedIds: string[]) => void) =>
    listener("history:retentionApplied", callback),
  chooseProjectIdentifier: (input) => invoke("projectVocabulary:choose", input),
  getProjectVocabulary: () => invoke("projectVocabulary:get"),
  selectProjectVocabulary: () => invoke("projectVocabulary:select"),
  refreshProjectVocabulary: () => invoke("projectVocabulary:refresh"),
  clearProjectVocabulary: () => invoke("projectVocabulary:clear"),
  chooseAudioFile: () => invoke("lab:chooseAudio"),
  runLab: (request: LabRequest) => invoke("lab:run", request),
  chooseAudioFiles: () => invoke("lab:chooseAudioFiles"),
  getAudioJobs: () => invoke("lab:getJobs"),
  loadAudioSource: (path: string) => invoke("lab:loadSource", path),
  removeAudioJob: (path: string) => invoke("lab:removeJob", path),
  relinkAudioJob: (path: string) => invoke("lab:relinkJob", path),
  resolveAudioFiles: async (files: File[]) => {
    if (!Array.isArray(files) || files.length > MAX_AUDIO_BATCH_FILES)
      throw new Error(`Choose at most ${MAX_AUDIO_BATCH_FILES} files at once`);
    const paths = files.map((file) => {
      let path: string;
      try {
        path = webUtils.getPathForFile(file);
      } catch {
        throw new Error(
          `${file?.name || "Dropped item"}: this is not a local file`,
        );
      }
      if (!path) throw new Error(`${file.name}: this file has no local path`);
      return path;
    });
    return invoke("lab:resolveAudioFiles", paths);
  },
  getImportQueue: () => invoke("lab:queueGet"),
  enqueueImport: (path) => invoke("lab:queueEnqueue", path),
  pauseImportQueue: (paused) => invoke("lab:queuePause", paused),
  moveImportJob: (id, direction) => invoke("lab:queueMove", id, direction),
  cancelImportJob: (id) => invoke("lab:queueCancel", id),
  retryImportJob: (id) => invoke("lab:queueRetry", id),
  clearFinishedImports: () => invoke("lab:queueClearFinished"),
  onImportQueue: (callback) => listener("lab:queueChanged", callback),
  exportTranscript: (id: string, format: ExportFormat) =>
    invoke("history:export", id, format),
  exportTranscriptTemplate: (id, request) =>
    invoke("history:exportTemplate", id, request),
  recordingStarted: (sessionId: string) =>
    invoke("recorder:started", sessionId),
  recordingLimitReached: (sessionId: string) =>
    invoke("recorder:limit", sessionId),
  recordingPauseChanged: (sessionId, paused) =>
    invoke("recorder:pause-changed", sessionId, paused),
  recordingSilence: (sessionId, remainingSeconds, stop) =>
    invoke("recorder:silence", sessionId, remainingSeconds, stop),
  recorderReady: () => invoke("recorder:ready"),
  recordingFailed: (message: string, sessionId: string) =>
    invoke("recorder:failed", message, sessionId),
  recordingInputChanged: (sessionId, message, inputLost) =>
    invoke("recorder:inputChanged", sessionId, message, inputLost),
  recordingLevel: (level: number) => send("recorder:level", level),
  submitRecording: (recording: RecordingSubmission) =>
    invoke("recorder:submit", recording),
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
