import { createHash } from "node:crypto";
import type {
  HistoryRetentionPolicy,
  HistoryRetentionEffects,
  HistoryRetentionPreview,
  TranscriptRecord,
} from "../../src/types";

export function validateRetentionPolicy(value: unknown): HistoryRetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a retention age and/or count before previewing.");
  const source = value as Record<string, unknown>;
  const limit = (key: string, minimum: number, maximum: number): number | null => {
    const input = source[key];
    if (input === null) return null;
    if (typeof input !== "number" || !Number.isInteger(input) || input < minimum || input > maximum)
      throw new Error(`${key === "maxAgeDays" ? "Age" : "Count"} must be a whole number from ${minimum} to ${maximum}, or unlimited.`);
    return input;
  };
  return {
    maxAgeDays: limit("maxAgeDays", 1, 36_500),
    maxCount: limit("maxCount", 0, 500),
  };
}

export function savedRetentionPolicy(value: unknown): HistoryRetentionPolicy {
  try {
    return validateRetentionPolicy(value);
  } catch {
    return { maxAgeDays: null, maxCount: null };
  }
}

export function historyFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function affectedByRetention(
  records: TranscriptRecord[],
  policy: HistoryRetentionPolicy,
  previewedAt: number,
): HistoryRetentionPreview["affected"] {
  const newest = records.map((record, index) => ({ record, index })).sort(
    (a, b) => b.record.createdAt - a.record.createdAt || a.index - b.index,
  );
  const cutoff = policy.maxAgeDays === null ? null : previewedAt - policy.maxAgeDays * 86_400_000;
  return newest.flatMap(({ record }, index) => {
    const age = cutoff !== null && record.createdAt < cutoff;
    const count = policy.maxCount !== null && index >= policy.maxCount;
    if (!age && !count) return [];
    return [{ record, reason: age && count ? "ageAndCount" as const : age ? "age" as const : "count" as const }];
  });
}

/** Describe all text variants removed, independently of the currently displayed variant. */
export function retentionEffects(records: TranscriptRecord[]): HistoryRetentionEffects {
  return {
    originals: records.length,
    personalized: records.filter((record) => record.personalizedText != null).length,
    corrections: records.filter((record) => record.editedText != null).length,
    rewrites: records.filter((record) => record.magicText != null).length,
    importedReferences: records.filter((record) => record.source === "file").length,
    audioFilesDeleted: 0,
  };
}
