import { emptyImportQueue } from "./importQueue";
import {
  previewScenario,
  scenarioHistory,
  scenarioMagicStatus,
  scenarioStatus,
  scenarioUpdateStatus,
} from "./previewScenarios";
import { activatePersonalProfile } from "./activePersonalProfile";
import { changePersonalProfiles } from "./personalProfileCommands";
import { emptyProjectVocabulary } from "./projectVocabulary";
import { DEFAULT_SETTINGS } from "./data";
import {
  deliveredText,
  originalTranscriptText,
  transcriptSourceRevision,
} from "./transcriptText";
import { normalizeTranscriptTitle } from "./transcriptTitle";
import type {
  AppSettings,
  AudioFileSelection,
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
} from "./types";

let demoHistory: TranscriptRecord[] =
  previewScenario === "empty" ? [] : scenarioHistory();

let liveStatus: DictationStatus = scenarioStatus();
const statusListeners = new Set<(status: DictationStatus) => void>();
const transcriptListeners = new Set<(record: TranscriptRecord) => void>();
function setLiveStatus(patch: Partial<DictationStatus>) {
  liveStatus = { ...liveStatus, ...patch };
  for (const listener of statusListeners) listener(liveStatus);
}

function mockSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("delulu-demo-settings");
    return raw
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
      : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function desktopOnly(): never {
  throw new Error(
    "This action needs the installed desktop app. You’re viewing a design preview.",
  );
}

export const previewApi: DeluluApi = {
  async getRenderingMode() {
    return "hardware";
  },
  onRenderingModeChanged() {
    return () => {};
  },
  getSelectedTextState: async () => ({
    enabled: false,
    supported: false,
    shortcut: "CommandOrControl+Shift+R",
    session: null,
    error: null,
  }),
  enableSelectedText: async () => {
    throw new Error(
      "Native selected-text capture requires the desktop application on X11.",
    );
  },
  discardSelectedText: async () => {},
  replaceSelectedText: async () => {
    throw new Error(
      "Native selected-text replacement is unavailable in browser preview.",
    );
  },
  onSelectedTextState: () => () => {},
  async getRuleUsage() {
    return desktopOnly();
  },
  async resetRuleUsage() {
    return desktopOnly();
  },
  async previewModelCache() {
    return desktopOnly();
  },
  async cleanupModelCache() {
    return desktopOnly();
  },
  async exportEncryptedHistory() {
    return desktopOnly();
  },
  async recoverEncryptedHistory() {
    return desktopOnly();
  },
  async getRendererRecoveryState() {
    return { canReload: true, reason: null, canStopRecording: false };
  },
  async reloadWorkspace() {
    window.location.reload();
  },
  async rendererControllerFailed() {},
  async getRuntimeSetupSnapshot() {
    return {
      checkedAt: Date.now(),
      platform: "Browser preview",
      arch: "Unknown",
      source: "preview" as const,
      space: null,
      runtimes: [],
    };
  },
  async getLocalDataOverview() {
    desktopOnly();
  },
  async getDiagnostics() {
    return {
      platform: "Browser preview",
      arch: "Preview",
      memoryGB: 16,
      freeMemoryGB: 8,
      python: "Desktop app required",
      ffmpeg: "Not available",
      dataDirectory: "Desktop app required",
      runtimeInstalled: false,
      microphone: {
        state: "not-applicable",
        canRequestCapture: false,
        detail:
          "Native microphone permission is available in the desktop app. Browser preview does not inspect macOS permissions.",
      },
      accessibility: {
        state: "not-applicable",
        canAttemptPaste: false,
        detail:
          "Native Accessibility permission is available in the desktop app. Browser preview cannot attempt native paste.",
      },
      packages: {},
      checkedAt: Date.now(),
    };
  },
  async getSetupLog(kind) {
    return {
      kind,
      attemptId: null,
      startedAt: null,
      finishedAt: null,
      outcome: "idle",
      entries: [],
      truncated: false,
      maxEntries: 128,
      maxCharacters: 64000,
    };
  },
  async getPasteRecovery() {
    return null;
  },
  async copyInstead(_id: string) {
    desktopOnly();
  },
  async dismissPasteRecovery(_id: string) {},
  onPasteRecovery(_callback) {
    return () => undefined;
  },
  async getPasteLastStatus() {
    return {
      phase: "idle" as const,
      operationId: null,
      dueAt: null,
      remainingSeconds: 0,
      message: "",
    };
  },
  async cancelPasteLast() {
    desktopOnly();
  },
  onPasteLastStatus: () => () => {},
  async pasteLastTranscript() {
    desktopOnly();
  },
  async discardFailedRecording() {
    desktopOnly();
  },
  async retryRecording() {
    desktopOnly();
  },
  async getSettings() {
    return mockSettings();
  },
  async updateSettings(settings) {
    const current = mockSettings();
    if (
      Object.prototype.hasOwnProperty.call(settings, "activePersonalProfile") &&
      JSON.stringify(settings.activePersonalProfile) !==
        JSON.stringify(current.activePersonalProfile)
    )
      throw new Error("Switch profiles using the explicit activation preview.");
    const next = { ...current, ...settings };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async activatePersonalProfile(command) {
    const current = mockSettings();
    const next = { ...current, ...activatePersonalProfile(current, command) };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async managePersonalProfile(command) {
    const current = mockSettings();
    const next = {
      ...current,
      personalProfiles: changePersonalProfiles(current, command, () =>
        crypto.randomUUID(),
      ),
    };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async getStatus() {
    return liveStatus;
  },
  async getMagicStatus() {
    return scenarioMagicStatus();
  },
  async getShortcutStatus() {
    return {
      accelerator: mockSettings().shortcut,
      registered: true,
      method: "portal",
      message: "Ready through the Wayland shortcut portal",
      lastTriggeredAt: null,
    };
  },
  async configureShortcut() {
    desktopOnly();
  },
  async getHistory() {
    return demoHistory;
  },
  async getCapabilities() {
    return {
      platform: "linux",
      desktop: "Browser preview",
      sessionType: "wayland",
      pasteMethod: "clipboard-only",
      overlayMethod: "layer-shell",
      overlayDetail: "Native click-through layer-shell pill",
      wayland: true,
    };
  },
  async getUpdateStatus() {
    return scenarioUpdateStatus();
  },
  async checkForUpdates() {
    return this.getUpdateStatus();
  },
  async downloadUpdate() {
    return this.getUpdateStatus();
  },
  async installUpdate() {
    desktopOnly();
  },
  async pauseDictation() {
    setLiveStatus({ phase: "paused", message: "Paused — microphone open" });
  },
  async resumeDictation() {
    setLiveStatus({ phase: "listening", message: "Listening — resumed" });
  },
  async recordingPauseChanged() {},
  async toggleDictation() {
    // The preview simulates a short dictation so the shell can be reviewed.
    if (liveStatus.phase === "listening" || liveStatus.phase === "paused") {
      setLiveStatus({ phase: "transcribing", message: "Transcribing locally" });
      setTimeout(() => {
        const record: TranscriptRecord = {
          ...scenarioHistory()[2],
          id: `demo-${Date.now()}`,
          createdAt: Date.now(),
          title: null,
          editedText: null,
          text: "This is a simulated dictation from the browser preview.",
        };
        demoHistory = [record, ...demoHistory];
        for (const listener of transcriptListeners) listener(record);
        setLiveStatus({ phase: "idle", message: "Ready" });
      }, 1400);
    } else if (liveStatus.phase === "idle")
      setLiveStatus({
        phase: "listening",
        message: "Listening — press the shortcut again to finish",
      });
  },
  async startDictation() {
    desktopOnly();
  },
  async stopDictation() {
    desktopOnly();
  },
  async cancelDictation() {
    setLiveStatus({ phase: "idle", message: "Recording cancelled" });
  },
  async setupModel() {
    desktopOnly();
  },
  async cancelModelSetup() {
    desktopOnly();
  },
  async loadModel() {
    desktopOnly();
  },
  async unloadModel() {
    desktopOnly();
  },
  async resetPythonEnvironment() {
    desktopOnly();
  },
  async setupMagic() {
    desktopOnly();
  },
  async cancelMagicSetup() {
    desktopOnly();
  },
  async loadMagic() {
    desktopOnly();
  },
  async unloadMagic() {
    desktopOnly();
  },
  async rewriteMagic(_request: MagicRewriteRequest) {
    return desktopOnly();
  },
  async cancelRewrite(_operationId: string) {
    return desktopOnly();
  },
  async copyText(text) {
    await navigator.clipboard?.writeText(text);
  },
  async authorizePaste() {
    desktopOnly();
  },
  async testPaste() {
    desktopOnly();
  },
  async updateTranscript(id: string, text: string | null) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    const normalized = text?.trim() ?? null;
    const correction =
      normalized && normalized !== originalTranscriptText(record)
        ? normalized
        : null;
    const revision = transcriptSourceRevision(record);
    if (revision >= Number.MAX_SAFE_INTEGER)
      throw new Error("This transcript has reached its revision limit");
    const updated = {
      ...record,
      editedText: correction,
      sourceRevision: revision + 1,
      rewriteSourceRevision: null,
      magicText: null,
      magicModel: null,
      magicPreset: null,
      magicIncludedInferences: false,
      magicProcessingTimeMs: 0,
    };
    demoHistory = demoHistory.map((item) => (item.id === id ? updated : item));
    return updated;
  },
  async setTranscriptRewrite(
    id,
    result,
    sourceText,
    expectedSourceRevision = 0,
  ) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    if (
      !Number.isSafeInteger(expectedSourceRevision) ||
      expectedSourceRevision < 0 ||
      transcriptSourceRevision(record) !== expectedSourceRevision ||
      deliveredText(record) !== sourceText
    )
      throw new Error("Transcript changed while rewriting");
    const updated = {
      ...record,
      magicText: result?.text ?? null,
      rewriteSourceRevision: result ? transcriptSourceRevision(record) : null,
      magicModel: result?.model ?? null,
      magicIncludedInferences: result?.includedInferences ?? false,
    };
    demoHistory = demoHistory.map((item) => (item.id === id ? updated : item));
    return updated;
  },
  async setTranscriptTitle(id, title) {
    const normalized = normalizeTranscriptTitle(title);
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    const updated = { ...record, title: normalized };
    demoHistory = demoHistory.map((item) => (item.id === id ? updated : item));
    return updated;
  },
  async deleteHistory(id) {
    demoHistory = demoHistory.filter((item) => item.id !== id);
  },
  async previewHistoryRetention(_policy) {
    return desktopOnly();
  },
  async applyHistoryRetention(_token) {
    return desktopOnly();
  },
  onHistoryRetentionApplied(_callback) {
    return () => undefined;
  },
  async clearHistory() {
    demoHistory = [];
  },
  async getHistoryBatchSnapshot() {
    return { deletion: null, records: demoHistory };
  },
  async stageHistoryDeletion(_ids) {
    return desktopOnly();
  },
  async undoHistoryDeletion(_token) {
    return desktopOnly();
  },
  onHistoryBatchChanged(_callback) {
    return () => undefined;
  },
  async exportHistorySelection(_ids, _format) {
    return desktopOnly();
  },
  async chooseProjectIdentifier() {
    return desktopOnly();
  },
  async getProjectVocabulary() {
    return emptyProjectVocabulary();
  },
  async selectProjectVocabulary() {
    return desktopOnly();
  },
  async refreshProjectVocabulary() {
    return desktopOnly();
  },
  async clearProjectVocabulary() {
    return emptyProjectVocabulary();
  },
  async chooseAudioFile(): Promise<AudioFileSelection | null> {
    return desktopOnly();
  },
  async inspectAudioFile(_path: string) {
    throw new Error("Media inspection requires Electron");
  },
  async getAudioJobs() {
    return desktopOnly();
  },
  async loadAudioSource(_path: string) {
    return desktopOnly();
  },
  async removeAudioJob(_path: string) {
    return desktopOnly();
  },
  async relinkAudioJob(_path: string) {
    return desktopOnly();
  },
  async chooseAudioFiles(): Promise<AudioFileSelection[]> {
    return desktopOnly();
  },
  async resolveAudioFiles(_files: File[]): Promise<AudioFileSelection[]> {
    return desktopOnly();
  },
  async getImportQueue() {
    return emptyImportQueue();
  },
  async enqueueImport() {
    return desktopOnly();
  },
  async pauseImportQueue() {
    return desktopOnly();
  },
  async moveImportJob() {
    return desktopOnly();
  },
  async cancelImportJob() {
    return desktopOnly();
  },
  async retryImportJob() {
    return desktopOnly();
  },
  async clearFinishedImports() {
    return emptyImportQueue();
  },
  onImportQueue() {
    return () => {};
  },
  async runLab(_request: LabRequest) {
    throw new Error("Audio file transcription requires Electron");
  },
  async exportTranscript(_id: string, _format: ExportFormat) {
    return desktopOnly();
  },
  async exportTranscriptTemplate() {
    return desktopOnly();
  },
  async recordingStarted() {},
  async recordingLimitReached() {},
  async recordingSilence() {},
  async recorderReady() {},
  async recordingFailed() {},
  async recordingInputChanged() {},
  recordingLevel(_level: number) {},
  recordingStream() {},
  async submitRecording(_recording: RecordingSubmission) {},
  onStatus(callback: (status: DictationStatus) => void) {
    statusListeners.add(callback);
    return () => statusListeners.delete(callback);
  },
  onMagicStatus(_callback: (status: MagicStatus) => void) {
    return () => undefined;
  },
  onSettingsChanged(_callback: (settings: AppSettings) => void) {
    return () => undefined;
  },
  async getWindowVisibility() {
    return !document.hidden;
  },
  onWindowVisibility(callback: (visible: boolean) => void) {
    const change = () => callback(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  },
  onNavigate(_callback: (page: Page) => void) {
    return () => undefined;
  },
  onShortcutStatus(_callback: (status: ShortcutStatus) => void) {
    return () => undefined;
  },
  onTranscript(callback: (record: TranscriptRecord) => void) {
    transcriptListeners.add(callback);
    return () => transcriptListeners.delete(callback);
  },
  onRecorderCommand(_callback: (command: RecorderCommand) => void) {
    return () => undefined;
  },
  onUpdateStatus(_callback: (status: UpdateStatus) => void) {
    return () => undefined;
  },
};
