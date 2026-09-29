import { contextBridge, ipcRenderer } from "electron";
import { encodeDomainFailure, type OperationResult } from "../src/domainErrors";
import type {
  AppSettings,
  DeluluApi,
  DictationStatus,
  ExportFormat,
  LabRequest,
  MagicRewriteRequest,
  MagicStatus,
  Page,
  PasteLastStatus,
  RecorderCommand,
  RecordingSubmission,
  ShortcutStatus,
  TranscriptRecord,
  UpdateStatus,
} from "../src/types";

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const result = await ipcRenderer.invoke(channel, ...args) as OperationResult<unknown>;
  if (!result || result.transport !== "delulu-operation-v1")
    throw new Error("Desktop operation transport mismatch. Restart the app.");
  if (result.ok === false) throw encodeDomainFailure(result.error);
  return result.value;
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
  getRendererRecoveryState: () => invoke("renderer:recoveryState"),
  reloadWorkspace: () => invoke("renderer:reload"),
  rendererControllerFailed: () =>
    invoke("renderer:controllerFailed"),
  getDiagnostics: () => invoke("runtime:diagnostics"),
  pasteLastTranscript: () => invoke("dictation:pasteLast"),
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
  rewriteMagic: (request: MagicRewriteRequest) =>
    invoke("magic:rewrite", request),
  copyText: (text: string) => invoke("clipboard:copy", text),
  authorizePaste: () => invoke("paste:authorize"),
  testPaste: () => invoke("paste:test"),
  updateTranscript: (id: string, text: string | null) =>
    invoke("history:updateTranscript", id, text),
  setTranscriptRewrite: (id, result, sourceText) =>
    invoke("history:setRewrite", id, result, sourceText),
  deleteHistory: (id: string) => invoke("history:delete", id),
  clearHistory: () => invoke("history:clear"),
  chooseAudioFile: () => invoke("lab:chooseAudio"),
  runLab: (request: LabRequest) => invoke("lab:run", request),
  exportTranscript: (id: string, format: ExportFormat) =>
    invoke("history:export", id, format),
  recordingStarted: (sessionId: string) =>
    invoke("recorder:started", sessionId),
  recordingLimitReached: (sessionId: string) =>
    invoke("recorder:limit", sessionId),
  recorderReady: () => invoke("recorder:ready"),
  recordingFailed: (message: string, sessionId: string) =>
    invoke("recorder:failed", message, sessionId),
  recordingLevel: (level: number) => ipcRenderer.send("recorder:level", level),
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
