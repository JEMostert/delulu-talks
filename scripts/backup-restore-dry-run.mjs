#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const languages = ["en", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "el", "sv", "da", "fi", "no", "uk", "ru", "tr", "ar", "he", "hi", "zh", "ja", "ko", "vi"];
const magicModels = ["qwen35Small", "qwen35Medium", "qwen35Large"];
const presets = ["polish", "concise", "structured", "prompt"];
const booleanSettings = ["onboardingComplete", "autoPaste", "copyToClipboard", "keepHistory", "showOverlay", "preloadModel", "magicEnabled", "magicAllowInferences", "preloadMagicModel", "launchAtLogin"];
const stringSettings = {
  shortcut: 96, language: 12, pythonCommand: 512, inputDeviceId: 512,
  inputDeviceLabel: 512, pastePortalToken: 4096,
};
const enumSettings = {
  theme: ["system", "light", "dark"], shortcutMode: ["hold", "toggle"],
  model: ["r2t2", "r2t2Mlx"], magicModel: magicModels, magicPreset: presets,
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Resolve existing symlinks, including parents of a not-yet-created target. */
function canonicalPath(input) {
  const absolute = resolve(input);
  try {
    lstatSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), relative(parent, absolute));
  }
  return realpathSync(absolute); // Dangling symlinks deliberately fail.
}

function overlaps(a, b) {
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return contains(a, b) || contains(b, a);
}

// JSON.parse accepts duplicate keys by dropping earlier values. Inspect tokens
// separately so a syntactically valid backup cannot hide overwritten data.
function hasDuplicateJsonKeys(raw) {
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^{}\[\]:,\s]+/g) || [];
  const stack = [];
  for (const token of tokens) {
    if (token === "{" || token === "[") {
      stack.push({ object: token === "{", key: token === "{", keys: new Set() });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") {
      if (stack.length) stack[stack.length - 1].key = stack[stack.length - 1].object;
    } else if (token === ":") {
      if (stack.length) stack[stack.length - 1].key = false;
    } else if (token.startsWith('"') && stack.at(-1)?.key) {
      const key = JSON.parse(token);
      if (stack.at(-1).keys.has(key)) return true;
      stack.at(-1).keys.add(key);
    }
  }
  return false;
}

export function defaultProfilePaths(env = process.env) {
  const home = homedir();
  const appData = process.platform === "darwin"
    ? join(home, "Library", "Application Support")
    : process.platform === "win32"
      ? env.APPDATA || join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(appData, "Delulu Talks"), join(appData, "Delulu Talks Dev"),
    join(home, ".local", "share", "com.joran.delulu-talks"),
    join(home, ".local", "share", "delulu-talks"),
    ...(env.DELULU_USER_DATA_DIR ? [env.DELULU_USER_DATA_DIR] : []),
  ];
}

/** Reads only: this module has no write, mkdir, copy, rename or removal operations. */
export function inspectBackup({ source, target, profiles = [] }) {
  const report = {
    format: "delulu-backup-dry-run/v1",
    dryRun: true,
    compatible: false,
    readyForManualRestore: false,
    source: resolve(source),
    target: resolve(target),
    supportedSchema: { workflowVersion: 1, history: "TranscriptRecord[]", requiredFiles: ["settings.json", "history.json"] },
    files: {},
    counts: { transcripts: null, customWords: null },
    protectedProfiles: [],
    findings: [],
    scope: "Current settings and history only. Profiles, jobs, runtime environments, model caches and audio are outside this restoration format.",
    nextAction: null,
  };
  const finding = (severity, code, path, message, action) => {
    report.findings.push({ severity, code, path, message, action });
  };
  const error = (code, path, message, action = "Repair a separate copy of the backup, then repeat the dry run.") => finding("error", code, path, message, action);
  const warning = (code, path, message, action) => finding("warning", code, path, message, action);
  const field = (value, key, path, validate) => {
    if (!own(value, key)) error("missing-field", `${path}.${key}`, "Required field is missing; restoring would invent a default.");
    else validate(value[key], `${path}.${key}`);
  };
  const text = (value, path, max, { empty = true, literal = false } = {}) => {
    if (typeof value !== "string") return error("field-type", path, "Expected text.");
    if (!empty && !value.trim()) error("empty-text", path, "Empty text would be discarded or replaced by a default.");
    if (max && value.length > max) error("text-limit", path, `Text exceeds ${max} characters and would be truncated.`);
    if (!literal && value !== value.trim()) error("normalization-change", path, "Surrounding whitespace would be removed on profile load.");
  };
  const boolean = (value, path) => {
    if (typeof value !== "boolean") error("field-type", path, "Expected a boolean.");
  };
  const number = (value, path, minimum = 0) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
      error("field-type", path, `Expected a finite number >= ${minimum}.`);
  };
  const enumeration = (value, path, values) => {
    if (!values.includes(value)) error("unsupported-value", path, `Supported values: ${values.join(", ")}.`);
  };
  const unknownFields = (value, allowed, path) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) error("unknown-field", `${path}.${key}`, "Unknown data would be ignored by this app version.", "Use the app version that created this backup or migrate a separate copy explicitly.");
  };

  let canonicalSource;
  let canonicalTarget;
  try {
    canonicalSource = canonicalPath(source);
    if (!statSync(canonicalSource).isDirectory()) throw new Error("not-directory");
    report.source = canonicalSource;
  } catch {
    error("source-directory", report.source, "Source must be an accessible backup directory.", "Pass --source with a directory containing both committed JSON files.");
  }
  try {
    canonicalTarget = canonicalPath(target);
    report.target = canonicalTarget;
    try {
      const targetStat = statSync(canonicalTarget);
      if (!targetStat.isDirectory() || readdirSync(canonicalTarget).length)
        error("target-not-empty", canonicalTarget, "Target must be an empty or not-yet-created directory.", "Choose a new isolated target; this command will not clear existing data.");
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    let ancestor = dirname(canonicalTarget);
    for (;;) {
      try {
        if (!statSync(ancestor).isDirectory()) throw new Error("not-directory");
        break;
      } catch (failure) {
        if (failure.code !== "ENOENT") throw failure;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw failure;
        ancestor = parent;
      }
    }
  } catch {
    error("target-path", report.target, "Cannot resolve a safe target directory (including symlink parents).", "Choose an accessible directory path whose existing parents are directories.");
  }
  if (canonicalSource && canonicalTarget && overlaps(canonicalSource, canonicalTarget))
    error("source-target-overlap", canonicalTarget, "Source and target overlap, including canonical symlink locations.", "Choose a target outside the source and its ancestors.");
  for (const profile of [...defaultProfilePaths(), ...profiles]) {
    try {
      const canonical = canonicalPath(profile);
      if (!report.protectedProfiles.includes(canonical)) report.protectedProfiles.push(canonical);
      if (canonicalTarget && overlaps(canonicalTarget, canonical))
        error("profile-overlap", canonicalTarget, `Target overlaps protected app profile ${canonical}.`, "Choose a new isolated target outside all protected profiles and their ancestors.");
    } catch {
      error("profile-path", resolve(profile), "Cannot resolve a protected profile safely.", "Repair its path or permissions before determining target isolation.");
    }
  }

  function readJson(name) {
    const path = join(report.source, name);
    report.files[name] = { path, status: "invalid", bytes: null };
    if (!canonicalSource) return null;
    let bytes;
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        error("backup-file-type", path, "Required backup file must be a regular file, not a directory or symlink.");
        return null;
      }
      bytes = readFileSync(path, "utf8");
      report.files[name].bytes = entry.size;
    } catch (failure) {
      error(failure.code === "ENOENT" ? "missing-file" : "unreadable-file", path, "Required committed backup file is missing or unreadable.", "Recover both settings.json and history.json from the same complete backup; .tmp files are not substitutes.");
      return null;
    }
    try {
      const value = JSON.parse(bytes);
      if (hasDuplicateJsonKeys(bytes)) {
        error("duplicate-json-key", path, "Duplicate object keys would silently overwrite earlier values during JSON parsing.");
        return null;
      }
      report.files[name].status = "parsed";
      return value;
    } catch {
      error("invalid-json", path, "Backup file contains invalid JSON; contents have not been included in this report.");
      return null;
    }
  }

  const settings = readJson("settings.json");
  if (settings !== null) {
    if (!isObject(settings)) error("settings-shape", "settings.json", "Settings must be a JSON object.");
    else if (settings.workflowVersion !== 1)
      error("unsupported-schema", "settings.json.workflowVersion", "Only complete workflowVersion 1 backups are supported; legacy unversioned and future versions require explicit migration.", "Use a compatible app to migrate a separate copy and export a complete current backup.");
    else {
      const allowed = ["workflowVersion", "pasteLastDelaySeconds", "modelIdleMinutes", "customWords", ...booleanSettings, ...Object.keys(stringSettings), ...Object.keys(enumSettings)];
      unknownFields(settings, allowed, "settings.json");
      for (const key of booleanSettings) field(settings, key, "settings.json", boolean);
      for (const [key, max] of Object.entries(stringSettings))
        field(settings, key, "settings.json", (value, path) => text(value, path, max, { empty: key === "pastePortalToken" }));
      for (const [key, values] of Object.entries(enumSettings))
        field(settings, key, "settings.json", (value, path) => enumeration(value, path, values));
      field(settings, "language", "settings.json", (value, path) => enumeration(value, path, languages));
      field(settings, "modelIdleMinutes", "settings.json", (value, path) => enumeration(value, path, [1, 5, 15, 30, 60]));
      field(settings, "pasteLastDelaySeconds", "settings.json", (value, path) => {
        if (!Number.isInteger(value) || value < 1 || value > 30) error("unsupported-value", path, "Expected an integer from 1 to 30 seconds.");
      });
      const hostModel = process.platform === "darwin" && process.arch === "arm64" ? "r2t2Mlx" : "r2t2";
      if (enumSettings.model.includes(settings.model) && settings.model !== hostModel)
        warning("host-engine-change", "settings.json.model", `The host app selects ${hostModel} when opening this profile.`, "Confirm this is the intended restore machine; runtime installation is separate.");
      if (settings.shortcut === "CommandOrControl+Shift+Space")
        error("shortcut-migration", "settings.json.shortcut", "This legacy default is replaced by Super+Z on load.", "Choose the desired shortcut explicitly in a separate migrated backup.");
      field(settings, "customWords", "settings.json", (words, path) => {
        if (!Array.isArray(words)) return error("field-type", path, "Expected a custom-word array.");
        report.counts.customWords = words.length;
        if (words.length > 500) error("word-limit", path, "More than 500 custom words would be discarded.");
        const ids = new Set();
        words.forEach((word, index) => {
          const location = `${path}[${index}]`;
          if (!isObject(word)) return error("word-shape", location, "Expected a custom-word object.");
          unknownFields(word, ["id", "kind", "term", "soundsLike", "replacement", "enabled"], location);
          for (const [key, max] of Object.entries({ id: 128, term: 256, soundsLike: 1024, replacement: 4096 }))
            field(word, key, location, (value, path) => text(value, path, max, { empty: ["soundsLike", "replacement"].includes(key), literal: key === "replacement" }));
          if (typeof word.replacement === "string" && word.replacement.length && !word.replacement.trim())
            error("normalization-change", `${location}.replacement`, "Whitespace-only replacement text would be discarded on load.");
          field(word, "enabled", location, boolean);
          if (own(word, "kind")) enumeration(word.kind, `${location}.kind`, ["correction", "shortcut"]);
          else warning("word-kind-default", `${location}.kind`, "Legacy word kind is inferred from its replacement text.", "Confirm inferred correction/shortcut behavior in a migrated copy.");
          if (ids.has(word.id)) error("duplicate-word-id", `${location}.id`, "Duplicate custom-word identity.");
          ids.add(word.id);
        });
      });
    }
  } else if (report.files["settings.json"].status === "parsed") error("settings-shape", "settings.json", "JSON null is not a settings profile.");

  const history = readJson("history.json");
  if (history !== null) {
    if (!Array.isArray(history)) error("history-shape", "history.json", "Expected the current unwrapped transcript array; future profile/job envelopes are unsupported.");
    else {
      report.counts.transcripts = history.length;
      if (history.length > 500) error("history-limit", "history.json", "More than 500 transcripts would be silently discarded on load.");
      const ids = new Set();
      history.forEach((record, index) => {
        const path = `history.json[${index}]`;
        if (!isObject(record)) return error("transcript-shape", path, "Expected a transcript object; this record would be discarded.");
        unknownFields(record, ["id", "createdAt", "durationMs", "text", "personalizedText", "editedText", "magicText", "magicModel", "magicPreset", "magicIncludedInferences", "magicProcessingTimeMs", "model", "language", "source", "sourceName", "processingTimeMs"], path);
        field(record, "id", path, (value, path) => text(value, path, 128, { empty: false }));
        field(record, "text", path, (value, path) => text(value, path, 250_000, { empty: false }));
        field(record, "language", path, (value, path) => text(value, path, 12, { empty: false }));
        for (const key of ["createdAt", "durationMs", "processingTimeMs"])
          field(record, key, path, (value, path) => number(value, path, key === "createdAt" ? 1 : 0));
        field(record, "model", path, (value, path) => enumeration(value, path, ["r2t2", "r2t2Mlx", "qwen3Asr"]));
        field(record, "source", path, (value, path) => enumeration(value, path, ["dictation", "file"]));
        for (const key of ["personalizedText", "editedText", "magicText"])
          if (own(record, key) && record[key] !== null)
            text(record[key], `${path}.${key}`, 500_000, { empty: false, literal: key !== "editedText" });
        if (own(record, "sourceName") && record.sourceName !== null)
          text(record.sourceName, `${path}.sourceName`, null, { literal: true });
        if (own(record, "magicModel") && record.magicModel !== null) enumeration(record.magicModel, `${path}.magicModel`, magicModels);
        if (own(record, "magicPreset") && record.magicPreset !== null) enumeration(record.magicPreset, `${path}.magicPreset`, presets);
        if (own(record, "magicIncludedInferences")) boolean(record.magicIncludedInferences, `${path}.magicIncludedInferences`);
        if (own(record, "magicProcessingTimeMs")) number(record.magicProcessingTimeMs, `${path}.magicProcessingTimeMs`);
        if (ids.has(record.id)) error("duplicate-transcript-id", `${path}.id`, "Duplicate transcript identity can hide or overwrite a record.");
        ids.add(record.id);
      });
    }
  } else if (report.files["history.json"].status === "parsed") error("history-shape", "history.json", "JSON null is not transcript history.");

  if (canonicalSource) {
    try {
      for (const name of readdirSync(canonicalSource)) {
        if (["settings.json", "history.json"].includes(name)) continue;
        if (/profile|job/i.test(name)) error("unsupported-backup-domain", name, "Profile/job data is not supported by this restoration format.", "Use a compatible restoration tool for the complete backup; do not drop this domain.");
        else warning("excluded-backup-entry", name, "This entry is outside settings/history restoration and will not be restored.", "Keep it separately; runtime/model/audio restoration is outside this dry run.");
      }
    } catch {
      error("source-listing", canonicalSource, "Cannot inspect backup completeness.");
    }
  }
  report.compatible = !report.findings.some((item) => item.severity === "error");
  report.readyForManualRestore = report.compatible;
  report.nextAction = report.compatible
    ? "Read every warning. With the app stopped, restore both JSON files to this isolated target in a separate explicit operation; this command writes nothing."
    : "Resolve all errors in a separate backup copy or choose a different target, then repeat this dry run. No files were changed.";
  return report;
}

function main(args) {
  const options = { profiles: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") {
      console.log("Usage: node scripts/backup-restore-dry-run.mjs --source BACKUP_DIR --target ISOLATED_DIR [--profile ACTIVE_PROFILE_DIR ...]\nRead-only JSON report; exit 0 means compatible, 1 blocked, 2 invalid arguments. Custom profile paths must be declared with --profile.");
      return;
    }
    if (!["--source", "--target", "--profile"].includes(flag) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Expected --source, --target and optional repeatable --profile path arguments.");
    const value = args[++i];
    if (flag === "--profile") options.profiles.push(value);
    else {
      const key = flag.slice(2);
      if (options[key]) throw new Error(`Duplicate ${flag} argument.`);
      options[key] = value;
    }
  }
  if (!options.source || !options.target) throw new Error("Both --source and --target are required.");
  const report = inspectBackup(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.compatible ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ format: "delulu-backup-dry-run/v1", dryRun: true, compatible: false, error: error.message }, null, 2));
    process.exitCode = 2;
  }
}
