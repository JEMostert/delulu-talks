import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

type ProfileFile = "settings.json" | "history.json";
export type ProfileRestoreRequest = {
  backupDirectory: string;
  targetDirectory: string;
  sourceProfileDirectory?: string;
  allowSettingsOnly?: boolean;
};
export type ProfileRestorePlan = {
  backupDirectory: string;
  sourceProfileDirectory: string;
  targetDirectory: string;
  settingsFormat: "workflow-1" | "legacy";
  historyRecords: number;
  files: Array<{ name: ProfileFile; bytes: number; sha256: string }>;
  warnings: string[];
};
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const contains = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
};

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected a regular backup file at ${path}`);
  if (info.size > maximum)
    throw new Error(
      `Backup file exceeds the bounded restore limit at ${path}; source files remain unchanged`,
    );
  const bytes = await readFile(path);
  if (bytes.length > maximum)
    throw new Error(`Backup file grew beyond the restore limit at ${path}`);
  return bytes;
}
function parse(path: string, bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error(
      `Could not parse backup JSON at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
function optionalString(
  source: Record<string, unknown>,
  key: string,
  maximum: number,
  nullable = false,
): void {
  const value = source[key];
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== "string" || value.length > maximum)
    throw new Error(
      `Unsupported ${key}: expected a string of at most ${maximum} characters`,
    );
}
function settingsSchema(value: unknown): "workflow-1" | "legacy" {
  if (!object(value))
    throw new Error("Settings backup must contain a JSON object");
  if (value.workflowVersion !== undefined && value.workflowVersion !== 1)
    throw new Error(
      `Unsupported settings workflowVersion ${JSON.stringify(value.workflowVersion)}; use a compatible application before restoring`,
    );
  for (const key of [
    "shortcut",
    "pythonCommand",
    "inputDeviceId",
    "inputDeviceLabel",
    "pastePortalToken",
    "language",
    "model",
    "magicModel",
    "magicPreset",
    "theme",
    "shortcutMode",
  ])
    optionalString(value, key, key === "pastePortalToken" ? 4096 : 512);
  for (const key of [
    "onboardingComplete",
    "autoPaste",
    "copyToClipboard",
    "keepHistory",
    "showOverlay",
    "preloadModel",
    "magicEnabled",
    "magicAllowInferences",
    "preloadMagicModel",
    "launchAtLogin",
  ])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`Unsupported settings ${key}: expected a boolean`);
  if (
    value.modelIdleMinutes !== undefined &&
    (!Number.isFinite(value.modelIdleMinutes) ||
      Number(value.modelIdleMinutes) < 0)
  )
    throw new Error("Unsupported settings modelIdleMinutes");
  if (
    value.workflowVersion === 1 &&
    value.model !== undefined &&
    !["r2t2", "r2t2Mlx"].includes(String(value.model))
  )
    throw new Error(
      "Versioned settings must select an R2T2 speech model; historical Qwen attribution remains valid only in history",
    );
  for (const [key, allowed] of Object.entries({
    theme: ["system", "light", "dark"],
    shortcutMode: ["hold", "toggle"],
    magicPreset: [
      "spoken-corrections",
      "polish",
      "concise",
      "structured",
      "prompt",
      "bullet-points",
      "professional-message",
    ],
  }))
    if (value[key] !== undefined && !allowed.includes(String(value[key])))
      throw new Error(`Unsupported settings ${key}`);
  if (value.customWords !== undefined) {
    if (!Array.isArray(value.customWords) || value.customWords.length > 500)
      throw new Error(
        "Vocabulary backup must be an array of at most 500 rules",
      );
    for (const rule of value.customWords) {
      if (!object(rule) || typeof rule.term !== "string" || !rule.term.trim())
        throw new Error("Vocabulary rule is missing its term");
      optionalString(rule, "term", 256);
      optionalString(rule, "id", 128);
      optionalString(rule, "soundsLike", 1024);
      optionalString(rule, "replacement", 4096);
      optionalString(rule, "language", 64);
      if (rule.enabled !== undefined && typeof rule.enabled !== "boolean")
        throw new Error("Vocabulary enabled must be boolean");
      if (
        rule.kind !== undefined &&
        !["correction", "shortcut"].includes(String(rule.kind))
      )
        throw new Error("Unsupported vocabulary kind");
    }
  }
  return value.workflowVersion === 1 ? "workflow-1" : "legacy";
}
function historySchema(value: unknown): number {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error(
      "History backup must contain at most 500 transcripts; restore never truncates records",
    );
  for (const record of value) {
    if (!object(record))
      throw new Error("History backup contains a non-object transcript");
    const text = record.text ?? record.intendedText ?? record.verbatimText;
    if (typeof text !== "string" || !text.trim() || text.length > 250_000)
      throw new Error(
        "History transcript has missing or unsupported original speech",
      );
    for (const key of [
      "personalizedText",
      "editedText",
      "editedIntendedText",
      "magicText",
    ])
      optionalString(record, key, 500_000, true);
    optionalString(record, "id", 128);
    optionalString(record, "language", 64);
    optionalString(record, "sourceName", 4096, true);
    if (
      record.model !== undefined &&
      !["r2t2", "r2t2Mlx", "qwen3Asr"].includes(String(record.model))
    )
      throw new Error(
        "History model attribution is unsupported; it cannot be silently relabeled during restore",
      );
    if (
      record.source !== undefined &&
      !["dictation", "file"].includes(String(record.source))
    )
      throw new Error("Unsupported transcript source");
    for (const key of [
      "createdAt",
      "durationMs",
      "processingTimeMs",
      "magicProcessingTimeMs",
    ])
      if (
        record[key] !== undefined &&
        (typeof record[key] !== "number" ||
          !Number.isFinite(record[key]) ||
          Number(record[key]) < 0)
      )
        throw new Error(`Unsupported transcript ${key}`);
    for (const key of ["sourceRevision", "rewriteSourceRevision"])
      if (
        record[key] != null &&
        (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
      )
        throw new Error(`Unsupported transcript ${key}`);
  }
  return value.length;
}

async function validate(
  request: ProfileRestoreRequest,
): Promise<{ plan: ProfileRestorePlan; contents: Map<ProfileFile, Buffer> }> {
  const backupDirectory = await realpath(resolve(request.backupDirectory));
  if (basename(backupDirectory).startsWith(".pending-"))
    throw new Error("An interrupted pending snapshot cannot be restored");
  if (!(await lstat(backupDirectory)).isDirectory())
    throw new Error("Backup source must be a directory");
  const inferred =
    basename(dirname(backupDirectory)) === "migration-backups"
      ? dirname(dirname(backupDirectory))
      : undefined;
  if (!request.sourceProfileDirectory && !inferred)
    throw new Error(
      "Provide the original source profile path when restoring a copied snapshot",
    );
  const sourceProfileDirectory = await realpath(
    resolve(request.sourceProfileDirectory ?? inferred!),
  );
  const requested = resolve(request.targetDirectory);
  const targetDirectory = join(
    await realpath(dirname(requested)),
    basename(requested),
  );
  for (const protectedPath of [backupDirectory, sourceProfileDirectory])
    if (
      contains(protectedPath, targetDirectory) ||
      contains(targetDirectory, protectedPath)
    )
      throw new Error(
        "Restore target must be separate from the source profile and backup, not a parent or child",
      );
  try {
    await lstat(targetDirectory);
    throw new Error(
      "Restore target already exists; select a new isolated profile directory",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifestPath = join(backupDirectory, "manifest.json");
  const manifest = parse(manifestPath, await boundedFile(manifestPath, 64_000));
  if (
    !object(manifest) ||
    manifest.owner !== "delulu-profile-migration" ||
    manifest.version !== 1 ||
    !object(manifest.files)
  )
    throw new Error(`Unsupported migration backup manifest at ${manifestPath}`);
  const names = Object.keys(manifest.files);
  if (
    !names.includes("settings.json") ||
    names.some((name) => name !== "settings.json" && name !== "history.json")
  )
    throw new Error(
      "Backup manifest must include settings.json and only supported profile files",
    );
  if (!names.includes("history.json") && !request.allowSettingsOnly)
    throw new Error(
      "Backup has no history payload. Use explicit settings-only restore to initialize empty history",
    );
  const contents = new Map<ProfileFile, Buffer>();
  for (const name of names as ProfileFile[]) {
    const expected = manifest.files[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
      throw new Error(`Invalid hash for ${name} in backup manifest`);
    const path = join(backupDirectory, name);
    const bytes = await boundedFile(
      path,
      name === "settings.json" ? 8 * 1024 * 1024 : 256 * 1024 * 1024,
    );
    if (hash(bytes) !== expected)
      throw new Error(
        `Backup checksum mismatch at ${path}; nothing was restored`,
      );
    contents.set(name, bytes);
  }
  const settingsPath = join(backupDirectory, "settings.json");
  let settingsFormat: "workflow-1" | "legacy";
  try {
    settingsFormat = settingsSchema(
      parse(settingsPath, contents.get("settings.json")!),
    );
  } catch (cause) {
    throw new Error(
      `Settings schema validation failed at ${settingsPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const historyPath = join(backupDirectory, "history.json");
  let historyRecords = 0;
  if (contents.has("history.json")) {
    try {
      historyRecords = historySchema(
        parse(historyPath, contents.get("history.json")!),
      );
    } catch (cause) {
      throw new Error(
        `History schema validation failed at ${historyPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  const warnings = [];
  if (settingsFormat === "legacy")
    warnings.push(
      "Unversioned settings are preserved; the app will migrate them when the isolated profile is opened",
    );
  if (!contents.has("history.json")) {
    contents.set("history.json", Buffer.from("[]\n"));
    warnings.push(
      "History payload is absent; explicitly requested settings-only restore initializes empty history",
    );
  }
  return {
    plan: {
      backupDirectory,
      sourceProfileDirectory,
      targetDirectory,
      settingsFormat,
      historyRecords,
      files: [...contents].map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
        sha256: hash(bytes),
      })),
      warnings,
    },
    contents,
  };
}

/** Dry run: validates source bytes/schema/completeness/isolation and performs no writes. */
export async function validateProfileBackup(
  request: ProfileRestoreRequest,
): Promise<ProfileRestorePlan> {
  return (await validate(request)).plan;
}

/** Revalidates and writes exact validated bytes into an exclusively created new profile. */
export async function restoreProfileBackup(
  request: ProfileRestoreRequest,
): Promise<ProfileRestorePlan> {
  const { plan, contents } = await validate(request);
  await mkdir(plan.targetDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of contents)
      await writeFile(join(plan.targetDirectory, name), bytes, {
        mode: 0o600,
        flag: "wx",
      });
    await writeFile(
      join(plan.targetDirectory, "restore-provenance.json"),
      `${JSON.stringify({ version: 1, restoredAt: new Date().toISOString(), ...plan }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return plan;
  } catch (error) {
    try {
      await rm(plan.targetDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Isolated restore failed and its new target could not be removed",
        { cause: error },
      );
    }
    throw new Error(
      "Isolated restore failed; original profile and backup files remain unchanged",
      { cause: error },
    );
  }
}
