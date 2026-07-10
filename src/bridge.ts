import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS } from "./data";
import type { AppSettings, DictationStatus, HuggingFaceAuthStatus, TranscriptRecord } from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

const demoHistory: TranscriptRecord[] = [
  {
    id: "demo-1",
    createdAt: Date.now() - 1000 * 60 * 18,
    durationMs: 24_000,
    text: "The launch plan is looking sharp. Move the design review to Thursday and add the new onboarding notes.",
    rawText: "The launch plan is looking sharp. Move the design review to Thursday and add the new onboarding notes.",
    model: "mossTranscribeDiarize",
    language: "en",
    segments: [],
  },
  {
    id: "demo-2",
    createdAt: Date.now() - 1000 * 60 * 60 * 3,
    durationMs: 11_000,
    text: "Remember to send the revised prototype before lunch.",
    rawText: "Remember to send the revised prototype before lunch.",
    model: "cohereTranscribe",
    language: "en",
    segments: [],
  },
];

function mockSettings(): AppSettings {
  const raw = localStorage.getItem("delulu-demo-settings");
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

export const bridge = {
  async getSettings(): Promise<AppSettings> {
    return isTauri() ? invoke("get_settings") : mockSettings();
  },
  async updateSettings(settings: AppSettings): Promise<AppSettings> {
    if (isTauri()) return invoke("update_settings", { settings });
    localStorage.setItem("delulu-demo-settings", JSON.stringify(settings));
    return settings;
  },
  async getHuggingFaceAuthStatus(): Promise<HuggingFaceAuthStatus> {
    return isTauri() ? invoke("get_hugging_face_auth_status") : { configured: false };
  },
  async saveHuggingFaceToken(token: string): Promise<HuggingFaceAuthStatus> {
    if (isTauri()) return invoke("save_hugging_face_token", { token });
    return { configured: token.trim().length > 0 };
  },
  async removeHuggingFaceToken(): Promise<HuggingFaceAuthStatus> {
    return isTauri() ? invoke("remove_hugging_face_token") : { configured: false };
  },
  async getStatus(): Promise<DictationStatus> {
    return isTauri() ? invoke("get_runtime_status") : { phase: "idle", message: "Ready to capture" };
  },
  async getHistory(): Promise<TranscriptRecord[]> {
    return isTauri() ? invoke("get_history") : demoHistory;
  },
  async listInputDevices(): Promise<string[]> {
    return isTauri() ? invoke("list_input_devices") : ["default", "MacBook Microphone", "Studio USB Mic"];
  },
  async toggleDictation(): Promise<void> {
    if (isTauri()) await invoke("toggle_dictation");
  },
  async setupModel(): Promise<void> {
    if (isTauri()) await invoke("setup_asr_environment");
  },
  async resetPythonEnvironment(): Promise<void> {
    if (isTauri()) await invoke("reset_asr_environment");
  },
  async copyText(text: string): Promise<void> {
    if (isTauri()) await invoke("copy_text", { text });
    else await navigator.clipboard?.writeText(text);
  },
  async deleteHistory(id: string): Promise<void> {
    if (isTauri()) await invoke("delete_history_item", { id });
  },
  async clearHistory(): Promise<void> {
    if (isTauri()) await invoke("clear_history");
  },
  onStatus(callback: (status: DictationStatus) => void) {
    if (!isTauri()) return Promise.resolve(() => undefined);
    return listen<DictationStatus>("dictation-state", (event) => callback(event.payload));
  },
  onTranscript(callback: (record: TranscriptRecord) => void) {
    if (!isTauri()) return Promise.resolve(() => undefined);
    return listen<TranscriptRecord>("dictation-transcript", (event) => callback(event.payload));
  },
};
