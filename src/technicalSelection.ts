/**
 * Map UTF-16 selection offsets from the textarea's LF-normalized display to the
 * original buffer. CRLF and lone CR each display as one LF; returned text retains
 * the original line endings and Unicode code units without normalization.
 */
export function rawTechnicalSelection(
  text: string,
  start: number,
  end: number,
): string | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return null;
  }
  let rawOffset = 0;
  let displayOffset = 0;
  let rawStart = start === 0 ? 0 : -1;
  while (rawOffset < text.length && displayOffset < end) {
    if (text[rawOffset] === "\r" && text[rawOffset + 1] === "\n") {
      rawOffset += 2;
    } else {
      rawOffset += 1;
    }
    displayOffset += 1;
    if (displayOffset === start) rawStart = rawOffset;
  }
  if (displayOffset !== end || rawStart < 0) return null;
  const splitsSurrogate = (offset: number): boolean => {
    if (offset === 0 || offset === text.length) return false;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return (
      before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    );
  };
  if (splitsSurrogate(rawStart) || splitsSurrogate(rawOffset)) return null;
  return text.slice(rawStart, rawOffset);
}
