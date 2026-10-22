import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { MAX_AUDIO_BATCH_FILES, audioMimeType } from "./audioFormats";
import { validateRewriteInstructions } from "./rewriteInstructions";
import { parseIpcRequest, type IpcRequestChannel } from "./ipcRequests";
import { domainErrorFromFailure, type OperationResult } from "./domainErrors";
import type { DeluluApi } from "./types";

/**
 * The Tauri side of `DeluluApi`, replacing the Electron preload. Requests
 * are validated here and again by the Rust router (`delulu-domain`); every
 * reply is a `delulu-operation-v1` envelope. There is no contextBridge, so
 * failures are thrown as real `DomainError`s.
 */

const TRANSPORT_MISMATCH =
  "Desktop operation transport mismatch. Restart the app.";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function failure(reason: unknown): Error {
  if (reason && typeof reason === "object") {
    const envelope = reason as Partial<OperationResult<unknown>>;
    const source =
      envelope.transport === "delulu-operation-v1" && envelope.ok === false
        ? envelope.error
        : reason;
    const domain = domainErrorFromFailure(source);
    if (domain) return domain;
    if (reason instanceof Error) return reason;
    const message = (source as { message?: unknown } | undefined)?.message;
    if (typeof message === "string" && message) return new Error(message);
  }
  return new Error(
    typeof reason === "string" && reason ? reason : "Desktop operation failed",
  );
}

function unwrap(result: unknown): unknown {
  const envelope = result as OperationResult<unknown> | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.transport !== "delulu-operation-v1"
  )
    throw new Error(TRANSPORT_MISMATCH);
  if (envelope.ok === false) throw failure(envelope);
  return envelope.value;
}

async function invoke(
  channel: IpcRequestChannel,
  ...args: unknown[]
): Promise<any> {
  const request = { channel, args: parseIpcRequest(channel, args) };
  let result: unknown;
  try {
    result = await tauriInvoke("ipc_invoke", request);
  } catch (reason) {
    throw failure(reason);
  }
  return unwrap(result);
}

/** Fire-and-forget; the desktop ignores invalid payloads. */
export function send(channel: IpcRequestChannel, ...args: unknown[]): void {
  void tauriInvoke("ipc_send", {
    channel,
    args: parseIpcRequest(channel, args),
  }).catch(() => undefined);
}

/** Binary replies arrive as a raw ArrayBuffer instead of an envelope. */
async function bytes(
  channel: IpcRequestChannel,
  ...args: unknown[]
): Promise<Uint8Array> {
  const request = { channel, args: parseIpcRequest(channel, args) };
  let result: unknown;
  try {
    result = await tauriInvoke("ipc_bytes", request);
  } catch (reason) {
    throw failure(reason);
  }
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (ArrayBuffer.isView(result))
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (Array.isArray(result)) return Uint8Array.from(result as number[]);
  // A router that answers with an envelope still reports its failure.
  unwrap(result);
  throw new Error(TRANSPORT_MISMATCH);
}

/** Events are named like the Electron channels; the payload is the value. */
function listener<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  listen<T>(channel, (event) => {
    if (!disposed) callback(event.payload);
  }).then(
    (stop) => {
      // The disposer may run before registration finishes.
      if (disposed) stop();
      else unlisten = stop;
    },
    () => undefined,
  );
  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Native drag-and-drop comes from the webview API (Tauri's built-in
 * `tauri://drag-drop`), not from a `window:filesDropped` backend event, so
 * the window must keep `dragDropEnabled` (the default). One native
 * subscription fans out to every renderer subscriber.
 */
const dropListeners = new Set<(paths: string[]) => void>();
let dropSubscription: Promise<UnlistenFn> | null = null;
function onFilesDropped(callback: (paths: string[]) => void): () => void {
  dropListeners.add(callback);
  if (!dropSubscription) {
    const subscription = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop" || !event.payload.paths.length) return;
      const paths = [...event.payload.paths];
      for (const receive of [...dropListeners]) receive(paths);
    });
    dropSubscription = subscription;
    subscription.catch(() => {
      if (dropSubscription === subscription) dropSubscription = null;
    });
  }
  return () => {
    dropListeners.delete(callback);
  };
}

export const desktopApi: DeluluApi = {
  getListenStatus: () => invoke("listen:status"),
  onListenStatus: (callback) => listener("listen:statusChanged", callback),
  startListening: () => invoke("listen:start"),
  stopListening: () => invoke("listen:stop"),
  installVoiceSkill: () => invoke("voice:installSkill"),
  getVoiceStatus: () => invoke("voice:status"),
  onVoiceStatus: (callback) => listener("voice:statusChanged", callback),
  setupVoice: () => invoke("voice:setup"),
  cancelVoiceSetup: () => invoke("voice:cancelSetup"),
  loadVoice: () => invoke("voice:load"),
  unloadVoice: () => invoke("voice:unload"),
  speak: (request) => invoke("voice:speak", request),
  stopSpeaking: () => invoke("voice:stop"),
  speakClipboard: () => invoke("voice:speakClipboard"),
  chooseVoiceReference: () => invoke("voice:chooseReference"),
  removeVoiceReference: () => invoke("voice:removeReference"),
  getVoiceAgentSetup: () => invoke("voice:agentSetup"),
  listMicrophones: () => invoke("audio:inputs"),
  onMicrophonesChanged: (callback) => listener("audio:inputsChanged", callback),
  listSpeakers: () => invoke("audio:outputs"),
  onRecordingLevel: (callback) => listener("recorder:level", callback),
  testCaptureCue: () => invoke("audio:testCue"),
  inspectAudioFile: (path) => invoke("lab:inspectAudio", path),
  getRuleUsage: () => invoke("rules:usage"),
  resetRuleUsage: () => invoke("rules:resetUsage"),
  previewModelCache: () => invoke("cache:preview"),
  listSpeechDownloads: () => invoke("models:downloads"),
  deleteSpeechDownload: (id) => invoke("models:deleteDownload", id),
  cleanupModelCache: (token, ids) => invoke("cache:cleanup", token, ids),
  getRendererRecoveryState: () => invoke("renderer:recoveryState"),
  reloadWorkspace: () => invoke("renderer:reload"),
  exportEncryptedHistory: (passphrase) =>
    invoke("history:encryptedExport", passphrase),
  recoverEncryptedHistory: (passphrase) =>
    invoke("history:encryptedRecover", passphrase),
  rendererControllerFailed: () => invoke("renderer:controllerFailed"),
  getDiagnostics: () => invoke("runtime:diagnostics"),
  getRenderingMode: () => invoke("runtime:renderingMode"),
  onRenderingModeChanged: (callback) =>
    listener("runtime:renderingModeChanged", callback),
  getRuntimeSetupSnapshot: () => invoke("runtime:setupSnapshot"),
  getSetupLog: (kind) => invoke("runtime:setupLog", kind),
  getLocalDataOverview: () => invoke("storage:overview"),
  pasteLastTranscript: () => invoke("dictation:pasteLast"),
  getPasteRecovery: () => invoke("paste:recovery"),
  copyInstead: (id) => invoke("paste:copyInstead", id),
  dismissPasteRecovery: (id) => invoke("paste:dismissRecovery", id),
  onPasteRecovery: (callback) => listener("paste:recoveryChanged", callback),
  getPasteLastStatus: () => invoke("dictation:pasteLastStatus"),
  cancelPasteLast: (operationId) =>
    invoke("dictation:cancelPasteLast", operationId),
  onPasteLastStatus: (callback) =>
    listener("dictation:pasteLastChanged", callback),
  discardFailedRecording: () => invoke("dictation:discardFailed"),
  retryRecording: () => invoke("dictation:retry"),
  getSettings: () => invoke("settings:get"),
  updateSettings: (settings) => invoke("settings:update", settings),
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
  rewriteMagic: (request) =>
    invoke("magic:rewrite", {
      ...request,
      instructions: validateRewriteInstructions(request.instructions),
    }),
  cancelRewrite: (operationId) => invoke("magic:cancelRewrite", operationId),
  copyText: (text) => invoke("clipboard:copy", text),
  authorizePaste: () => invoke("paste:authorize"),
  testPaste: () => invoke("paste:test"),
  updateTranscript: (id, text) => invoke("history:updateTranscript", id, text),
  setTranscriptRewrite: (id, result, sourceText, expectedSourceRevision) =>
    invoke(
      "history:setRewrite",
      id,
      result,
      sourceText,
      expectedSourceRevision,
    ),
  setTranscriptTitle: (id, title) => invoke("history:setTitle", id, title),
  deleteHistory: (id) => invoke("history:delete", id),
  clearHistory: () => invoke("history:clear"),
  previewHistoryRetention: (policy) =>
    invoke("history:retentionPreview", policy),
  applyHistoryRetention: (token) => invoke("history:retentionApply", token),
  getHistoryBatchSnapshot: () => invoke("history:batchSnapshot"),
  stageHistoryDeletion: (ids) => invoke("history:stageDeletion", ids),
  undoHistoryDeletion: (token) => invoke("history:undoDeletion", token),
  onHistoryBatchChanged: (callback) =>
    listener("history:batchChanged", callback),
  exportHistorySelection: (ids, format) =>
    invoke("history:exportSelection", ids, format),
  onHistoryRetentionApplied: (callback) =>
    listener("history:retentionApplied", callback),
  chooseAudioFile: () => invoke("lab:chooseAudio"),
  runLab: (request) => invoke("lab:run", request),
  chooseAudioFiles: () => invoke("lab:chooseAudioFiles"),
  getAudioJobs: () => invoke("lab:getJobs"),
  loadAudioSource: async (path) => ({
    bytes: await bytes("lab:loadSource", path),
    mime: audioMimeType(path),
  }),
  removeAudioJob: (path) => invoke("lab:removeJob", path),
  relinkAudioJob: (path) => invoke("lab:relinkJob", path),
  onFilesDropped,
  resolveAudioPaths: async (paths) => {
    if (!Array.isArray(paths) || paths.length > MAX_AUDIO_BATCH_FILES)
      throw new Error(`Choose at most ${MAX_AUDIO_BATCH_FILES} files at once`);
    return invoke("lab:resolveAudioPaths", paths);
  },
  getImportQueue: () => invoke("lab:queueGet"),
  enqueueImport: (path) => invoke("lab:queueEnqueue", path),
  pauseImportQueue: (paused) => invoke("lab:queuePause", paused),
  moveImportJob: (id, direction) => invoke("lab:queueMove", id, direction),
  cancelImportJob: (id) => invoke("lab:queueCancel", id),
  retryImportJob: (id) => invoke("lab:queueRetry", id),
  clearFinishedImports: () => invoke("lab:queueClearFinished"),
  onImportQueue: (callback) => listener("lab:queueChanged", callback),
  exportTranscript: (id, format) => invoke("history:export", id, format),
  onStatus: (callback) => listener("runtime:statusChanged", callback),
  onMagicStatus: (callback) => listener("magic:statusChanged", callback),
  onSettingsChanged: (callback) => listener("settings:changed", callback),
  getWindowVisibility: () => invoke("app:visibility"),
  onWindowVisibility: (callback) => listener("app:visibility", callback),
  onNavigate: (callback) => listener("app:navigate", callback),
  onShortcutStatus: (callback) => listener("shortcut:statusChanged", callback),
  onTranscript: (callback) => listener("history:added", callback),
  onUpdateStatus: (callback) => listener("updates:statusChanged", callback),
};

/** Installs `window.delulu` inside Tauri; returns null elsewhere. */
export function installDesktopBridge(): DeluluApi | null {
  if (!isTauri()) return null;
  window.delulu ??= desktopApi;
  return window.delulu;
}
