/** Titles are optional single-line metadata, separate from transcript content. */
export function normalizeTranscriptTitle(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error("A transcript title must be text or null");
  if (value.length > 256)
    throw new Error("A transcript title cannot exceed 256 characters");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value))
    throw new Error(
      "A transcript title must be a single line without control characters",
    );
  return value.trim() || null;
}
