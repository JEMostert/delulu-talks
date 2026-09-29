import type { TranscriptRecord } from "./types";

export const SESSION_TRANSCRIPT_LIMIT = 20;
export const SESSION_TRANSCRIPT_TEXT_BYTES = 8 * 1024 * 1024;

/** Account for all strings, including originals, corrections and rewrites. */
function textBytes(record: TranscriptRecord): number {
  const encoder = new TextEncoder();
  return Object.values(record).reduce<number>(
    (bytes, value) =>
      bytes + (typeof value === "string" ? encoder.encode(value).byteLength : 0),
    0,
  );
}

/** Keep newest session outputs whole; only the newest may exceed the budget. */
export function retainSessionTranscripts(
  records: TranscriptRecord[],
): TranscriptRecord[] {
  const sessions = records
    .filter((record) => record.sessionOnly)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const retained = new Set<string>();
  let bytes = 0;
  for (const record of sessions) {
    const size = textBytes(record);
    if (
      retained.size >= SESSION_TRANSCRIPT_LIMIT ||
      (retained.size > 0 && bytes + size > SESSION_TRANSCRIPT_TEXT_BYTES)
    ) break;
    retained.add(record.id);
    bytes += size;
  }
  return records.filter(
    (record) => !record.sessionOnly || retained.has(record.id),
  );
}

/** Saved records belong to disk history, not a second session cache. */
export function rememberSessionTranscript(
  records: Map<string, TranscriptRecord>,
  record: TranscriptRecord,
): void {
  if (!record.sessionOnly) return;
  records.set(record.id, record);
  const retained = new Set(
    retainSessionTranscripts([...records.values()]).map((item) => item.id),
  );
  for (const id of records.keys()) {
    if (!retained.has(id)) records.delete(id);
  }
}
