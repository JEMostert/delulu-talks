import { DEFAULT_SETTINGS, LANGUAGES, MAGIC_MODELS, MODELS } from "../../src/data";

type ProfileKind = "settings" | "history";
type ObjectValue = Record<string, unknown>;
import { REWRITE_PRESETS } from "../../src/rewritePresets";
const presets = REWRITE_PRESETS.map(preset => preset.id);

/** Validate the original value before serialization; never normalize user text. */
export function validateProfileWrite(kind: ProfileKind, value: unknown): void {
  const fail = (path: string, expectation: string): never => {
    throw new Error(
      `Cannot save ${kind}: ${path} ${expectation}. Fix this value and try again. The write was cancelled; the existing file has been preserved.`,
    );
  };
  const object = (item: unknown, path: string): ObjectValue => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return fail(path, "must be a plain object");
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null)
      return fail(path, "must be a plain object");
    return item as ObjectValue;
  };
  const string = (
    item: unknown,
    path: string,
    max: number,
    nonblank = false,
  ): void => {
    if (typeof item !== "string" || item.length > max || (nonblank && !item.trim()))
      fail(path, `must be ${nonblank ? "a nonblank" : "a"} string of at most ${max} characters`);
  };
  const boolean = (item: unknown, path: string): void => {
    if (typeof item !== "boolean") fail(path, "must be a boolean");
  };
  const nonnegative = (item: unknown, path: string): void => {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
      fail(path, "must be a finite nonnegative number");
  };
  const enumeration = (item: unknown, path: string, allowed: readonly string[]): void => {
    if (typeof item !== "string" || !allowed.includes(item))
      fail(path, `must be one of ${allowed.join(", ")}`);
  };
  const array = (item: unknown, path: string): unknown[] => {
    if (!Array.isArray(item) || item.length > (path === "history" ? 1000 : 500))
      return fail(path, "exceeds the supported record limit");
    return item;
  };
  const ancestors = new Set<object>();
  const jsonValue = (item: unknown, path: string, depth = 0): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail(path, "must not contain nonfinite numbers");
      return;
    }
    if (typeof item !== "object") fail(path, "must contain only JSON-compatible values");
    if (depth > 100) fail(path, "is too deeply nested to save safely");
    if (ancestors.has(item)) fail(path, "must not contain circular references");
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor) || descriptor.value === undefined)
          fail(`${path}[${index}]`, "must be present and contain a JSON-compatible value");
        jsonValue(descriptor.value, `${path}[${index}]`, depth + 1);
      }
    } else {
      object(item, path);
    }
    for (const key of Reflect.ownKeys(item)) {
      // Unknown extension keys can themselves contain private user text.
      const field = `${path}.[extension]`;
      if (typeof key !== "string") fail(field, "must not contain symbol keys");
      if (Array.isArray(item) && (key === "length" || (String(Number(key)) === key && Number(key) >= 0 && Number(key) < item.length)))
        continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor)) fail(field, "must not contain accessor properties");
      if (descriptor.value !== undefined) jsonValue(descriptor.value, field, depth + 1);
    }
    ancestors.delete(item);
  };
  jsonValue(value, kind);

  if (kind === "settings") {
    const settings = object(value, "settings");
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      if (!Object.hasOwn(settings, key) || settings[key] === undefined)
        fail(`settings.${key}`, "is required");
      if (typeof defaultValue === "boolean") boolean(settings[key], `settings.${key}`);
    }
    if (settings.workflowVersion !== 1)
      fail("settings.workflowVersion", "must be the supported version 1");
    enumeration(settings.theme, "settings.theme", ["system", "light", "dark"]);
    enumeration(settings.shortcutMode, "settings.shortcutMode", ["hold", "toggle"]);
    enumeration(settings.model, "settings.model", MODELS.map((model) => model.id));
    enumeration(settings.magicModel, "settings.magicModel", MAGIC_MODELS.map((model) => model.id));
    enumeration(settings.magicPreset, "settings.magicPreset", presets);
    enumeration(settings.language, "settings.language", LANGUAGES.map(([code]) => code));
    for (const [key, max, nonblank] of [
      ["shortcut", 96, true],
      ["pythonCommand", 512, true],
      ["inputDeviceId", 512, true],
      ["inputDeviceLabel", 512, true],
      ["pastePortalToken", 4096, false],
    ] as const) string(settings[key], `settings.${key}`, max, nonblank);
    nonnegative(settings.modelIdleMinutes, "settings.modelIdleMinutes");
    const delay = settings.pasteLastDelaySeconds;
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 1 || delay > 30)
      fail("settings.pasteLastDelaySeconds", "must be an integer from 1 through 30");
    const ids = new Set<unknown>();
    for (const [index, item] of array(settings.customWords, "settings.customWords").entries()) {
      const path = `settings.customWords[${index}]`;
      const word = object(item, path);
      string(word.id, `${path}.id`, 128, true);
      if (ids.has(word.id)) fail(`${path}.id`, "must be unique");
      ids.add(word.id);
      string(word.term, `${path}.term`, 256, true);
      string(word.soundsLike, `${path}.soundsLike`, 1024);
      string(word.replacement, `${path}.replacement`, 4096);
      boolean(word.enabled, `${path}.enabled`);
      if (word.kind !== undefined)
        enumeration(word.kind, `${path}.kind`, ["correction", "shortcut"]);
    }
    return;
  }

  const ids = new Set<unknown>();
  for (const [index, item] of array(value, "history").entries()) {
    const path = `history[${index}]`;
    const record = object(item, path);
    string(record.id, `${path}.id`, 128, true);
    if (ids.has(record.id)) fail(`${path}.id`, "must be unique");
    ids.add(record.id);
    string(record.text, `${path}.text`, 250_000, true);
    string(record.language, `${path}.language`, 12, true);
    enumeration(record.model, `${path}.model`, [...MODELS.map((model) => model.id), "qwen3Asr"]);
    enumeration(record.source, `${path}.source`, ["file", "dictation"]);
    const createdAt = record.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(new Date(createdAt).getTime()))
      fail(`${path}.createdAt`, "must be a finite positive valid timestamp");
    nonnegative(record.durationMs, `${path}.durationMs`);
    nonnegative(record.processingTimeMs, `${path}.processingTimeMs`);
    if (record.magicProcessingTimeMs !== undefined)
      nonnegative(record.magicProcessingTimeMs, `${path}.magicProcessingTimeMs`);
    if (record.magicIncludedInferences !== undefined)
      boolean(record.magicIncludedInferences, `${path}.magicIncludedInferences`);
    for (const key of ["personalizedText", "editedText", "magicText"] as const) {
      if (record[key] !== undefined && record[key] !== null)
        string(record[key], `${path}.${key}`, 500_000);
    }
    if (record.sourceName !== undefined && record.sourceName !== null)
      string(record.sourceName, `${path}.sourceName`, 4096);
    if (record.magicModel !== undefined && record.magicModel !== null)
      enumeration(record.magicModel, `${path}.magicModel`, MAGIC_MODELS.map((model) => model.id));
    if (record.magicPreset !== undefined && record.magicPreset !== null)
      enumeration(record.magicPreset, `${path}.magicPreset`, presets);
  }
}
