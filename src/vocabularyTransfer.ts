import { assertPersistedSchema, versionPersistedRecord } from "./persistedSchema";
import { ruleConflict, ruleKind } from "./personalization";
import type { CustomWord } from "./types";

export const MAX_VOCABULARY_FILE_BYTES = 32 * 1024 * 1024;
export type ImportChoice = "add" | "replace" | "skip";
export type VocabularyBundle = { schemaVersion: 1; rules: CustomWord[] };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new Error(`${label} must be ${required ? "nonempty " : ""}text of at most ${max} characters.`);
  return value;
}

export function parseVocabularyBundle(raw: string): VocabularyBundle {
  if (new TextEncoder().encode(raw).byteLength > MAX_VOCABULARY_FILE_BYTES)
    throw new Error("The rules file exceeds the 32 MiB limit.");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("The rules file is not valid JSON. Nothing was imported."); }
  const bundle = object(value, "Rules file");
  if (bundle.schemaVersion !== 1) throw new Error("Unsupported rules schema version. This app accepts version 1.");
  if (Object.keys(bundle).some((key) => !["schemaVersion", "rules"].includes(key)))
    throw new Error("The rules file contains unsupported fields.");
  if (!Array.isArray(bundle.rules) || bundle.rules.length > 500)
    throw new Error("The rules file must contain an array of at most 500 rules.");
  const ids = new Set<string>();
  const rules = bundle.rules.map((value, index): CustomWord => {
    const row = object(value, `Rule ${index + 1}`);
    assertPersistedSchema(row, "rule");
    if (Object.keys(row).some((key) => !["schemaVersion", "id", "kind", "term", "soundsLike", "replacement", "enabled"].includes(key)))
      throw new Error(`Rule ${index + 1} contains unsupported fields.`);
    const id = text(row.id, `Rule ${index + 1} id`, 128, true);
    if (id !== id.trim() || ids.has(id)) throw new Error(`Rule ${index + 1} has a padded or duplicate id.`);
    ids.add(id);
    const term = text(row.term, `Rule ${index + 1} name`, 256, true);
    const soundsLike = text(row.soundsLike, `Rule ${index + 1} aliases`, 1024);
    const replacement = text(row.replacement, `Rule ${index + 1} replacement`, 4096);
    if (term !== term.trim() || soundsLike !== soundsLike.trim())
      throw new Error(`Rule ${index + 1} name/aliases contain outer whitespace; review that file explicitly before importing.`);
    if (row.kind !== "correction" && row.kind !== "shortcut")
      throw new Error(`Rule ${index + 1} must identify a correction or text shortcut.`);
    if (typeof row.enabled !== "boolean") throw new Error(`Rule ${index + 1} enabled must be true or false.`);
    if (row.kind === "shortcut" && !replacement.trim()) throw new Error(`Rule ${index + 1} has an empty text shortcut.`);
    if (row.kind === "correction" && replacement !== "") throw new Error(`Rule ${index + 1} correction must not contain a shortcut replacement.`);
    return { schemaVersion: 1, id, kind: row.kind, term, soundsLike, replacement, enabled: row.enabled };
  });
  return { schemaVersion: 1, rules };
}

export function serializeVocabularyBundle(words: CustomWord[]): string {
  const raw = JSON.stringify({ schemaVersion: 1, rules: words.map((word) => versionPersistedRecord({ ...word, kind: ruleKind(word) }, "rule")) }, null, 2) + "\n";
  parseVocabularyBundle(raw);
  return raw;
}

export function vocabularyConflicts(rule: CustomWord, existing: CustomWord[]): CustomWord[] {
  return existing.filter((word) => word.id === rule.id || ruleConflict(rule, [word]) !== null);
}

export function planVocabularyImport(incoming: CustomWord[], existing: CustomWord[], choices: Record<string, ImportChoice | undefined>) {
  const removed = new Set<string>();
  const accepted: CustomWord[] = [];
  for (const rule of incoming) {
    const choice = choices[rule.id];
    if (!choice) throw new Error(`Choose an action for “${rule.term}”.`);
    if (choice === "skip") continue;
    const conflicts = vocabularyConflicts(rule, existing);
    if (conflicts.length && choice !== "replace")
      throw new Error(`“${rule.term}” conflicts with ${conflicts.map((word) => `“${word.term}”`).join(", ")}. Choose replace or skip.`);
    if (choice === "replace") for (const conflict of conflicts) removed.add(conflict.id);
    accepted.push(rule);
  }
  const next = [...accepted, ...existing.filter((word) => !removed.has(word.id))];
  if (next.length > 500) throw new Error(`This import would create ${next.length} rules. Keep at most 500 by skipping rules or removing existing ones.`);
  for (const rule of accepted) {
    const conflict = ruleConflict(rule, next);
    if (conflict) throw new Error(`Imported “${rule.term}”: ${conflict} Skip one of the conflicting imports.`);
  }
  return { words: next, added: accepted.length, replaced: existing.filter((word) => removed.has(word.id)).length, skipped: incoming.length - accepted.length };
}
