import { DEFAULT_SETTINGS } from "./data";
import { originalTranscriptText } from "./transcriptText";
import type {
  AppSettings,
  AudioFileSelection,
  DeluluApi,
  DictationStatus,
  ExportFormat,
  LabRequest,
  MagicRewriteRequest,
  MagicStatus,
  PlatformCapabilities,
  RecorderCommand,
  RecordingSubmission,
  TranscriptRecord,
  TranscriptVersion,
} from "./types";

let demoHistory: TranscriptRecord[] = [
  {
    id: "demo-1",
    createdAt: Date.now() - 1000 * 60 * 18,
    durationMs: 24_000,
    text: "Move the design review to Thursday and add the new onboarding notes.",
    intendedText: "Move the design review to Thursday and add the new onboarding notes.",
    verbatimText: "[UM] move the design review to, to Thursday and add the new onboarding notes.",
    mode: "dual",
    model: "crisperMedium",
    language: "en",
    words: [],
    verbatimWords: [],
    insights: { fillerCount: 1, repetitionCount: 1, cutOffCount: 0, vocalEventCount: 0, wordsPerMinute: 118, speakingSeconds: 9.4 },
    source: "dictation",
    processingTimeMs: 1800,
  },
];

function mockSettings(): AppSettings {
  const raw = localStorage.getItem("delulu-demo-settings");
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

const mockApi: DeluluApi = {
  async getSettings() { return mockSettings(); },
  async updateSettings(settings) { localStorage.setItem("delulu-demo-settings", JSON.stringify(settings)); return settings; },
  async getStatus() { return { phase: "idle", engine: "ready", message: "Browser preview", model: "crisperMedium", backend: "ct2" }; },
  async getMagicStatus() { return { phase: "idle", engine: "ready", message: "Qwen 3.5 · 2B ready", model: "qwen35Medium", device: "cuda" }; },
  async getHistory() { return demoHistory; },
  async getCapabilities() { return { platform: "linux", desktop: "Browser preview", sessionType: "wayland", pasteMethod: "clipboard-only", wayland: true }; },
  async toggleDictation() {},
  async startDictation() {},
  async stopDictation() {},
  async cancelDictation() {},
  async setupModel() {},
  async loadModel() {},
  async unloadModel() {},
  async resetPythonEnvironment() {},
  async setupMagic() {},
  async loadMagic() {},
  async unloadMagic() {},
  async rewriteMagic(request: MagicRewriteRequest) {
    const presets = {
      polish: request.text.replace(/\s+/g, " ").trim(),
      concise: "Move the design review to Thursday and include the onboarding notes.",
      structured: "Design review\n\n- Move the session to Thursday.\n- Add the new onboarding notes to the agenda.",
      prompt: "Update the project schedule and onboarding documentation.\n\nRequirements:\n- Move the design review to Thursday.\n- Add the new onboarding notes.\n- Confirm the updated agenda with participants.",
    };
    const text = presets[request.preset];
    return { text, model: mockSettings().magicModel, processingTimeMs: 640, inputCharacters: request.text.length, outputCharacters: text.length, includedInferences: request.allowInferences };
  },
  async copyText(text) { await navigator.clipboard?.writeText(text); },
  async updateTranscript(id: string, version: TranscriptVersion, text: string | null) {
    const record = demoHistory.find((item) => item.id === id);
    if (!record) throw new Error("Transcript not found");
    const normalized = text?.trim() ?? null;
    const correction = normalized && normalized !== originalTranscriptText(record, version) ? normalized : null;
    const updated = version === "intended"
      ? { ...record, editedIntendedText: correction }
      : { ...record, editedVerbatimText: correction };
    demoHistory = demoHistory.map((item) => item.id === id ? updated : item);
    return updated;
  },
  async deleteHistory() {},
  async clearHistory() {},
  async chooseAudioFile(): Promise<AudioFileSelection | null> { return null; },
  async runLab(_request: LabRequest) { throw new Error("Speech Lab requires Electron"); },
  async exportTranscript(_id: string, _format: ExportFormat) { return null; },
  async recordingStarted() {},
  async recordingFailed() {},
  async submitRecording(_recording: RecordingSubmission) {},
  onStatus(_callback: (status: DictationStatus) => void) { return () => undefined; },
  onMagicStatus(_callback: (status: MagicStatus) => void) { return () => undefined; },
  onTranscript(_callback: (record: TranscriptRecord) => void) { return () => undefined; },
  onRecorderCommand(_callback: (command: RecorderCommand) => void) { return () => undefined; },
};

export const bridge: DeluluApi = window.delulu ?? mockApi;

export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  return bridge.getCapabilities();
}
