import { LANGUAGES } from "./data";
import type { AppSettings, MagicModelId, MagicPreset } from "./types";

export type ProfileJson = null | boolean | number | string | ProfileJson[] | { [key: string]: ProfileJson };
/** Opaque future documents remain stored, but must never be activated or edited. */
export type PersonalProfileDocument = { schemaVersion: number; [key: string]: ProfileJson };
export type ProfileVocabularyRuleV1 = {
  id: string;
  kind: "correction" | "shortcut";
  term: string;
  soundsLike: string;
  replacement: string;
  enabled: boolean;
  /** Omitted means all languages, matching legacy vocabulary rules. */
  language?: string;
};
export type PersonalProfileV1 = {
  schemaVersion: 1;
  id: string;
  name: string;
  /** Configured recognition language, never a claim of detected language. */
  language: string;
  decode: { mode: "backend-default" } | {
    mode: "explicit";
    temperature: number;
    maxTokens: number;
  };
  delivery: { autoPaste: boolean; copyToClipboard: boolean; keepHistory: boolean };
  vocabulary: { rules: ProfileVocabularyRuleV1[] };
  technicalGrammar: { preserveIdentifiers: boolean; literalTerms: string[] };
  context: { mode: "none" } | {
    mode: "manual";
    scope: "capture" | "session";
    text: string;
  } | {
    mode: "native";
    scope: "capture";
    sources: ("foreground-app" | "window-title" | "selected-text")[];
    /** A profile expresses a request; it cannot grant native permissions. */
    requiresExplicitPermission: true;
  };
  rewrite: {
    enabled: boolean;
    model: MagicModelId;
    preset: MagicPreset;
    allowInferences: boolean;
    instructions?: string;
  };
};
export type PersonalProfileCollectionV1 = {
  schemaVersion: 1;
  profiles: PersonalProfileV1[];
};
export type ReadPersonalProfiles =
  | { status: "supported"; document: PersonalProfileCollectionV1 }
  | { status: "unsupported"; document: PersonalProfileDocument };

const languages = new Set<string>(LANGUAGES.map(([code]) => code));
const magicModels = new Set(["qwen35Small", "qwen35Medium", "qwen35Large"]);
const presets = new Set(["polish", "concise", "structured", "prompt"]);

function fail(path: string): never {
  throw new Error(`Invalid personal profile data at ${path}. Existing settings are preserved.`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(path);
  return value;
}
function flag(value: unknown, path: string): void {
  if (typeof value !== "boolean") fail(path);
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path);
  return value;
}
function language(value: unknown, path: string): void {
  if (typeof value !== "string" || !languages.has(value)) fail(path);
}
function version(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(path);
  return value;
}
function json(value: unknown, path: string, depth = 0): void {
  if (depth > 40) fail(path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => json(item, `${path}[${index}]`, depth + 1));
    return;
  }
  const source = object(value, path);
  if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) fail(path);
  for (const [key, item] of Object.entries(source)) json(item, `${path}.${key}`, depth + 1);
}
function rule(value: unknown, path: string): void {
  const source = object(value, path);
  text(source.id, `${path}.id`, 128);
  if (source.kind !== "correction" && source.kind !== "shortcut") fail(`${path}.kind`);
  text(source.term, `${path}.term`, 256);
  text(source.soundsLike, `${path}.soundsLike`, 1024, false);
  // Never trim a saved text block or silently globalize an invalid language.
  text(source.replacement, `${path}.replacement`, 4096, source.kind === "shortcut");
  flag(source.enabled, `${path}.enabled`);
  if (source.language !== undefined) language(source.language, `${path}.language`);
}
function uniqueIds(items: unknown[], path: string): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const id = text(object(item, `${path}[${index}]`).id, `${path}[${index}].id`, 128);
    if (ids.has(id)) fail(`${path}[${index}].id (duplicate)`);
    ids.add(id);
  });
}
function profile(value: unknown, path: string): void {
  const source = object(value, path);
  text(source.id, `${path}.id`, 128);
  text(source.name, `${path}.name`, 128);
  language(source.language, `${path}.language`);
  const decode = object(source.decode, `${path}.decode`);
  if (decode.mode === "explicit") {
    if (typeof decode.temperature !== "number" || !Number.isFinite(decode.temperature) || decode.temperature < 0 || decode.temperature > 2) fail(`${path}.decode.temperature`);
    if (typeof decode.maxTokens !== "number" || !Number.isInteger(decode.maxTokens) || decode.maxTokens < 1 || decode.maxTokens > 32768) fail(`${path}.decode.maxTokens`);
  } else if (decode.mode !== "backend-default") fail(`${path}.decode.mode`);
  const delivery = object(source.delivery, `${path}.delivery`);
  for (const field of ["autoPaste", "copyToClipboard", "keepHistory"]) flag(delivery[field], `${path}.delivery.${field}`);
  const vocabulary = object(source.vocabulary, `${path}.vocabulary`);
  const rules = array(vocabulary.rules, `${path}.vocabulary.rules`, 500);
  rules.forEach((item, index) => rule(item, `${path}.vocabulary.rules[${index}]`));
  uniqueIds(rules, `${path}.vocabulary.rules`);
  const grammar = object(source.technicalGrammar, `${path}.technicalGrammar`);
  flag(grammar.preserveIdentifiers, `${path}.technicalGrammar.preserveIdentifiers`);
  array(grammar.literalTerms, `${path}.technicalGrammar.literalTerms`, 500).forEach((item, index) => text(item, `${path}.technicalGrammar.literalTerms[${index}]`, 4096));
  const context = object(source.context, `${path}.context`);
  if (context.mode === "manual") {
    if (context.scope !== "capture" && context.scope !== "session") fail(`${path}.context.scope`);
    text(context.text, `${path}.context.text`, 4096);
  } else if (context.mode === "native") {
    if (context.scope !== "capture" || context.requiresExplicitPermission !== true) fail(`${path}.context.permission/scope`);
    const sources = array(context.sources, `${path}.context.sources`, 3);
    if (!sources.length || new Set(sources).size !== sources.length || sources.some((item) => !["foreground-app", "window-title", "selected-text"].includes(String(item)))) fail(`${path}.context.sources`);
  } else if (context.mode !== "none") fail(`${path}.context.mode`);
  const rewrite = object(source.rewrite, `${path}.rewrite`);
  flag(rewrite.enabled, `${path}.rewrite.enabled`);
  flag(rewrite.allowInferences, `${path}.rewrite.allowInferences`);
  if (!magicModels.has(String(rewrite.model))) fail(`${path}.rewrite.model`);
  if (!presets.has(String(rewrite.preset))) fail(`${path}.rewrite.preset`);
  if (rewrite.instructions !== undefined) text(rewrite.instructions, `${path}.rewrite.instructions`, 4096, false);
}

/** Missing data is a legacy installation, with no stored or active profiles. */
export function readPersonalProfiles(value: unknown): ReadPersonalProfiles {
  if (value === undefined) return { status: "supported", document: { schemaVersion: 1, profiles: [] } };
  json(value, "personalProfiles");
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 5_000_000) fail("personalProfiles (too large)");
  const source = object(value, "personalProfiles");
  const schemaVersion = version(source.schemaVersion, "personalProfiles.schemaVersion");
  if (schemaVersion !== 1) return { status: "unsupported", document: structuredClone(source) as PersonalProfileDocument };
  const profiles = array(source.profiles, "personalProfiles.profiles", 128);
  // A newer profile inside a known collection also makes the whole document
  // opaque/read-only. Do not normalize away that profile or its unknown fields.
  let future = false;
  profiles.forEach((item, index) => {
    const entry = object(item, `personalProfiles.profiles[${index}]`);
    if (version(entry.schemaVersion, `personalProfiles.profiles[${index}].schemaVersion`) !== 1) future = true;
    else profile(entry, `personalProfiles.profiles[${index}]`);
  });
  if (future) return { status: "unsupported", document: structuredClone(source) as PersonalProfileDocument };
  uniqueIds(profiles, "personalProfiles.profiles");
  // Validate without reconstructing: preserve extra fields and exact text bytes.
  return { status: "supported", document: structuredClone(source) as unknown as PersonalProfileCollectionV1 };
}

/** Called before storage writes; an older app may preserve but not replace future data. */
export function assertPersonalProfilesUpdate(previous: unknown, next: unknown): void {
  const before = readPersonalProfiles(previous);
  const after = readPersonalProfiles(next);
  if (before.status === "unsupported" || after.status === "unsupported") {
    if (JSON.stringify(before.document) !== JSON.stringify(after.document)) {
      throw new Error("This app cannot edit personal profiles from a newer schema. Their data has been preserved; use a compatible app version.");
    }
  }
}

/** Contract snapshot only; this neither stores nor activates a profile. */
export function personalProfileFromSettings(settings: AppSettings, id: string, name: string): PersonalProfileV1 {
  const value: PersonalProfileV1 = {
    schemaVersion: 1,
    id,
    name,
    language: settings.language,
    decode: { mode: "backend-default" },
    delivery: { autoPaste: settings.autoPaste, copyToClipboard: settings.copyToClipboard, keepHistory: settings.keepHistory },
    vocabulary: { rules: settings.customWords.map((word) => ({
      ...word,
      kind: word.kind ?? (word.replacement ? "shortcut" : "correction"),
    })) },
    technicalGrammar: { preserveIdentifiers: true, literalTerms: [] },
    context: { mode: "none" },
    rewrite: { enabled: settings.magicEnabled, model: settings.magicModel, preset: settings.magicPreset, allowInferences: settings.magicAllowInferences },
  };
  profile(value, "profile");
  return structuredClone(value);
}
