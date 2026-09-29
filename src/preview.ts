import { changePersonalProfiles } from "./personalProfileCommands";
import { DEFAULT_SETTINGS } from "./data";
import { deliveredText, originalTranscriptText, transcriptSourceRevision } from "./transcriptText";
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

let demoHistory: TranscriptRecord[] = [
  {
    id: "demo-1",
    createdAt: Date.now() - 1000 * 60 * 18,
    durationMs: 24_000,
    text: "Move the design review to Thursday and add the new onboarding notes.",
    magicText:
      "Move the design review to Thursday and include the new onboarding notes.",
    magicModel: "qwen35Medium",
    magicPreset: "polish",
    magicIncludedInferences: false,
    magicProcessingTimeMs: 640,
    model: "r2t2",
    language: "en",
    source: "dictation",
    processingTimeMs: 1800,
  },
];

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
  async getRendererRecoveryState() {
    return { canReload: true, reason: null, canStopRecording: false };
  },
  async reloadWorkspace() {
    window.location.reload();
  },
  async rendererControllerFailed() {},
  async getRuntimeSetupSnapshot() {
    return { checkedAt: Date.now(), platform: "Browser preview", arch: "Unknown", source: "preview" as const, runtimes: [] };
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
      accessibility: {
        state: "not-applicable",
        canAttemptPaste: false,
        detail: "Native Accessibility permission is available in the desktop app. Browser preview cannot attempt native paste.",
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
  async getPasteRecovery() { return null; },
  async copyInstead(_id: string) { desktopOnly(); },
  async dismissPasteRecovery(_id: string) {},
  onPasteRecovery(_callback) { return () => undefined; },
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
    const next = { ...mockSettings(), ...settings };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async managePersonalProfile(command) {
    const current = mockSettings();
    const next = {
      ...current,
      personalProfiles: changePersonalProfiles(current, command, () => crypto.randomUUID()),
    };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async getStatus() {
    return {
      phase: "idle",
      engine: "ready",
      message: "Browser preview",
      model: "r2t2" as const,
    };
  },
  async getMagicStatus() {
    return {
      phase: "idle",
      engine: "ready",
      message: "Qwen 3.5 · 2B ready",
      model: "qwen35Medium",
      device: "cuda",
    };
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
    return {
      phase: "unsupported",
      currentVersion: "browser",
      message: "Updates are available in the installed app",
    };
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
  async toggleDictation() {
    desktopOnly();
  },
  async startDictation() {
    desktopOnly();
  },
  async stopDictation() {
    desktopOnly();
  },
  async cancelDictation() {
    desktopOnly();
  },
  async setupModel() {
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
  async loadMagic() {
    desktopOnly();
  },
  async unloadMagic() {
    desktopOnly();
  },
  async rewriteMagic(_request: MagicRewriteRequest) {
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
    const updated = { ...record, editedText: correction, sourceRevision: revision + 1,
      rewriteSourceRevision: null, magicText: null, magicModel: null, magicPreset: null,
      magicIncludedInferences: false, magicProcessingTimeMs: 0 };
    demoHistory = demoHistory.map((item) => (item.id === id ? updated : item));
    return updated;
  },
  async setTranscriptRewrite(id, result, sourceText, expectedSourceRevision = 0) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    if (!Number.isSafeInteger(expectedSourceRevision) || expectedSourceRevision < 0 ||
        transcriptSourceRevision(record) !== expectedSourceRevision || deliveredText(record) !== sourceText)
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
  async clearHistory() {
    demoHistory = [];
  },
  async chooseAudioFile(): Promise<AudioFileSelection | null> {
    return desktopOnly();
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
  async recorderReady() {},
  async recordingFailed() {},
  recordingLevel(_level: number) {},
  async submitRecording(_recording: RecordingSubmission) {},
  onStatus(_callback: (status: DictationStatus) => void) {
    return () => undefined;
  },
  onMagicStatus(_callback: (status: MagicStatus) => void) {
    return () => undefined;
  },
  onSettingsChanged(_callback: (settings: AppSettings) => void) {
    return () => undefined;
  },
  onNavigate(_callback: (page: Page) => void) {
    return () => undefined;
  },
  onShortcutStatus(_callback: (status: ShortcutStatus) => void) {
    return () => undefined;
  },
  onTranscript(_callback: (record: TranscriptRecord) => void) {
    return () => undefined;
  },
  onRecorderCommand(_callback: (command: RecorderCommand) => void) {
    return () => undefined;
  },
  onUpdateStatus(_callback: (status: UpdateStatus) => void) {
    return () => undefined;
  },
};
