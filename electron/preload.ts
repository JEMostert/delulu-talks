import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DeluluApi,
  DictationStatus,
  ExportFormat,
  LabRequest,
  RecorderCommand,
  RecordingSubmission,
  TranscriptRecord,
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
  getHistory: () => ipcRenderer.invoke("history:get"),
  getCapabilities: () => ipcRenderer.invoke("platform:capabilities"),
  toggleDictation: () => ipcRenderer.invoke("dictation:toggle"),
  startDictation: () => ipcRenderer.invoke("dictation:start"),
  stopDictation: () => ipcRenderer.invoke("dictation:stop"),
  cancelDictation: () => ipcRenderer.invoke("dictation:cancel"),
  setupModel: () => ipcRenderer.invoke("runtime:setup"),
  loadModel: () => ipcRenderer.invoke("runtime:load"),
  unloadModel: () => ipcRenderer.invoke("runtime:unload"),
  resetPythonEnvironment: () => ipcRenderer.invoke("runtime:reset"),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:copy", text),
  deleteHistory: (id: string) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  chooseAudioFile: () => ipcRenderer.invoke("lab:chooseAudio"),
  runLab: (request: LabRequest) => ipcRenderer.invoke("lab:run", request),
  exportTranscript: (id: string, format: ExportFormat) => ipcRenderer.invoke("history:export", id, format),
  recordingStarted: () => ipcRenderer.invoke("recorder:started"),
  recordingFailed: (message: string) => ipcRenderer.invoke("recorder:failed", message),
  submitRecording: (recording: RecordingSubmission) => ipcRenderer.invoke("recorder:submit", recording),
  onStatus: (callback: (status: DictationStatus) => void) => listener("runtime:statusChanged", callback),
  onTranscript: (callback: (record: TranscriptRecord) => void) => listener("history:added", callback),
  onRecorderCommand: (callback: (command: RecorderCommand) => void) => listener("recorder:command", callback),
};

contextBridge.exposeInMainWorld("delulu", api);
