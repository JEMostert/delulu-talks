/**
 * Plan synthesis chunks from parsed voice markup. The first chunk is short so
 * audio starts quickly; the next chunk is synthesized while the previous one
 * plays. A chunk never mixes speaking styles.
 */
import { VOICE_LIMITS, type VoicePart, type VoiceStyle } from "./voice";
import type { VoiceSegment } from "./voiceMarkup";

export type VoiceChunk = {
  styles: VoiceStyle[];
  parts: VoicePart[];
  /** Display text without tags. */
  text: string;
};

/** Silence one chunk may carry, well inside the worker's 90-second audio limit. */
const MAX_CHUNK_PAUSE_MS = 15_000;
const SENTENCE_END = /[.!?…;]+["'’”)\]]*(?=\s|$)/g;

/** Split at sentence punctuation followed by whitespace, and at line breaks. */
function sentences(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    let start = 0;
    for (const match of line.matchAll(SENTENCE_END)) {
      const end = match.index! + match[0].length;
      pieces.push(line.slice(start, end));
      start = end;
    }
    pieces.push(line.slice(start));
  }
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/** Break an overlong sentence at a clause boundary, else a space, else anywhere. */
function fit(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const clause = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" — "),
      window.lastIndexOf(" - "),
    );
    const space = window.lastIndexOf(" ");
    const cut =
      clause > limit / 3 ? clause + 1 : space > limit / 3 ? space : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function displayText(parts: VoicePart[]): string {
  return parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+([.,!?;:…])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

type Draft = { styles: VoiceStyle[]; parts: VoicePart[]; characters: number };

export function planVoiceChunks(
  segments: VoiceSegment[],
  options: { firstChunkCharacters?: number; chunkCharacters?: number } = {},
): VoiceChunk[] {
  const ceiling = VOICE_LIMITS.chunkCharacters;
  const first = Math.min(
    ceiling,
    Math.max(1, options.firstChunkCharacters ?? 140),
  );
  const later = Math.min(ceiling, Math.max(1, options.chunkCharacters ?? 420));
  const chunks: Draft[] = [];
  let current: Draft | null = null;
  const target = () => (chunks.length ? later : first);
  const close = () => {
    if (current && current.parts.some((part) => part.kind !== "pause"))
      chunks.push(current);
    current = null;
  };
  const open = (styles: VoiceStyle[]): Draft => {
    if (!current) current = { styles, parts: [], characters: 0 };
    return current;
  };
  const add = (styles: VoiceStyle[], part: VoicePart, characters = 0) => {
    let draft = open(styles);
    if (draft.parts.length >= VOICE_LIMITS.chunkParts) {
      close();
      draft = open(styles);
    }
    const previous = draft.parts[draft.parts.length - 1];
    if (part.kind === "text" && previous?.kind === "text") {
      previous.text = `${previous.text} ${part.text}`;
      draft.characters += characters + 1;
    } else {
      draft.parts.push(part);
      draft.characters += characters;
    }
  };

  for (const segment of segments) {
    if (current && (current as Draft).styles.join() !== segment.styles.join())
      close();
    if (segment.kind === "pause") {
      // A pause belongs at the end of what came before it; leading ones carry nothing.
      const host: Draft | undefined =
        current && (current as Draft).parts.length
          ? current
          : chunks[chunks.length - 1];
      // Stay inside the worker's part and audio limits however many pauses arrive.
      const paused = host?.parts.reduce(
        (total, part) => total + (part.kind === "pause" ? part.ms : 0),
        0,
      );
      if (
        host &&
        host.parts.length < VOICE_LIMITS.chunkParts &&
        paused! + segment.ms <= MAX_CHUNK_PAUSE_MS
      )
        host.parts.push({ kind: "pause", ms: segment.ms });
      continue;
    }
    if (segment.kind === "event") {
      add(segment.styles, { kind: "event", tag: segment.tag });
      continue;
    }
    for (const sentence of sentences(segment.text)) {
      for (const piece of fit(sentence, ceiling)) {
        const draft = current as Draft | null;
        if (
          draft &&
          draft.characters > 0 &&
          draft.characters + 1 + piece.length > target()
        )
          close();
        add(segment.styles, { kind: "text", text: piece }, piece.length);
      }
    }
  }
  close();

  const last = chunks[chunks.length - 1];
  while (last?.parts[last.parts.length - 1]?.kind === "pause") last.parts.pop();
  return chunks.map(({ styles, parts }) => ({
    styles: [...styles],
    parts,
    text: displayText(parts),
  }));
}
