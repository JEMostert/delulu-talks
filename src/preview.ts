import { DEFAULT_SETTINGS } from "./data";
import { deliveredText, originalTranscriptText } from "./transcriptText";
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
  TranscriptVersion,
  UpdateStatus,
} from "./types";

let demoHistory: TranscriptRecord[] = [
  {
    id: "demo-1",
    createdAt: Date.now() - 1000 * 60 * 18,
    durationMs: 24_000,
    text: "Move the design review to Thursday and add the new onboarding notes.",
    intendedText:
      "Move the design review to Thursday and add the new onboarding notes.",
    verbatimText:
      "[UM] move the design review to, to Thursday and add the new onboarding notes.",
    magicText:
      "Move the design review to Thursday and include the new onboarding notes.",
    magicModel: "qwen35Medium",
    magicPreset: "polish",
    magicIncludedInferences: false,
    magicProcessingTimeMs: 640,
    mode: "dual",
    model: "crisperMedium",
    language: "en",
    words: [],
    verbatimWords: [],
    insights: {
      fillerCount: 1,
      repetitionCount: 1,
      cutOffCount: 0,
      vocalEventCount: 0,
      wordsPerMinute: 118,
      speakingSeconds: 9.4,
    },
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
      packages: {},
      checkedAt: Date.now(),
    };
  },
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
  async getStatus() {
    return {
      phase: "idle",
      engine: "ready",
      message: "Browser preview",
      model: "crisperMedium",
      backend: "ct2",
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
  async updateTranscript(
    id: string,
    version: TranscriptVersion,
    text: string | null,
  ) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    const normalized = text?.trim() ?? null;
    const correction =
      normalized && normalized !== originalTranscriptText(record, version)
        ? normalized
        : null;
    record.magicText = null;
    const updated =
      version === "intended"
        ? { ...record, editedIntendedText: correction }
        : { ...record, editedVerbatimText: correction };
    demoHistory = demoHistory.map((item) => (item.id === id ? updated : item));
    return updated;
  },
  async setTranscriptRewrite(id, result, sourceText) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    if (deliveredText(record) !== sourceText)
      throw new Error("Transcript changed while rewriting");
    const updated = {
      ...record,
      magicText: result?.text ?? null,
      magicModel: result?.model ?? null,
      magicIncludedInferences: result?.includedInferences ?? false,
    };
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
    throw new Error("Speech Lab requires Electron");
  },
  async exportTranscript(_id: string, _format: ExportFormat) {
    return desktopOnly();
  },
  async recordingStarted() {},
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
