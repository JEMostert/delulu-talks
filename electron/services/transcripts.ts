import type { TranscriptRecord } from "../../src/types";
import { deliveredText, transcriptText } from "../../src/transcriptText";

export function exportRecord(
  record: TranscriptRecord,
  format: "txt" | "json",
): string {
  if (format === "json") return `${JSON.stringify(record, null, 2)}\n`;
  const source = transcriptText(record);
  const output = deliveredText(record);
  return record.magicText || (record.personalizedText && output !== source)
    ? `${output.trim()}\n\n--- Source transcript ---\n\n${source.trim()}\n`
    : `${output.trim()}\n`;
}
