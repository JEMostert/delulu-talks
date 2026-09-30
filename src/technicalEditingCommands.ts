/** Ranges use UTF-16 textarea offsets; callers provide the displayed LF-normalized text. */
export interface TextRange {
  start: number;
  end: number;
}

function safeOffset(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
    return false;
  if (offset === 0 || offset === text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

/**
 * Find the last complete lexical identifier preceding the caret. This is a Unicode
 * token heuristic, not a programming-language parser. Kebab segments follow the same
 * letter/underscore/dollar start rule. A caret inside a token is rejected rather than
 * returning a truncated token or silently choosing a more distant identifier.
 */
export function previousIdentifierRange(
  text: string,
  caret: number,
): TextRange | null {
  if (!safeOffset(text, caret)) return null;
  const tokens = /[\p{L}\p{M}\p{N}_$-]+/gu;
  const identifier =
    /^[\p{L}_$][\p{L}\p{M}\p{N}_$]*(?:-[\p{L}_$][\p{L}\p{M}\p{N}_$]*)*$/u;
  let previous: TextRange | null = null;
  for (const match of text.matchAll(tokens)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= caret) break;
    if (end > caret) return null;
    if (identifier.test(match[0])) previous = { start, end };
  }
  return previous;
}

/**
 * Keep an explicit nonempty selection exactly, otherwise select a Unicode word under
 * or immediately before the caret. Apostrophes may occur inside words. These lexical
 * ranges do not infer language syntax and never mutate the supplied text.
 */
export function correctionWordRange(
  text: string,
  start: number,
  end: number,
): TextRange | null {
  if (!safeOffset(text, start) || !safeOffset(text, end) || start > end)
    return null;
  if (start !== end) return { start, end };
  const words =
    /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
  for (const match of text.matchAll(words)) {
    const wordStart = match.index;
    const wordEnd = wordStart + match[0].length;
    if (wordStart > start) break;
    if (start >= wordStart && start <= wordEnd)
      return { start: wordStart, end: wordEnd };
  }
  return null;
}
