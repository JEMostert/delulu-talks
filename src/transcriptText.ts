import type { TranscriptRecord } from "./types";

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
    record.magicText?.trim() ||
    (record.editedText == null ? record.personalizedText : null) ||
    transcriptText(record)
  );
}
