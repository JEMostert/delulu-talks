import type { TranscriptRecord, TranscriptVersion } from "./types";

export function originalTranscriptText(record: TranscriptRecord, version: TranscriptVersion): string {
  return version === "intended"
    ? record.intendedText || record.text
    : record.verbatimText || record.text;
}

export function transcriptText(record: TranscriptRecord, version: TranscriptVersion): string {
  const edited = version === "intended" ? record.editedIntendedText : record.editedVerbatimText;
  return edited ?? originalTranscriptText(record, version);
}

export function transcriptIsEdited(record: TranscriptRecord, version: TranscriptVersion): boolean {
  return (version === "intended" ? record.editedIntendedText : record.editedVerbatimText) != null;
}
