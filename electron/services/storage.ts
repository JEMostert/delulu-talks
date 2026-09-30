import { normalizeCaptureDiagnostics } from "../../src/captureDiagnostics";
import { transcriptSourceRevision } from "../../src/transcriptText";
import { assertPersistedSchema, versionPersistedRecord } from "../../src/persistedSchema";
import { readActivePersonalProfile } from "../../src/activePersonalProfile";
import { assertPersonalProfilesUpdate, readPersonalProfiles } from "../../src/personalProfiles";
import { normalizeTimings, withoutRewriteTimings } from "../../src/pipelineTimings";
import { normalizeSpeechExecution } from "../../src/speechModels";
import { app } from "electron";
import { isMagicPreset } from "../../src/rewritePresets";
import { backupProfileMigration, removeMigrationHistoryBackups } from "./migrationBackups";
import { randomUUID } from "node:crypto";
import { validateProfileWrite } from "./profileWriteValidation";
import { speechModelForPlatform } from "../runtime/platform";
import { normalizeAliases } from "../../src/personalization";
import { historyFingerprint, savedRetentionPolicy } from "./historyRetention";
import {
  normalizeLanguageMetadata,
  normalizeReportedLanguage,
} from "../../src/transcriptLanguage";
import { normalizeTranscriptTitle } from "../../src/transcriptTitle";
import {
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  TranscriptDelivery,
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
  if (kind === "settings") {
    assertPersistedSchema(value, "settings");
    const rules = (value as Record<string, unknown>).customWords;
    if (Array.isArray(rules)) rules.forEach((rule) => assertPersistedSchema(rule, "rule"));
  } else if (Array.isArray(value)) {
    value.forEach((record) => assertPersistedSchema(record, "transcript"));
  }
  return value;
}

function stageJson(path: string, value: unknown): string {
  const kind = basename(path) === SETTINGS_FILE ? "settings" : "history";
  validateProfileWrite(kind, value);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  // Validate the exact JSON bytes that will become durable, not just the
  // in-memory object, before creating or replacing any profile file.
  validateProfileWrite(kind, JSON.parse(serialized));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Preserve the write error. */
      }
    }
    if (created) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the write error. */
      }
    }
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  const temporary = stageJson(path, value);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Preserve the replacement error. */
    }
    throw error;
  }
}

function safeString(value: unknown, fallback: string, max = 512): string {
  return typeof value === "string"
    ? value.trim().slice(0, max) || fallback
    : fallback;
}

function normalizeWords(value: unknown): CustomWord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Invalid or oversized vocabulary rules. Existing settings are preserved.");
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid vocabulary rule. Existing settings are preserved.");
    assertPersistedSchema(item, "rule");
    const source = item as Partial<CustomWord>;
    const term = safeString(source.term, "", 256);
    if (!term)
      throw new Error("Vocabulary rule has no term. Existing settings are preserved.");
    if (typeof source.replacement === "string" && source.replacement.length > 4096)
      throw new Error("Vocabulary text block exceeds the supported limit. Existing settings are preserved.");
    return [
      {
        ...source,
        schemaVersion: 1,
        kind:
          source.kind === "shortcut" || (!source.kind && !!source.replacement)
            ? "shortcut"
            : "correction",
        id: safeString(source.id, `word-${Date.now()}-${index}`, 128),
        term,
        // Preserve nonempty scopes, including unknown codes: never widen a saved rule.
        language: typeof source.language === "string" && source.language.trim()
          ? source.language.trim().toLowerCase().slice(0, 64)
          : undefined,
        soundsLike: safeString(source.soundsLike, "", 1024),
        ...(source.aliases !== undefined
          ? { aliases: normalizeAliases(source.aliases) }
          : {}),
        // Shortcut indentation and trailing whitespace are literal user text.
        replacement:
          typeof source.replacement === "string" && source.replacement.trim()
            ? source.replacement
            : "",
        enabled: source.enabled !== false &&
          (source.language == null || typeof source.language === "string"),
      },
    ];
  });
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function normalizeSettings(value: unknown): AppSettings {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  assertPersistedSchema(source, "settings");
  const magicModel = validMagicModels.has(source.magicModel as MagicModelId)
    ? (source.magicModel as MagicModelId)
    : DEFAULT_SETTINGS.magicModel;
  const magicPreset = isMagicPreset(source.magicPreset)
    ? source.magicPreset
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
    ...source,
    schemaVersion: 1,
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
    dictationMode:
      source.dictationMode === "code" || source.dictationMode === "command"
        ? source.dictationMode
        : "prose",
    dictationFormatting: source.dictationFormatting === "spoken" ? "spoken" : "preserve",
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
    trailingSilenceStopEnabled: boolean(
      source.trailingSilenceStopEnabled,
      DEFAULT_SETTINGS.trailingSilenceStopEnabled,
    ),
    trailingSilenceSeconds: boundedNumber(
      source.trailingSilenceSeconds,
      DEFAULT_SETTINGS.trailingSilenceSeconds,
      2,
      30,
    ),
    trailingSilenceThresholdDb: boundedNumber(
      source.trailingSilenceThresholdDb,
      DEFAULT_SETTINGS.trailingSilenceThresholdDb,
      -60,
      -20,
    ),
    autoPaste: boolean(source.autoPaste, DEFAULT_SETTINGS.autoPaste),
    pasteShortcut:
      source.pasteShortcut === "terminal"
        ? "terminal"
        : DEFAULT_SETTINGS.pasteShortcut,
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
    restoreClipboardAfterPaste: boolean(
      source.restoreClipboardAfterPaste,
      DEFAULT_SETTINGS.restoreClipboardAfterPaste,
    ),
    spokenFormattingCommands: boolean(
      source.spokenFormattingCommands,
      DEFAULT_SETTINGS.spokenFormattingCommands,
    ),
    pastePortalToken: safeString(
      source.pastePortalToken,
      DEFAULT_SETTINGS.pastePortalToken,
      4096,
    ),
    keepHistory: boolean(source.keepHistory, DEFAULT_SETTINGS.keepHistory),
    historyRetention: savedRetentionPolicy(source.historyRetention),
    showOverlay: boolean(source.showOverlay, DEFAULT_SETTINGS.showOverlay),
    captureSoundsMuted: boolean(
      source.captureSoundsMuted,
      DEFAULT_SETTINGS.captureSoundsMuted,
    ),
    captureSoundVolume:
      typeof source.captureSoundVolume === "number" &&
      Number.isFinite(source.captureSoundVolume)
        ? Math.min(1, Math.max(0, source.captureSoundVolume))
        : DEFAULT_SETTINGS.captureSoundVolume,
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
    memoryPolicy:
      source.memoryPolicy === "balanced" ? "balanced" : "independent",
    modelIdleMinutes: [1, 5, 15, 30, 60].includes(
      Number(source.modelIdleMinutes),
    )
      ? Number(source.modelIdleMinutes)
      : DEFAULT_SETTINGS.modelIdleMinutes,
    launchAtLogin: boolean(
      source.launchAtLogin,
      DEFAULT_SETTINGS.launchAtLogin,
    ),
    menuBarOnly: boolean(source.menuBarOnly, DEFAULT_SETTINGS.menuBarOnly),
    customWords: normalizeWords(source.customWords),
    personalProfiles: readPersonalProfiles(source.personalProfiles).document as AppSettings["personalProfiles"],
    activePersonalProfile: readActivePersonalProfile(source.activePersonalProfile),
  };
}

function migrateDelivery(value: unknown): TranscriptDelivery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.state !== "string" ||
    !["transcribed", "copied", "paste-attempted", "confirmed"].includes(
      source.state,
    ) ||
    typeof source.updatedAt !== "number" ||
    !Number.isFinite(source.updatedAt) ||
    source.updatedAt < 0 ||
    (source.method !== undefined && typeof source.method !== "string") ||
    (source.detail !== undefined && typeof source.detail !== "string")
  )
    return undefined;
  return {
    state: source.state as TranscriptDelivery["state"],
    updatedAt: source.updatedAt,
    ...(typeof source.method === "string"
      ? { method: source.method.slice(0, 128) }
      : {}),
    ...(typeof source.detail === "string"
      ? { detail: source.detail.slice(0, 2_000) }
      : {}),
  };
}

function migrateRecord(value: unknown): TranscriptRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  assertPersistedSchema(source, "transcript");
  const original = source.text ?? source.intendedText ?? source.verbatimText;
  const text = typeof original === "string" ? original : "";
  if (!text.trim())
    throw new Error("Invalid transcript text. History has been preserved; repair or restore the file before migration.");
  if (source.schemaVersion === 1) return structuredClone(source) as unknown as TranscriptRecord;
  const model = validHistoryModels.has(source.model as ModelId)
    ? (source.model as ModelId)
    : DEFAULT_SETTINGS.model;
  const delivery = migrateDelivery(source.delivery);
  let title: string | null = null;
  if (source.title !== undefined) {
    try {
      title = normalizeTranscriptTitle(source.title);
    } catch {
      // Invalid optional metadata must not discard original transcript content.
    }
  }
  const execution = model === "qwen3Asr" ? undefined : normalizeSpeechExecution(source.speechExecution);
  return {
    ...source,
    schemaVersion: 1,
    id: safeString(source.id, `legacy-${Date.now()}-${Math.random()}`, 128),
    ...(source.title === undefined ? {} : { title }),
    createdAt: Number(source.createdAt) || Date.now(),
    durationMs: Math.max(0, Number(source.durationMs) || 0),
    text,
    technicalText:
      typeof source.technicalText === "string"
        ? source.technicalText.slice(0, 500_000)
        : null,
    dictationMode:
      source.dictationMode === "code" || source.dictationMode === "command"
        ? source.dictationMode
        : "prose",
    sourceRevision: Number.isSafeInteger(source.sourceRevision) && Number(source.sourceRevision) >= 0
      ? Number(source.sourceRevision) : 0,
    rewriteSourceRevision: Number.isSafeInteger(source.rewriteSourceRevision) && Number(source.rewriteSourceRevision) >= 0
      ? Number(source.rewriteSourceRevision) : null,
    personalizedText: typeof source.personalizedText === "string" ? source.personalizedText : null,
    editedText: typeof (source.editedText ?? source.editedIntendedText) === "string"
      ? (source.editedText ?? source.editedIntendedText) as string : null,
    magicText: typeof source.magicText === "string" ? source.magicText : null,
    magicModel: validMagicModels.has(source.magicModel as MagicModelId)
      ? (source.magicModel as MagicModelId)
      : null,
    magicPreset: isMagicPreset(source.magicPreset)
      ? (source.magicPreset as MagicPreset)
      : null,
    magicIncludedInferences: source.magicIncludedInferences === true,
    magicProcessingTimeMs: Math.max(
      0,
      Number(source.magicProcessingTimeMs) || 0,
    ),
    model,
    ...(execution ? { speechExecution: execution } : {}),
    language: safeString(source.language, "en", 12),
    ...(source.requestedLanguage === undefined
      ? {}
      : {
          requestedLanguage: normalizeReportedLanguage(source.requestedLanguage),
        }),
    ...(source.recognizedLanguage === undefined &&
    source.recognizedLanguages === undefined &&
    source.languageStatus === undefined
      ? {}
      : normalizeLanguageMetadata(source)),
    dictationFormatting: source.dictationFormatting === "spoken" ? "spoken" : "preserve",
    source: ["dictation", "file"].includes(String(source.source))
      ? (source.source as TranscriptRecord["source"])
      : "dictation",
    sourceName:
      typeof source.sourceName === "string" ? source.sourceName : null,
    processingTimeMs: Math.max(0, Number(source.processingTimeMs) || 0),
    ...(delivery ? { delivery } : {}),
    captureDiagnostics: normalizeCaptureDiagnostics(source.captureDiagnostics),
    timings: normalizeTimings(source.timings),
  };
}

export function applyTranscriptEdit(
  record: TranscriptRecord,
  text: string | null,
): TranscriptRecord {
  const revision = transcriptSourceRevision(record);
  if (revision >= Number.MAX_SAFE_INTEGER)
    throw new Error("This transcript has reached its revision limit");
  record = {
    ...record,
    sourceRevision: revision + 1,
    rewriteSourceRevision: null,
    magicText: null,
    magicModel: null,
    magicPreset: null,
    magicIncludedInferences: false,
    magicProcessingTimeMs: 0,
    timings: withoutRewriteTimings(record.timings),
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
  private historyPins = new Set<string>();

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
      ? rawHistory.map((item) => {
          const record = migrateRecord(item);
          if (!record) throw new Error("Invalid transcript record. History has been preserved.");
          return record;
        })
      : [];
    const settingsChanged = rawSettings !== undefined &&
      JSON.stringify(rawSettings) !== JSON.stringify(this.settings);
    const historyChanged = rawHistory !== undefined &&
      (JSON.stringify(rawHistory) !== JSON.stringify(this.history) || !existsSync(historyPath));
    if (settingsChanged || historyChanged || (rawSettings !== undefined && !existsSync(settingsPath))) {
      backupProfileMigration(this.dataDirectory, {
        "settings.json": existsSync(settingsPath) ? settingsPath : legacy ? join(legacy, SETTINGS_FILE) : undefined,
        "history.json": existsSync(historyPath) ? historyPath : legacy ? join(legacy, HISTORY_FILE) : undefined,
      });
    }
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
      if (historyChanged) writeJson(historyPath, this.history);
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
    const source = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    // Older settings callers may omit the new field. Preserve existing documents.
    const document = Object.prototype.hasOwnProperty.call(source, "personalProfiles")
      ? source.personalProfiles
      : this.settings.personalProfiles;
    assertPersonalProfilesUpdate(this.settings.personalProfiles, document);
    const activePersonalProfile = Object.prototype.hasOwnProperty.call(source, "activePersonalProfile")
      ? source.activePersonalProfile : this.settings.activePersonalProfile;
    const next = normalizeSettings({ ...source, personalProfiles: document, activePersonalProfile });
    writeJson(join(this.dataDirectory, SETTINGS_FILE), next);
    this.settings = next;
    return this.getSettings();
  }

  getHistory(): TranscriptRecord[] {
    return structuredClone(this.history);
  }

  addHistory(record: TranscriptRecord): void {
    record = versionPersistedRecord(record, "transcript");
    if (!this.settings.keepHistory || record.sessionOnly) return;
    const ordered = [
      record,
      ...this.history.filter((item) => item.id !== record.id),
    ];
    // A pending undo window must survive the normal newest-500 eviction.
    // At most 500 additional pinned records; ordinary retention resumes after it.
    const next = [
      ...ordered.slice(0, MAX_HISTORY),
      ...ordered.slice(MAX_HISTORY).filter((item) => this.historyPins.has(item.id)),
    ];
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  pinHistory(ids: readonly string[]): void {
    this.historyPins = new Set(ids);
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

  setTranscriptTitle(id: string, title: string | null): TranscriptRecord {
    const index = this.history.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Transcript not found");
    const updated = {
      ...this.history[index],
      title: normalizeTranscriptTitle(title),
    };
    const next = this.history.map((item, itemIndex) =>
      itemIndex === index ? updated : item,
    );
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
    return structuredClone(updated);
  }

  replaceHistory(record: TranscriptRecord): void {
    record = versionPersistedRecord(record, "transcript");
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
    removeMigrationHistoryBackups(this.dataDirectory);
    this.history = next;
  }

  deleteHistorySelection(ids: readonly string[]): void {
    const removed = new Set(ids);
    const next = this.history.filter((record) => !removed.has(record.id));
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  applyHistoryRetention(expectedFingerprint: string, ids: readonly string[]): void {
    if (historyFingerprint(this.history) !== expectedFingerprint)
      throw new Error("History changed. Preview the affected records again before applying retention.");
    const removed = new Set(ids);
    const next = this.history.filter((record) => !removed.has(record.id));
    // Publish the complete filtered snapshot before changing memory; retained records are untouched.
    writeJson(join(this.dataDirectory, HISTORY_FILE), next);
    this.history = next;
  }

  clearHistory(): void {
    writeJson(join(this.dataDirectory, HISTORY_FILE), []);
    removeMigrationHistoryBackups(this.dataDirectory);
    this.history = [];
  }
}
