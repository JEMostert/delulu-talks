import type { TranscriptRecord } from "./types";

export function transcriptSourceRevision(record: TranscriptRecord): number {
  const revision = record.sourceRevision;
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? revision! : 0;
}

export function originalTranscriptText(record: TranscriptRecord): string {
  return record.text;
}

export function transcriptText(record: TranscriptRecord): string {
  return record.editedText ?? originalTranscriptText(record);
}

export function transcriptIsEdited(record: TranscriptRecord): boolean {
  return record.editedText != null;
}

export function deliveredText(record: TranscriptRecord): string {
  return (
    ((record.rewriteSourceRevision == null ||
      record.rewriteSourceRevision === transcriptSourceRevision(record))
      ? record.magicText?.trim() : null) ||
    (record.editedText == null ? record.personalizedText : null) ||
    transcriptText(record)
  );
}
