import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExportFormat, TranscriptRecord } from "../../src/types";
import { deliveredText, transcriptText } from "../../src/transcriptText";

function markdownBlock(text: string, language = "text"): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

function markdownNote(record: TranscriptRecord): string {
  const created = new Date(record.createdAt);
  const metadata = JSON.stringify({
    id: record.id,
    recordedAt: Number.isFinite(created.getTime()) ? created.toISOString() : null,
    speechModel: record.model,
    language: record.language,
    source: record.source,
    sourceName: record.sourceName ?? null,
    rewriteModel: record.magicModel ?? null,
  }, null, 2);
  const sections: Array<[string, string]> = [["Original speech", record.text]];
  if (record.editedText != null) sections.push(["Saved correction", record.editedText]);
  if (record.personalizedText != null) sections.push(["Vocabulary result", record.personalizedText]);
  if (record.magicText != null) sections.push(["Rewrite", record.magicText]);
  return `# Transcript note\n\n## Recording\n\n${markdownBlock(metadata, "json")}\n` +
    sections.map(([title, text]) => `## ${title}\n\n${markdownBlock(text)}\n`).join("");
}

export function exportRecord(
  record: TranscriptRecord,
  format: ExportFormat,
): string {
  if (format === "md") return markdownNote(record);
  if (format === "json") return `${JSON.stringify(record, null, 2)}\n`;
  const source = transcriptText(record);
  const output = deliveredText(record);
  return record.magicText || (record.personalizedText && output !== source)
    ? `${output}\n\n--- Source transcript ---\n\n${source.trim()}\n`
    : `${output}\n`;
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
