import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** Replace only a fully written export; a failed write leaves the destination intact. */
export function saveTemplateExport(outputPath: string, text: string): void {
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, text, "utf8");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, outputPath);
  } finally {
    if (created) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup must not hide the original save failure.
      }
    }
  }
}
