export type TechnicalRange = { start: number; end: number };
export type TechnicalPart = { text: string; protected: boolean };

// Only explicit literals are protected. Spoken symbols remain recognizer text;
// this does not guess an address/path from ordinary Dutch or English prose.
const patterns = [
  /```[^\r\n]*\r?\n[\s\S]*?(?:```|$)/g,
  /`[^`\r\n]+`/g,
  /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/giu,
  /(?<![\p{L}\p{N}_.+-])[\p{L}\p{N}_.+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  /["'](?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^"'\r\n]*["']/g,
  /(?<![\p{L}\p{N}_])(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~\/)[^\s<>"'`]+/gu,
  /(?<![\p{L}\p{N}_])[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)+(?![\p{L}\p{N}_])/gu,
  /(?<![\p{L}\p{N}_])v?\d+(?:\.\d+)+(?:[-+][\p{L}\p{N}.-]+)?(?![\p{L}\p{N}_])/gu,
  /(?<![\p{L}\p{N}_])--[\p{L}\p{N}][\p{L}\p{N}_-]*(?:=[^\s<>"'`]+)?/gu,
  /^[\t ]*(?:\$|>)\s*[^\r\n]+/gm,
  /^[\t ]*(?:sudo\s+)?(?:git|npm|npx|bun|pnpm|yarn|node|python3?|pip3?|cargo|rustc|docker|kubectl|ffmpeg|curl|wget|ssh|rsync|chmod|chown|rm|mv|cp|mkdir|cmake|bash|zsh|powershell|pwsh|cmd(?:\.exe)?)(?=[\t ]|$)[^\r\n]*/gm,
  /^[\t ]*go\s+(?:build|run|test|mod|get|install|fmt|vet|generate|version|env|list|clean|tool)(?=[\t ]|$)[^\r\n]*/gm,
];

export function technicalRanges(text: string): TechnicalRange[] {
  const ranges: TechnicalRange[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TechnicalRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function splitTechnicalText(text: string): TechnicalPart[] {
  const parts: TechnicalPart[] = [];
  let cursor = 0;
  for (const range of technicalRanges(text)) {
    if (range.start > cursor)
      parts.push({ text: text.slice(cursor, range.start), protected: false });
    parts.push({ text: text.slice(range.start, range.end), protected: true });
    cursor = range.end;
  }
  if (cursor < text.length || !parts.length)
    parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}
