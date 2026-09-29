import { app } from "electron";
import { speechModelForPlatform } from "../runtime/platform";
import { normalizeReportedLanguage } from "../../src/transcriptLanguage";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  LEGACY_DEFAULT_SHORTCUT,
  MAGIC_MODELS,
  MODELS,
} from "../../src/data";
import type {
  AppSettings,
  CustomWord,
  MagicModelId,
  MagicPreset,
  ModelId,
  TranscriptRecord,
} from "../../src/types";

const SETTINGS_FILE = "settings.json";
const HISTORY_FILE = "history.json";
const MAX_HISTORY = 500;
const validHistoryModels = new Set<ModelId>([
  ...MODELS.map((model) => model.id),
  "qwen3Asr",
]);
const validMagicModels = new Set(MAGIC_MODELS.map((model) => model.id));
const validLanguages = new Set<string>(LANGUAGES.map(([code]) => code));

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Could not read local data at ${path}. The file has been preserved. Restore a valid backup or repair the JSON before reopening Delulu Talks.`,
      { cause: error },
    );
  }
}

/** Only a missing file is a first-run profile; invalid data must survive startup. */
function readProfileJson(
  path: string,
  legacyPath: string | undefined,
  kind: "settings" | "history",
): unknown {
  let sourcePath = path;
  let value = readJson(sourcePath);
  if (value === undefined && legacyPath) {
    sourcePath = legacyPath;
    value = readJson(sourcePath);
  }
  if (value === undefined) return undefined;

  let problem: string | undefined;
  if (kind === "history") {
    if (!Array.isArray(value)) problem = "expected a JSON array of transcripts";
  } else if (!value || typeof value !== "object" || Array.isArray(value)) {
    problem = "expected a JSON object of settings";
  } else {
    const version = (value as Record<string, unknown>).workflowVersion;
    // Unversioned profiles are the supported legacy format. Never downgrade a
    // newer or malformed version by normalizing it into workflowVersion 1.
    if (version !== undefined && version !== 1)
      problem = `unsupported workflowVersion ${JSON.stringify(version)}; supported formats are an unversioned legacy object or workflowVersion 1`;
  }
  if (problem)
    throw new Error(
      `Unsupported local data at ${sourcePath}: ${problem}. The file has been preserved. Restore a compatible backup or use an app version that supports this format.`,
    );
  return value;
}

function stageJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return temporary;
}

function writeJson(path: string, value: unknown): void {
  renameSync(stageJson(path, value), path);
}

function safeString(value: unknown, fallback: string, max = 512): string {
  return typeof value === "string"
    ? value.trim().slice(0, max) || fallback
    : fallback;
}

function optionalText(
  value: unknown,
  max: number,
  preserveWhitespace = false,
): string | null {
  if (typeof value !== "string") return null;
  const text = preserveWhitespace ? value : value.trim();
  return text.trim() ? text.slice(0, max) : null;
}

function normalizeWords(value: unknown): CustomWord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<CustomWord>;
    const term = safeString(source.term, "", 256);
    if (!term) return [];
    return [
      {
        kind:
          source.kind === "shortcut" || (!source.kind && !!source.replacement)
            ? "shortcut"
            : "correction",
        id: safeString(source.id, `word-${Date.now()}-${index}`, 128),
        term,
        soundsLike: safeString(source.soundsLike, "", 1024),
        // Shortcut indentation and trailing whitespace are literal user text.
        replacement:
          typeof source.replacement === "string" && source.replacement.trim()
            ? source.replacement.slice(0, 4096)
            : "",
        enabled: source.enabled !== false,
      },
    ];
  });
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(value: unknown): AppSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const magicModel = validMagicModels.has(source.magicModel as MagicModelId)
    ? (source.magicModel as MagicModelId)
    : DEFAULT_SETTINGS.magicModel;
  const magicPreset = ["polish", "concise", "structured", "prompt"].includes(
    String(source.magicPreset),
  )
    ? (source.magicPreset as MagicPreset)
    : DEFAULT_SETTINGS.magicPreset;
  const requestedLanguage = safeString(
    source.language,
    DEFAULT_SETTINGS.language,
    12,
  ).toLowerCase();
  const requestedShortcut = safeString(
    source.shortcut,
    DEFAULT_SETTINGS.shortcut,
    96,
  );

  return {
    workflowVersion: 1,
    theme: ["light", "dark"].includes(String(source.theme))
      ? (source.theme as AppSettings["theme"])
      : "system",
    onboardingComplete: boolean(
      source.onboardingComplete,
      DEFAULT_SETTINGS.onboardingComplete,
    ),
    shortcut:
      requestedShortcut === LEGACY_DEFAULT_SHORTCUT
        ? DEFAULT_SETTINGS.shortcut
        : requestedShortcut,
    shortcutMode: source.shortcutMode === "toggle" ? "toggle" : "hold",
    model: speechModelForPlatform(),
    language: validLanguages.has(requestedLanguage)
      ? requestedLanguage
      : DEFAULT_SETTINGS.language,
    pythonCommand: safeString(
      source.pythonCommand,
      DEFAULT_SETTINGS.pythonCommand,
      512,
    ),
    inputDeviceId: safeString(
      source.inputDeviceId,
      DEFAULT_SETTINGS.inputDeviceId,
      512,
    ),
    inputDeviceLabel: safeString(
      source.inputDeviceLabel,
      DEFAULT_SETTINGS.inputDeviceLabel,
      512,
    ),
    autoPaste: boolean(source.autoPaste, DEFAULT_SETTINGS.autoPaste),
    pasteLastDelaySeconds:
      typeof source.pasteLastDelaySeconds === "number" &&
      Number.isInteger(source.pasteLastDelaySeconds) &&
      source.pasteLastDelaySeconds >= 1 &&
      source.pasteLastDelaySeconds <= 30
        ? source.pasteLastDelaySeconds
        : DEFAULT_SETTINGS.pasteLastDelaySeconds,
    copyToClipboard: boolean(
      source.copyToClipboard,
      DEFAULT_SETTINGS.copyToClipboard,
    ),
    pastePortalToken: safeString(
      source.pastePortalToken,
      DEFAULT_SETTINGS.pastePortalToken,
      4096,
    ),
    keepHistory: boolean(source.keepHistory, DEFAULT_SETTINGS.keepHistory),
    showOverlay: boolean(source.showOverlay, DEFAULT_SETTINGS.showOverlay),
    preloadModel: boolean(source.preloadModel, DEFAULT_SETTINGS.preloadModel),
    magicEnabled: boolean(source.magicEnabled, DEFAULT_SETTINGS.magicEnabled),
    magicModel,
    magicPreset,
    magicAllowInferences: boolean(
      source.magicAllowInferences,
      DEFAULT_SETTINGS.magicAllowInferences,
    ),
    preloadMagicModel: boolean(
      source.preloadMagicModel,
      DEFAULT_SETTINGS.preloadMagicModel,
    ),
    modelIdleMinutes: [1, 5, 15, 30, 60].includes(
      Number(source.modelIdleMinutes),
    )
      ? Number(source.modelIdleMinutes)
      : DEFAULT_SETTINGS.modelIdleMinutes,
    launchAtLogin: boolean(
      source.launchAtLogin,
      DEFAULT_SETTINGS.launchAtLogin,
    ),
    customWords: normalizeWords(source.customWords),
  };
}

function migrateRecord(value: unknown): TranscriptRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const text = safeString(
    source.text ?? source.intendedText ?? source.verbatimText,
    "",
    250_000,
  );
  if (!text) return null;
  const model = validHistoryModels.has(source.model as ModelId)
    ? (source.model as ModelId)
    : DEFAULT_SETTINGS.model;
  return {
    id: safeString(source.id, `legacy-${Date.now()}-${Math.random()}`, 128),
    createdAt: Number(source.createdAt) || Date.now(),
    durationMs: Math.max(0, Number(source.durationMs) || 0),
    text,
    personalizedText: optionalText(source.personalizedText, 500_000, true),
    editedText: optionalText(
      source.editedText ?? source.editedIntendedText,
      500_000,
    ),
    magicText: optionalText(source.magicText, 500_000, true),
    magicModel: validMagicModels.has(source.magicModel as MagicModelId)
      ? (source.magicModel as MagicModelId)
      : null,
    magicPreset: ["polish", "concise", "structured", "prompt"].includes(
      String(source.magicPreset),
    )
      ? (source.magicPreset as MagicPreset)
      : null,
    magicIncludedInferences: source.magicIncludedInferences === true,
    magicProcessingTimeMs: Math.max(
      0,
      Number(source.magicProcessingTimeMs) || 0,
    ),
    model,
    language: safeString(source.language, "en", 12),
    ...(source.requestedLanguage === undefined
      ? {}
      : {
          requestedLanguage: normalizeReportedLanguage(source.requestedLanguage),
        }),
    ...(source.recognizedLanguage === undefined
      ? {}
      : {
          recognizedLanguage: normalizeReportedLanguage(source.recognizedLanguage),
        }),
    source: ["dictation", "file"].includes(String(source.source))
      ? (source.source as TranscriptRecord["source"])
      : "dictation",
    sourceName:
      typeof source.sourceName === "string" ? source.sourceName : null,
    processingTimeMs: Math.max(0, Number(source.processingTimeMs) || 0),
  };
}

export function applyTranscriptEdit(
  record: TranscriptRecord,
  text: string | null,
): TranscriptRecord {
  record = {
    ...record,
    magicText: null,
    magicModel: null,
    magicPreset: null,
    magicIncludedInferences: false,
    magicProcessingTimeMs: 0,
  };
  const normalized = text?.trim() ?? null;
  if (text !== null && !normalized)
    throw new Error("A transcript correction cannot be empty");
  const correction = normalized === record.text ? null : normalized;
  return { ...record, editedText: correction };
}

export class StorageService {
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  /** Dedicated speech environment. Kept as venvDirectory for API compatibility. */
  readonly venvDirectory: string;
  readonly magicVenvDirectory: string;
  readonly legacyVenvDirectory: string;
  readonly modelCacheDirectory: string;
  private settings: AppSettings;
  private history: TranscriptRecord[];

  constructor() {
    this.dataDirectory = app.getPath("userData");
    this.cacheDirectory = join(this.dataDirectory, "audio-cache");
    this.venvDirectory = join(this.dataDirectory, "speech-venv");
    const dedicatedMagicVenv = join(this.dataDirectory, "magic-venv");
    this.legacyVenvDirectory = join(this.dataDirectory, "asr-venv");
    // Releases before split runtimes installed Magic into asr-venv. Preserve a
    // working 6+ GB environment instead of forcing an unnecessary reinstall.
    this.magicVenvDirectory = existsSync(dedicatedMagicVenv)
      ? dedicatedMagicVenv
      : existsSync(this.legacyVenvDirectory)
        ? this.legacyVenvDirectory
        : dedicatedMagicVenv;
    this.modelCacheDirectory = join(this.dataDirectory, "models");
    mkdirSync(this.dataDirectory, { recursive: true });
    mkdirSync(this.cacheDirectory, { recursive: true });
    mkdirSync(this.modelCacheDirectory, { recursive: true });

    const settingsPath = join(this.dataDirectory, SETTINGS_FILE);
    const historyPath = join(this.dataDirectory, HISTORY_FILE);
    const legacy = this.findLegacyDirectory();
    // Validate both files before any migration writes. JSON null is invalid,
    // not a signal to fall back to an older profile or default settings.
    const rawSettings = readProfileJson(
      settingsPath,
      legacy ? join(legacy, SETTINGS_FILE) : undefined,
      "settings",
    );
    const rawHistory = readProfileJson(
      historyPath,
      legacy ? join(legacy, HISTORY_FILE) : undefined,
      "history",
    );
    // Old releases enabled rewriting by default, so that setting did not record opt-in.
    // Migrate once; subsequent explicit choices persist with the workflow version.
    const prior =
      rawSettings && typeof rawSettings === "object"
        ? (rawSettings as Record<string, unknown>)
        : {};
    this.settings = normalizeSettings(
      prior.workflowVersion === 1
        ? prior
        : { ...prior, magicEnabled: false, preloadMagicModel: false },
    );
    this.history = Array.isArray(rawHistory)
      ? rawHistory
          .flatMap((item) => migrateRecord(item) ?? [])
          .slice(0, MAX_HISTORY)
      : [];
    if (!existsSync(historyPath) && this.history.length) {
      // Stage both migration outputs before replacing either destination.
      // Publish the previously absent history first: if the settings rename
      // fails, remove only the history created by this attempt. Existing
      // settings and both legacy source files remain untouched.
      const stagedSettings = stageJson(settingsPath, this.settings);
      let stagedHistory: string | undefined;
      let historyPublished = false;
      try {
        stagedHistory = stageJson(historyPath, this.history);
        renameSync(stagedHistory, historyPath);
        historyPublished = true;
        renameSync(stagedSettings, settingsPath);
      } catch (error) {
        if (historyPublished) {
          try {
            rmSync(historyPath);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Profile migration failed and its newly created history could not be rolled back. Existing settings and legacy source files were preserved.",
            );
          }
        }
        throw error;
      } finally {
        rmSync(stagedSettings, { force: true });
        if (stagedHistory) rmSync(stagedHistory, { force: true });
      }
    } else {
      writeJson(settingsPath, this.settings);
    }
  }

  private findLegacyDirectory(): string | null {
    if (!app.isPackaged) return null;
    const home = app.getPath("home");
    const candidates =
      process.platform === "linux"
        ? [
            join(home, ".local", "share", "com.joran.delulu-talks"),
            join(home, ".local", "share", "delulu-talks"),
          ]
        : [];
    return (
      candidates.find((candidate) =>
        existsSync(join(candidate, SETTINGS_FILE)),
      ) ?? null
    );
  }

  getSettings(): AppSettings {
    return structuredClone(this.settings);
  }

  updateSettings(value: unknown): AppSettings {
    const next = normalizeSettings(value);
    writeJson(join(this.dataDirectory, SETTINGS_FILE), next);
    this.settings = next;
    return this.getSettings();
  }

  getHistory(): TranscriptRecord[] {
    return structuredClone(this.history);
  }

  addHistory(record: TranscriptRecord): void {
    if (!this.settings.keepHistory) return;
    const next = [
      record,
      ...this.history.filter((item) => item.id !== record.id),
    ].slice(0, MAX_HISTORY);
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  findHistory(id: string): TranscriptRecord | undefined {
    return this.history.find((item) => item.id === id);
  }

  updateTranscript(id: string, text: string | null): TranscriptRecord {
    const index = this.history.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Transcript not found");
    const updated = applyTranscriptEdit(this.history[index], text);
    const next = this.history.map((item, itemIndex) =>
      itemIndex === index ? updated : item,
    );
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
    return structuredClone(updated);
  }

  replaceHistory(record: TranscriptRecord): void {
    if (!this.findHistory(record.id)) throw new Error("Transcript not found");
    const next = this.history.map((item) =>
      item.id === record.id ? record : item,
    );
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  deleteHistory(id: string): void {
    const next = this.history.filter((item) => item.id !== id);
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  clearHistory(): void {
    writeJson(join(this.dataDirectory, HISTORY_FILE), []);
    this.history = [];
  }
}
