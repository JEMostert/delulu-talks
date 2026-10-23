import {
  normalizeHelperMode,
  type TalkLevel,
  type TalkStatus,
  type VoiceHelperMode,
} from "./talk";
import { emptyImportQueue } from "./importQueue";
import { stripVoiceMarkup } from "./voiceMarkup";
import {
  previewScenario,
  scenarioHistory,
  scenarioMagicStatus,
  scenarioStatus,
  scenarioUpdateStatus,
} from "./previewScenarios";
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
  MicrophoneDevice,
  Page,
  ShortcutStatus,
  TranscriptRecord,
  UpdateStatus,
} from "./types";
import { VOICE_AGENT_INSTRUCTIONS, type VoiceStatus } from "./voice";
import type { ListenStatus } from "./listening";

let demoHistory: TranscriptRecord[] =
  previewScenario === "empty" ? [] : scenarioHistory();

let liveStatus: DictationStatus = scenarioStatus();
const statusListeners = new Set<(status: DictationStatus) => void>();
const transcriptListeners = new Set<(record: TranscriptRecord) => void>();
function setLiveStatus(patch: Partial<DictationStatus>) {
  liveStatus = { ...liveStatus, ...patch };
  for (const listener of statusListeners) listener(liveStatus);
  syncPreviewLevel();
}
/** Pushes a dictation status, as the native recorder would (preview and e2e). */
export function setPreviewStatus(patch: Partial<DictationStatus>) {
  setLiveStatus(patch);
}

// Preview capture: no microphone; a speech-like level arrives at ~20 Hz
// while listening, like the desktop's `recorder:level` event.
const levelListeners = new Set<(level: number) => void>();
let levelTimer: ReturnType<typeof setInterval> | null = null;
function syncPreviewLevel() {
  const active = liveStatus.phase === "listening" && levelListeners.size > 0;
  if (active && !levelTimer) {
    const started = performance.now();
    levelTimer = setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const syllables =
        Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 1.1));
      const level = Math.min(1, 0.04 + syllables * 0.6 + Math.random() * 0.05);
      for (const listener of levelListeners) listener(level);
    }, 50);
  } else if (!active && levelTimer) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

const PREVIEW_MICROPHONES: MicrophoneDevice[] = [
  { deviceId: "default", label: "System default", labelKnown: true },
  { deviceId: "preview-usb-mic", label: "USB Microphone", labelKnown: true },
  {
    deviceId: "preview-built-in",
    label: "Built-in Audio Analog Stereo",
    labelKnown: true,
  },
];
const PREVIEW_SPEAKERS: MicrophoneDevice[] = [
  { deviceId: "default", label: "System default", labelKnown: true },
  { deviceId: "preview-headphones", label: "Headphones", labelKnown: true },
  {
    deviceId: "preview-speakers",
    label: "Built-in Audio Speakers",
    labelKnown: true,
  },
];

// Preview voice: no audio plays in the browser; status changes are simulated.
const PREVIEW_APP = "/usr/bin/delulu-talks";
let voiceStatus: VoiceStatus = {
  engine: "ready",
  phase: "idle",
  message: "Preview — the browser plays no audio",
  model: "kokoro",
  residency: "resident",
  warmup: "complete",
  device: "cpu",
  current: null,
  queued: 0,
  recent:
    previewScenario === "empty"
      ? []
      : [
          {
            id: "preview-voice-2",
            at: Date.now() - 4 * 60_000,
            source: "agent",
            agent: "Claude Code",
            text: "Done. The cache path fix is merged and all 212 tests pass.",
            outcome: "spoken",
            durationMs: 4_200,
          },
          {
            id: "preview-voice-1",
            at: Date.now() - 19 * 60_000,
            source: "agent",
            agent: "Codex",
            text: "The build still fails on the cache path. Want me to try another way?",
            outcome: "spoken",
            durationMs: 4_700,
          },
        ],
  bridge: {
    enabled: false,
    listening: false,
    clients: 0,
    endpoint: null,
    error: null,
  },
};
const voiceListeners = new Set<(status: VoiceStatus) => void>();
let voiceTimer: ReturnType<typeof setTimeout> | null = null;
function setVoiceStatus(patch: Partial<VoiceStatus>) {
  voiceStatus = { ...voiceStatus, ...patch };
  for (const listener of voiceListeners) listener(voiceStatus);
}
function syncPreviewBridge(settings: AppSettings) {
  setVoiceStatus({
    bridge: settings.voiceAgentBridge
      ? {
          enabled: true,
          listening: true,
          clients: 1,
          endpoint: "/home/you/.config/delulu-talks/voice/agent.sock",
          error: null,
        }
      : {
          enabled: false,
          listening: false,
          clients: 0,
          endpoint: null,
          error: null,
        },
  });
}

// Preview listening: no microphone; session state and turns are simulated.
const listenStatus: ListenStatus = {
  session: null,
  recent:
    previewScenario === "empty"
      ? []
      : [
          {
            seq: 2,
            type: "utterance",
            sessionId: "lst_preview",
            id: "utt_preview_2",
            text: "Actually, skip the tests for now and open the pull request.",
            at: Date.now() - 2 * 60_000,
            durationMs: 3_400,
            interruptedResponseId: "rsp_preview_1",
          },
          {
            seq: 1,
            type: "utterance",
            sessionId: "lst_preview",
            id: "utt_preview_1",
            text: "Can you fix the cache path test first?",
            at: Date.now() - 6 * 60_000,
            durationMs: 2_100,
            interruptedResponseId: null,
          },
        ],
  capturing: false,
  message: "Preview — the browser opens no microphone",
};
const listenListeners = new Set<(status: ListenStatus) => void>();

function mockSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("delulu-demo-settings");
    const saved = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      voiceCoordinatorMode: normalizeHelperMode(saved.voiceCoordinatorMode),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function desktopOnly(): never {
  throw new Error(
    "This action needs the installed desktop app. You’re viewing a design preview.",
  );
}

// Preview Talk: no microphone or helper model; status, turns and the input
// level are simulated. The helper "downloads" once per page load, so the
// confirmation shows the first time it is switched on or Talk starts with it.
let helperDownloaded = false;
const talkListeners = new Set<(status: TalkStatus) => void>();
const talkLevelListeners = new Set<(level: TalkLevel) => void>();
// Each start or stop begins a new run; a stopped run's pending steps end early.
let talkRun = 0;
let talkWaits: Array<() => void> = [];
let talkLevelTimer: ReturnType<typeof setInterval> | null = null;
function previewHelper(
  mode: VoiceHelperMode,
  on: boolean,
): TalkStatus["helper"] {
  if (mode === "off") return { mode, state: "off", message: "" };
  if (!helperDownloaded) return { mode, state: "missing", message: "" };
  return { mode, state: on ? "ready" : "installed", message: "" };
}
let talkStatus: TalkStatus = {
  on: false,
  phase: "off",
  message: "Off",
  helper: previewHelper(mockSettings().voiceCoordinatorMode, false),
  needsDownload: false,
  downloadSize: "~1.7 GB",
  agents:
    previewScenario === "empty"
      ? []
      : [
          {
            id: "agent_preview_1",
            name: "Claude Code",
            listening: true,
            openTasks: 1,
          },
          {
            id: "agent_preview_2",
            name: "Codex",
            listening: false,
            openTasks: 0,
          },
        ],
  turns:
    previewScenario === "empty"
      ? []
      : [
          {
            id: "turn_preview_1",
            at: Date.now() - 6 * 60_000,
            user: "Draai de unit tests.",
            tool: "send_to_agent",
            said: "Doorgestuurd naar Claude Code.",
            helperMs: 412,
          },
          {
            id: "turn_preview_2",
            at: Date.now() - 3 * 60_000,
            user: "How far along are the tests?",
            tool: "task_status",
            said: "Claude Code is still running the unit tests.",
            helperMs: 388,
          },
          {
            id: "turn_preview_3",
            at: Date.now() - 60_000,
            user: "Stop maar met praten.",
            tool: "stop_speaking",
            said: "",
            helperMs: 296,
          },
        ],
};
function setTalkStatus(patch: Partial<TalkStatus>) {
  talkStatus = { ...talkStatus, ...patch };
  for (const listener of talkListeners) listener(talkStatus);
  syncTalkLevel();
}
function newTalkRun(): number {
  for (const finish of talkWaits) finish();
  talkWaits = [];
  return ++talkRun;
}
/** Waits, then reports whether the run is still current. */
function talkStep(run: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(), ms);
    const finish = () => {
      clearTimeout(timer);
      talkWaits = talkWaits.filter((item) => item !== finish);
      resolve(run === talkRun);
    };
    talkWaits.push(finish);
  });
}
// A slowly drifting room level with speech-like bursts, ~15 Hz like `talk:level`.
function syncTalkLevel() {
  const active = talkStatus.on && talkLevelListeners.size > 0;
  if (active && !talkLevelTimer) {
    const started = performance.now();
    talkLevelTimer = setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const speech =
        Math.max(0, Math.sin(t * 0.7)) * Math.abs(Math.sin(t * 3.1));
      const db = -54 + speech * 36 + Math.random() * 3;
      for (const listener of talkLevelListeners) listener({ db });
    }, 66);
  } else if (!active && talkLevelTimer) {
    clearInterval(talkLevelTimer);
    talkLevelTimer = null;
  }
}
async function previewStartTalk(download: boolean): Promise<TalkStatus> {
  const mode = mockSettings().voiceCoordinatorMode;
  if (mode === "lightweight" && !helperDownloaded && !download) {
    setTalkStatus({
      needsDownload: true,
      helper: previewHelper(mode, false),
    });
    return talkStatus;
  }
  const run = newTalkRun();
  const listening = (): Partial<TalkStatus> => ({
    on: true,
    phase: "listening",
    message: "Listening",
    needsDownload: false,
    helper: previewHelper(mockSettings().voiceCoordinatorMode, true),
  });
  if (mode === "off") {
    setTalkStatus({ on: true, phase: "starting", message: "Starting…" });
    if (await talkStep(run, 500)) setTalkStatus(listening());
    return talkStatus;
  }
  if (!helperDownloaded) {
    setTalkStatus({
      on: true,
      phase: "downloading",
      message: "Downloading the helper · 0%",
      needsDownload: false,
      helper: { mode, state: "loading", message: "" },
    });
    for (const percent of [24, 51, 78, 100]) {
      if (!(await talkStep(run, 700))) return talkStatus;
      setTalkStatus({ message: `Downloading the helper · ${percent}%` });
    }
    helperDownloaded = true;
  }
  setTalkStatus({
    on: true,
    phase: "loading",
    message: "Loading the helper…",
    helper: { mode, state: "loading", message: "" },
  });
  if (await talkStep(run, 900)) setTalkStatus(listening());
  return talkStatus;
}

export const previewApi: DeluluApi = {
  async getTalkStatus() {
    return talkStatus;
  },
  startTalk(options) {
    return previewStartTalk(options?.download === true);
  },
  async stopTalk() {
    newTalkRun();
    setTalkStatus({
      on: false,
      phase: "off",
      message: "Off",
      needsDownload: false,
      helper: previewHelper(mockSettings().voiceCoordinatorMode, false),
    });
    return talkStatus;
  },
  onTalkStatus(callback) {
    talkListeners.add(callback);
    return () => talkListeners.delete(callback);
  },
  onTalkLevel(callback) {
    talkLevelListeners.add(callback);
    syncTalkLevel();
    return () => {
      talkLevelListeners.delete(callback);
      syncTalkLevel();
    };
  },
  async getListenStatus() {
    return listenStatus;
  },
  onListenStatus(callback) {
    listenListeners.add(callback);
    return () => listenListeners.delete(callback);
  },
  async installVoiceSkill() {
    return desktopOnly();
  },
  async getVoiceStatus() {
    syncPreviewBridge(mockSettings());
    return voiceStatus;
  },
  onVoiceStatus(callback) {
    voiceListeners.add(callback);
    return () => voiceListeners.delete(callback);
  },
  async setupVoice() {
    desktopOnly();
  },
  async cancelVoiceSetup() {
    desktopOnly();
  },
  async loadVoice() {
    desktopOnly();
  },
  async unloadVoice() {
    desktopOnly();
  },
  async speak(request) {
    // Simulates timing only, so the page can be reviewed without audio.
    if (voiceTimer) clearTimeout(voiceTimer);
    const id = `preview-voice-${Date.now()}`;
    const text = stripVoiceMarkup(request.text);
    const durationMs = Math.min(8_000, Math.max(800, text.length * 55));
    const settings = mockSettings();
    setVoiceStatus({
      phase: "speaking",
      current: {
        id,
        text,
        source: request.source ?? "app",
        agent: request.agent ?? null,
        chunk: 1,
        chunks: 1,
      },
    });
    await new Promise<void>((resolve) => {
      voiceTimer = setTimeout(resolve, durationMs);
    });
    voiceTimer = null;
    const summary = {
      id,
      at: Date.now(),
      source: request.source ?? ("app" as const),
      agent: request.agent ?? null,
      text: text.slice(0, 280),
      outcome: "spoken" as const,
      durationMs,
    };
    setVoiceStatus({
      phase: "idle",
      current: null,
      recent: [summary, ...voiceStatus.recent].slice(0, 20),
    });
    const unsupported =
      settings.voiceEngine === "kokoro"
        ? [
            ...new Set(
              [
                ...request.text.matchAll(
                  /\[(laugh|chuckle|sigh|gasp|cough|clear-throat|sniff|groan|shush)\]/gi,
                ),
              ].map((match) => match[1].toLowerCase()),
            ),
          ]
        : [];
    return {
      id,
      responseId: request.responseId ?? `rsp_preview_${Date.now()}`,
      outcome: "spoken",
      durationMs,
      timestamps: [{ text, startMs: 0, endMs: durationMs }],
      warnings: [],
      unsupported,
    };
  },
  async speakClipboard() {
    return null;
  },
  async stopSpeaking() {
    if (voiceTimer) clearTimeout(voiceTimer);
    voiceTimer = null;
    setVoiceStatus({ phase: "idle", current: null, queued: 0 });
  },
  async chooseVoiceReference() {
    return desktopOnly();
  },
  async removeVoiceReference() {
    const next = { ...mockSettings(), voiceClone: "" };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    return next;
  },
  async getVoiceAgentSetup() {
    return {
      scriptPath: PREVIEW_APP,
      command: [PREVIEW_APP, "mcp"],
      nodeFound: false,
      claudeCode: `claude mcp add --scope user delulu-voice -- ${PREVIEW_APP} mcp`,
      codex: `codex mcp add delulu-voice -- ${PREVIEW_APP} mcp`,
      json: JSON.stringify(
        {
          mcpServers: {
            "delulu-voice": { command: PREVIEW_APP, args: ["mcp"] },
          },
        },
        null,
        2,
      ),
      shell: `${PREVIEW_APP} mcp say "Done, all tests pass."`,
      instructions: VOICE_AGENT_INSTRUCTIONS,
    };
  },
  async listMicrophones() {
    return PREVIEW_MICROPHONES;
  },
  onMicrophonesChanged() {
    return () => undefined;
  },
  async listSpeakers() {
    return PREVIEW_SPEAKERS;
  },
  onRecordingLevel(callback) {
    levelListeners.add(callback);
    syncPreviewLevel();
    return () => {
      levelListeners.delete(callback);
      syncPreviewLevel();
    };
  },
  async testCaptureCue() {
    // The preview plays no audio.
  },
  async getRenderingMode() {
    return "hardware";
  },
  onRenderingModeChanged() {
    return () => {};
  },
  async getRuleUsage() {
    return desktopOnly();
  },
  async resetRuleUsage() {
    return desktopOnly();
  },
  async previewModelCache() {
    return desktopOnly();
  },
  async listSpeechDownloads() {
    return [];
  },
  async deleteSpeechDownload() {
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
    const next = { ...mockSettings(), ...settings };
    localStorage.setItem("delulu-demo-settings", JSON.stringify(next));
    syncPreviewBridge(next);
    const mode = next.voiceCoordinatorMode;
    if (mode !== talkStatus.helper.mode) {
      // Switching the helper on before its first download asks for it.
      const ready = talkStatus.on && helperDownloaded;
      setTalkStatus({
        needsDownload: mode === "lightweight" && !helperDownloaded,
        helper: previewHelper(mode, ready),
      });
    }
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
    setLiveStatus({
      phase: "paused",
      message: "Paused — microphone open",
      silenceCountdownSeconds: null,
    });
  },
  async resumeDictation() {
    setLiveStatus({ phase: "listening", message: "Listening — resumed" });
  },
  async toggleDictation() {
    // The preview simulates a short dictation so the shell can be reviewed.
    if (liveStatus.phase === "listening" || liveStatus.phase === "paused") {
      setLiveStatus({
        phase: "transcribing",
        message: "Transcribing locally",
        silenceCountdownSeconds: null,
        captureInputNotice: null,
      });
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
    setLiveStatus({
      phase: "idle",
      message: "Recording cancelled",
      silenceCountdownSeconds: null,
      captureInputNotice: null,
    });
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
  async chooseAudioFile(): Promise<AudioFileSelection | null> {
    return desktopOnly();
  },
  async inspectAudioFile(_path: string) {
    throw new Error("Media inspection requires the desktop app");
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
  onFilesDropped(callback) {
    // Browsers expose no local paths; report names so the page responds.
    const drop = (event: DragEvent) => {
      const names = [...(event.dataTransfer?.files ?? [])].map(
        (file) => file.name,
      );
      if (names.length) callback(names);
    };
    window.addEventListener("drop", drop);
    return () => window.removeEventListener("drop", drop);
  },
  async resolveAudioPaths(_paths: string[]): Promise<AudioFileSelection[]> {
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
    throw new Error("Audio file transcription requires the desktop app");
  },
  async exportTranscript(_id: string, _format: ExportFormat) {
    return desktopOnly();
  },
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
  onUpdateStatus(_callback: (status: UpdateStatus) => void) {
    return () => undefined;
  },
};
