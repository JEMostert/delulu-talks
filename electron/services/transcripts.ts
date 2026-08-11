import type { SpeechInsights, TranscriptRecord, WordTimestamp } from "../../src/types";
import { transcriptText } from "../../src/transcriptText";

const fillerPattern = /\[(?:um|uh|erm|hmm)\]|\b(?:um+|uh+|erm+|hmm+)\b/giu;
const vocalPattern = /\[(?:laughter|laugh|cough|sigh|breath|noise|music|applause)\]/giu;

export function deriveInsights(text: string, words: WordTimestamp[], durationMs: number): SpeechInsights {
  const plainWords = text.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
  const repeated = plainWords.slice(1).filter((word, index) => word.localeCompare(plainWords[index], undefined, { sensitivity: "accent" }) === 0).length;
  const cutOffs = plainWords.filter((word) => /[-–—]$/u.test(word)).length;
  const speakingSeconds = words.length
    ? words.reduce((sum, word) => sum + Math.max(0, word.end - word.start), 0)
    : durationMs / 1000;
  const minutes = Math.max(durationMs / 60_000, 1 / 60);
  return {
    fillerCount: (text.match(fillerPattern) ?? []).length,
    repetitionCount: repeated,
    cutOffCount: cutOffs,
    vocalEventCount: (text.match(vocalPattern) ?? []).length,
    wordsPerMinute: Math.round(plainWords.length / minutes),
    speakingSeconds: Math.round(speakingSeconds * 10) / 10,
  };
}

function timecode(seconds: number, separator: "," | "."): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function captionGroups(words: WordTimestamp[]): WordTimestamp[][] {
  const groups: WordTimestamp[][] = [];
  let current: WordTimestamp[] = [];
  for (const word of words) {
    const currentStart = current[0]?.start ?? word.start;
    const currentText = current.map((item) => item.word).join(" ");
    if (current.length && (word.end - currentStart > 5 || currentText.length + word.word.length > 72)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups;
}

export function exportRecord(record: TranscriptRecord, format: "txt" | "json" | "srt" | "vtt"): string {
  if (format === "json") return `${JSON.stringify(record, null, 2)}\n`;
  if (format === "txt") {
    const intended = transcriptText(record, "intended");
    const verbatim = transcriptText(record, "verbatim");
    const hasIntended = Boolean(record.intendedText || record.editedIntendedText);
    const hasVerbatim = Boolean(record.verbatimText || record.editedVerbatimText);
    const dual = hasIntended && hasVerbatim && verbatim !== intended
      ? `${intended}\n\n--- Verbatim ---\n\n${verbatim}`
      : hasVerbatim && !hasIntended ? verbatim : intended || verbatim;
    return record.magicText
      ? `${record.magicText.trim()}\n\n--- Source transcript ---\n\n${dual.trim()}\n`
      : `${dual.trim()}\n`;
  }

  const groups = captionGroups(record.words.length ? record.words : record.verbatimWords);
  const cues = groups.map((group, index) => {
    const start = timecode(group[0].start, format === "srt" ? "," : ".");
    const end = timecode(group[group.length - 1].end, format === "srt" ? "," : ".");
    const line = group.map((word) => word.word).join(" ").replace(/\s+([,.;!?])/g, "$1");
    return format === "srt" ? `${index + 1}\n${start} --> ${end}\n${line}` : `${start} --> ${end}\n${line}`;
  });
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues.join("\n\n")}\n`;
}
