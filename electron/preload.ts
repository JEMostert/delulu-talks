import { contextBridge, ipcRenderer } from "electron";
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
  TranscriptVersion,
  UpdateStatus,
} from "../src/types";

function listener<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DeluluApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:update", settings),
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
  rewriteMagic: (request: MagicRewriteRequest) => ipcRenderer.invoke("magic:rewrite", request),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:copy", text),
  authorizePaste: () => ipcRenderer.invoke("paste:authorize"),
  testPaste: () => ipcRenderer.invoke("paste:test"),
  updateTranscript: (id: string, version: TranscriptVersion, text: string | null) => ipcRenderer.invoke("history:updateTranscript", id, version, text),
  deleteHistory: (id: string) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  chooseAudioFile: () => ipcRenderer.invoke("lab:chooseAudio"),
  runLab: (request: LabRequest) => ipcRenderer.invoke("lab:run", request),
  exportTranscript: (id: string, format: ExportFormat) => ipcRenderer.invoke("history:export", id, format),
  recordingStarted: () => ipcRenderer.invoke("recorder:started"),
  recorderReady: () => ipcRenderer.invoke("recorder:ready"),
  recordingFailed: (message: string) => ipcRenderer.invoke("recorder:failed", message),
  recordingLevel: (level: number) => ipcRenderer.send("recorder:level", level),
  submitRecording: (recording: RecordingSubmission) => ipcRenderer.invoke("recorder:submit", recording),
  onStatus: (callback: (status: DictationStatus) => void) => listener("runtime:statusChanged", callback),
  onMagicStatus: (callback: (status: MagicStatus) => void) => listener("magic:statusChanged", callback),
  onSettingsChanged: (callback: (settings: AppSettings) => void) => listener("settings:changed", callback),
  onNavigate: (callback: (page: Page) => void) => listener("app:navigate", callback),
  onShortcutStatus: (callback: (status: ShortcutStatus) => void) => listener("shortcut:statusChanged", callback),
  onTranscript: (callback: (record: TranscriptRecord) => void) => listener("history:added", callback),
  onRecorderCommand: (callback: (command: RecorderCommand) => void) => listener("recorder:command", callback),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => listener("updates:statusChanged", callback),
};

contextBridge.exposeInMainWorld("delulu", api);
