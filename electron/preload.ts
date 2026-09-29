import { contextBridge, ipcRenderer } from "electron";
import { parseIpcRequest } from "../src/ipcRequests";
import type { IpcRequestChannel } from "../src/ipcRequests";
import type {
  AppSettings,
  DeluluApi,
  DictationStatus,
  ExportFormat,
  LabRequest,
  MagicRewriteRequest,
  MagicStatus,
  Page,
  RecorderCommand,
  RecordingSubmission,
  ShortcutStatus,
  TranscriptRecord,
  UpdateStatus,
} from "../src/types";

async function invoke(channel: IpcRequestChannel, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...parseIpcRequest(channel, args));
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
  getRendererRecoveryState: () => invoke("renderer:recoveryState"),
  reloadWorkspace: () => invoke("renderer:reload"),
  rendererControllerFailed: () =>
    invoke("renderer:controllerFailed"),
  getDiagnostics: () => invoke("runtime:diagnostics"),
  pasteLastTranscript: () => invoke("dictation:pasteLast"),
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
  inspectAudioFile: (path: string) => invoke("lab:inspectAudio", path),
  runLab: (request: LabRequest) => invoke("lab:run", request),
  exportTranscript: (id: string, format: ExportFormat) =>
    invoke("history:export", id, format),
  recordingStarted: () => invoke("recorder:started"),
  recorderReady: () => invoke("recorder:ready"),
  recordingFailed: (message: string) =>
    invoke("recorder:failed", message),
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
