/**
 * Parse Delulu Voice markup: Grok-style inline tags such as `[laugh]` and
 * wrapping styles such as `<whisper>…</whisper>`. Agents write this text, so
 * the parser is lenient: unknown tags are skipped with a warning, unclosed
 * styles close at the end, and anything that is not tag-shaped stays text.
 */
import {
  VOICE_LIMITS,
  VOICE_PAUSES,
  type VoiceEventTag,
  type VoiceStyle,
} from "./voice";

export type VoiceSegment =
  | { kind: "text"; text: string; styles: VoiceStyle[] }
  | { kind: "event"; tag: VoiceEventTag; styles: VoiceStyle[] }
  | { kind: "pause"; ms: number; styles: VoiceStyle[] };

export type ParsedVoiceMarkup = {
  segments: VoiceSegment[];
  warnings: string[];
  /** What a person would read: the text without tags. */
  plainText: string;
};

/** Spellings agents use for each sound, after lowercasing and hyphens → spaces. */
const EVENT_ALIASES: Record<string, VoiceEventTag> = {
  laugh: "laugh",
  laughs: "laugh",
  laughing: "laugh",
  chuckle: "chuckle",
  chuckles: "chuckle",
  giggle: "chuckle",
  giggles: "chuckle",
  sigh: "sigh",
  sighs: "sigh",
  gasp: "gasp",
  gasps: "gasp",
  cough: "cough",
  coughs: "cough",
  "clear throat": "clear-throat",
  "clears throat": "clear-throat",
  sniff: "sniff",
  sniffs: "sniff",
  groan: "groan",
  groans: "groan",
  shush: "shush",
};

const STYLE_ALIASES: Record<string, VoiceStyle> = {
  whisper: "whisper",
  whispers: "whisper",
  whispering: "whisper",
  happy: "happy",
  excited: "happy",
  angry: "angry",
  surprised: "surprised",
  scared: "scared",
  fear: "scared",
  sarcastic: "sarcastic",
  dramatic: "dramatic",
  narration: "narration",
  crying: "crying",
  slow: "slow",
  fast: "fast",
  soft: "soft",
  loud: "loud",
  emphasis: "emphasis",
};

/** Guards against runaway nesting from malformed input. */
const MAX_STYLE_STACK = 32;

type Token =
  | { kind: "text"; text: string }
  | { kind: "event"; tag: VoiceEventTag }
  | { kind: "pause"; ms: number }
  | { kind: "open"; style: VoiceStyle; raw: string }
  | { kind: "close"; style: VoiceStyle; raw: string };

function squareKey(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function pauseMs(key: string): number | null {
  if (key === "pause") return VOICE_PAUSES.pause;
  if (key === "long pause") return VOICE_PAUSES["long-pause"];
  const timed = /^pause (\d+(?:\.\d+)?) ?(ms|s|sec|secs|seconds?)?$/.exec(key);
  if (!timed) return null;
  const value = Number(timed[1]);
  const ms = timed[2] && timed[2] !== "ms" ? value * 1000 : value;
  return Math.round(Math.min(VOICE_LIMITS.pauseMs, Math.max(0, ms)));
}

/** `[word]` or `[two words]`; single letters, numbers and acronyms stay text. */
function looksLikeSquareTag(content: string): boolean {
  if (!/^[A-Za-z][A-Za-z _-]{1,23}$/.test(content.trim())) return false;
  // [WIP], [TODO] and similar acronyms are part of the message, not markup.
  return !/^[A-Z]+$/.test(content.trim());
}

function tokenize(input: string, warnings: string[]): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (
      char === "\\" &&
      (input[index + 1] === "[" || input[index + 1] === "<")
    ) {
      text += input[index + 1];
      index += 2;
      continue;
    }
    if (char === "[") {
      const end = input.indexOf("]", index + 1);
      const content = end > index ? input.slice(index + 1, end) : "";
      // Markdown links keep their bracketed text: [label](url).
      if (
        end > index &&
        end - index <= 41 &&
        !/[[\n]/.test(content) &&
        input[end + 1] !== "("
      ) {
        const key = squareKey(content);
        const event = EVENT_ALIASES[key];
        const pause = pauseMs(key);
        if (event || pause !== null || looksLikeSquareTag(content)) {
          flush();
          if (event) tokens.push({ kind: "event", tag: event });
          else if (pause !== null) tokens.push({ kind: "pause", ms: pause });
          else warnings.push(`Unknown tag [${content.trim()}] skipped`);
          index = end + 1;
          continue;
        }
      }
    }
    if (char === "<") {
      const match = /^<(\/?)([A-Za-z][A-Za-z_-]{1,23})\s*>/.exec(
        input.slice(index, index + 32),
      );
      // A word character before `<` is a generic type such as Array<string>.
      const generic = !match?.[1] && index > 0 && /\w/.test(input[index - 1]);
      if (match && !generic && !/^[A-Z]+$/.test(match[2])) {
        flush();
        const style = STYLE_ALIASES[match[2].toLowerCase().replace(/_/g, "-")];
        if (style)
          tokens.push({
            kind: match[1] ? "close" : "open",
            style,
            raw: match[0],
          });
        else warnings.push(`Unknown tag ${match[0]} skipped`);
        index += match[0].length;
        continue;
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return tokens;
}

/** Collapse spaces and tabs; keep single line breaks as sentence boundaries. */
function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n");
}

function readable(text: string): string {
  return collapse(text)
    .replace(/ +([.,!?;:…])/g, "$1")
    .replace(/ +\n|\n +/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function parseVoiceMarkup(input: string): ParsedVoiceMarkup {
  const warnings: string[] = [];
  const segments: VoiceSegment[] = [];
  const stack: VoiceStyle[] = [];
  let truncated = false;
  const active = (): VoiceStyle[] => {
    const unique = [...new Set(stack)];
    if (unique.length > VOICE_LIMITS.styles && !truncated) {
      truncated = true;
      warnings.push(
        `Only ${VOICE_LIMITS.styles} styles can apply at once; extra styles skipped`,
      );
    }
    return unique.slice(0, VOICE_LIMITS.styles);
  };
  for (const token of tokenize(input, warnings)) {
    if (token.kind === "open") {
      if (stack.length < MAX_STYLE_STACK) stack.push(token.style);
      else warnings.push(`Too many nested styles; ${token.raw} skipped`);
    } else if (token.kind === "close") {
      const at = stack.lastIndexOf(token.style);
      if (at >= 0) stack.splice(at, 1);
      else warnings.push(`Closing tag ${token.raw} had no opening tag`);
    } else if (token.kind === "text") {
      const text = collapse(token.text);
      if (!text.trim()) continue;
      const styles = active();
      const previous = segments[segments.length - 1];
      if (previous?.kind === "text" && previous.styles.join() === styles.join())
        previous.text = collapse(previous.text + text);
      else segments.push({ kind: "text", text, styles });
    } else segments.push({ ...token, styles: active() });
  }
  for (const style of new Set(stack))
    warnings.push(`Unclosed tag <${style}> closed at the end`);
  // Leading and trailing whitespace of the whole utterance carries nothing.
  const first = segments[0];
  if (first?.kind === "text") first.text = first.text.replace(/^\s+/, "");
  const last = segments[segments.length - 1];
  if (last?.kind === "text") last.text = last.text.replace(/\s+$/, "");
  const plainText = readable(
    segments
      .map((segment) => (segment.kind === "text" ? segment.text : " "))
      .join(""),
  );
  return { segments, warnings, plainText };
}

export function stripVoiceMarkup(input: string): string {
  return parseVoiceMarkup(input).plainText;
}
