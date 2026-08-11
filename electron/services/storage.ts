import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, LANGUAGES, MAGIC_MODELS, MODELS } from "../../src/data";
import { originalTranscriptText } from "../../src/transcriptText";
import type { AppSettings, CustomWord, MagicModelId, MagicPreset, ModelId, SpeechInsights, TranscriptRecord, TranscriptVersion } from "../../src/types";

const SETTINGS_FILE = "settings.json";
const HISTORY_FILE = "history.json";
const MAX_HISTORY = 500;
const validModels = new Set(MODELS.map((model) => model.id));
const validMagicModels = new Set(MAGIC_MODELS.map((model) => model.id));
const validLanguages = new Set<string>(LANGUAGES.map(([code]) => code));

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function safeString(value: unknown, fallback: string, max = 512): string {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, max) || null;
}

function normalizeWords(value: unknown): CustomWord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<CustomWord>;
    const term = safeString(source.term, "", 256);
    if (!term) return [];
    return [{
      id: safeString(source.id, `word-${Date.now()}-${index}`, 128),
      term,
      soundsLike: safeString(source.soundsLike, "", 1024),
      replacement: safeString(source.replacement, "", 4096),
      enabled: source.enabled !== false,
    }];
  });
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(value: unknown): AppSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const model = validModels.has(source.model as ModelId) ? source.model as ModelId : DEFAULT_SETTINGS.model;
  const magicModel = validMagicModels.has(source.magicModel as MagicModelId) ? source.magicModel as MagicModelId : DEFAULT_SETTINGS.magicModel;
  const magicPreset = ["polish", "concise", "structured", "prompt"].includes(String(source.magicPreset))
    ? source.magicPreset as MagicPreset
    : DEFAULT_SETTINGS.magicPreset;
  const backend = ["auto", "ct2", "transformers"].includes(String(source.backend))
    ? source.backend as AppSettings["backend"]
    : DEFAULT_SETTINGS.backend;
  const computeType = ["auto", "float16", "int8Float16", "int8", "float32"].includes(String(source.computeType))
    ? source.computeType as AppSettings["computeType"]
    : DEFAULT_SETTINGS.computeType;
  const transcriptionMode = ["intended", "verbatim", "dual"].includes(String(source.transcriptionMode))
    ? source.transcriptionMode as AppSettings["transcriptionMode"]
    : DEFAULT_SETTINGS.transcriptionMode;
  const requestedLanguage = safeString(source.language, DEFAULT_SETTINGS.language, 12).toLowerCase();

  return {
    shortcut: safeString(source.shortcut, DEFAULT_SETTINGS.shortcut, 96),
    model,
    language: validLanguages.has(requestedLanguage) ? requestedLanguage : DEFAULT_SETTINGS.language,
    pythonCommand: safeString(source.pythonCommand, DEFAULT_SETTINGS.pythonCommand, 512),
    inputDeviceId: safeString(source.inputDeviceId, DEFAULT_SETTINGS.inputDeviceId, 512),
    inputDeviceLabel: safeString(source.inputDeviceLabel, DEFAULT_SETTINGS.inputDeviceLabel, 512),
    transcriptionMode,
    pasteVersion: source.pasteVersion === "verbatim" ? "verbatim" : "intended",
    autoPaste: boolean(source.autoPaste, DEFAULT_SETTINGS.autoPaste),
    copyToClipboard: boolean(source.copyToClipboard, DEFAULT_SETTINGS.copyToClipboard),
    keepHistory: boolean(source.keepHistory, DEFAULT_SETTINGS.keepHistory),
    showOverlay: boolean(source.showOverlay, DEFAULT_SETTINGS.showOverlay),
    preloadModel: boolean(source.preloadModel, DEFAULT_SETTINGS.preloadModel),
    magicEnabled: boolean(source.magicEnabled, DEFAULT_SETTINGS.magicEnabled),
    magicModel,
    magicPreset,
    magicAllowInferences: boolean(source.magicAllowInferences, DEFAULT_SETTINGS.magicAllowInferences),
    preloadMagicModel: boolean(source.preloadMagicModel, DEFAULT_SETTINGS.preloadMagicModel),
    modelIdleMinutes: [1, 5, 15, 30, 60].includes(Number(source.modelIdleMinutes)) ? Number(source.modelIdleMinutes) : DEFAULT_SETTINGS.modelIdleMinutes,
    backend,
    computeType,
    speculativeDecoding: boolean(source.speculativeDecoding, DEFAULT_SETTINGS.speculativeDecoding),
    wordTimestamps: boolean(source.wordTimestamps, DEFAULT_SETTINGS.wordTimestamps),
    launchAtLogin: boolean(source.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    modelLicenseAccepted: boolean(source.modelLicenseAccepted, DEFAULT_SETTINGS.modelLicenseAccepted),
    customWords: normalizeWords(source.customWords),
  };
}

function emptyInsights(): SpeechInsights {
  return { fillerCount: 0, repetitionCount: 0, cutOffCount: 0, vocalEventCount: 0, wordsPerMinute: 0, speakingSeconds: 0 };
}

function migrateRecord(value: unknown): TranscriptRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const text = safeString(source.text, "", 250_000);
  if (!text) return null;
  const model = validModels.has(source.model as ModelId) ? source.model as ModelId : DEFAULT_SETTINGS.model;
  const mode = ["intended", "verbatim", "dual", "forcedAlign", "verbatimize"].includes(String(source.mode))
    ? source.mode as TranscriptRecord["mode"]
    : "intended";
  return {
    id: safeString(source.id, `legacy-${Date.now()}-${Math.random()}`, 128),
    createdAt: Number(source.createdAt) || Date.now(),
    durationMs: Math.max(0, Number(source.durationMs) || 0),
    text,
    intendedText: safeString(source.intendedText, mode === "verbatim" ? "" : text, 250_000),
    verbatimText: safeString(source.verbatimText ?? source.rawText, "", 250_000),
    editedIntendedText: optionalText(source.editedIntendedText, 500_000),
    editedVerbatimText: optionalText(source.editedVerbatimText, 500_000),
    magicText: optionalText(source.magicText, 500_000),
    magicModel: validMagicModels.has(source.magicModel as MagicModelId) ? source.magicModel as MagicModelId : null,
    magicPreset: ["polish", "concise", "structured", "prompt"].includes(String(source.magicPreset)) ? source.magicPreset as MagicPreset : null,
    magicIncludedInferences: source.magicIncludedInferences === true,
    magicProcessingTimeMs: Math.max(0, Number(source.magicProcessingTimeMs) || 0),
    mode,
    model,
    language: safeString(source.language, "en", 12),
    words: Array.isArray(source.words) ? source.words as TranscriptRecord["words"] : [],
    verbatimWords: Array.isArray(source.verbatimWords) ? source.verbatimWords as TranscriptRecord["verbatimWords"] : [],
    insights: source.insights && typeof source.insights === "object" ? source.insights as SpeechInsights : emptyInsights(),
    source: ["dictation", "file", "verbatimize", "forcedAlign"].includes(String(source.source))
      ? source.source as TranscriptRecord["source"]
      : "dictation",
    sourceName: typeof source.sourceName === "string" ? source.sourceName : null,
    processingTimeMs: Math.max(0, Number(source.processingTimeMs) || 0),
  };
}

export function applyTranscriptEdit(record: TranscriptRecord, version: TranscriptVersion, text: string | null): TranscriptRecord {
  const normalized = text?.trim() ?? null;
  if (text !== null && !normalized) throw new Error("A transcript correction cannot be empty");
  const correction = normalized === originalTranscriptText(record, version) ? null : normalized;
  return version === "intended"
    ? { ...record, editedIntendedText: correction }
    : { ...record, editedVerbatimText: correction };
}

export class StorageService {
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  readonly venvDirectory: string;
  readonly modelCacheDirectory: string;
  private settings: AppSettings;
  private history: TranscriptRecord[];

  constructor() {
    this.dataDirectory = app.getPath("userData");
    this.cacheDirectory = join(app.getPath("temp"), "delulu-talks");
    this.venvDirectory = join(this.dataDirectory, "asr-venv");
    this.modelCacheDirectory = join(this.dataDirectory, "models");
    mkdirSync(this.dataDirectory, { recursive: true });
    mkdirSync(this.cacheDirectory, { recursive: true });
    mkdirSync(this.modelCacheDirectory, { recursive: true });

    const settingsPath = join(this.dataDirectory, SETTINGS_FILE);
    const historyPath = join(this.dataDirectory, HISTORY_FILE);
    const legacy = this.findLegacyDirectory();
    const rawSettings = readJson(settingsPath) ?? (legacy ? readJson(join(legacy, SETTINGS_FILE)) : undefined);
    const rawHistory = readJson(historyPath) ?? (legacy ? readJson(join(legacy, HISTORY_FILE)) : undefined);
    this.settings = normalizeSettings(rawSettings);
    this.history = Array.isArray(rawHistory) ? rawHistory.flatMap((item) => migrateRecord(item) ?? []).slice(0, MAX_HISTORY) : [];
    writeJson(settingsPath, this.settings);
    if (!existsSync(historyPath) && this.history.length) writeJson(historyPath, this.history);
  }

  private findLegacyDirectory(): string | null {
    const home = app.getPath("home");
    const candidates = process.platform === "linux"
      ? [join(home, ".local", "share", "com.joran.delulu-talks"), join(home, ".local", "share", "delulu-talks")]
      : [];
    return candidates.find((candidate) => existsSync(join(candidate, SETTINGS_FILE))) ?? null;
  }

  getSettings(): AppSettings {
    return structuredClone(this.settings);
  }

  updateSettings(value: unknown): AppSettings {
    this.settings = normalizeSettings(value);
    writeJson(join(this.dataDirectory, SETTINGS_FILE), this.settings);
    return this.getSettings();
  }

  getHistory(): TranscriptRecord[] {
    return structuredClone(this.history);
  }

  addHistory(record: TranscriptRecord): void {
    if (!this.settings.keepHistory) return;
    this.history = [record, ...this.history.filter((item) => item.id !== record.id)].slice(0, MAX_HISTORY);
    writeJson(join(this.dataDirectory, HISTORY_FILE), this.history);
  }

  findHistory(id: string): TranscriptRecord | undefined {
    return this.history.find((item) => item.id === id);
  }

  updateTranscript(id: string, version: TranscriptVersion, text: string | null): TranscriptRecord {
    const index = this.history.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Transcript not found");
    const updated = applyTranscriptEdit(this.history[index], version, text);
    this.history = this.history.map((item, itemIndex) => itemIndex === index ? updated : item);
    writeJson(join(this.dataDirectory, HISTORY_FILE), this.history);
    return structuredClone(updated);
  }

  deleteHistory(id: string): void {
    this.history = this.history.filter((item) => item.id !== id);
    writeJson(join(this.dataDirectory, HISTORY_FILE), this.history);
  }

  clearHistory(): void {
    this.history = [];
    writeJson(join(this.dataDirectory, HISTORY_FILE), this.history);
  }
}
